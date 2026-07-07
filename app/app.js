/* Poole Harbour — Three Ways
 *
 * A single static page over an Oxigraph SPARQL endpoint (served from the same
 * origin at /sparql). It loads a handful of queries once, caches the rows, then
 * switches between four "views" and filters by substance entirely client-side.
 *
 * Geometry note: regulation discharge points and SFI options carry WGS84 lon/lat
 * WKT; WINEP action sites carry EPSG:27700 (British National Grid) and are
 * reprojected here with proj4.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const ENDPOINT = "/sparql";
const CENTER = [50.731, -2.370];
const NITROGEN = "0111"; // Ammoniacal Nitrogen as N — the default for the substance story
const WQE = "https://environment.data.gov.uk/water-quality/sampling-point/";

// Conservation-designation underlays (clipped to the catchment by raw_datasets/prep_designations.py).
// Rendered beneath every plotted location on all map views, toggled from the legend.
const DESIGNATIONS = [
  { key: "sssi", label: "SSSI", full: "Sites of Special Scientific Interest", file: "sssi.geojson", color: "#c9922e" },
  { key: "sac", label: "SAC", full: "Special Areas of Conservation", file: "sac.geojson", color: "#2f9ea0" },
  { key: "spa", label: "SPA", full: "Special Protection Areas", file: "spa.geojson", color: "#9a5eae" },
];

// SFI programmes (schemes). Only the Expanded Offer has published option rates in our source
// workbook, so SFI 2023 agreements are shown unpriced. Applications colour-code by programme.
const PROGRAMMES = {
  "SFI EO": { label: "SFI Expanded Offer", color: "#46b978", priced: true },
  "SFI 23": { label: "SFI 2023", color: "#8a94a0", priced: false },
};
const progOf = (a) =>
  PROGRAMMES[a.scheme] || { label: a.scheme || "—", color: "#8a94a0", priced: a.priced > 0 };
// Short cost label for an application: the summed priced total plus how many options are unpriced.
// SFI 2023 (unpriced programme) shows just "unpriced".
function appCostLabel(a) {
  if (!progOf(a).priced) return "unpriced";
  const base = fmtGBP(a.total) + "/yr";
  return a.unpriced ? `${base} · ${a.unpriced} unpriced` : base;
}

proj4.defs(
  "EPSG:27700",
  "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 " +
  "+ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs"
);

const PREFIXES = `
PREFIX reg:   <http://environment.data.gov.uk/ontology/regulation/>
PREFIX water: <http://environment.data.gov.uk/ontology/water/>
PREFIX core:  <http://environment.data.gov.uk/ontology/core/>
PREFIX farm:  <http://environment.data.gov.uk/ontology/farming/>
PREFIX ex:    <http://example.com/>
PREFIX qudt:  <http://qudt.org/schema/qudt/>
PREFIX iop:   <http://w3id.org/iadopt/ont/>
PREFIX geo:   <http://www.opengis.net/ont/geosparql#>
PREFIX skos:  <http://www.w3.org/2004/02/skos/core#>
PREFIX rdfs:  <http://www.w3.org/2000/01/rdf-schema#>
PREFIX dcterms: <http://purl.org/dc/terms/>
`;

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------
const Q = {
  substances: `${PREFIXES}
    SELECT ?s ?label ?notation WHERE {
      ?s skos:inScheme <http://example.com/water-regulation/substance> ;
         skos:prefLabel ?label ; skos:notation ?notation .
    } ORDER BY ?label`,

  breaches: `${PREFIXES}
    SELECT ?breach ?type ?from ?to ?subLabel ?subNotation ?permit ?cond
           (SAMPLE(?sp) AS ?sp) (SAMPLE(?w) AS ?wkt) WHERE {
      ?breach reg:breachesCondition ?cond ;
              core:hasApplicability/core:applicabilityPeriod ?period .
      ?period core:applicableFrom ?from .
      OPTIONAL { ?period core:applicableTo ?to }
      OPTIONAL { ?breach a ?type . FILTER(?type IN (reg:ExceedanceBreach, reg:ShortfallBreach)) }
      ?cond reg:regulatedProperty ?sub .
      ?sub skos:prefLabel ?subLabel ; skos:notation ?subNotation .
      ?permit reg:hasCondition ?cond ; reg:permitSite ?dp .
      ?dp water:monitoredAt ?sp ; geo:hasGeometry/geo:asWKT ?w .
      ?breach reg:evidencedByObservation ?obs .
      FILTER(STRSTARTS(STR(?obs), STR(?sp)))
    } GROUP BY ?breach ?type ?from ?to ?subLabel ?subNotation ?permit ?cond`,

  dischargePoints: `${PREFIXES}
    SELECT ?dp ?permit (SAMPLE(?w) AS ?wkt) ?sp WHERE {
      ?permit a water:WaterDischargePermit ; reg:permitSite ?dp .
      ?dp geo:hasGeometry/geo:asWKT ?w .
      OPTIONAL { ?dp water:monitoredAt ?sp }
    } GROUP BY ?dp ?permit ?sp`,

  conditions: `${PREFIXES}
    SELECT ?permit ?cond ?subLabel ?subNotation ?upper ?lower ?unitLabel WHERE {
      ?permit a water:WaterDischargePermit ; reg:hasCondition ?cond .
      ?cond reg:regulatedProperty ?sub .
      ?sub skos:prefLabel ?subLabel ; skos:notation ?subNotation .
      OPTIONAL { ?cond reg:hasLimit/reg:upperBound ?ub . ?ub qudt:numericValue ?upper .
                 OPTIONAL { ?ub qudt:unit/skos:prefLabel ?unitLabel } }
      OPTIONAL { ?cond reg:hasLimit/reg:lowerBound/qudt:numericValue ?lower }
    }`,

  limitHistory: `${PREFIXES}
    SELECT ?permit ?subNotation ?version ?from ?to ?upper ?lower WHERE {
      ?permit a water:WaterDischargePermit ; reg:hasCondition ?cond .
      ?cond reg:regulatedProperty ?sub .
      ?sub skos:notation ?subNotation .
      BIND(IRI(REPLACE(STR(?cond), "/condition/.*", "")) AS ?doc)
      BIND(REPLACE(STR(?doc), ".*/version/", "") AS ?version)
      ?doc core:hasApplicability/core:applicabilityPeriod ?p .
      ?p core:applicableFrom ?from .
      OPTIONAL { ?p core:applicableTo ?to }
      OPTIONAL { ?cond reg:hasLimit/reg:upperBound/qudt:numericValue ?upper }
      OPTIONAL { ?cond reg:hasLimit/reg:lowerBound/qudt:numericValue ?lower }
    }`,

  actions: `${PREFIXES}
    SELECT ?action ?label ?desc ?completion ?permit (SAMPLE(?w) AS ?wkt) WHERE {
      ?action a reg:Action ; rdfs:label ?label ; reg:actionSite ?site .
      ?site geo:hasGeometry/geo:asWKT ?w .
      OPTIONAL { ?action dcterms:description ?desc }
      OPTIONAL { ?action reg:targetPermit ?permit }
      OPTIONAL { ?app core:applicabilityPeriod/core:applicableFrom ?completion .
                 FILTER(STRSTARTS(STR(?app), CONCAT(STR(?action), "#"))) }
    } GROUP BY ?action ?label ?desc ?completion ?permit`,

  proposed: `${PREFIXES}
    SELECT ?action ?limit ?subLabel ?subNotation ?val ?unitLabel ?statmod ?stmt ?carried ?continues WHERE {
      ?action reg:proposesLimit ?limit .
      OPTIONAL { ?limit reg:regulatedProperty ?sub . ?sub skos:prefLabel ?subLabel ; skos:notation ?subNotation }
      OPTIONAL { ?limit reg:upperBound ?b . ?b qudt:numericValue ?val .
                 OPTIONAL { ?b qudt:unit/skos:prefLabel ?unitLabel }
                 OPTIONAL { ?b iop:hasStatisticalModifier ?sm . ?sm skos:prefLabel|rdfs:label ?statmod } }
      OPTIONAL { ?limit reg:limitStatement ?stmt }
      OPTIONAL { ?limit a reg:CarriedOverLimit . BIND(true AS ?carried) }
      OPTIONAL { ?limit reg:continuesCondition ?continues }
    }`,

  // Farming: one row per application with its option count and TOTAL annual payment summed live.
  // COALESCE(?c,0): an application's options are OPTIONALly priced, so unpriced options leave ?c
  // unbound — and SUM over a group containing an unbound value yields unbound (not 0). Coalescing to
  // 0 lets the priced options still sum (otherwise any mixed application totals £0).
  applications: `${PREFIXES}
    SELECT ?app ?appId ?scheme (SUM(COALESCE(?c, 0)) AS ?total) (COUNT(DISTINCT ?opt) AS ?n) WHERE {
      ?app a farm:Application ; core:hasPart ?opt .
      OPTIONAL { ?app skos:notation ?appId }
      OPTIONAL { ?app ex:scheme ?scheme }
      OPTIONAL { ?opt farm:annualPayment/qudt:numericValue ?c }
    } GROUP BY ?app ?appId ?scheme`,

  // Canonical broader-group labels (HRW → Hedgerows). Used as a fallback for options whose own
  // concept isn't in the scheme (so it carries no broader link) but whose group code is labelled.
  groupLabels: `${PREFIXES}
    SELECT ?code ?label WHERE {
      ?bc skos:prefLabel ?label .
      FILTER(STRSTARTS(STR(?bc), "http://example.com/sfi/Option/Concept/"))
      BIND(REPLACE(STR(?bc), ".*/Concept/", "") AS ?code)
    }`,

  // Farming: one row per option — its concept definition, broader group (+ label), annual payment
  // and multipoint geometry. Drives the hulls, spiders, option tables and pie.
  sfiOptions: `${PREFIXES}
    SELECT ?app ?opt ?def ?broader ?broaderLabel ?cost (SAMPLE(?w) AS ?wkt) WHERE {
      ?app a farm:Application ; core:hasPart ?opt .
      ?opt geo:hasGeometry/geo:asWKT ?w .
      OPTIONAL { ?opt core:hasClassification ?con .
                 OPTIONAL { ?con skos:definition ?def }
                 OPTIONAL { ?con skos:broader ?broader . OPTIONAL { ?broader skos:prefLabel ?broaderLabel } } }
      OPTIONAL { ?opt farm:annualPayment/qudt:numericValue ?cost }
    } GROUP BY ?app ?opt ?def ?broader ?broaderLabel ?cost`,
};

// ---------------------------------------------------------------------------
// SPARQL helper
// ---------------------------------------------------------------------------
async function sparql(query) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/sparql-query", Accept: "application/sparql-results+json" },
    body: query,
  });
  if (!res.ok) throw new Error(`SPARQL ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.results.bindings.map((row) => {
    const o = {};
    for (const k in row) o[k] = row[k].value;
    return o;
  });
}

// ---------------------------------------------------------------------------
// WKT parsing + reprojection
// ---------------------------------------------------------------------------
function parseWkt(wkt) {
  // Returns { points: [[lat, lon], ...] } in WGS84.
  const bng = wkt.includes("27700");
  const nums = wkt.match(/-?\d+\.?\d*/g);
  if (!nums) return { points: [] };
  const pairs = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    let x = parseFloat(nums[i]), y = parseFloat(nums[i + 1]);
    let lon, lat;
    if (bng) {
      [lon, lat] = proj4("EPSG:27700", "EPSG:4326", [x, y]);
    } else {
      lon = x; lat = y; // WKT/CRS84 order is lon lat
    }
    pairs.push([lat, lon]);
  }
  return { points: pairs };
}

// Centroid of a set of [lat, lon] points (simple mean; the points sit within one small catchment).
function centroidOf(points) {
  if (!points.length) return null;
  let la = 0, lo = 0;
  for (const [a, o] of points) { la += a; lo += o; }
  return [la / points.length, lo / points.length];
}

// Convex hull (Andrew's monotone chain) over [lat, lon] points, treating lon=x, lat=y. Returns the
// hull as an ordered ring of [lat, lon]. Degenerate inputs (<3 unique points) return the unique set.
function convexHull(points) {
  const uniq = [...new Map(points.map((p) => [`${p[0]},${p[1]}`, p])).values()];
  if (uniq.length < 3) return uniq;
  const pts = uniq.map(([lat, lon]) => [lon, lat]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper).map(([lon, lat]) => [lat, lon]);
}

// A polygon ring for an application, ALWAYS with area (never a dot). Uses the convex hull when there
// are ≥3 non-collinear points; otherwise (1–2 distinct or collinear points) a small square around the
// centroid so a single-option application still reads as a polygon.
function hullPolygon(points) {
  const hull = convexHull(points);
  if (hull.length >= 3) return hull;
  const [la, lo] = centroidOf(points);
  const dLat = 0.0006, dLon = 0.0009; // ~65 m; dLon widened for the ~50.7°N latitude compression
  return [[la + dLat, lo - dLon], [la + dLat, lo + dLon], [la - dLat, lo + dLon], [la - dLat, lo - dLon]];
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const last = (iri) => iri.split("/").pop();
const permitRef = (iri) => (iri ? last(iri) : "—");
// version number embedded in a condition/permit-document IRI: .../version/{v}/...
const verOf = (iri) => {
  const m = /\/version\/([^/#]+)/.exec(iri || "");
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : m[1];
};
const spOf = (obsOrSp) => {
  const m = /sampling-point\/([^/]+)/.exec(obsOrSp || "");
  return m ? m[1] : null;
};
const fmtNum = (v) => {
  if (v == null || v === "") return "";
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString("en-GB", { maximumFractionDigits: 4 }) : v;
};
const prettyUnit = (u) =>
  !u ? "" : u.toLowerCase()
        .replace("microgram per litre", "µg/l")
        .replace("milligram per litre", "mg/l")
        .replace("percentage", "%");
const fmtDate = (d) => (d ? d.slice(0, 10) : "");
const fmtGBP = (v) =>
  "£" + Number(v || 0).toLocaleString("en-GB", { maximumFractionDigits: 0 });
// Stable colour per broader group so hulls/spiders/pie agree. Hashes the group code to a hue.
const groupColor = (code) => {
  let h = 0;
  for (const ch of String(code)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 62% 55%)`;
};
const swatch = (c) => `<span class="swatch" style="background:${c}"></span>`;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------------------------------------------------------------------------
// Substance time-series chart (opens to the right of the map)
// ---------------------------------------------------------------------------
const parseResult = (r) => {
  if (r == null) return null;
  const m = /-?\d+\.?\d*/.exec(String(r)); // handles "<0.5", ">10", "1.2"
  return m ? parseFloat(m[0]) : null;
};

// Current + proposed limits for (permit, substance), and the monitored unit.
function chartContext(subNotation, permit) {
  const sub = DB.substances.find((s) => s.notation === subNotation);
  const cond = DB.conditionsCurrent.find((c) => c.permit === permit && c.subNotation === subNotation);
  const proposed = [];
  for (const l of DB.proposed) {
    if (l.subNotation !== subNotation) continue;
    const act = DB.actions.find((a) => a.iri === l.action);
    if (act && act.permit === permit) for (const b of l.bounds) proposed.push(b);
  }
  return {
    label: sub ? sub.label : subNotation,
    unit: (cond && cond.unit) || (proposed[0] && proposed[0].unit) || "",
    upper: cond && cond.upper != null ? Number(cond.upper) : null,
    lower: cond && cond.lower != null ? Number(cond.lower) : null,
    version: DB.currentVersion[permit], // current (latest) version number
    steps: (DB.limitHistory[`${permit}|${subNotation}`] || []), // dated version windows for the step line
    proposed,
  };
}

// The upper/lower limit IN FORCE at time t: the version whose [from, to] window contains t. If t
// falls outside every dated window there was no limit then (before the first version, or in a gap)
// -> null, so the observation is not a miss. Two fallbacks to the current limit: when the permit has
// no dated versions at all, and for times after the last dated window (an undated current version).
function limitAt(steps, t, fbU, fbL) {
  if (!steps.length) return { upper: fbU, lower: fbL };
  for (const s of steps) {
    if (s.from <= t && (s.to == null || t <= s.to)) return { upper: s.upper, lower: s.lower };
  }
  const lastEnd = Math.max(...steps.map((s) => (s.to == null ? Infinity : s.to)));
  if (t > lastEnd) return { upper: fbU, lower: fbL }; // beyond the last dated window
  return { upper: null, lower: null };                // before the first version, or in a gap
}

async function openChart(subNotation, sp, permit) {
  const chart = document.getElementById("chart");
  const ctx = chartContext(subNotation, permit);
  document.getElementById("chart-title").textContent = `${ctx.label} at ${sp}`;
  const body = document.getElementById("chart-body");
  chart.classList.remove("hidden");
  collapseLegend();
  // resize the (now narrower) map and zoom it to the charted sampling point's discharge point
  const target = DB.dischargePoints.find((d) => d.permit === permit && d.sp === sp && d.lat != null)
    || DB.dischargePoints.find((d) => d.permit === permit && d.lat != null);
  document.getElementById("map").scrollIntoView({ behavior: "smooth", block: "start" });
  setTimeout(() => {
    map.invalidateSize();
    if (target) map.setView([target.lat, target.lon], 13);
  }, 80);
  body.innerHTML = `<p class="chart-note">Loading observations…</p>`;
  try {
    const res = await fetch(`/observations?samplingPoint=${encodeURIComponent(sp)}&determinand=${encodeURIComponent(subNotation)}`);
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    const obs = (data.observations || [])
      .map((o) => ({ t: Date.parse(o.time), v: parseResult(o.result) }))
      .filter((o) => Number.isFinite(o.t) && o.v != null)
      .sort((a, b) => a.t - b.t);
    body.innerHTML = renderChart(ctx, obs);
  } catch (err) {
    body.innerHTML = `<p class="chart-note">Could not load observations: ${esc(err.message)}</p>`;
  }
}

function closeChart() {
  document.getElementById("chart").classList.add("hidden");
  expandLegend();
  setTimeout(() => map.invalidateSize(), 60);
}

function renderChart(ctx, obs) {
  if (!obs.length) return `<p class="chart-note">No observations for this substance at this sampling point.</p>`;
  const W = 640, H = 380, m = { l: 52, r: 16, t: 14, b: 38 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b, y0 = m.t + ih;
  const tMin = obs[0].t, tMax = obs[obs.length - 1].t;
  const propVals = ctx.proposed.map((b) => Number(b.val)).filter(Number.isFinite);
  const stepUppers = ctx.steps.map((s) => s.upper).filter(Number.isFinite);
  const yMax = (Math.max(ctx.upper || 0, ...stepUppers, ...obs.map((o) => o.v), ...propVals) || 1) * 1.1;
  const x = (t) => m.l + (iw * (t - tMin)) / (tMax - tMin || 1);
  const y = (v) => m.t + ih - (ih * v) / yMax;
  // miss = value outside the limit that was IN FORCE at that observation's time (per version)
  const missAt = (o) => {
    const { upper, lower } = limitAt(ctx.steps, o.t, ctx.upper, ctx.lower);
    return (upper != null && o.v > upper) || (lower != null && o.v < lower);
  };

  let grid = "";
  for (let i = 0; i <= 5; i++) {
    const val = (yMax * i) / 5, yy = y(val);
    grid += `<line x1="${m.l}" y1="${yy}" x2="${W - m.r}" y2="${yy}" stroke="#2b3a49"/>` +
      `<text x="${m.l - 6}" y="${yy + 3}" fill="#93a4b3" font-size="10" text-anchor="end">${val.toFixed(val < 10 ? 1 : 0)}</text>`;
  }
  const yr1 = new Date(tMin).getFullYear(), yr2 = new Date(tMax).getFullYear();
  const step = Math.max(1, Math.ceil((yr2 - yr1) / 8));
  for (let yr = yr1; yr <= yr2; yr += step) {
    const xx = x(Date.parse(`${yr}-01-01`));
    if (xx < m.l - 1 || xx > W - m.r + 1) continue;
    grid += `<line x1="${xx}" y1="${m.t}" x2="${xx}" y2="${y0}" stroke="#212e3b"/>` +
      `<text x="${xx}" y="${y0 + 14}" fill="#93a4b3" font-size="10" text-anchor="middle">${yr}</text>`;
  }

  // Limit line. If we have dated version windows, draw the limit as a STEP line following the
  // versions (red dashed segment per window, vertical connector at each change); else a flat line.
  let lines = "";
  const hasSteps = ctx.steps.some((s) => s.upper != null || s.lower != null);
  // plain stepped segments (used for the lower bound; no per-segment labels)
  const stepLine = (pick, width) => {
    let svg = "";
    for (const s of ctx.steps) {
      const v = pick(s);
      if (!Number.isFinite(v)) continue;
      const from = Math.max(s.from, tMin), to = Math.min(s.to == null ? tMax : s.to, tMax);
      if (to < tMin || from > tMax) continue;
      const yy = y(v);
      svg += `<line x1="${x(from)}" y1="${yy}" x2="${x(to)}" y2="${yy}" stroke="#e5484d" stroke-width="${width}" stroke-dasharray="6 4"/>`;
    }
    return svg;
  };
  // upper (enforced) step line: each run of consecutive versions at the SAME value is one segment,
  // labelled on the LEFT with its version range (e.g. "v2-v8", or just "v3" for a single version).
  const stepUpperLine = () => {
    let svg = "", run = null;
    const emit = () => {
      if (!run || !run.versions.length) return;
      const first = run.versions[0], last = run.versions[run.versions.length - 1];
      const label = first === last ? `v${first}` : `v${first}-v${last}`;
      svg += `<text x="${run.xLeft + 3}" y="${run.yy - 4}" fill="#e5484d" font-size="10">${esc(label)}</text>`;
    };
    for (const s of ctx.steps) {
      if (!Number.isFinite(s.upper)) continue;
      const from = Math.max(s.from, tMin), to = Math.min(s.to == null ? tMax : s.to, tMax);
      if (to < tMin || from > tMax) continue;
      const yy = y(s.upper);
      svg += `<line x1="${x(from)}" y1="${yy}" x2="${x(to)}" y2="${yy}" stroke="#e5484d" stroke-width="1.75" stroke-dasharray="6 4"/>`;
      if (run && run.upper === s.upper) {
        if (s.version != null) run.versions.push(s.version);         // extend the current run
      } else {
        emit();                                                       // close the previous run
        run = { upper: s.upper, yy, xLeft: x(from), versions: s.version != null ? [s.version] : [] };
      }
    }
    emit();
    return svg;
  };
  if (hasSteps) {
    lines += stepUpperLine() + stepLine((s) => s.lower, 1.5);
    // value + unit on the RIGHT, for the latest (current) enforced limit only
    if (ctx.upper != null)
      lines += `<text x="${W - m.r}" y="${y(ctx.upper) - 4}" fill="#e5484d" font-size="10" text-anchor="end">${fmtNum(ctx.upper)} ${prettyUnit(ctx.unit)}</text>`;
  } else {
    // undated permit: one flat enforced line — version on the left, value + unit on the right
    if (ctx.upper != null) {
      const yy = y(ctx.upper);
      lines += `<line x1="${m.l}" y1="${yy}" x2="${W - m.r}" y2="${yy}" stroke="#e5484d" stroke-width="1.75" stroke-dasharray="6 4"/>`
        + (ctx.version != null ? `<text x="${m.l + 3}" y="${yy - 4}" fill="#e5484d" font-size="10">v${esc(ctx.version)}</text>` : "")
        + `<text x="${W - m.r}" y="${yy - 4}" fill="#e5484d" font-size="10" text-anchor="end">${fmtNum(ctx.upper)} ${prettyUnit(ctx.unit)}</text>`;
    }
    if (ctx.lower != null) {
      const yy = y(ctx.lower);
      lines += `<line x1="${m.l}" y1="${yy}" x2="${W - m.r}" y2="${yy}" stroke="#e5484d" stroke-width="1.5" stroke-dasharray="6 4"/>`;
    }
  }
  const seen = new Set();
  for (const b of ctx.proposed) {
    const v = Number(b.val);
    if (!Number.isFinite(v) || seen.has(v)) continue;
    seen.add(v);
    const yy = y(v);
    // "proposed" on the LEFT of the line; value + unit + method on the RIGHT
    lines += `<line x1="${m.l}" y1="${yy}" x2="${W - m.r}" y2="${yy}" stroke="#a06bff" stroke-width="1.75" stroke-dasharray="6 4"/>`
      + `<text x="${m.l + 3}" y="${yy - 4}" fill="#a06bff" font-size="10">proposed</text>`
      + `<text x="${W - m.r}" y="${yy - 4}" fill="#a06bff" font-size="10" text-anchor="end">${fmtNum(v)} ${prettyUnit(b.unit)}${b.stat ? " (" + esc(b.stat) + ")" : ""}</text>`;
  }

  let pts = "", nMiss = 0;
  for (const o of obs) {
    const px = x(o.t), py = y(o.v);
    if (missAt(o)) {
      nMiss++;
      const s = 3.5;
      pts += `<path d="M${px - s} ${py - s}L${px + s} ${py + s}M${px - s} ${py + s}L${px + s} ${py - s}" stroke="#e5484d" stroke-width="1.7"/>`;
    } else {
      pts += `<circle cx="${px}" cy="${py}" r="3" fill="none" stroke="#3aa0ff" stroke-width="1.5"/>`;
    }
  }
  const legend = `<div class="chart-legend">
    <span class="item" style="color:#e5484d">✕ miss (${nMiss})</span>
    <span class="item" style="color:#3aa0ff">◯ hit (${obs.length - nMiss})</span>
    <span class="item" style="color:#e5484d">– – enforced limit${hasSteps ? " (by version)" : ""}</span>
    ${ctx.proposed.length ? `<span class="item" style="color:#a06bff">– – proposed limit</span>` : ""}
  </div>`;
  return `${legend}<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
    ${grid}
    <text transform="translate(13 ${m.t + ih / 2}) rotate(-90)" fill="#93a4b3" font-size="11" text-anchor="middle">${esc(prettyUnit(ctx.unit) || "value")}</text>
    ${lines}${pts}
    <line x1="${m.l}" y1="${m.t}" x2="${m.l}" y2="${y0}" stroke="#4a5b6b"/>
    <line x1="${m.l}" y1="${y0}" x2="${W - m.r}" y2="${y0}" stroke="#4a5b6b"/>
  </svg><p class="chart-note">${obs.length} observations · live from the EA Water Quality Archive</p>`;
}

// ---------------------------------------------------------------------------
// Farming: application pie chart (cost per intervention, opens to the right of the map)
// ---------------------------------------------------------------------------
// Sum each application's option costs up to the TOP-LEVEL broader group (two hedgerow options add
// into one "Hedgerows" slice), sorted biggest first.
function groupCostsForApp(appIri) {
  const byGroup = {};
  for (const o of DB.optionsByApp[appIri] || []) {
    if (o.cost == null) continue;
    (byGroup[o.broader] ||= { code: o.broader, label: o.broaderLabel, value: 0 }).value += o.cost;
  }
  return Object.values(byGroup).sort((a, b) => b.value - a.value);
}

// Count view: mapped locations (multipoint components) per intervention group — how many places
// each intervention is done. This is the "count" view and the fallback when there are no prices.
function groupCountsForApp(appIri) {
  const byGroup = {};
  for (const o of DB.optionsByApp[appIri] || [])
    (byGroup[o.broader] ||= { code: o.broader, label: o.broaderLabel, count: 0 }).count += o.points.length;
  return Object.values(byGroup).sort((a, b) => b.count - a.count);
}

// Open (and keep open) the chart for a selected application. Priced applications default to the cost
// pie with a Cost/Count toggle; unpriced ones show the count bar chart directly (no prices to show).
function openAppChart(appIri) {
  const app = DB.appById[appIri];
  document.getElementById("chart-title").textContent = `Application ${app ? app.id : last(appIri)}`;
  renderAppChart(appIri);
  document.getElementById("chart").classList.remove("hidden");
  collapseLegend();
  setTimeout(() => map.invalidateSize(), 60);
}

function renderAppChart(appIri) {
  const app = DB.appById[appIri];
  const slices = groupCostsForApp(appIri);
  const total = slices.reduce((s, g) => s + g.value, 0);
  const unpriced = (DB.optionsByApp[appIri] || []).filter((o) => o.cost == null).length;
  const hasPrices = total > 0;
  const mode = hasPrices ? farmChartMode : "count"; // no prices -> force the count view
  const toggle = hasPrices
    ? `<div class="chart-toggle">
         <button class="${mode === "value" ? "on" : ""}" onclick="setFarmChartMode('value')">Cost</button>
         <button class="${mode === "count" ? "on" : ""}" onclick="setFarmChartMode('count')">Count</button>
       </div>`
    : "";
  const body = mode === "value"
    ? renderPie(slices, total, unpriced, app)
    : renderBars(groupCountsForApp(appIri), app, hasPrices, unpriced);
  document.getElementById("chart-body").innerHTML = toggle + body;
}

function setFarmChartMode(m) {
  farmChartMode = m;
  if (selectedApp) renderAppChart(selectedApp);
}
window.setFarmChartMode = setFarmChartMode;

// Count view: a bar per intervention group (categorical x), option count on y.
function renderBars(groups, app, hasPrices, unpriced) {
  if (!groups.length) return `<p class="chart-note">No options for this application.</p>`;
  const W = 340, H = 300, m = { l: 34, r: 12, t: 16, b: 64 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b, y0 = m.t + ih;
  const yMax = Math.max(1, ...groups.map((g) => g.count));
  const bw = iw / groups.length;
  const y = (v) => m.t + ih - (ih * v) / yMax;
  let grid = "";
  const ticks = Math.min(yMax, 5);
  for (let i = 0; i <= ticks; i++) {
    const v = Math.round((yMax * i) / ticks), yy = y(v);
    grid += `<line x1="${m.l}" y1="${yy}" x2="${W - m.r}" y2="${yy}" stroke="#2b3a49"/>` +
      `<text x="${m.l - 5}" y="${yy + 3}" fill="#93a4b3" font-size="10" text-anchor="end">${v}</text>`;
  }
  let bars = "";
  groups.forEach((g, i) => {
    const x0 = m.l + i * bw + bw * 0.16, w = bw * 0.68, yy = y(g.count);
    bars += `<rect x="${x0}" y="${yy}" width="${w}" height="${y0 - yy}" fill="${groupColor(g.code)}" rx="2"><title>${esc(g.label)} — ${g.count}</title></rect>` +
      `<text x="${x0 + w / 2}" y="${yy - 4}" fill="#e8eef4" font-size="10" text-anchor="middle">${g.count}</text>` +
      `<text transform="translate(${x0 + w / 2} ${y0 + 9}) rotate(35)" fill="#93a4b3" font-size="9.5" text-anchor="start">${esc(g.code)}</text>`;
  });
  const note = hasPrices
    ? "count of intervention locations"
    : `SFI 2023 — rates unavailable; showing intervention locations (${unpriced} options unpriced)`;
  const legend = groups.map((g) =>
    `<div class="pie-leg"><span class="dot" style="background:${groupColor(g.code)}"></span>` +
    `<span class="pie-name">${esc(g.label)} <span class="mono">${esc(g.code)}</span></span>` +
    `<span class="pie-val">${g.count}</span></div>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="bars" preserveAspectRatio="xMidYMid meet">${grid}${bars}
    <line x1="${m.l}" y1="${m.t}" x2="${m.l}" y2="${y0}" stroke="#4a5b6b"/>
    <line x1="${m.l}" y1="${y0}" x2="${W - m.r}" y2="${y0}" stroke="#4a5b6b"/>
    <text transform="translate(11 ${m.t + ih / 2}) rotate(-90)" fill="#93a4b3" font-size="10" text-anchor="middle">locations</text>
  </svg>
  <p class="chart-note">${note}</p>
  <div class="pie-legend">${legend}</div>`;
}

function renderPie(slices, total, unpriced, app) {
  if (!slices.length || total <= 0) {
    const prog = app ? progOf(app) : null;
    const why = prog && !prog.priced
      ? `this is an <b>${esc(prog.label)}</b> agreement — SFI 2023 option rates are not published in our source`
      : `these options have no published per-unit rate in our source`;
    return `<p class="chart-note">No priced options — ${why}. ${unpriced} option${unpriced === 1 ? "" : "s"} unpriced.</p>`;
  }
  const S = 320, R = 132, cx = S / 2, cy = S / 2;
  const pt = (a) => [cx + R * Math.cos(a), cy + R * Math.sin(a)];
  let a0 = -Math.PI / 2, paths = "";
  for (const g of slices) {
    const a1 = a0 + (g.value / total) * 2 * Math.PI;
    const [x0, y0] = pt(a0), [x1, y1] = pt(a1);
    const large = a1 - a0 > Math.PI ? 1 : 0;
    // full-circle guard (a lone slice) — draw as a circle, an arc back to the same point is a no-op
    paths += slices.length === 1
      ? `<circle cx="${cx}" cy="${cy}" r="${R}" fill="${groupColor(g.code)}"/>`
      : `<path d="M${cx} ${cy} L${x0.toFixed(1)} ${y0.toFixed(1)} A${R} ${R} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)} Z" fill="${groupColor(g.code)}" stroke="#0b1016" stroke-width="1"><title>${esc(g.label)} — ${fmtGBP(g.value)}</title></path>`;
    a0 = a1;
  }
  const legend = slices.map((g) =>
    `<div class="pie-leg"><span class="dot" style="background:${groupColor(g.code)}"></span>` +
    `<span class="pie-name">${esc(g.label)} <span class="mono">${esc(g.code)}</span></span>` +
    `<span class="pie-val">${fmtGBP(g.value)} · ${Math.round((g.value / total) * 100)}%</span></div>`).join("");
  return `<svg viewBox="0 0 ${S} ${S}" class="pie" preserveAspectRatio="xMidYMid meet">${paths}
    <circle cx="${cx}" cy="${cy}" r="58" fill="#0b1016"/>
    <text x="${cx}" y="${cy - 3}" text-anchor="middle" fill="#e8eef4" font-size="22" font-weight="600">${fmtGBP(total)}</text>
    <text x="${cx}" y="${cy + 17}" text-anchor="middle" fill="#93a4b3" font-size="12">per annum</text>
  </svg>
  <p class="chart-note">${fmtGBP(total)} per annum · cost per intervention${unpriced ? ` · <b>${unpriced}</b> option${unpriced === 1 ? "" : "s"} unpriced` : ""}</p>
  <div class="pie-legend">${legend}</div>`;
}

// Select (toggle) an application: redraw the map emphasis + spider + tables, and open its pie.
function selectApp(iri) {
  selectedApp = selectedApp === iri ? null : iri;
  farmChartMode = "value"; // each new selection defaults to the cost view (falls back to count if unpriced)
  render();
}
window.selectApp = selectApp;

// Reset the farming focus back to the filter-driven view (no application selected). Overlapping
// hulls make deselecting-by-clicking painful, so this is the one-shot escape hatch — wired to the
// chart's ✕, the Escape key, clicking empty map, and a "clear selection" link in the table header.
function clearAppFocus() {
  if (!selectedApp) return;
  selectedApp = null;
  render();
}

// clickable substance name that opens the chart (needs a sampling point)
const subLink = (label, subNotation, sp, permit) =>
  sp ? `<span class="sub-link" onclick="openChart('${subNotation}','${esc(sp)}','${permit}')">${esc(label)}</span>` : esc(label);
window.openChart = openChart;

// clickable permit id that zooms the map to that permit's discharge point(s)
const permitLink = (iri) =>
  `<span class="mono sub-link" onclick="event.stopPropagation();zoomPermit('${iri}')">${permitRef(iri)}</span>`;
// sampling point that links OUT to the Water Quality Explorer (external: solid underline + ↗)
const wqeLink = (sp) =>
  sp ? `<a class="ext-link" href="${WQE}${esc(sp)}" target="_blank" rel="noopener">${esc(sp)} ↗</a>` : "—";

const permitMarkers = {}; // permit IRI -> [marker] for the current render, for zoom-to-permit
const actionMarkers = {}; // WINEP action IRI -> marker (current render), for table<->map focus
// Farming overlap disambiguation: applications overlap heavily, so we keep each drawn polygon and
// its ring to (a) list ALL applications under the cursor on hover, and (b) pick one from a popup.
const appShapes = {}; // app IRI -> polygon layer (current render)
const appRings = {};  // app IRI -> hull ring [[lat,lon],...] for point-in-polygon tests
let overlapTip = null, tipHideTimer = null, pickerOpen = false;
function zoomPermit(permit) {
  const dps = DB.dischargePoints.filter((d) => d.permit === permit && d.lat != null);
  if (!dps.length) return;
  const lls = dps.map((d) => [d.lat, d.lon]);
  if (lls.length === 1) map.setView(lls[0], 14);
  else map.fitBounds(L.latLngBounds(lls).pad(0.3), { maxZoom: 14 });
  const mk = (permitMarkers[permit] || [])[0];
  document.getElementById("map").scrollIntoView({ behavior: "smooth", block: "start" });
  if (mk) setTimeout(() => mk.openPopup(), 350);
}
window.zoomPermit = zoomPermit;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const DB = {};       // raw + derived caches
let map, base, catchmentLayer;
const layers = {};   // name -> L.LayerGroup / MarkerClusterGroup
const DES = {};      // designation key -> { label, full, color, sites: Map(name -> {layer, on}) }
let currentView = "breaches";
let currentSubstance = ""; // notation or ""
let currentOptionType = ""; // farming: broader option-group code filter, or ""
let selectedApp = null;    // farming: selected application IRI (or null)
let selectedAction = null; // WINEP: focused action IRI (or null) — links the table row and map marker
let farmChartMode = "value"; // farming chart: "value" (cost pie) | "count" (bar)

// Focus a WINEP action, keeping the table row and its map marker in sync (the dashed-underlined
// action id in the table and the marker both call this). fromMap=true means the click came from the
// marker, so we bring the table row into view; otherwise we pan the map to the marker + open it.
function focusAction(iri, fromMap) {
  selectedAction = iri;
  document.querySelectorAll("#tables tr.action-row").forEach((tr) => tr.classList.toggle("sel", tr.dataset.action === iri));
  for (const k in actionMarkers) styleActionMarker(actionMarkers[k], k === iri);
  const mk = actionMarkers[iri];
  if (fromMap) {
    const tr = [...document.querySelectorAll("#tables tr.action-row")].find((t) => t.dataset.action === iri);
    if (tr) tr.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } else if (mk) {
    map.panTo(mk.getLatLng());
    mk.openPopup();
  }
}
function styleActionMarker(mk, on) {
  mk.setStyle({ color: "#0b1016", weight: 1.5, fillColor: on ? "#c9aaff" : "#a06bff", fillOpacity: on ? 1 : 0.85 });
  mk.setRadius(on ? 9 : 7);
  if (on) mk.bringToFront();
}

// ---------------------------------------------------------------------------
// Load everything once
// ---------------------------------------------------------------------------
async function loadAll() {
  const [substances, breaches, dps, conditions, actions, proposed, applications, groupLabels, sfiOptions, limitHistory] =
    await Promise.all([
      sparql(Q.substances), sparql(Q.breaches), sparql(Q.dischargePoints),
      sparql(Q.conditions), sparql(Q.actions), sparql(Q.proposed),
      sparql(Q.applications), sparql(Q.groupLabels), sparql(Q.sfiOptions), sparql(Q.limitHistory),
    ]);

  // Canonical broader-group label map (code -> label), for the option-type fallback below.
  DB.groupLabels = {};
  for (const r of groupLabels) DB.groupLabels[r.code] = r.label;

  // Dated limit history per (permit, substance): each permit version's bound(s) over its
  // effective window [from, to] (from the public register). Powers the chart's stepped limit line.
  DB.limitHistory = {};
  for (const r of limitHistory) {
    const key = `${r.permit}|${r.subNotation}`;
    (DB.limitHistory[key] ||= []).push({
      version: r.version, from: Date.parse(r.from), to: r.to ? Date.parse(r.to) : null,
      upper: r.upper != null ? Number(r.upper) : null,
      lower: r.lower != null ? Number(r.lower) : null,
    });
  }
  for (const k in DB.limitHistory) DB.limitHistory[k].sort((a, b) => a.from - b.from);

  // Breaches are periods. current = the period is still open (no applicableTo) i.e. nothing has
  // passed since it started; past = closed with a from/to. A lone failure has from == to.
  DB.breaches = breaches.map((b) => {
    const p = parseWkt(b.wkt).points[0] || null;
    return {
      iri: b.breach, from: b.from, to: b.to || null, current: !b.to,
      subLabel: b.subLabel, subNotation: b.subNotation, permit: b.permit,
      version: verOf(b.cond), // the permit version whose limit was breached
      sp: spOf(b.sp), type: b.type ? last(b.type) : "ConditionBreach",
      lat: p ? p[0] : null, lon: p ? p[1] : null,
    };
  });

  // Discharge points
  DB.dischargePoints = dps.map((d) => {
    const p = parseWkt(d.wkt).points[0] || null;
    return { iri: d.dp, permit: d.permit, sp: spOf(d.sp), lat: p ? p[0] : null, lon: p ? p[1] : null };
  });

  // Conditions grouped per (permit, condition). Each condition belongs to a permit VERSION;
  // a permit's in-force limits are those of its latest (max) version, so mark current vs superseded.
  const condMap = {};
  for (const c of conditions) {
    const key = c.cond;
    (condMap[key] ||= {
      permit: c.permit, cond: c.cond, version: verOf(c.cond),
      subLabel: c.subLabel, subNotation: c.subNotation, upper: null, lower: null, unit: null,
    });
    if (c.upper != null) condMap[key].upper = c.upper;
    if (c.lower != null) condMap[key].lower = c.lower;
    if (c.unitLabel) condMap[key].unit = c.unitLabel;
  }
  DB.conditions = Object.values(condMap);
  DB.currentVersion = {};
  for (const c of DB.conditions)
    DB.currentVersion[c.permit] = Math.max(DB.currentVersion[c.permit] ?? -Infinity, Number(c.version) || 0);
  for (const c of DB.conditions) c.current = Number(c.version) === DB.currentVersion[c.permit];
  DB.conditionsCurrent = DB.conditions.filter((c) => c.current);

  DB.actions = actions.map((a) => {
    const p = parseWkt(a.wkt).points[0] || null;
    return {
      iri: a.action, id: last(a.action), label: a.label, desc: a.desc || "",
      completion: a.completion || "", permit: a.permit || null,
      // Delivering party. All current WINEP actions are Wessex Water (the "WW" in the action id);
      // default it here until the data carries an explicit operator for multi-company actions.
      party: a.party || "Wessex Water",
      lat: p ? p[0] : null, lon: p ? p[1] : null,
    };
  });

  // Proposed limits grouped per limit (a limit may have several bounds/tiers)
  const limMap = {};
  for (const r of proposed) {
    const key = r.limit;
    const l = (limMap[key] ||= {
      limit: r.limit, action: r.action, subLabel: r.subLabel || "", subNotation: r.subNotation || "",
      bounds: [], stmt: r.stmt || "", carried: r.carried === "true", continues: r.continues || null,
    });
    if (r.val != null) l.bounds.push({ val: r.val, unit: r.unitLabel || "", stat: r.statmod || "" });
    if (r.stmt) l.stmt = r.stmt;
    if (r.carried === "true") l.carried = true;
    if (r.continues) l.continues = r.continues;
  }
  DB.proposed = Object.values(limMap);

  // Farming applications: id, option count, total annual payment (£). Keyed by IRI for selection.
  DB.applications = applications.map((a) => ({
    iri: a.app, id: a.appId || last(a.app), scheme: a.scheme || "—",
    total: a.total != null ? Number(a.total) : 0,
    n: a.n != null ? Number(a.n) : 0,
  })).sort((a, b) => b.total - a.total);
  DB.appById = {};
  for (const a of DB.applications) DB.appById[a.iri] = a;

  // Farming options: keep ALL multipoint components (for the spider legs) + the concept meaning.
  DB.sfiOptions = sfiOptions.map((o) => {
    const points = parseWkt(o.wkt).points;                  // [[lat,lon], ...] in WGS84
    const code = (/\/([A-Za-z0-9]+)$/.exec(o.opt) || [])[1] || "";
    const broaderCode = o.broader ? last(o.broader) : (code.match(/[A-Za-z]+/) || [""])[0].replace(/^C/, "");
    return {
      app: o.app, iri: o.opt, code, def: o.def || "",
      broader: broaderCode, broaderLabel: o.broaderLabel || DB.groupLabels[broaderCode] || broaderCode,
      cost: o.cost != null ? Number(o.cost) : null,
      points, centroid: centroidOf(points),
    };
  }).filter((o) => o.points.length);
  DB.optionsByApp = groupBy(DB.sfiOptions, "app");
  // How many of each application's options have no published rate (superseded SFI 2023 codes).
  for (const a of DB.applications) {
    const opts = DB.optionsByApp[a.iri] || [];
    a.unpriced = opts.filter((o) => o.cost == null).length;
    a.priced = opts.length - a.unpriced;
  }

  // Substance dropdown (Water super-box)
  DB.substances = substances;
  const sel = document.getElementById("substance");
  sel.innerHTML =
    `<option value="">All substances</option>` +
    substances.map((s) => `<option value="${s.notation}">${esc(s.label)} (${s.notation})</option>`).join("");

  // Option-type dropdown (Land super-box): the distinct broader intervention groups.
  DB.optionTypes = {};
  for (const o of DB.sfiOptions) DB.optionTypes[o.broader] = o.broaderLabel;
  const typeSel = document.getElementById("optionType");
  typeSel.innerHTML =
    `<option value="">All option types</option>` +
    Object.entries(DB.optionTypes).sort((a, b) => a[1].localeCompare(b[1]))
      .map(([code, label]) => `<option value="${esc(code)}">${esc(label)} (${esc(code)})</option>`).join("");
}

// ---------------------------------------------------------------------------
// Map setup
// ---------------------------------------------------------------------------
function initMap() {
  map = L.map("map", { zoomControl: true }).setView(CENTER, 11);
  base = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap contributors", maxZoom: 18,
  }).addTo(map);

  // Base-map style toggle: full colour vs a desaturated (greyscale) version, so the coloured markers
  // and shaded designation polygons on top read more clearly. It is a CSS filter on the tile
  // container only — the vector overlays live in other panes, so they keep their colour.
  const savedBasemap = (() => { try { return localStorage.getItem("basemap"); } catch (e) { return null; } })() || "colour";
  setBasemap(savedBasemap);
  const BasemapControl = L.Control.extend({
    options: { position: "topright" },
    onAdd() {
      const div = L.DomUtil.create("div", "basemap-control");
      div.innerHTML =
        `<button type="button" data-bm="colour" title="Full-colour base map">Colour</button>` +
        `<button type="button" data-bm="desaturated" title="Desaturated base map — makes overlays stand out">Desaturated</button>`;
      div.querySelectorAll("button").forEach((b) => {
        b.classList.toggle("on", b.dataset.bm === savedBasemap);
        b.addEventListener("click", () => {
          div.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
          setBasemap(b.dataset.bm);
        });
      });
      L.DomEvent.disableClickPropagation(div);
      return div;
    },
  });
  map.addControl(new BasemapControl());

  // A pane for the conservation underlays: above the tiles, below every vector/marker (overlayPane
  // is 400, markerPane 600), and non-interactive so it never intercepts clicks on the data above it.
  map.createPane("designations");
  map.getPane("designations").style.zIndex = 250;
  map.getPane("designations").style.pointerEvents = "none";

  fetch("catchment.geojson").then((r) => r.json()).then((gj) => {
    catchmentLayer = L.geoJSON(gj, {
      style: { color: "#5aa9ff", weight: 1.5, fillColor: "#3aa0ff", fillOpacity: 0.06 },
    }).addTo(map);
  }).catch(() => {});

  layers.breachCurrent = L.layerGroup();
  layers.breachPast = L.layerGroup();
  layers.dischargePoints = L.layerGroup();
  layers.actions = L.layerGroup();
  layers.sfi = L.markerClusterGroup({ chunkedLoading: true, maxClusterRadius: 45 });
  layers.appHulls = L.layerGroup();
  layers.spider = L.layerGroup();

  // While the application picker popup is open, suppress the hover tooltip; restore polygon fills
  // when it closes.
  map.on("popupopen", (e) => { if (e.popup.options.className === "picker-popup") { pickerOpen = true; hideOverlapTip(); } });
  map.on("popupclose", (e) => { if (e.popup.options.className === "picker-popup") { pickerOpen = false; restoreAllShapes(); } });

  // Click on empty map (no application polygon under the cursor) resets the farming focus — the
  // intuitive "click away to deselect". Clicks on a hull hit containingApps() and open the picker
  // instead, so this only fires on genuine background clicks.
  map.on("click", (e) => {
    if (currentView === "farming" && selectedApp && !containingApps(e.latlng).length) clearAppFocus();
  });
}

// Toggle the base-map tiles between full colour and desaturated (greyscale). The filter is applied
// to the tile layer's container, so only the basemap is affected, not the vector overlays.
function setBasemap(mode) {
  const container = base && base.getContainer();
  if (container) container.classList.toggle("basemap-desaturated", mode === "desaturated");
  try { localStorage.setItem("basemap", mode); } catch (e) {}
}

function dot(color, r = 7, opacity = 0.9) {
  return { radius: r, color: "#0b1016", weight: 1.5, fillColor: color, fillOpacity: opacity };
}
function circle(lat, lon, style, popupHtml) {
  const m = L.circleMarker([lat, lon], style);
  if (popupHtml) m.bindPopup(popupHtml);
  return m;
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------
const matchSub = (n) => !currentSubstance || n === currentSubstance;

// ---------------------------------------------------------------------------
// View rendering
// ---------------------------------------------------------------------------
const LEDE = {
  breaches: (n, cur) => `<b>${n} condition breaches</b> — each a run of failing observations with no passing result in between. <b>${cur} current</b> (open: nothing has passed since the breach began); the rest are <b>past</b> (closed, with a start and end). Click a marker to open the sampling point in the Water Quality Explorer.`,
  substance: (n, lbl) => `Solving for <b>${esc(lbl)}</b>: <b>${n.limits} current permit limits</b> in force and <b>${n.works} improvement actions</b> proposing future limits across the catchment.`,
  wessex: (n) => `<b>Wessex Water</b> has <b>${n} WINEP actions</b> in this catchment — investments with a completion date and the new (or continued) permit limits they will bring.`,
};

function clearLayers() {
  Object.values(layers).forEach((l) => map.removeLayer(l));
  layers.breachCurrent.clearLayers();
  layers.breachPast.clearLayers();
  layers.dischargePoints.clearLayers();
  layers.actions.clearLayers();
  layers.sfi.clearLayers();
  layers.appHulls.clearLayers();
  layers.spider.clearLayers();
}

function setLegend(items) {
  document.getElementById("legend-key").innerHTML = items
    .map((i) => `<span class="item"><span class="dot" style="background:${i.c}"></span>${i.t}</span>`)
    .join("");
}

// ---------------------------------------------------------------------------
// Conservation-designation underlays + their legend control
// ---------------------------------------------------------------------------
async function loadDesignations() {
  for (const d of DESIGNATIONS) {
    let gj;
    try {
      const res = await fetch(d.file);
      if (!res.ok) continue;
      gj = await res.json();
    } catch { continue; }
    const sites = new Map();
    for (const f of (gj.features || [])) {
      const name = (f.properties && f.properties.name) || "Unnamed";
      const layer = L.geoJSON(f, {
        pane: "designations", interactive: false,
        style: { color: d.color, weight: 1, fillColor: d.color, fillOpacity: 0.22 },
      });
      sites.set(name, { layer, on: false });
    }
    DES[d.key] = { label: d.label, full: d.full, color: d.color, sites };
  }
  buildDesignationLegend();
}

function setSite(key, name, on) {
  const site = DES[key] && DES[key].sites.get(name);
  if (!site || site.on === on) return;
  site.on = on;
  if (on) site.layer.addTo(map); else map.removeLayer(site.layer);
}
function setCategory(key, on) {
  for (const name of DES[key].sites.keys()) setSite(key, name, on);
  syncCategory(key);
}
// Reflect the current on/off state into a category's checkboxes (tri-state header + each site).
function syncCategory(key) {
  const el = document.querySelector(`.desig-cat[data-cat="${key}"]`);
  if (!el) return;
  const sites = DES[key].sites;
  const on = [...sites.values()].filter((s) => s.on).length;
  const head = el.querySelector(".cat-all");
  head.checked = sites.size > 0 && on === sites.size;
  head.indeterminate = on > 0 && on < sites.size;
  el.querySelectorAll(".desig-site input").forEach((cb) => {
    cb.checked = !!(sites.get(cb.dataset.name) || {}).on;
  });
}

function buildDesignationLegend() {
  const host = document.getElementById("legend-desig");
  if (!Object.keys(DES).length) return;
  host.innerHTML = `<span class="desig-title">Designations</span>` +
    DESIGNATIONS.filter((d) => DES[d.key]).map((d) => {
      const names = [...DES[d.key].sites.keys()].sort((a, b) => a.localeCompare(b));
      const list = names.map((n) =>
        `<label class="desig-site"><input type="checkbox" data-name="${esc(n)}"><span>${esc(n)}</span></label>`).join("");
      return `<div class="desig-cat" data-cat="${d.key}">
        <div class="desig-head">
          <span class="caret">▸</span>
          <input type="checkbox" class="cat-all" title="Show all ${esc(d.label)}">
          <span class="swatch" style="background:${d.color}"></span>
          <span class="desig-lbl" title="${esc(d.full)}">${esc(d.label)}</span>
          <span class="desig-count">${names.length}</span>
        </div>
        <div class="desig-list hidden">${list}</div>
      </div>`;
    }).join("");

  host.addEventListener("click", (e) => {
    const head = e.target.closest(".desig-head");
    if (head && !e.target.matches("input")) {           // toggle the site list (not on the checkbox)
      const cat = head.closest(".desig-cat");
      cat.classList.toggle("open");
      cat.querySelector(".desig-list").classList.toggle("hidden");
    }
  });
  host.addEventListener("change", (e) => {
    const cat = e.target.closest(".desig-cat");
    if (!cat) return;
    const key = cat.dataset.cat;
    if (e.target.classList.contains("cat-all")) setCategory(key, e.target.checked);
    else if (e.target.matches(".desig-site input")) { setSite(key, e.target.dataset.name, e.target.checked); syncCategory(key); }
  });
}

const collapseLegend = () => document.getElementById("legend").classList.add("collapsed");
const expandLegend = () => document.getElementById("legend").classList.remove("collapsed");

function breachPeriod(b) {
  if (b.current) return `since ${fmtDate(b.from)} (ongoing)`;
  if (b.from === b.to) return `${fmtDate(b.from)} (single observation)`;
  return `${fmtDate(b.from)} → ${fmtDate(b.to)}`;
}
// Format a condition's bound(s) as "≤ X ≥ Y unit".
function limitRange(c) {
  const parts = [];
  if (c.upper != null) parts.push("≤ " + fmtNum(c.upper));
  if (c.lower != null) parts.push("≥ " + fmtNum(c.lower));
  return (parts.join(" ") || "—") + (c.unit ? " " + prettyUnit(c.unit) : "");
}
// One unified popup per discharge point: identity + WQE link, its breaches (current/past), and
// the in-force (current-version) limits. Shown whether or not the point has any breaches.
function dischargePopup(dp, currentConds, cur, past) {
  const wqe = wqeLink(dp.sp);
  let breaches = "";
  if (cur.length || past.length) {
    const line = (b) => `${esc(b.subLabel)} — ${breachPeriod(b)}`;
    breaches = `<hr><div class="kv"><b>Breaches</b><br>
      <b>Current:</b> ${cur.length ? cur.map(line).join("<br>") : "none"}<br>
      <b>Past:</b> ${past.length ? past.map(line).join("<br>") : "none"}</div>`;
  }
  const limits = currentConds.length
    ? currentConds.slice().sort((a, b) => a.subLabel.localeCompare(b.subLabel))
        .map((c) => `${subLink(c.subLabel, c.subNotation, dp.sp, dp.permit)}: ${limitRange(c)}`).join("<br>")
    : "—";
  return `<h3>Discharge point</h3>
    <div class="kv"><b>Permit:</b> ${permitRef(dp.permit)}<br>
    <b>Monitored at:</b> ${wqe}</div>
    ${breaches}
    <hr><div class="kv"><b>Current limits</b> <span style="color:#777">(v${DB.currentVersion[dp.permit] ?? "?"})</span><br>${limits}</div>`;
}
function actionPopup(a, limits) {
  const l = limits.map((x) => `${esc(x.subLabel || "—")}: ${limitText(x)}`).join("<br>");
  return `<h3>${esc(a.label)}</h3><div class="kv"><b>Action:</b> ${esc(a.id)}<br>
    <b>Completion:</b> ${fmtDate(a.completion) || "TBC"}<br>
    <b>Target permit:</b> ${permitRef(a.permit)}</div>
    ${a.desc ? `<p>${esc(a.desc)}</p>` : ""}${l ? `<hr><div class="kv"><b>Proposed limits</b><br>${l}</div>` : ""}`;
}

function limitText(l) {
  if (l.carried || (l.continues && !l.bounds.length)) return "Continued (no change)";
  if (l.bounds.length)
    return l.bounds.map((b) => `${fmtNum(b.val)} ${prettyUnit(b.unit)}${b.stat ? " (" + esc(b.stat) + ")" : ""}`).join("; ");
  if (l.stmt) return esc(l.stmt);
  return "—";
}

// Flatten an action's limits into individual display lines — one per bound/tier — so a multi-tier
// limit (e.g. Iron: 8 mg/l Maximum + 4 mg/l 95th percentile) reads on separate rows rather than
// being ";"-joined into one cell, and the Limits count matches the number of rows shown.
function limitLines(limits) {
  const lines = [];
  for (const l of limits) {
    const base = { subLabel: l.subLabel, subNotation: l.subNotation };
    if (l.carried || (l.continues && !l.bounds.length)) lines.push({ ...base, text: "Continued (no change)", carried: true });
    else if (l.bounds.length)
      for (const b of l.bounds)
        lines.push({ ...base, text: `${fmtNum(b.val)} ${prettyUnit(b.unit)}${b.stat ? " (" + esc(b.stat) + ")" : ""}` });
    else lines.push({ ...base, text: l.stmt ? esc(l.stmt) : "—" });
  }
  return lines;
}

// The permit's current in-force limit for a substance, as text — for showing alongside the proposed
// limit. Returns null when the substance isn't currently regulated on that permit (i.e. a new limit).
function currentLimitFor(permit, subNotation) {
  const c = DB.conditionsCurrent.find((x) => x.permit === permit && x.subNotation === subNotation);
  if (!c) return null;
  const u = prettyUnit(c.unit);
  const parts = [];
  if (c.upper != null && c.upper !== "") parts.push(`≤ ${fmtNum(c.upper)}`);
  if (c.lower != null && c.lower !== "") parts.push(`≥ ${fmtNum(c.lower)}`);
  return parts.length ? parts.join(" ") + (u ? " " + u : "") : null;
}

const drawnBounds = [];

function render() {
  clearLayers();
  drawnBounds.length = 0;
  for (const k in permitMarkers) delete permitMarkers[k];
  const sub = DB.substances.find((s) => s.notation === currentSubstance);
  const subLbl = sub ? sub.label : "all substances";
  const tables = document.getElementById("tables");
  tables.innerHTML = "";
  if (currentView === "farming") { renderFarming(tables); return; }

  // Data slices with substance filter applied where relevant. "Current limits" are the latest
  // permit version's conditions only; the full history stays available for the expandable views.
  const breaches = DB.breaches.filter((b) => matchSub(b.subNotation));
  const conditions = DB.conditionsCurrent.filter((c) => matchSub(c.subNotation));
  const proposedForSub = DB.proposed.filter((l) => matchSub(l.subNotation));
  const condByPermit = groupBy(DB.conditionsCurrent, "permit"); // current limits per permit
  const condHistByPermit = groupBy(DB.conditions, "permit");    // all versions per permit
  const breachesByPermit = groupBy(DB.breaches, "permit");
  // breaches grouped by the discharge point they occurred at (permit + monitored sampling point)
  const breachAtDp = {};
  for (const b of DB.breaches) (breachAtDp[`${b.permit}|${b.sp}`] ||= []).push(b);
  const dpByPermit = groupBy(DB.dischargePoints, "permit");
  const limByAction = groupBy(DB.proposed, "action");
  // (permit|version|substance) tuples that were actually breached, to flag them in the history
  const breachedKey = new Set(DB.breaches.map((b) => `${b.permit}|${b.version}|${b.subNotation}`));

  // Which permits/actions are relevant to the substance
  const permitsWithSub = new Set(conditions.map((c) => c.permit));
  const actionIdsWithSub = new Set(proposedForSub.map((l) => l.action));

  const show = { breach: false, discharge: false, action: false, sfi: false };

  if (currentView === "breaches") {
    show.breach = show.discharge = true;
    setLegend([{ c: "#e5484d", t: "Discharge point — current breach" }, { c: "#f5a623", t: "past breach" }, { c: "#3aa0ff", t: "no breach" }]);
    document.getElementById("lede").innerHTML = LEDE.breaches(breaches.length, breaches.filter((b) => b.current).length);
    tables.append(breachTable(breaches), permitTable(conditions, dpByPermit, condByPermit, condHistByPermit, breachedKey, breachesByPermit));
  } else if (currentView === "substance") {
    show.breach = show.discharge = show.action = true;
    setLegend([{ c: "#3aa0ff", t: "Current limit (no breach)" }, { c: "#e5484d", t: "current breach" }, { c: "#f5a623", t: "past breach" }, { c: "#a06bff", t: "Future works (action)" }]);
    const limitCount = conditions.length, workCount = actionIdsWithSub.size;
    document.getElementById("lede").innerHTML = LEDE.substance({ limits: limitCount, works: workCount }, subLbl);
    tables.append(
      substanceStoryTable(conditions, proposedForSub, dpByPermit),
      breachTable(breaches),
    );
  } else if (currentView === "wessex") {
    show.action = true;
    setLegend([{ c: "#a06bff", t: "Wessex Water action site" }]);
    document.getElementById("lede").innerHTML = LEDE.wessex(DB.actions.length);
    tables.append(actionTable(DB.actions, limByAction));
  }

  // Draw layers. Breaches live AT their discharge point, so a discharge point is a single marker
  // coloured by its worst breach status; its popup carries permit + WQE + breaches + current limits.
  if (show.discharge) {
    const order = { none: 0, past: 1, current: 2 }; // draw current breaches on top
    const items = DB.dischargePoints
      .filter((dp) => dp.lat != null)
      .map((dp) => {
        const allConds = condByPermit[dp.permit] || [];              // all current limits (unfiltered)
        const allBr = breachAtDp[`${dp.permit}|${dp.sp}`] || [];      // all breaches here (unfiltered)
        const fConds = allConds.filter((c) => matchSub(c.subNotation));
        const fBr = allBr.filter((b) => matchSub(b.subNotation));
        const status = fBr.some((b) => b.current) ? "current" : fBr.length ? "past" : "none";
        return { dp, allConds, allBr, fConds, fBr, status };
      })
      // in a substance view, only show discharge points relevant to the substance
      .filter((x) => !currentSubstance || x.fConds.length || x.fBr.length)
      .sort((a, b) => order[a.status] - order[b.status]);
    for (const x of items) {
      const col = x.status === "current" ? "#e5484d" : x.status === "past" ? "#f5a623" : "#3aa0ff";
      const r = x.status === "current" ? 8 : x.status === "past" ? 7 : 6;
      const cur = x.allBr.filter((b) => b.current);
      const past = x.allBr.filter((b) => !b.current);
      const mk = circle(x.dp.lat, x.dp.lon, dot(col, r, 0.9), dischargePopup(x.dp, x.allConds, cur, past));
      mk.addTo(layers.dischargePoints);
      (permitMarkers[x.dp.permit] ||= []).push(mk);
      drawnBounds.push([x.dp.lat, x.dp.lon]);
    }
    layers.dischargePoints.addTo(map);
  }
  if (show.action) {
    const winep = currentView === "wessex"; // only the WINEP table has rows to focus/sync with
    for (const k in actionMarkers) delete actionMarkers[k];
    for (const a of DB.actions) {
      if (a.lat == null) continue;
      if (currentView === "substance" && currentSubstance && !actionIdsWithSub.has(a.iri)) continue;
      const on = a.iri === selectedAction;
      const mk = circle(a.lat, a.lon, dot(on ? "#c9aaff" : "#a06bff", on ? 9 : 7, on ? 1 : 0.85), actionPopup(a, limByAction[a.iri] || []));
      if (winep) { mk.on("click", () => focusAction(a.iri, true)); actionMarkers[a.iri] = mk; }
      mk.addTo(layers.actions);
      drawnBounds.push([a.lat, a.lon]);
    }
    layers.actions.addTo(map);
  }
  if (show.sfi) {
    for (const s of DB.sfi)
      L.circleMarker([s.lat, s.lon], dot("#46b978", 5, 0.8)).bindPopup(`<b>SFI option</b><br>${esc(s.code)}`).addTo(layers.sfi);
    layers.sfi.addTo(map);
  }

  // Frame whatever we drew (WINEP actions spread across the whole Wessex region,
  // well beyond the Poole Harbour catchment outline).
  if (drawnBounds.length) {
    map.fitBounds(L.latLngBounds(drawnBounds).pad(0.15), { maxZoom: 12 });
  } else if (catchmentLayer) {
    map.fitBounds(catchmentLayer.getBounds());
  }
}

function groupBy(arr, key) {
  const o = {};
  for (const x of arr) (o[x[key]] ||= []).push(x);
  return o;
}

// ---------------------------------------------------------------------------
// Table builders
// ---------------------------------------------------------------------------
function card(title, count, bodyEl) {
  const c = document.createElement("div");
  c.className = "card";
  c.innerHTML = `<h2>${title} <span class="count">${count}</span></h2>`;
  const scroll = document.createElement("div");
  scroll.className = "scroll";
  scroll.append(bodyEl);
  c.append(scroll);
  return c;
}
function emptyBody(msg) {
  const d = document.createElement("div");
  d.className = "empty";
  d.textContent = msg;
  return d;
}
// Header cells. A column heading may carry an alignment marker — "Cost|r" (right) or "Status|c"
// (centre) — so the label lines up with its cells (which use the same .num / .ctr classes).
function tableEl(head, rowsHtml) {
  const th = head.map((h) => {
    const [label, align] = String(h).split("|");
    const cls = align === "r" ? ' class="num"' : align === "c" ? ' class="ctr"' : "";
    return `<th${cls}>${label}</th>`;
  }).join("");
  const t = document.createElement("table");
  t.innerHTML = `<thead><tr>${th}</tr></thead><tbody>${rowsHtml}</tbody>`;
  return t;
}

function breachTable(breaches) {
  if (!breaches.length) return card("Breaches", "0", emptyBody("No breaches for this selection."));
  // current first, then most-recently-started
  const rows = [...breaches].sort((a, b) => (b.current - a.current) || (a.from < b.from ? 1 : -1)).map((b) => `
    <tr>
      <td>${breachPeriod(b)}</td>
      <td>${subLink(b.subLabel, b.subNotation, b.sp, b.permit)}</td>
      <td>${permitLink(b.permit)}</td>
      <td class="ctr">${b.current ? '<span class="pill current">current</span>' : '<span class="pill past">past</span>'}</td>
      <td>${wqeLink(b.sp)}</td>
    </tr>`).join("");
  return card("Breaches", breaches.length, tableEl(["Period", "Substance", "Permit", "Status|c", "Sampling point (WQE)"], rows));
}

function permitTable(conditions, dpByPermit, condByPermit, condHistByPermit, breachedKey, breachesByPermit) {
  const permits = [...new Set(conditions.map((c) => c.permit))].sort();
  if (!permits.length) return card("Permits &amp; limits", "0", emptyBody("No permits for this selection."));
  const rows = permits.map((p, i) => {
    const cur = (condByPermit[p] || []); // current-version conditions only
    const dps = dpByPermit[p] || [];
    const sp = dps.map((d) => d.sp).filter(Boolean)[0] || null;
    const nB = (breachesByPermit[p] || []).length;
    return `<tr class="expandable" data-row="${i}"><td><span class="caret">▸</span> ${permitLink(p)}
          <span style="color:#777"> v${DB.currentVersion[p] ?? "?"}</span></td>
        <td>${cur.length} current limit${cur.length === 1 ? "" : "s"}</td><td>${dps.length}</td>
        <td class="ctr">${nB ? `<span class="pill past">${nB} breach${nB === 1 ? "" : "es"}</span>` : "—"}</td><td>${wqeLink(sp)}</td></tr>
      <tr class="expand-row hidden" data-exp="${i}"><td colspan="5"><div class="expand-inner"></div></td></tr>`;
  }).join("");
  const c = card("Permits &amp; limits", permits.length,
    tableEl(["Permit", "Current limits", "Discharge points", "Breaches|c", "Monitored at"], rows));
  wireExpand(c, permits, (p) => permitDetail(p, condByPermit, condHistByPermit, breachedKey, dpByPermit));
  return c;
}

// Expandable detail: current limits, then the full version history with breached rows flagged.
function permitDetail(p, condByPermit, condHistByPermit, breachedKey, dpByPermit) {
  const sp = ((dpByPermit || {})[p] || []).map((d) => d.sp).filter(Boolean)[0] || null;
  const cur = (condByPermit[p] || []).slice().sort((a, b) => a.subLabel.localeCompare(b.subLabel));
  const hist = (condHistByPermit[p] || []).slice().sort((a, b) =>
    (Number(b.version) - Number(a.version)) || a.subLabel.localeCompare(b.subLabel));
  const curTbl = tableEl(["Substance", "Upper|r", "Lower|r", "Unit"],
    cur.map((c) => `<tr><td>${subLink(c.subLabel, c.subNotation, sp, p)}</td><td class="num">${c.upper ? fmtNum(c.upper) : "—"}</td>
      <td class="num">${c.lower ? fmtNum(c.lower) : "—"}</td><td>${prettyUnit(c.unit)}</td></tr>`).join("")).outerHTML;
  const histTbl = tableEl(["Version", "Substance", "Upper|r", "Lower|r", "Unit", "|c"],
    hist.map((c) => {
      const breached = breachedKey.has(`${p}|${c.version}|${c.subNotation}`);
      return `<tr${c.current ? ' style="font-weight:600"' : ""}>
        <td class="mono">v${c.version}${c.current ? " (current)" : ""}</td>
        <td>${esc(c.subLabel)}</td><td class="num">${c.upper ? fmtNum(c.upper) : "—"}</td>
        <td class="num">${c.lower ? fmtNum(c.lower) : "—"}</td><td>${prettyUnit(c.unit)}</td>
        <td class="ctr">${breached ? '<span class="pill current">breached</span>' : ""}</td></tr>`;
    }).join("")).outerHTML;
  const nVer = new Set(hist.map((c) => c.version)).size;
  return `<div style="padding:2px 0 8px"><b style="color:#93a4b3">Current limits</b></div>${curTbl}` +
    (nVer > 1 ? `<div style="padding:12px 0 8px"><b style="color:#93a4b3">Limit history — ${nVer} versions</b></div>${histTbl}` : "");
}

// One table keyed by (permit, substance): the current in-force limit on the left, and any WINEP
// action proposing a future limit for that SAME permit AND substance on the right (a proposed
// phosphorus limit must not land on a pH row). A permit+substance with both is a single row.
function substanceStoryTable(conditions, proposed, dpByPermit) {
  const key = (permit, sub) => `${permit} ${sub}`;
  const curByKey = {};
  for (const c of conditions) curByKey[key(c.permit, c.subNotation)] = c;
  const futByKey = {};
  for (const l of proposed) {
    const a = DB.actions.find((x) => x.iri === l.action);
    if (a && a.permit) (futByKey[key(a.permit, l.subNotation)] ||= []).push({ a, l });
  }
  const keys = [...new Set([...Object.keys(curByKey), ...Object.keys(futByKey)])];
  if (!keys.length) return card("Current limits &amp; future works", "0", emptyBody("Nothing for this substance."));

  const rows = [];
  for (const k of keys) {
    const [permit] = k.split(" ");
    const cur = curByKey[k] || null;
    const sp = (dpByPermit[permit] || []).map((d) => d.sp).filter(Boolean)[0] || null;
    const ver = cur ? cur.version : DB.currentVersion[permit];
    const futs = futByKey[k] || [null];
    for (const f of futs) rows.push({ p: permit, cur, sp, ver, f });
  }
  // current-bearing rows first (tightest first), then future-only
  rows.sort((a, b) => (!!b.cur - !!a.cur)
    || (Number((b.cur || {}).upper || 0) - Number((a.cur || {}).upper || 0))
    || (a.p < b.p ? -1 : 1));

  const isContinued = (l) => l.carried || (l.continues && !l.bounds.length);
  const body = rows.map(({ p, cur, sp, ver, f }) => {
    const subNotation = cur ? cur.subNotation : (f ? f.l.subNotation : "");
    const subLabel = cur ? cur.subLabel : (f ? f.l.subLabel : "");
    const limit = cur ? `${cur.upper ? "≤ " + fmtNum(cur.upper) : ""}${cur.lower ? " ≥ " + fmtNum(cur.lower) : ""}` : "—";
    const proposedCell = !f ? "—"
      : isContinued(f.l) ? '<span class="pill carried">continued</span>'
      : limitText(f.l);
    return `<tr>
      <td>${permitLink(p)}${ver != null ? ` <span style="color:#777">v${ver}</span>` : ""}</td>
      <td>${subLink(subLabel, subNotation, sp, p)}</td>
      <td class="num">${limit}</td>
      <td>${cur ? prettyUnit(cur.unit) : ""}</td>
      <td>${wqeLink(sp)}</td>
      <td class="mono">${f ? esc(f.a.id) : "—"}</td>
      <td>${f ? esc(f.a.label) : "—"}</td>
      <td>${f ? (fmtDate(f.a.completion) || "TBC") : "—"}</td>
      <td>${proposedCell}</td>
    </tr>`;
  }).join("");

  return card('Current limits &amp; future works <span class="count">— click a substance for its time-series chart</span>',
    `${conditions.length} current · ${proposed.length} proposed`,
    tableEl(["Permit", "Substance", "Limit|r", "Unit", "Monitored at", "Action", "Name", "Completion", "Proposed limit"], body));
}

function actionTable(actions, limByAction) {
  // Sort ONCE and use this order for both the rows (data-row=i) and the wireExpand keys, so each
  // expansion resolves to the action on its own row (previously rows were sorted but the keys were
  // not, cross-wiring one action's row to another action's limits).
  const sorted = [...actions].sort((a, b) => (a.completion < b.completion ? -1 : 1));
  const rows = sorted.map((a, i) => {
    const nLimits = limitLines(limByAction[a.iri] || []).length; // individual limit lines (matches the expansion)
    return `<tr class="expandable action-row${a.iri === selectedAction ? " sel" : ""}" data-row="${i}" data-action="${esc(a.iri)}">
        <td><span class="caret">▸</span> <span class="sub-link mono">${esc(a.id)}</span></td>
        <td>${esc(a.party)}</td><td>${esc(a.label)}</td><td>${fmtDate(a.completion) || "TBC"}</td>
        <td class="mono">${permitRef(a.permit)}</td><td class="num">${nLimits}</td></tr>
      <tr class="expand-row hidden" data-exp="${i}"><td colspan="6"><div class="expand-inner"></div></td></tr>`;
  }).join("");
  const c = card("WINEP Actions", actions.length, tableEl(["Action", "Party", "Name", "Completion", "Target permit", "Limits|r"], rows));
  // Clicking a row focuses the action on the map (marker highlight + pan + popup); it still expands.
  c.addEventListener("click", (e) => {
    const tr = e.target.closest(".action-row");
    if (tr) focusAction(tr.dataset.action, false);
  });
  wireExpand(c, sorted.map((a) => a.iri), (iri) => {
    const a = DB.actions.find((x) => x.iri === iri);
    const lines = limitLines(limByAction[iri] || []);
    // One row per limit line; the substance label + its matching current limit show once per
    // substance (blank on that substance's subsequent tier rows). A "continued" limit is just the
    // pill (it keeps the current limit, shown to the right); a substance with no current limit shows
    // a "none" pill (i.e. a brand-new limit).
    const body = tableEl(["Substance", "New limit", "Current limit"],
      lines.map((ln, idx) => {
        const firstOfSub = idx === 0 || lines[idx - 1].subNotation !== ln.subNotation;
        const cur = firstOfSub ? currentLimitFor(a?.permit, ln.subNotation) : null;
        return `<tr>
          <td>${firstOfSub ? esc(ln.subLabel || "—") : ""}</td>
          <td>${ln.carried ? '<span class="pill carried">continued</span>' : ln.text}</td>
          <td>${firstOfSub ? (cur || '<span class="pill none">none</span>') : ""}</td>
        </tr>`;
      }).join("") || `<tr><td colspan="3" class="empty">No structured limits.</td></tr>`);
    return `${a?.desc ? `<p style="color:#93a4b3">${esc(a.desc)}</p>` : ""}${body.outerHTML}`;
  });
  return c;
}

// ---------------------------------------------------------------------------
// Farming view: application hulls on the map, a spider + pie for the selected one.
// ---------------------------------------------------------------------------
// Farming filter: does an application include an option of the given broader type; and the current
// application set after the Land "Option type" filter.
const appHasType = (iri, code) => (DB.optionsByApp[iri] || []).some((o) => o.broader === code);
const farmingApps = () =>
  currentOptionType ? DB.applications.filter((a) => appHasType(a.iri, currentOptionType)) : DB.applications;

// --- Overlap handling: which applications sit under a point, and how we highlight them ----------
function pointInRing(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i][0], xi = ring[i][1], yj = ring[j][0], xj = ring[j][1];
    if (((yi > lat) !== (yj > lat)) && (lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
// Every application whose polygon contains the given latlng (topmost first, i.e. smallest last-drawn
// on top → we return them in draw order reversed so the visually-topmost is first).
function containingApps(latlng) {
  const out = [];
  for (const a of DB.applications) {
    const ring = appRings[a.iri];
    if (ring && pointInRing(latlng.lat, latlng.lng, ring)) out.push(a);
  }
  return out;
}
const baseFillOf = (iri) => (iri === selectedApp ? 0.12 : 0.05);
function restoreAllShapes() {
  for (const k in appShapes) appShapes[k].setStyle({ fillOpacity: baseFillOf(k) });
}
// Darken exactly one polygon (used when hovering a picker row); null restores all.
function highlightOnly(iri) {
  restoreAllShapes();
  const s = iri && appShapes[iri];
  if (s) { s.setStyle({ fillOpacity: 0.34 }); s.bringToFront(); }
}

// Hover: a tooltip listing ALL applications under the cursor (read-only preview of the overlap).
function showOverlapTip(latlng) {
  if (pickerOpen) return;
  clearTimeout(tipHideTimer);
  const apps = containingApps(latlng);
  if (!apps.length) { hideOverlapTip(); return; }
  const rows = apps.map((a) => `${esc(a.id)} · ${appCostLabel(a)}`).join("<br>");
  const head = apps.length > 1 ? `<b>${apps.length} applications here</b><br>` : "";
  const foot = `<br><i>click to ${apps.length > 1 ? "choose" : "select"}</i>`;
  if (!overlapTip) overlapTip = L.tooltip({ direction: "top", className: "overlap-tip", offset: [0, -2], opacity: 1 });
  overlapTip.setLatLng(latlng).setContent(head + rows + foot);
  if (!map.hasLayer(overlapTip)) overlapTip.addTo(map);
}
function hideOverlapTip() {
  clearTimeout(tipHideTimer);
  if (overlapTip && map.hasLayer(overlapTip)) map.removeLayer(overlapTip);
}

// Click: a persistent, interactive popup listing the applications under the click. Each row is a
// dotted-underline (internal) link — hovering it darkens that one polygon, clicking selects it.
function openPicker(latlng) {
  hideOverlapTip();
  const apps = containingApps(latlng);
  if (!apps.length) return;
  const div = document.createElement("div");
  div.className = "app-picker";
  div.innerHTML = `<div class="pick-head">${apps.length} application${apps.length === 1 ? "" : "s"} here</div>` +
    apps.map((a) =>
      `<div class="pick-row"><span class="sub-link pick-app" data-app="${esc(a.iri)}">${esc(a.id)}</span>` +
      `<span class="pick-meta">${swatch(progOf(a).color)}${appCostLabel(a)} · ${a.n} opt${a.n === 1 ? "" : "s"}</span></div>`
    ).join("");
  div.querySelectorAll(".pick-app").forEach((el) => {
    const iri = el.dataset.app;
    el.addEventListener("mouseenter", () => highlightOnly(iri));
    el.addEventListener("mouseleave", () => highlightOnly(null));
    el.addEventListener("click", () => { map.closePopup(); selectApp(iri); });
  });
  L.popup({ className: "picker-popup", maxHeight: 260 }).setLatLng(latlng).setContent(div).openOn(map);
}

// Lede for the farming view: the prices broken down per programme (so it's clear which carries
// finances) plus why SFI 2023 agreements are unpriced.
function farmingLede() {
  const apps = farmingApps();
  const byProg = {};
  for (const a of apps) {
    const p = progOf(a);
    const g = (byProg[p.label] ||= { label: p.label, color: p.color, priced: p.priced, apps: 0, total: 0 });
    g.apps++; g.total += a.total;
  }
  const chips = Object.values(byProg).sort((a, b) => b.total - a.total).map((g) =>
    `<span class="prog-chip"><span class="swatch" style="background:${g.color}"></span>` +
    `${esc(g.label)}: <b>${g.apps}</b> agreement${g.apps === 1 ? "" : "s"} · ` +
    `${g.priced ? "<b>" + fmtGBP(g.total) + "</b>/yr" : "rates unavailable"}</span>`).join("");
  const filterNote = currentOptionType
    ? ` Filtered to agreements with a <b>${esc(DB.optionTypes[currentOptionType] || currentOptionType)}</b> option.`
    : "";
  return `<b>Farming (SFI)</b> — ${apps.length} agreement${apps.length === 1 ? "" : "s"} ` +
    `paying farmers to cut diffuse pollution at source. Only <b>SFI Expanded Offer</b> rates are published in our ` +
    `source, so <b>SFI 2023</b> agreements show as <b>unpriced</b>.${filterNote} Click an application to value it.` +
    `<span class="prog-summary">${chips}</span>`;
}

function renderFarming(tables) {
  setLegend([
    { c: PROGRAMMES["SFI EO"].color, t: "SFI Expanded Offer — priced" },
    { c: PROGRAMMES["SFI 23"].color, t: "SFI 2023 — rates unavailable" },
    { c: "#f5a623", t: "selected application" },
  ]);
  document.getElementById("lede").innerHTML = farmingLede();

  // Every application as a polygon (convex hull of all its option multipoints, or a small square when
  // degenerate), coloured by its programme. Applications overlap heavily, so hovering lists ALL of
  // them under the cursor and clicking opens a picker rather than selecting the topmost outright.
  for (const k in appShapes) delete appShapes[k];
  for (const k in appRings) delete appRings[k];
  hideOverlapTip();
  const bounds = [];
  for (const app of farmingApps()) {
    const pts = (DB.optionsByApp[app.iri] || []).flatMap((o) => o.points);
    if (!pts.length) continue;
    const sel = app.iri === selectedApp;
    const prog = progOf(app);
    const col = sel ? "#f5a623" : prog.color;
    const ring = hullPolygon(pts);
    const shape = L.polygon(ring, { color: col, weight: sel ? 2.5 : 1, fillColor: col, fillOpacity: baseFillOf(app.iri) });
    shape.on("mousemove", (e) => showOverlapTip(e.latlng));
    shape.on("mouseout", () => { tipHideTimer = setTimeout(hideOverlapTip, 60); });
    shape.on("click", (e) => openPicker(e.latlng));
    shape.addTo(layers.appHulls);
    appShapes[app.iri] = shape;
    appRings[app.iri] = ring;
    if (sel) pts.forEach((p) => bounds.push(p));
  }
  layers.appHulls.addTo(map);

  // Selected application: a spider per option (hub at the option's centroid, a leg to each point),
  // each hub permanently labelled with its option code so you can read what is done where.
  if (selectedApp) {
    for (const o of DB.optionsByApp[selectedApp] || []) {
      if (!o.centroid) continue;
      const col = groupColor(o.broader);
      for (const p of o.points) {
        L.polyline([o.centroid, p], { color: col, weight: 1, opacity: 0.5 }).addTo(layers.spider);
        L.circleMarker(p, { radius: 2.5, color: col, weight: 1, fillColor: col, fillOpacity: 0.9 }).addTo(layers.spider);
      }
      L.circleMarker(o.centroid, dot(col, 6, 0.95))
        .bindTooltip(`${o.code} · ${o.cost != null ? fmtGBP(o.cost) : "unpriced"}`,
          { permanent: true, direction: "top", className: "spider-label", offset: [0, -3] })
        .bindPopup(`<b>${esc(o.broaderLabel)}</b> <span class="mono">${esc(o.code)}</span><br>` +
          `${esc(o.def || "")}<br><b>${o.cost != null ? fmtGBP(o.cost) + " / annum" : "unpriced — no published rate for this SFI 2023 action"}</b>`)
        .addTo(layers.spider);
    }
    layers.spider.addTo(map);
    openAppChart(selectedApp);
  } else {
    closeChart();
  }

  tables.append(applicationsTable(), optionsTable(selectedApp));

  if (bounds.length) map.fitBounds(L.latLngBounds(bounds).pad(0.25), { maxZoom: 14 });
  else {
    const all = DB.sfiOptions.flatMap((o) => o.points);
    if (all.length) map.fitBounds(L.latLngBounds(all).pad(0.1));
  }
}

function applicationsTable() {
  const apps = farmingApps();
  const rows = apps.map((a) => {
    const prog = progOf(a);
    const cost = prog.priced
      ? `${fmtGBP(a.total)}/yr${a.unpriced ? ` <span class="unpriced-tag" title="${a.unpriced} option(s) with no published rate">+${a.unpriced}&nbsp;unpriced</span>` : ""}`
      : `<span class="muted">unpriced</span>`;
    return `
    <tr class="app-row${a.iri === selectedApp ? " sel" : ""}" data-app="${esc(a.iri)}">
      <td class="mono"><span class="sub-link">${esc(a.id)}</span></td>
      <td>${swatch(prog.color)}${esc(prog.label)}</td>
      <td class="num">${a.n}</td>
      <td class="num">${cost}</td>
    </tr>`;
  }).join("");
  const hint = selectedApp
    ? '<span class="count">— <span class="sub-link clear-sel" title="Reset focus back to the filters">✕ clear selection</span></span>'
    : '<span class="count">— click one to value it</span>';
  const c = card(`Applications ${hint}`,
    apps.length, tableEl(["Application", "Programme", "Options|r", "Total cost|r"], rows));
  c.addEventListener("click", (e) => {
    if (e.target.closest(".clear-sel")) { clearAppFocus(); return; }
    const tr = e.target.closest(".app-row");
    if (tr) selectApp(tr.dataset.app);
  });
  return c;
}

// Options for the selected application, grouped by broader concept (expandable to the components).
function optionsTable(appIri) {
  if (!appIri) return card("Options", "—", emptyBody("Select an application to see its options."));
  const byG = {};
  for (const o of DB.optionsByApp[appIri] || []) {
    const g = (byG[o.broader] ||= { code: o.broader, label: o.broaderLabel, items: [], total: 0, unpriced: 0 });
    g.items.push(o);
    if (o.cost == null) g.unpriced++; else g.total += o.cost;
  }
  const groups = Object.values(byG).sort((a, b) => b.total - a.total);
  const nOpts = groups.reduce((s, g) => s + g.items.length, 0);
  const groupCost = (g) => g.total
    ? `${fmtGBP(g.total)}/yr${g.unpriced ? ` <span class="unpriced-tag">+${g.unpriced}&nbsp;unpriced</span>` : ""}`
    : `<span class="muted">unpriced</span>`;
  const rows = groups.map((g, i) => `
    <tr class="expandable" data-row="${i}">
      <td><span class="caret">▸</span> ${esc(g.label)} <span class="mono">${esc(g.code)}</span></td>
      <td class="num">${g.items.length}</td>
      <td class="num">${groupCost(g)}</td>
    </tr>
    <tr class="expand-row hidden" data-exp="${i}"><td colspan="3"><div class="expand-inner"></div></td></tr>`).join("");
  const c = card(`Options <span class="count">— ${esc(DB.appById[appIri]?.id || "")}</span>`, nOpts,
    tableEl(["Group", "Options|r", "Cost|r"], rows));
  wireExpand(c, groups, (g) => tableEl(["Option", "Description", "Cost|r"],
    g.items.slice().sort((a, b) => (b.cost || 0) - (a.cost || 0)).map((o) =>
      `<tr><td class="mono">${esc(o.code)}</td><td>${esc(o.def || "—")}</td>` +
      `<td class="num">${o.cost != null ? fmtGBP(o.cost) + "/yr" : '<span class="muted">unpriced</span>'}</td></tr>`).join("")).outerHTML);
  return c;
}

// Expandable rows: clicking a summary row toggles the detail row and lazily fills it.
function wireExpand(cardEl, keys, buildHtml) {
  cardEl.addEventListener("click", (e) => {
    const tr = e.target.closest(".expandable");
    if (!tr) return;
    const i = tr.dataset.row;
    const exp = cardEl.querySelector(`.expand-row[data-exp="${i}"]`);
    const inner = exp.querySelector(".expand-inner");
    const opening = exp.classList.contains("hidden");
    if (opening && !inner.dataset.filled) { inner.innerHTML = buildHtml(keys[i]); inner.dataset.filled = "1"; }
    exp.classList.toggle("hidden");
    tr.classList.toggle("open");
  });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function setView(v) {
  currentView = v;
  document.querySelectorAll("#views button").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
  if (v !== "farming") { selectedApp = null; closeChart(); } // drop the pie when leaving farming
  if (v !== "wessex") selectedAction = null; // drop the WINEP action focus when leaving
  if (v === "substance" && !currentSubstance) {
    currentSubstance = NITROGEN;
    document.getElementById("substance").value = NITROGEN;
  }
  render();
}

async function main() {
  initMap();
  const status = document.getElementById("status");
  try {
    await loadAll();
    loadDesignations();  // fire-and-forget: fetches the 3 clipped GeoJSONs and builds the legend control
    status.textContent = `Loaded ${DB.breaches.length} breaches · ${DB.conditions.length} conditions · ${DB.actions.length} actions · ${DB.applications.length} farming applications (${DB.sfiOptions.length} options)`;
  } catch (err) {
    status.textContent = "Error: " + err.message;
    console.error(err);
    return;
  }
  document.querySelectorAll("#views button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
  document.getElementById("substance").addEventListener("change", (e) => { currentSubstance = e.target.value; render(); });
  document.getElementById("optionType").addEventListener("change", (e) => {
    currentOptionType = e.target.value;
    // drop the selection if the filter no longer includes it
    if (currentOptionType && selectedApp && !appHasType(selectedApp, currentOptionType)) selectedApp = null;
    render();
  });
  // The chart is the manifestation of a focused application, so in farming its ✕ clears the
  // selection (which also closes the chart); elsewhere (the substance time-series) it just closes.
  document.getElementById("chart-close").addEventListener("click", () => {
    if (currentView === "farming" && selectedApp) clearAppFocus();
    else closeChart();
  });
  // Escape resets the farming focus, or closes an open chart on the other views.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (currentView === "farming" && selectedApp) clearAppFocus();
    else if (!document.getElementById("chart").classList.contains("hidden")) closeChart();
  });

  // Deep-link support: ?view=breaches|substance|wessex|overall & ?sub=<notation>
  const params = new URLSearchParams(location.search);
  const sub = params.get("sub");
  if (sub && DB.substances.some((s) => s.notation === sub)) {
    currentSubstance = sub;
    document.getElementById("substance").value = sub;
  }
  const view = params.get("view");
  setView(["breaches", "substance", "wessex", "farming"].includes(view) ? view : "breaches");
}

main();
