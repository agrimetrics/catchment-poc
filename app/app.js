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
    SELECT ?breach ?type ?date ?subLabel ?subNotation ?permit ?obs (SAMPLE(?w) AS ?wkt) WHERE {
      ?breach reg:breachesCondition ?cond ;
              reg:evidencedByObservation ?obs ;
              core:hasApplicability/core:applicabilityPeriod/core:applicableFrom ?date .
      OPTIONAL { ?breach a ?type . FILTER(?type IN (reg:ExceedanceBreach, reg:ShortfallBreach)) }
      ?cond reg:regulatedProperty ?sub .
      ?sub skos:prefLabel ?subLabel ; skos:notation ?subNotation .
      ?permit reg:hasCondition ?cond ; reg:permitSite ?dp .
      ?dp water:monitoredAt ?sp ; geo:hasGeometry/geo:asWKT ?w .
      FILTER(STRSTARTS(STR(?obs), STR(?sp)))
    } GROUP BY ?breach ?type ?date ?subLabel ?subNotation ?permit ?obs`,

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
  const [substances, breaches, dps, conditions, actions, proposed, sfi] = await Promise.all([
    sparql(Q.substances), sparql(Q.breaches), sparql(Q.dischargePoints),
    sparql(Q.conditions), sparql(Q.actions), sparql(Q.proposed), sparql(Q.sfi),
  ]);

  // Breaches: attach geometry + current/past (latest per permit+substance = current)
  DB.breaches = breaches.map((b) => {
    const p = parseWkt(b.wkt).points[0] || null;
    return {
      iri: b.breach, date: b.date, subLabel: b.subLabel, subNotation: b.subNotation,
      permit: b.permit, obs: b.obs, sp: spOf(b.obs),
      type: b.type ? last(b.type) : "ConditionBreach",
      lat: p ? p[0] : null, lon: p ? p[1] : null, current: false,
    };
  });
  const byKey = {};
  for (const b of DB.breaches) (byKey[b.permit + "|" + b.subNotation] ||= []).push(b);
  for (const k in byKey) {
    byKey[k].sort((a, c) => (a.date < c.date ? 1 : -1));
    byKey[k][0].current = true;
  }

  // Discharge points
  DB.dischargePoints = dps.map((d) => {
    const p = parseWkt(d.wkt).points[0] || null;
    return { iri: d.dp, permit: d.permit, sp: spOf(d.sp), lat: p ? p[0] : null, lon: p ? p[1] : null };
  });

  // Conditions grouped per (permit, condition)
  const condMap = {};
  for (const c of conditions) {
    const key = c.cond;
    (condMap[key] ||= {
      permit: c.permit, cond: c.cond, subLabel: c.subLabel, subNotation: c.subNotation,
      upper: null, lower: null, unit: null,
    });
    if (c.upper != null) condMap[key].upper = c.upper;
    if (c.lower != null) condMap[key].lower = c.lower;
    if (c.unitLabel) condMap[key].unit = c.unitLabel;
  }
  DB.conditions = Object.values(condMap);

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
  breaches: (n) => `<b>${n} condition breaches</b> where an observed value crossed a permit limit. The most recent breach at each site is shown as <b>current</b>; earlier ones as <b>past</b>. Click a marker to open the sampling point in the Water Quality Explorer.`,
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

function breachPopup(b) {
  return `<h3>Breach — ${esc(b.subLabel)}</h3>
    <div class="kv"><b>Permit:</b> ${permitRef(b.permit)}<br>
    <b>Date:</b> ${fmtDate(b.date)}<br>
    <b>Status:</b> ${b.current ? "Current" : "Past"}<br>
    <b>Sampling point:</b> ${esc(b.sp || "—")}</div>
    ${b.sp ? `<p><a href="${WQE}${b.sp}" target="_blank" rel="noopener">Open in Water Quality Explorer ↗</a></p>` : ""}`;
}
function dpPopup(dp, conds) {
  const rows = conds.map((c) => `${esc(c.subLabel)}: ${c.upper ? "≤ " + fmtNum(c.upper) + " " + prettyUnit(c.unit) : ""}${c.lower ? " ≥ " + fmtNum(c.lower) : ""}`).join("<br>");
  return `<h3>Discharge point</h3><div class="kv"><b>Permit:</b> ${permitRef(dp.permit)}<br>
    <b>Monitored at:</b> ${esc(dp.sp || "—")}</div>${rows ? `<hr><div class="kv">${rows}</div>` : ""}`;
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
  const sub = DB.substances.find((s) => s.notation === currentSubstance);
  const subLbl = sub ? sub.label : "all substances";
  const tables = document.getElementById("tables");
  tables.innerHTML = "";

  // Data slices with substance filter applied where relevant
  const breaches = DB.breaches.filter((b) => matchSub(b.subNotation));
  const conditions = DB.conditions.filter((c) => matchSub(c.subNotation));
  const proposedForSub = DB.proposed.filter((l) => matchSub(l.subNotation));
  const condByPermit = groupBy(DB.conditions, "permit");
  const dpByPermit = groupBy(DB.dischargePoints, "permit");
  const limByAction = groupBy(DB.proposed, "action");

  // Which permits/actions are relevant to the substance
  const permitsWithSub = new Set(conditions.map((c) => c.permit));
  const actionIdsWithSub = new Set(proposedForSub.map((l) => l.action));

  const show = { breach: false, discharge: false, action: false, sfi: false };

  if (currentView === "breaches") {
    show.breach = show.discharge = true;
    setLegend([{ c: "#e5484d", t: "Current breach" }, { c: "#f5a623", t: "Past breach" }, { c: "#3aa0ff", t: "Discharge point (permit limit)" }]);
    document.getElementById("lede").innerHTML = LEDE.breaches(breaches.length);
    tables.append(breachTable(breaches), permitTable(conditions, dpByPermit, condByPermit));
  } else if (currentView === "substance") {
    show.breach = show.discharge = show.action = true;
    setLegend([{ c: "#3aa0ff", t: "Current limit" }, { c: "#a06bff", t: "Future works (action)" }, { c: "#e5484d", t: "Breach" }]);
    const limitCount = conditions.length, workCount = actionIdsWithSub.size;
    document.getElementById("lede").innerHTML = LEDE.substance({ limits: limitCount, works: workCount }, subLbl);
    tables.append(
      currentLimitsTable(conditions, dpByPermit),
      futureWorksTable(proposedForSub, limByAction),
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
      permitTable(conditions, dpByPermit, condByPermit),
      actionTable(DB.actions, limByAction),
      sfiTable(DB.sfi),
    );
  }

  // Draw layers
  if (show.discharge) {
    for (const dp of DB.dischargePoints) {
      if (dp.lat == null) continue;
      const conds = (condByPermit[dp.permit] || []).filter((c) => matchSub(c.subNotation));
      if (currentSubstance && conds.length === 0) continue;
      circle(dp.lat, dp.lon, dot("#3aa0ff", 6, 0.85), dpPopup(dp, conds)).addTo(layers.dischargePoints);
      drawnBounds.push([dp.lat, dp.lon]);
    }
    layers.dischargePoints.addTo(map);
  }
  if (show.breach) {
    for (const b of breaches) {
      if (b.lat == null) continue;
      const grp = b.current ? layers.breachCurrent : layers.breachPast;
      circle(b.lat, b.lon, dot(b.current ? "#e5484d" : "#f5a623", b.current ? 8 : 6, 0.9), breachPopup(b)).addTo(grp);
      drawnBounds.push([b.lat, b.lon]);
    }
    layers.breachPast.addTo(map);
    layers.breachCurrent.addTo(map);
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
  const rows = [...breaches].sort((a, b) => (a.date < b.date ? 1 : -1)).map((b) => `
    <tr>
      <td>${fmtDate(b.date)}</td>
      <td>${esc(b.subLabel)}</td>
      <td class="mono">${permitRef(b.permit)}</td>
      <td>${b.current ? '<span class="pill current">current</span>' : '<span class="pill past">past</span>'}</td>
      <td>${b.sp ? `<a href="${WQE}${b.sp}" target="_blank" rel="noopener">${esc(b.sp)} ↗</a>` : "—"}</td>
    </tr>`).join("");
  return card("Breaches", breaches.length, tableEl(["Date", "Substance", "Permit", "Status", "Sampling point (WQE)"], rows));
}

function permitTable(conditions, dpByPermit, condByPermit) {
  const permits = [...new Set(conditions.map((c) => c.permit))].sort();
  if (!permits.length) return card("Permits &amp; limits", "0", emptyBody("No permits for this selection."));
  const rows = permits.map((p, i) => {
    const conds = (condByPermit[p] || []).filter((c) => !currentSubstance || matchSub(c.subNotation));
    const dps = dpByPermit[p] || [];
    const sp = dps.map((d) => d.sp).filter(Boolean)[0] || "—";
    const inner = tableEl(["Substance", "Upper", "Lower", "Unit"],
      conds.map((c) => `<tr><td>${esc(c.subLabel)}</td><td class="num">${c.upper ? fmtNum(c.upper) : "—"}</td>
        <td class="num">${c.lower ? fmtNum(c.lower) : "—"}</td><td>${prettyUnit(c.unit)}</td></tr>`).join(""));
    return `<tr class="expandable" data-row="${i}"><td><span class="caret">▸</span> <span class="mono">${permitRef(p)}</span></td>
        <td>${conds.length} condition${conds.length === 1 ? "" : "s"}</td><td>${dps.length}</td><td>${esc(sp)}</td></tr>
      <tr class="expand-row hidden" data-exp="${i}"><td colspan="4"><div class="expand-inner"></div></td></tr>`;
  }).join("");
  const c = card("Permits &amp; limits", permits.length, tableEl(["Permit", "Conditions", "Discharge points", "Monitored at"], rows));
  // attach expand data
  wireExpand(c, permits, (p) => {
    const conds = (condByPermit[p] || []).filter((x) => !currentSubstance || matchSub(x.subNotation));
    return tableEl(["Substance", "Upper", "Lower", "Unit"],
      conds.map((x) => `<tr><td>${esc(x.subLabel)}</td><td class="num">${x.upper ? fmtNum(x.upper) : "—"}</td>
        <td class="num">${x.lower ? fmtNum(x.lower) : "—"}</td><td>${prettyUnit(x.unit)}</td></tr>`).join("")).outerHTML;
  });
  return c;
}

function currentLimitsTable(conditions, dpByPermit) {
  if (!conditions.length) return card("Current limits", "0", emptyBody("No current limits for this substance."));
  const rows = [...conditions].sort((a, b) => (Number(b.upper || 0) - Number(a.upper || 0))).map((c) => {
    const sp = (dpByPermit[c.permit] || []).map((d) => d.sp).filter(Boolean)[0] || "—";
    return `<tr><td class="mono">${permitRef(c.permit)}</td><td>${esc(c.subLabel)}</td>
      <td class="num">${c.upper ? "≤ " + fmtNum(c.upper) : ""}${c.lower ? " ≥ " + fmtNum(c.lower) : ""}</td>
      <td>${prettyUnit(c.unit)}</td><td>${esc(sp)}</td></tr>`;
  }).join("");
  return card("Current limits", conditions.length, tableEl(["Permit", "Substance", "Limit", "Unit", "Monitored at"], rows));
}

function futureWorksTable(proposed, limByAction) {
  if (!proposed.length) return card("Future works", "0", emptyBody("No proposed works for this substance."));
  const rows = [...proposed].sort((a, b) => (a.action < b.action ? -1 : 1)).map((l) => {
    const a = DB.actions.find((x) => x.iri === l.action);
    return `<tr>
      <td class="mono">${a ? esc(a.id) : last(l.action)}</td>
      <td>${a ? esc(a.label) : "—"}</td>
      <td>${fmtDate(a?.completion) || "TBC"}</td>
      <td>${l.carried ? '<span class="pill carried">continued</span> ' : '<span class="pill proposed">proposed</span> '}${limitText(l)}</td>
    </tr>`;
  }).join("");
  return card("Future works (proposed limits)", proposed.length, tableEl(["Action", "Name", "Completion", "Proposed limit"], rows));
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
