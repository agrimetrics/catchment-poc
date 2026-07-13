/* Points apart
 * ------------
 * Makes the demonstrator's central argument concrete: EA records about the same regulated thing can
 * be merged reliably only by identifier, not by location. There are two failure modes, and they are
 * mirror images of each other.
 *
 * 1. TOO FAR APART TO MERGE. A permit's discharge point, the monitoring (sampling) point it is
 *    `water:monitoredAt`, and any WINEP action `reg:targetPermit`-linked to it all describe the SAME
 *    regulated works — yet their source geometries sit hundreds of metres to over a kilometre apart on
 *    the ground. All three come from EA sources in British National Grid (EPSG:27700), each captured in
 *    that source encoding, so a projection difference is NOT what separates them: they are simply
 *    different real-world points — the consented outfall vs. the watercourse location it is sampled at.
 *    A proximity join misses the link, or has to open its radius so wide it sweeps in the neighbours.
 *
 * 2. TOO CLOSE TO SEPARATE. Discharge points that are genuinely DIFFERENT things land on the SAME
 *    coordinate. The permit register publishes three grid references, at three levels of a hierarchy —
 *    the discharge SITE (`DISCHARGE_NGR`), the OUTLET (`OUTLET_GRID_REF`) and the EFFLUENT
 *    (`EFFLUENT_GRID_REF`) — and this store hangs the *site* grid ref on every effluent-level discharge
 *    point (see ttl/regulation/README.md). There is no such thing as a per-permit NGR: a site can carry
 *    many permits, so the same coordinate is inherited across permit boundaries. At Brockhill Watercress
 *    Farm that collapses 7 outlets belonging to 4 permits (043244, 043245, 401057, 401058) onto one dot,
 *    while the EA genuinely samples them at 4 different sampling points 120–265 m away. Proximity cannot
 *    separate what proximity has already merged. `water:monitoredAt` names the right one every time.
 *
 * The second mode is the more uncomfortable, because it is not a data-quality accident — it is a
 * modelling choice, and a different, equally defensible choice flips the answer. At Brockhill, rank the
 * sampling points by distance from the SITE grid ref and a nearest-neighbour join gets 1 of those 7
 * outlets right (and that one by luck); rank them from the EFFLUENT grid ref and it gets 7 of 7. The
 * join reports the same confidence either way, so nothing in its output tells you which regime you are
 * in. `monitoredAt` scores 7/7 under every choice.
 *
 * Nor does "just use finer coordinates" rescue the spatial join. Scored across the 69 monitored
 * discharge points for which the register carries ALL THREE grid refs (so the three rows are the same
 * outlets, judged three ways), against the whole 161-point sampling layer:
 *
 *     geometry hung on the discharge point   distinct coords   nearest-neighbour correct
 *     site grid ref  (what this store uses)       37              33 / 69   (48%)
 *     outlet grid ref                             60              53 / 69   (77%)
 *     effluent grid ref                           66              53 / 69   (77%)
 *     water:monitoredAt                            –              69 / 69  (100%)
 *
 * Note the effluent ref — the FINEST geometry available — does no better than the outlet ref, despite
 * resolving 66 distinct coordinates to the outlet's 60. Accuracy is not monotonic in coordinate
 * precision, so there is no "just pick the most precise one" rule that saves you. The spatial join tops
 * out around three in four and its accuracy is set by a schema decision taken two levels above the
 * feature being joined. The identifier is 69/69 and does not depend on the geometry being right, or on
 * there being any geometry at all. That is the argument for linked data, in one catchment.
 *
 * 3. AND IT CAN LAND ON SOMETHING THAT IS NOT AN OUTFALL AT ALL. The candidate set below is EVERY
 *    sampling point the EA holds here — 161 of them, and only 70 monitor a discharge. The other 91 are
 *    rivers, boreholes, bathing waters and investigation points (the app's "measured world"). A GIS
 *    layer contains all of them, and a nearest-feature join is free to pick any one. For 8 of the
 *    scored outlets it does exactly that: the closest sampling point is one that monitors no discharge
 *    whatsoever. Blackheath WRC (042451) — the worked example at the top of this list — is one. Its
 *    nearest sampling point is SW-50951085, "SHERFORD AT SNAILS BRIDGE US BLACKHEATH": a river station,
 *    and one sited UPSTREAM of the works — i.e. the one place in the catchment guaranteed to carry none
 *    of its effluent. The points the EA actually samples it at (SW-50951080, the final effluent, and
 *    SW-50951082, the storm overflow) are further away. The join returns the upstream river as the
 *    works' effluent monitoring point, with no error and no warning. Restricting the candidate layer to
 *    "just the effluent points" would hide this — but you can only restrict it that way if you already
 *    know which points those are, which is the very thing the join was for.
 *
 * (The outlet/effluent grid refs are shown for comparison only — this store ingests the site ref alone;
 * see ttl/regulation/README.md. The scores above come from the register extracts in raw_datasets/.)
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
PREFIX rdfs:  <http://www.w3.org/2000/01/rdf-schema#>
PREFIX skos:  <http://www.w3.org/2004/02/skos/core#>
PREFIX sosa:  <http://www.w3.org/ns/sosa/>`;

// One row per (discharge point × sampling point × action) for a permit; deduped into sets below.
const Q = `${PREFIXES}
SELECT ?permit ?dp ?dpw ?sp ?spw ?action ?al ?aw WHERE {
  ?permit a water:WaterDischargePermit ; reg:permitSite ?dp .
  ?dp geo:hasGeometry/geo:asWKT ?dpw .
  OPTIONAL { ?dp water:monitoredAt ?sp . ?sp geo:hasGeometry/geo:asWKT ?spw . }
  OPTIONAL { ?action reg:targetPermit ?permit ; rdfs:label ?al ; reg:actionSite ?s .
             ?s geo:hasGeometry/geo:asWKT ?aw . }
}`;

// EVERY sampling point in the store — all 161, of which only 70 monitor a discharge. The rest are
// rivers, boreholes and bathing waters that belong to no permit at all. That is deliberately the
// candidate set: a GIS layer holds all of them, and a nearest-feature join is free to pick any one,
// so this is what proximity WOULD actually choose from. Scoring against only the effluent points
// would flatter the join by handing it the answer (see mode 3 in the header).
//
// ?type is carried so the panel can say WHAT proximity landed on when it lands on a non-outfall.
const Q_SP = `${PREFIXES}
SELECT ?sp ?spw ?spl ?type (COUNT(?dp) AS ?nMon) WHERE {
  ?sp a sosa:FeatureOfInterest ; geo:hasGeometry/geo:asWKT ?spw .
  OPTIONAL { ?sp skos:prefLabel ?spl }
  OPTIONAL { ?sp water:samplingPointType/skos:prefLabel ?type }
  OPTIONAL { ?dp water:monitoredAt ?sp }
} GROUP BY ?sp ?spw ?spl ?type`;

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

// The "what GIS sees when the points collide" query — a permit's outlets ranked against EVERY sampling
// point by straight-line distance, next to the sampling point the identifier actually names. Deep-links
// into the SPARQL editor from the stack panel so the reader can run the nearest-neighbour join herself.
//
// EPSG:27700 is a PROJECTED CRS in metres, so plain Pythagoras on easting/northing is the true ground
// distance — no reprojection, no geodesic. SPARQL 1.1 has no SQRT (and this store's geof:distance
// assumes degrees, so it is useless on grid metres), but nearest-neighbour only needs the RANKING, and
// ranking by squared distance is identical. Metres are recovered in the page, which uses haversine on
// the same points and agrees to within a metre at these ranges.
const collisionQuery = (permit) => `${PREFIXES}
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>

# Every outlet of this permit, ranked against every sampling point by distance. Outlets that share a
# coordinate get an IDENTICAL ranking — proximity has no way to tell them apart. Compare the top row
# (what a nearest-neighbour join would pick) with ?identifierSaysThisOne (what monitoredAt names).
SELECT ?outlet ?samplingPoint ?label ?distanceSquared ?identifierSaysThisOne WHERE {
  <${permit}> reg:permitSite ?dp .
  ?dp geo:hasGeometry/geo:asWKT ?dpWkt .
  ?sp a sosa:FeatureOfInterest ; skos:prefLabel ?label ; geo:hasGeometry/geo:asWKT ?spWkt .

  BIND(xsd:decimal(STRBEFORE(STRAFTER(STR(?dpWkt), "POINT("), " ")) AS ?dpE)
  BIND(xsd:decimal(STRBEFORE(STRAFTER(STR(?dpWkt), " "), ")"))      AS ?dpN)
  BIND(xsd:decimal(STRBEFORE(STRAFTER(STR(?spWkt), "POINT("), " ")) AS ?spE)
  BIND(xsd:decimal(STRBEFORE(STRAFTER(STR(?spWkt), " "), ")"))      AS ?spN)
  BIND((?dpE - ?spE) * (?dpE - ?spE) + (?dpN - ?spN) * (?dpN - ?spN) AS ?distanceSquared)

  BIND(EXISTS { ?dp water:monitoredAt ?sp } AS ?identifierSaysThisOne)
  BIND(REPLACE(STR(?dp), "^.*/permit/", "") AS ?outlet)
  BIND(REPLACE(STR(?sp), "^.*/sampling-point/", "") AS ?samplingPoint)

  # Sampling points within 500 m, to keep the ranking readable. Delete this line to rank the whole
  # layer -- a nearest-feature join is choosing from all of it, which is precisely the problem.
  FILTER(?distanceSquared < 250000)
}
ORDER BY ?outlet ?distanceSquared`;

// Permits highlighted in the docs argument; pinned to the top of the list as worked examples.
const FEATURED = {
  "042451": "Blackheath WRC — 5 outlets, 2 monitoring points & two WINEP actions, ~1.4 km across. " +
            "Proximity's nearest point is an UPSTREAM RIVER station, so it scores 0 of 5",
  "EPRBB3593EG": "Largest discharge↔monitoring gap in the catchment (~1 km)",
  "043245": "Both outlets on one coordinate, shared with 3 other permits — so the nearest sampling " +
            "point is the wrong one",
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

// WKT literal -> { ll:[lat,lon], crs, key }. Mirrors app.js parseWkt: an EPSG:27700 tag means the
// numbers are BNG easting/northing (reproject); otherwise they are WGS84 lon lat. Only the first
// coordinate pair is used (a POINT), so the CRS-URI digits that trail a BNG literal are ignored.
//
// `key` is the coordinate AS PUBLISHED (source CRS, source numbers) — never the reprojected pair. Two
// features are "on the same point" only if the store says so exactly; that keeps collision detection a
// fact about the data rather than an artefact of proj4 rounding.
function wktLatLng(wkt) {
  const bng = wkt.includes("27700");
  const src = bng ? wkt.slice(0, wkt.indexOf("<") === -1 ? wkt.length : wkt.indexOf("<")) : wkt;
  const nums = (src.match(/-?\d+\.?\d*/g) || []).map(Number);
  let lon, lat;
  if (bng) { [lon, lat] = proj4("EPSG:27700", "EPSG:4326", [nums[0], nums[1]]); }
  else { lon = nums[0]; lat = nums[1]; }
  return {
    ll: [lat, lon],
    crs: bng ? "EPSG:27700 · British National Grid" : "EPSG:4326 · WGS84",
    key: `${bng ? "BNG" : "WGS84"}:${nums[0]} ${nums[1]}`,
  };
}

function haversine([la1, lo1], [la2, lo2]) {
  const R = 6371000, p = Math.PI / 180;
  const a = Math.sin((la2 - la1) * p / 2) ** 2 +
    Math.cos(la1 * p) * Math.cos(la2 * p) * Math.sin((lo2 - lo1) * p / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
const fmtM = (m) => (m >= 1000 ? (m / 1000).toFixed(2) + " km" : Math.round(m) + " m");
// Some permit references contain slashes ("400114/CF/01" is real), so the IRI percent-encodes them
// inside its path segment: .../permit/400114%2FCF%2F01/outlet/2/effluent/2. The IRI is right — a raw
// slash there would fake a path hierarchy and collide with the outlet path minted under it — but %2F
// is IRI syntax, not part of the permit's name, so it is decoded on the way to the screen.
const unescIri = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
const shortDp = (iri) => unescIri(iri.split("/permit/")[1]);
const shortSp = (iri) => unescIri(iri.split("sampling-point/")[1] || iri);
const shortAct = (iri) => unescIri(iri.split("/action/")[1] || iri);
// "043245/outlet/1/effluent/1" -> "043245 · o1/e1". The stack table lists outlets from several permits
// side by side in a narrow card, so the permit must stay visible while the row stays on one line.
// The permit part is matched greedily because it may itself contain slashes once decoded, and the
// outlet/effluent numbers are NOT digits-only — Blackheath has an outlet "1a".
const tinyDp = (iri) => shortDp(iri).replace(/^(.+)\/outlet\/([^/]+)\/effluent\/([^/]+)$/, "$1 · o$2/e$3");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------------------------------------------------------------------------
// State. `stacks` maps a source coordinate -> every discharge point published at it (only the
// coordinates carrying more than one are kept); `allSp` is every sampling point in the store, i.e. the
// candidate set a nearest-feature spatial join would be choosing from.
let map, combos = [], byId = {}, selected = null, stacks = {}, allSp = [];

async function boot() {
  map = L.map("map", { zoomControl: true }).setView(CENTER, 11);
  L.tileLayer(TILES_URL, { attribution: "© OpenStreetMap contributors", maxZoom: 18 }).addTo(map);

  renderLegend();

  let rows, spRows;
  try { [rows, spRows] = await Promise.all([sparql(Q), sparql(Q_SP)]); }
  catch (e) {
    document.getElementById("pts-stats").innerHTML =
      `<span style="color:var(--red)">Could not load from <code>${esc(ENDPOINT)}</code>: ${esc(e.message)}</span>`;
    return;
  }

  // `monitors` = does this sampling point monitor any discharge at all? A point with none is an
  // AMBIENT station (a river, a borehole) — still in the layer, still pickable by proximity.
  allSp = spRows.map((r) => ({
    iri: r.sp, id: shortSp(r.sp), label: r.spl || shortSp(r.sp),
    type: r.type || "", monitors: Number(r.nMon || 0) > 0,
    ...wktLatLng(r.spw),
  }));
  buildCombos(rows);
  buildStacks();
  drawAll();
  renderStats();
  renderList();
  wireSearch();

  // A permit is a shareable location: points.html#043245 opens straight onto that worked example, so
  // the docs (and the prose above) can link to a specific one. Otherwise open on the flagship.
  const fromHash = decodeURIComponent(location.hash.slice(1));
  const first = byId[fromHash] || byId["042451"] || combos[0];
  if (first) select(first.id, !!byId[fromHash]);
  window.addEventListener("hashchange", () => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (byId[id] && (!selected || selected.id !== id)) select(id);
  });
}

// Every discharge point in the store, bucketed by the coordinate it is published at. A bucket with
// more than one member is a COLLISION: two or more distinct regulated outlets that a GIS sees as a
// single dot. They routinely cross permit boundaries, because the coordinate the store hangs on a
// discharge point is the discharge SITE's grid reference — and one site can hold many permits.
function buildStacks() {
  stacks = {};
  for (const c of combos)
    for (const [iri, g] of Object.entries(c.dp))
      (stacks[g.key] ||= []).push({ permit: c.id, iri, id: shortDp(iri), sp: c.monOf[iri] || null, ll: g.ll });
  for (const k of Object.keys(stacks)) if (stacks[k].length < 2) delete stacks[k];
  // Which shared coordinates does each permit sit on? (Usually one; a permit could straddle several.)
  for (const c of combos)
    c.stackKeys = [...new Set(Object.values(c.dp).map((g) => g.key))].filter((k) => stacks[k]);
}

// The sampling point a nearest-feature spatial join would pick for a location — the whole layer is in
// play, not just the ones this permit happens to be linked to. That is exactly the point: proximity
// does not know about the permit.
function nearestSp(ll) {
  let best = null;
  for (const sp of allSp) {
    const d = haversine(ll, sp.ll);
    if (!best || d < best.d) best = { sp, d };
  }
  return best;
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
  const st = pt.role === "dp" ? stacks[pt.key] : null;
  const collide = st
    ? `<div class="tstack">⊕ ${st.length} discharge points from ` +
      `${new Set(st.map((s) => s.permit)).size} permits share this exact coordinate</div>`
    : "";
  return `<div class="tt" style="color:${r.color}">${r.label}</div>` +
    `<div class="tid">${esc(pt.id)}</div>${extra}${collide}<div class="tcrs">${esc(pt.crs)}</div>`;
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
      // A collided discharge point is drawn once but IS several outlets. Halo it, so the map does not
      // quietly show one dot where the register holds many — that silence is the bug being illustrated.
      if (pt.role === "dp" && stacks[pt.key])
        c.layer.addLayer(L.circleMarker(pt.ll, {
          radius: r.r + 5, color: r.color, weight: 1.5, opacity: 0.65,
          fill: false, dashArray: "3 3", interactive: false,
        }));
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
  if (decodeURIComponent(location.hash.slice(1)) !== id) history.replaceState(null, "", `#${encodeURIComponent(id)}`);

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

  // Both failure modes, counted live: how far apart the things that belong together are, and how many
  // things that do NOT belong together are stacked on one indistinguishable coordinate.
  const nDp = combos.reduce((n, c) => n + Object.keys(c.dp).length, 0);
  const nCoords = new Set(combos.flatMap((c) => Object.values(c.dp).map((g) => g.key))).size;
  const stacked = Object.values(stacks).reduce((n, st) => n + st.length, 0);

  // And the third: the layer proximity chooses FROM. Most of it monitors no discharge at all, so the
  // join's nearest hit is not even guaranteed to be an outfall.
  const nAmb = allSp.filter((s) => !s.monitors).length;

  document.getElementById("pts-stats").innerHTML =
    `<b>${combos.length}</b> permits · <b>${withAct}</b> with WINEP actions. ` +
    `A permit's points typically sit <b>${fmtM(med)}</b> apart, and up to <b>${fmtM(max)}</b>.<br>` +
    `<b>${stacked}</b> of the <b>${nDp}</b> discharge points share their coordinate with another outlet ` +
    `— all ${nDp} of them fit on just <b>${nCoords}</b> points.<br>` +
    `A proximity join picks from the whole sampling layer: <b>${allSp.length}</b> points, of which ` +
    `<b>${nAmb}</b> monitor no discharge at all.`;
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

  // Permit references named in the intro prose are live: clicking one selects it on the map.
  document.querySelectorAll(".pts-jump").forEach((a) =>
    a.addEventListener("click", (ev) => { ev.preventDefault(); select(a.dataset.permit); }));
}

// ---------------------------------------------------------------------------
// The mirror failure, scored. For each coordinate this permit's outlets are stacked on, work out what
// a nearest-feature join WOULD pick (one answer, because the outlets are one point to it) and set that
// against what `water:monitoredAt` actually names for each outlet. The score is the whole argument: the
// spatial join is not merely uncertain here, it is confidently wrong, and it cannot know that it is.
function stackHtml(c) {
  if (!c.stackKeys || !c.stackKeys.length) return "";

  return c.stackKeys.map((k) => {
    const st = stacks[k];
    const nPermits = new Set(st.map((s) => s.permit)).size;
    const near = nearestSp(st[0].ll);             // identical for every member — to a GIS they ARE one point
    const labelOf = (iri) => (allSp.find((s) => s.iri === iri) || {}).label || "—";

    const rows = st.map((s) => {
      const hit = s.sp === near.sp.iri;           // would proximity have landed on the right one?
      return `<tr class="${s.permit === c.id ? "mine" : ""}">
          <td>${esc(tinyDp(s.iri))}</td>
          <td>${s.sp ? esc(shortSp(s.sp)) : "—"}</td>
          <td class="v ${hit ? "ok" : "bad"}">${hit ? "✓" : "✗"}</td>
        </tr>`;
    }).join("");
    const hits = st.filter((s) => s.sp === near.sp.iri).length;

    // The sharpest case: proximity's pick is not a discharge monitoring point at all, but an ambient
    // station (a river, a borehole). It is in the layer, so the join can return it — and does.
    const ambient = !near.sp.monitors
      ? `<p class="stack-warn">⚠ And its pick monitors <b>no discharge at all</b> —
           <b>${esc(near.sp.label)}</b> is ${esc(near.sp.type || "an ambient station")}.
           A nearest-feature join chooses from the whole sampling layer, not just the outfalls in it.</p>`
      : "";

    const deep = `sparql.html#q=${encodeURIComponent(collisionQuery(c.permit))}`;
    return `
      <h3>⊕ Stacked on one coordinate</h3>
      <p class="stack-lede">
        <b>${st.length}</b> discharge points from <b>${nPermits}</b> permit${nPermits > 1 ? "s" : ""}
        sit on this <b>one</b> coordinate. To a map they are a single dot, so a nearest-point join
        picks the same sampling point for every one of them —
        <b>${esc(near.sp.id)}</b>, ${fmtM(near.d)} away.
        <code>monitoredAt</code> names a different one per outlet:
      </p>
      ${ambient}
      <table class="stack">
        <thead><tr><th>outlet</th><th>monitoredAt</th><th class="v">GIS?</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="stack-score">
        nearest point <b class="bad">${hits} / ${st.length}</b> ·
        identifier <b class="ok">${st.length} / ${st.length}</b>
      </p>
      <a class="sparql-link ext-link" href="${deep}" target="_blank" rel="noopener">◈ Run the nearest-point join in SPARQL</a>`;
  }).join("");
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
     ${stackHtml(c)}
     <a class="sparql-link ext-link" href="${deep}" target="_blank" rel="noopener">◈ Open “what GIS sees” in SPARQL</a>`;
  box.classList.remove("hidden");
  box.querySelector(".close").addEventListener("click", () => {
    box.classList.add("hidden");
    if (selected) { styleCombo(selected, false); selected = null; }
    document.querySelectorAll(".pts-row").forEach((el) => el.classList.remove("active"));
  });
}

boot();
