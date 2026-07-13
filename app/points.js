/* Points apart
 * ------------
 * Makes the demonstrator's central argument concrete: EA records about the same regulated thing can
 * be merged reliably only by identifier, not by location.
 *
 * A permit's discharge point, the monitoring (sampling) point it is `water:monitoredAt`, and any
 * WINEP action `reg:targetPermit`-linked to it all describe the SAME regulated works — yet their
 * source geometries sit hundreds of metres to over a kilometre apart on the ground. All three come
 * from EA sources in British National Grid (EPSG:27700), each captured in that source encoding, so a
 * projection difference is NOT what separates them: they are simply different real-world points — the
 * consented outfall vs. the watercourse location it is sampled at. This page draws each permit's
 * cluster as an identifier-linked "spider" and measures the on-the-ground gaps, so the reader can see
 * what a naive nearest-feature spatial join would get wrong — only the identifier link joins them.
 *
 * Data comes live from the same /sparql endpoint as the map app; geometry is reprojected client-side
 * with proj4 (EPSG:27700 → WGS84) exactly as app.js does.
 */

// --- config (shared with the map app via config.js) ---
const CONFIG = window.APP_CONFIG || {};
const ENDPOINT = CONFIG.sparqlEndpoint || "sparql";
const TILES_URL = CONFIG.tilesUrl || "tiles/{z}/{x}/{y}.png";
const CENTER = [50.731, -2.370];

// Same British National Grid definition the map app registers, so EPSG:27700 easting/northing
// reproject identically here.
proj4.defs(
  "EPSG:27700",
  "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 " +
  "+ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs"
);

// The three roles and their marker colours (matching the map app: WINEP = purple).
const ROLE = {
  dp:  { color: "#3aa0ff", r: 7, label: "Discharge point" },
  sp:  { color: "#46b978", r: 6, label: "Monitoring point" },
  act: { color: "#a06bff", r: 7, label: "WINEP action site" },
};

const PREFIXES = `
PREFIX water: <http://environment.data.gov.uk/ontology/water/>
PREFIX reg:   <http://environment.data.gov.uk/ontology/regulation/>
PREFIX geo:   <http://www.opengis.net/ont/geosparql#>
PREFIX rdfs:  <http://www.w3.org/2000/01/rdf-schema#>`;

// One row per (discharge point × sampling point × action) for a permit; deduped into sets below.
const Q = `${PREFIXES}
SELECT ?permit ?dp ?dpw ?sp ?spw ?action ?al ?aw WHERE {
  ?permit a water:WaterDischargePermit ; reg:permitSite ?dp .
  ?dp geo:hasGeometry/geo:asWKT ?dpw .
  OPTIONAL { ?dp water:monitoredAt ?sp . ?sp geo:hasGeometry/geo:asWKT ?spw . }
  OPTIONAL { ?action reg:targetPermit ?permit ; rdfs:label ?al ; reg:actionSite ?s .
             ?s geo:hasGeometry/geo:asWKT ?aw . }
}`;

// The "what GIS sees" query, per permit — a provenance deep-link into the SPARQL editor.
const gisQuery = (permit) => `${PREFIXES}
SELECT ?role ?feature ?wkt WHERE {
  { <${permit}> reg:permitSite ?feature .
    ?feature geo:hasGeometry/geo:asWKT ?wkt . BIND("discharge point" AS ?role) }
  UNION
  { <${permit}> reg:permitSite/water:monitoredAt ?feature .
    ?feature geo:hasGeometry/geo:asWKT ?wkt . BIND("monitoring point" AS ?role) }
  UNION
  { ?a reg:targetPermit <${permit}> ; reg:actionSite ?feature .
    ?feature geo:hasGeometry/geo:asWKT ?wkt . BIND("WINEP action site" AS ?role) }
} ORDER BY ?role`;

// Permits highlighted in the docs argument; pinned to the top of the list as worked examples.
const FEATURED = {
  "042451": "Blackheath WRC — discharge, monitoring & two WINEP actions, ~1.4 km across",
  "EPRBB3593EG": "Largest discharge↔monitoring gap in the catchment (~1 km)",
};

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

// WKT literal -> { ll:[lat,lon], crs }. Mirrors app.js parseWkt: an EPSG:27700 tag means the numbers
// are BNG easting/northing (reproject); otherwise they are WGS84 lon lat. Only the first coordinate
// pair is used (a POINT), so the CRS-URI digits that trail a BNG literal are ignored.
function wktLatLng(wkt) {
  const bng = wkt.includes("27700");
  const src = bng ? wkt.slice(0, wkt.indexOf("<") === -1 ? wkt.length : wkt.indexOf("<")) : wkt;
  const nums = (src.match(/-?\d+\.?\d*/g) || []).map(Number);
  let lon, lat;
  if (bng) { [lon, lat] = proj4("EPSG:27700", "EPSG:4326", [nums[0], nums[1]]); }
  else { lon = nums[0]; lat = nums[1]; }
  return { ll: [lat, lon], crs: bng ? "EPSG:27700 · British National Grid" : "EPSG:4326 · WGS84" };
}

function haversine([la1, lo1], [la2, lo2]) {
  const R = 6371000, p = Math.PI / 180;
  const a = Math.sin((la2 - la1) * p / 2) ** 2 +
    Math.cos(la1 * p) * Math.cos(la2 * p) * Math.sin((lo2 - lo1) * p / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
const fmtM = (m) => (m >= 1000 ? (m / 1000).toFixed(2) + " km" : Math.round(m) + " m");
const shortDp = (iri) => iri.split("/permit/")[1];
const shortSp = (iri) => iri.split("sampling-point/")[1] || iri;
const shortAct = (iri) => iri.split("/action/")[1] || iri;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------------------------------------------------------------------------
// State
let map, combos = [], byId = {}, selected = null;

async function boot() {
  map = L.map("map", { zoomControl: true }).setView(CENTER, 11);
  L.tileLayer(TILES_URL, { attribution: "© OpenStreetMap contributors", maxZoom: 18 }).addTo(map);

  renderLegend();

  let rows;
  try { rows = await sparql(Q); }
  catch (e) {
    document.getElementById("pts-stats").innerHTML =
      `<span style="color:var(--red)">Could not load from <code>${esc(ENDPOINT)}</code>: ${esc(e.message)}</span>`;
    return;
  }

  buildCombos(rows);
  drawAll();
  renderStats();
  renderList();
  wireSearch();

  // Open on the flagship worked example if present.
  const first = byId["042451"] || combos[0];
  if (first) select(first.id, false);
}

// Group the flat rows into one record per permit: sets of discharge / monitoring / action points,
// which monitoring point belongs to which discharge point, and the derived geometry summaries.
function buildCombos(rows) {
  const map_ = {};
  for (const r of rows) {
    const id = shortDp(r.permit);
    const c = map_[id] ||= { id, permit: r.permit, dp: {}, sp: {}, act: {}, monOf: {} };
    if (r.dp && !c.dp[r.dp]) c.dp[r.dp] = wktLatLng(r.dpw);
    if (r.sp) { if (!c.sp[r.sp]) c.sp[r.sp] = wktLatLng(r.spw); c.monOf[r.dp] = r.sp; }
    if (r.action && !c.act[r.action]) c.act[r.action] = Object.assign(wktLatLng(r.aw), { label: r.al });
  }

  combos = Object.values(map_).map((c) => {
    // Anchor the spider on the primary discharge point (outlet 1 / effluent 1 if present).
    const dpIris = Object.keys(c.dp);
    const anchor = c.dp[dpIris.find((i) => /\/outlet\/1\/effluent\/1$/.test(i)) || dpIris[0]];

    // Edges: each discharge point -> its monitoring point; the anchor -> each action site.
    c.edges = [];
    for (const [dpIri, g] of Object.entries(c.dp)) {
      const spIri = c.monOf[dpIri];
      if (spIri && c.sp[spIri]) c.edges.push({ a: g.ll, b: c.sp[spIri].ll, d: haversine(g.ll, c.sp[spIri].ll) });
    }
    for (const g of Object.values(c.act)) c.edges.push({ a: anchor.ll, b: g.ll, d: haversine(anchor.ll, g.ll) });

    // All member points + the maximum pairwise gap (headline "how far apart").
    c.points = [
      ...Object.entries(c.dp).map(([iri, g]) => ({ role: "dp", iri, id: shortDp(iri), ...g })),
      ...Object.entries(c.sp).map(([iri, g]) => ({ role: "sp", iri, id: shortSp(iri), ...g })),
      ...Object.entries(c.act).map(([iri, g]) => ({ role: "act", iri, id: shortAct(iri), ...g })),
    ];
    let maxGap = 0;
    for (let i = 0; i < c.points.length; i++)
      for (let j = i + 1; j < c.points.length; j++)
        maxGap = Math.max(maxGap, haversine(c.points[i].ll, c.points[j].ll));
    c.maxGap = maxGap;
    c.nAct = Object.keys(c.act).length;
    c.featured = c.id in FEATURED;
    return c;
  }).sort((a, b) => b.maxGap - a.maxGap);

  byId = Object.fromEntries(combos.map((c) => [c.id, c]));
}

// ---------------------------------------------------------------------------
// Map drawing. Every combo is drawn once into its own layer group (thin/dim by default); selecting a
// combo restyles it bold, makes its tooltips permanent and labels each leg with its length.
function tipHtml(pt) {
  const r = ROLE[pt.role];
  const extra = pt.role === "act" && pt.label ? `<div>${esc(pt.label)}</div>` : "";
  return `<div class="tt" style="color:${r.color}">${r.label}</div>` +
    `<div class="tid">${esc(pt.id)}</div>${extra}<div class="tcrs">${esc(pt.crs)}</div>`;
}

function drawAll() {
  for (const c of combos) {
    c.layer = L.layerGroup();
    for (const e of c.edges) {
      const line = L.polyline([e.a, e.b], { color: "#7d8a99", weight: 1.5, opacity: 0.5, dashArray: "4 4" });
      e.line = line;
      c.layer.addLayer(line);
    }
    c.markers = [];
    for (const pt of c.points) {
      const r = ROLE[pt.role];
      const mk = L.circleMarker(pt.ll, { radius: r.r, color: "#0b1016", weight: 1.5, fillColor: r.color, fillOpacity: 0.9 })
        .bindTooltip(tipHtml(pt), { className: "pts-tip", direction: "top", offset: [0, -4] });
      mk._pt = pt;
      c.markers.push(mk);
      c.layer.addLayer(mk);
    }
    c.layer.addTo(map);
  }
}

function styleCombo(c, on) {
  for (const e of c.edges) {
    e.line.setStyle(on
      ? { color: "#f5a623", weight: 3, opacity: 0.95, dashArray: null }
      : { color: "#7d8a99", weight: 1.5, opacity: 0.5, dashArray: "4 4" });
    if (on) e.line.bringToFront();
    // Permanent distance label at the leg midpoint.
    if (on && !e.tip) {
      const mid = [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2];
      e.tip = L.tooltip({ permanent: true, direction: "center", className: "pts-leg" })
        .setLatLng(mid).setContent(fmtM(e.d));
      c.layer.addLayer(e.tip);
    } else if (!on && e.tip) {
      c.layer.removeLayer(e.tip); e.tip = null;
    }
  }
  for (const mk of c.markers) {
    const pt = mk._pt, r = ROLE[pt.role];
    mk.setStyle({ radius: on ? r.r + 2 : r.r, weight: on ? 2.5 : 1.5, color: on ? "#fff" : "#0b1016" });
    // Rebind so the focused combo shows its identifiers without a hover.
    mk.unbindTooltip();
    mk.bindTooltip(tipHtml(pt), { className: "pts-tip", direction: "top", offset: [0, -4], permanent: on });
    if (on) mk.bringToFront();
  }
}

function select(id, pan = true) {
  const c = byId[id];
  if (!c) return;
  if (selected && selected !== c) styleCombo(selected, false);
  selected = c;
  styleCombo(c, true);

  if (pan) {
    const b = L.latLngBounds(c.points.map((p) => p.ll));
    if (c.points.length === 1) map.setView(c.points[0].ll, 15);
    else map.fitBounds(b.pad(0.35), { maxZoom: 16 });
  }

  document.querySelectorAll(".pts-row").forEach((el) => el.classList.toggle("active", el.dataset.id === id));
  renderDetail(c);
}

// ---------------------------------------------------------------------------
// Left rail
function renderLegend() {
  const keys = [
    ...Object.values(ROLE).map((r) => `<span class="key"><span class="swatch" style="background:${r.color}"></span>${r.label}</span>`),
    `<span class="key"><span class="swatch line"></span>identifier link · gap</span>`,
  ];
  document.getElementById("pts-legend").innerHTML = keys.join("");
}

function renderStats() {
  const gaps = combos.map((c) => c.maxGap).filter((g) => g > 0).sort((a, b) => a - b);
  const med = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
  const max = gaps.length ? gaps[gaps.length - 1] : 0;
  const withAct = combos.filter((c) => c.nAct).length;
  document.getElementById("pts-stats").innerHTML =
    `<b>${combos.length}</b> permits · <b>${withAct}</b> with WINEP actions. ` +
    `Median discharge-cluster spread <b>${fmtM(med)}</b>, up to <b>${fmtM(max)}</b> — ` +
    `every one merged by identifier, none by proximity.`;
}

function rowHtml(c) {
  const badges = [
    c.featured ? `<span class="badge star">★ example</span>` : "",
    c.nAct ? `<span class="badge winep">${c.nAct} WINEP</span>` : "",
    `<span class="badge">${c.points.length} pts</span>`,
  ].filter(Boolean).join("");
  const note = FEATURED[c.id] ? `<span>${esc(FEATURED[c.id])}</span>` : "";
  return `<div class="pts-row" data-id="${c.id}" data-search="${esc(c.id.toLowerCase())}">
      <span class="pid">${esc(c.id)}</span>
      <span class="gap">${fmtM(c.maxGap)}</span>
      <span class="sub">${badges}${note}</span>
    </div>`;
}

function renderList() {
  const featured = combos.filter((c) => c.featured);
  const rest = combos.filter((c) => !c.featured);
  const list = document.getElementById("pts-list");
  list.innerHTML =
    (featured.length ? `<div class="grp">Worked examples</div>` + featured.map(rowHtml).join("") : "") +
    `<div class="grp">All permits · widest gap first</div>` + rest.map(rowHtml).join("");
  list.querySelectorAll(".pts-row").forEach((el) => el.addEventListener("click", () => select(el.dataset.id)));
}

function wireSearch() {
  const input = document.getElementById("pts-search");
  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    document.querySelectorAll(".pts-row").forEach((el) => {
      el.style.display = !q || el.dataset.search.includes(q) ? "" : "none";
    });
  });
}

// ---------------------------------------------------------------------------
// Floating detail card
function renderDetail(c) {
  const box = document.getElementById("pts-detail");
  const pts = c.points.map((p) => {
    const r = ROLE[p.role];
    const lbl = p.role === "act" && p.label ? ` — ${esc(p.label)}` : "";
    return `<div class="pt"><span class="dotmark" style="background:${r.color}"></span>
      <span><span class="id">${esc(p.id)}</span>${lbl}<br><span class="crs">${r.label} · ${esc(p.crs)}</span></span></div>`;
  }).join("");

  // All pairwise gaps, widest first — "how far apart everything is".
  const pairs = [];
  for (let i = 0; i < c.points.length; i++)
    for (let j = i + 1; j < c.points.length; j++) {
      const a = c.points[i], b = c.points[j];
      if (a.ll[0] === b.ll[0] && a.ll[1] === b.ll[1]) continue; // coincident (e.g. duplicate outlet)
      pairs.push({ a, b, d: haversine(a.ll, b.ll) });
    }
  pairs.sort((x, y) => y.d - x.d);
  const gapRows = pairs.length
    ? pairs.map((p) => `<tr><td>${ROLE[p.a.role].label} <span class="crs">${esc(p.a.id)}</span> ↔ ${ROLE[p.b.role].label} <span class="crs">${esc(p.b.id)}</span></td><td class="d">${fmtM(p.d)}</td></tr>`).join("")
    : `<tr><td colspan="2" class="crs">All member points share one location.</td></tr>`;

  const deep = `sparql.html#q=${encodeURIComponent(gisQuery(c.permit))}`;
  const note = FEATURED[c.id] ? `<p class="lede">${esc(FEATURED[c.id])}</p>` : "";
  box.innerHTML =
    `<button class="close" title="Clear selection">✕</button>
     <h2>Permit ${esc(c.id)}</h2>${note}
     <h3>Points (${c.points.length})</h3>${pts}
     <h3>Distances apart</h3><table class="gaps"><tbody>${gapRows}</tbody></table>
     <a class="sparql-link ext-link" href="${deep}" target="_blank" rel="noopener">◈ Open “what GIS sees” in SPARQL</a>`;
  box.classList.remove("hidden");
  box.querySelector(".close").addEventListener("click", () => {
    box.classList.add("hidden");
    if (selected) { styleCombo(selected, false); selected = null; }
    document.querySelectorAll(".pts-row").forEach((el) => el.classList.remove("active"));
  });
}

boot();
