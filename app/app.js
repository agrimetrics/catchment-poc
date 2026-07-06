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

proj4.defs(
  "EPSG:27700",
  "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 " +
  "+ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs"
);

const PREFIXES = `
PREFIX reg:   <http://environment.data.gov.uk/ontology/regulation/>
PREFIX water: <http://environment.data.gov.uk/ontology/water/>
PREFIX core:  <http://environment.data.gov.uk/ontology/core/>
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
    SELECT ?permit ?subNotation ?from ?to ?upper ?lower WHERE {
      ?permit a water:WaterDischargePermit ; reg:hasCondition ?cond .
      ?cond reg:regulatedProperty ?sub .
      ?sub skos:notation ?subNotation .
      BIND(IRI(REPLACE(STR(?cond), "/condition/.*", "")) AS ?doc)
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

  sfi: `${PREFIXES}
    SELECT ?opt (SAMPLE(?w) AS ?wkt) WHERE {
      ?opt geo:hasGeometry/geo:asWKT ?w .
      FILTER(STRSTARTS(STR(?opt), "http://example.com/sfi/"))
    } GROUP BY ?opt`,
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
  setTimeout(() => map.invalidateSize(), 60);
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
  if (hasSteps) {
    lines += stepLine((s) => s.upper, 1.75) + stepLine((s) => s.lower, 1.5);
    if (ctx.upper != null)
      lines += `<text x="${W - m.r}" y="${y(ctx.upper) - 4}" fill="#e5484d" font-size="10" text-anchor="end">current ${fmtNum(ctx.upper)} ${prettyUnit(ctx.unit)}</text>`;
  } else {
    if (ctx.upper != null) {
      const yy = y(ctx.upper);
      lines += `<line x1="${m.l}" y1="${yy}" x2="${W - m.r}" y2="${yy}" stroke="#e5484d" stroke-width="1.75" stroke-dasharray="6 4"/>` +
        `<text x="${W - m.r}" y="${yy - 4}" fill="#e5484d" font-size="10" text-anchor="end">current ${fmtNum(ctx.upper)} ${prettyUnit(ctx.unit)}</text>`;
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
    lines += `<line x1="${m.l}" y1="${yy}" x2="${W - m.r}" y2="${yy}" stroke="#a06bff" stroke-width="1.75" stroke-dasharray="6 4"/>` +
      `<text x="${m.l}" y="${yy - 4}" fill="#a06bff" font-size="10">proposed ${fmtNum(v)}${b.stat ? " (" + esc(b.stat) + ")" : ""}</text>`;
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
    <span class="item" style="color:#e5484d">– – current limit${hasSteps ? " (by version)" : ""}</span>
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

// clickable substance name that opens the chart (needs a sampling point)
const subLink = (label, subNotation, sp, permit) =>
  sp ? `<span class="sub-link" onclick="openChart('${subNotation}','${esc(sp)}','${permit}')">${esc(label)}</span>` : esc(label);
window.openChart = openChart;

// clickable permit id that zooms the map to that permit's discharge point(s)
const permitLink = (iri) =>
  `<span class="mono sub-link" onclick="event.stopPropagation();zoomPermit('${iri}')">${permitRef(iri)}</span>`;
// sampling point that links out to the Water Quality Explorer
const wqeLink = (sp) =>
  sp ? `<a href="${WQE}${esc(sp)}" target="_blank" rel="noopener">${esc(sp)} ↗</a>` : "—";

const permitMarkers = {}; // permit IRI -> [marker] for the current render, for zoom-to-permit
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
let currentView = "breaches";
let currentSubstance = ""; // notation or ""

// ---------------------------------------------------------------------------
// Load everything once
// ---------------------------------------------------------------------------
async function loadAll() {
  const [substances, breaches, dps, conditions, actions, proposed, sfi, limitHistory] = await Promise.all([
    sparql(Q.substances), sparql(Q.breaches), sparql(Q.dischargePoints),
    sparql(Q.conditions), sparql(Q.actions), sparql(Q.proposed), sparql(Q.sfi), sparql(Q.limitHistory),
  ]);

  // Dated limit history per (permit, substance): each permit version's bound(s) over its
  // effective window [from, to] (from the public register). Powers the chart's stepped limit line.
  DB.limitHistory = {};
  for (const r of limitHistory) {
    const key = `${r.permit}|${r.subNotation}`;
    (DB.limitHistory[key] ||= []).push({
      from: Date.parse(r.from), to: r.to ? Date.parse(r.to) : null,
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

  DB.sfi = sfi.map((s) => {
    const p = parseWkt(s.wkt).points[0] || null;
    const code = (/\/([A-Za-z0-9]+)$/.exec(s.opt) || [])[1] || "";
    return { iri: s.opt, code, cat: (code.match(/[A-Za-z]+/) || [""])[0].replace(/^C/, ""),
             lat: p ? p[0] : null, lon: p ? p[1] : null };
  }).filter((s) => s.lat != null);

  // Substance dropdown
  DB.substances = substances;
  const sel = document.getElementById("substance");
  sel.innerHTML =
    `<option value="">All substances</option>` +
    substances.map((s) => `<option value="${s.notation}">${esc(s.label)} (${s.notation})</option>`).join("");
}

// ---------------------------------------------------------------------------
// Map setup
// ---------------------------------------------------------------------------
function initMap() {
  map = L.map("map", { zoomControl: true }).setView(CENTER, 11);
  base = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap contributors", maxZoom: 18,
  }).addTo(map);

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
  overall: () => `The whole picture: permit limits and their breaches, Wessex Water's planned works, and the farming (SFI) options that reduce diffuse pollution at source.`,
};

function clearLayers() {
  Object.values(layers).forEach((l) => map.removeLayer(l));
  layers.breachCurrent.clearLayers();
  layers.breachPast.clearLayers();
  layers.dischargePoints.clearLayers();
  layers.actions.clearLayers();
  layers.sfi.clearLayers();
}

function setLegend(items) {
  document.getElementById("legend").innerHTML = items
    .map((i) => `<span class="item"><span class="dot" style="background:${i.c}"></span>${i.t}</span>`)
    .join("");
}

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
  const wqe = dp.sp
    ? `<a href="${WQE}${dp.sp}" target="_blank" rel="noopener">${esc(dp.sp)} ↗</a>`
    : "—";
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

const drawnBounds = [];

function render() {
  clearLayers();
  drawnBounds.length = 0;
  for (const k in permitMarkers) delete permitMarkers[k];
  const sub = DB.substances.find((s) => s.notation === currentSubstance);
  const subLbl = sub ? sub.label : "all substances";
  const tables = document.getElementById("tables");
  tables.innerHTML = "";

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
  } else if (currentView === "overall") {
    show.breach = show.discharge = show.action = show.sfi = true;
    setLegend([
      { c: "#3aa0ff", t: "Discharge point" }, { c: "#e5484d", t: "Current breach" }, { c: "#f5a623", t: "Past breach" },
      { c: "#a06bff", t: "Action site" }, { c: "#46b978", t: "Farming (SFI)" },
    ]);
    document.getElementById("lede").innerHTML = LEDE.overall();
    tables.append(
      breachTable(breaches),
      permitTable(conditions, dpByPermit, condByPermit, condHistByPermit, breachedKey, breachesByPermit),
      actionTable(DB.actions, limByAction),
      sfiTable(DB.sfi),
    );
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
    for (const a of DB.actions) {
      if (a.lat == null) continue;
      if (currentView === "substance" && currentSubstance && !actionIdsWithSub.has(a.iri)) continue;
      circle(a.lat, a.lon, dot("#a06bff", 7, 0.85), actionPopup(a, limByAction[a.iri] || [])).addTo(layers.actions);
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
function tableEl(head, rowsHtml) {
  const t = document.createElement("table");
  t.innerHTML = `<thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rowsHtml}</tbody>`;
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
      <td>${b.current ? '<span class="pill current">current</span>' : '<span class="pill past">past</span>'}</td>
      <td>${wqeLink(b.sp)}</td>
    </tr>`).join("");
  return card("Breaches", breaches.length, tableEl(["Period", "Substance", "Permit", "Status", "Sampling point (WQE)"], rows));
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
        <td>${nB ? `<span class="pill past">${nB} breach${nB === 1 ? "" : "es"}</span>` : "—"}</td><td>${wqeLink(sp)}</td></tr>
      <tr class="expand-row hidden" data-exp="${i}"><td colspan="5"><div class="expand-inner"></div></td></tr>`;
  }).join("");
  const c = card("Permits &amp; limits", permits.length,
    tableEl(["Permit", "Current limits", "Discharge points", "Breaches", "Monitored at"], rows));
  wireExpand(c, permits, (p) => permitDetail(p, condByPermit, condHistByPermit, breachedKey, dpByPermit));
  return c;
}

// Expandable detail: current limits, then the full version history with breached rows flagged.
function permitDetail(p, condByPermit, condHistByPermit, breachedKey, dpByPermit) {
  const sp = ((dpByPermit || {})[p] || []).map((d) => d.sp).filter(Boolean)[0] || null;
  const cur = (condByPermit[p] || []).slice().sort((a, b) => a.subLabel.localeCompare(b.subLabel));
  const hist = (condHistByPermit[p] || []).slice().sort((a, b) =>
    (Number(b.version) - Number(a.version)) || a.subLabel.localeCompare(b.subLabel));
  const curTbl = tableEl(["Substance", "Upper", "Lower", "Unit"],
    cur.map((c) => `<tr><td>${subLink(c.subLabel, c.subNotation, sp, p)}</td><td class="num">${c.upper ? fmtNum(c.upper) : "—"}</td>
      <td class="num">${c.lower ? fmtNum(c.lower) : "—"}</td><td>${prettyUnit(c.unit)}</td></tr>`).join("")).outerHTML;
  const histTbl = tableEl(["Version", "Substance", "Upper", "Lower", "Unit", ""],
    hist.map((c) => {
      const breached = breachedKey.has(`${p}|${c.version}|${c.subNotation}`);
      return `<tr${c.current ? ' style="font-weight:600"' : ""}>
        <td class="mono">v${c.version}${c.current ? " (current)" : ""}</td>
        <td>${esc(c.subLabel)}</td><td class="num">${c.upper ? fmtNum(c.upper) : "—"}</td>
        <td class="num">${c.lower ? fmtNum(c.lower) : "—"}</td><td>${prettyUnit(c.unit)}</td>
        <td>${breached ? '<span class="pill current">breached</span>' : ""}</td></tr>`;
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
    tableEl(["Permit", "Substance", "Limit", "Unit", "Monitored at", "Action", "Name", "Completion", "Proposed limit"], body));
}

function actionTable(actions, limByAction) {
  const rows = [...actions].sort((a, b) => (a.completion < b.completion ? -1 : 1)).map((a, i) => {
    const limits = limByAction[a.iri] || [];
    return `<tr class="expandable" data-row="${i}">
        <td><span class="caret">▸</span> <span class="mono">${esc(a.id)}</span></td>
        <td>${esc(a.label)}</td><td>${fmtDate(a.completion) || "TBC"}</td>
        <td class="mono">${permitRef(a.permit)}</td><td>${limits.length}</td></tr>
      <tr class="expand-row hidden" data-exp="${i}"><td colspan="5"><div class="expand-inner"></div></td></tr>`;
  }).join("");
  const c = card("Wessex Water actions", actions.length, tableEl(["Action", "Name", "Completion", "Target permit", "Limits"], rows));
  wireExpand(c, actions.map((a) => a.iri), (iri) => {
    const a = DB.actions.find((x) => x.iri === iri);
    const limits = limByAction[iri] || [];
    const body = tableEl(["Substance", "New limit"],
      limits.map((l) => `<tr><td>${esc(l.subLabel || "—")}</td><td>${l.carried ? '<span class="pill carried">continued</span> ' : ""}${limitText(l)}</td></tr>`).join("")
      || `<tr><td colspan="2" class="empty">No structured limits.</td></tr>`);
    return `${a?.desc ? `<p style="color:#93a4b3">${esc(a.desc)}</p>` : ""}${body.outerHTML}`;
  });
  return c;
}

function sfiTable(sfi) {
  const byCat = {};
  for (const s of sfi) (byCat[s.cat] ||= []).push(s);
  const cats = Object.entries(byCat).sort((a, b) => b[1].length - a[1].length);
  const rows = cats.map(([cat, arr]) => `<tr><td class="mono">${esc(cat || "?")}</td><td class="num">${arr.length}</td></tr>`).join("");
  return card("Farming options (SFI)", `${sfi.length} options · not substance-filtered`, tableEl(["Option group", "Count"], rows));
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
    status.textContent = `Loaded ${DB.breaches.length} breaches · ${DB.conditions.length} conditions · ${DB.actions.length} actions · ${DB.sfi.length} SFI options`;
  } catch (err) {
    status.textContent = "Error: " + err.message;
    console.error(err);
    return;
  }
  document.querySelectorAll("#views button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
  document.getElementById("substance").addEventListener("change", (e) => { currentSubstance = e.target.value; render(); });
  document.getElementById("chart-close").addEventListener("click", closeChart);

  // Deep-link support: ?view=breaches|substance|wessex|overall & ?sub=<notation>
  const params = new URLSearchParams(location.search);
  const sub = params.get("sub");
  if (sub && DB.substances.some((s) => s.notation === sub)) {
    currentSubstance = sub;
    document.getElementById("substance").value = sub;
  }
  const view = params.get("view");
  setView(["breaches", "substance", "wessex", "overall"].includes(view) ? view : "breaches");
}

main();
