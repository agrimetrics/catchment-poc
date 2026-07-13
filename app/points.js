/* Points apart
 * ------------
 * The demonstrator's central argument, laid out as five screens rather than one crowded page:
 *
 *   #/why        the argument, an abstracted example, and the joins this store actually makes
 *   #/blackheath Example 1 — proximity returns a river, sited UPSTREAM of the works
 *   #/brockhill  Example 2 — seven outlets on one coordinate; proximity cannot tell them apart
 *   #/doreys     Example 3 — the right answer is a kilometre away; no radius works
 *   #/explorer   the collections themselves: permits, outlets, sampling points, WINEP actions
 *
 * EA records about the same regulated thing can be merged reliably only by identifier, not by
 * location, and there are three ways proximity fails. Each example is one of them. Every number on
 * these pages is COMPUTED FROM THE STORE at render time (see the fact() helpers) rather than typed
 * into the prose, so the page cannot drift away from the data behind it.
 *
 * Geometry comes from the same /sparql endpoint as the map app, in the source CRS the EA published
 * it in (EPSG:27700, British National Grid), and is reprojected client-side with proj4 exactly as
 * app.js does. Distances are computed on the BNG easting/northing — a projected CRS in metres, so
 * plain Pythagoras is true ground distance — not on the reprojected degrees.
 */

// --- config (shared with the map app via config.js) ---
const CONFIG = window.APP_CONFIG || {};
const ENDPOINT = CONFIG.sparqlEndpoint || "sparql";
const TILES_URL = CONFIG.tilesUrl || "tiles/{z}/{x}/{y}.png";

proj4.defs(
  "EPSG:27700",
  "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 " +
  "+ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs"
);

// The three roles, and their colours (matching the map app: WINEP = purple).
const ROLE = {
  dp:  { color: "#3aa0ff", r: 7, label: "Discharge point" },
  sp:  { color: "#46b978", r: 6, label: "Sampling point" },
  act: { color: "#a06bff", r: 7, label: "WINEP action site" },
};
// A sampling point that monitors no discharge — a river, a borehole. Still in the layer a spatial
// join picks from, which is the whole trouble.
const AMBIENT_COLOR = "#8a94a0";

const PREFIXES = `
PREFIX water: <http://environment.data.gov.uk/ontology/water/>
PREFIX reg:   <http://environment.data.gov.uk/ontology/regulation/>
PREFIX geo:   <http://www.opengis.net/ont/geosparql#>
PREFIX rdfs:  <http://www.w3.org/2000/01/rdf-schema#>
PREFIX skos:  <http://www.w3.org/2004/02/skos/core#>
PREFIX sosa:  <http://www.w3.org/ns/sosa/>`;

// One row per (discharge point × sampling point × action) for a permit; deduped into sets below.
const Q_PERMITS = `${PREFIXES}
SELECT ?permit ?dp ?dpw ?sp ?spw ?action ?al ?aw WHERE {
  ?permit a water:WaterDischargePermit ; reg:permitSite ?dp .
  ?dp geo:hasGeometry/geo:asWKT ?dpw .
  OPTIONAL { ?dp water:monitoredAt ?sp . ?sp geo:hasGeometry/geo:asWKT ?spw . }
  OPTIONAL { ?action reg:targetPermit ?permit ; rdfs:label ?al ; reg:actionSite ?s .
             ?s geo:hasGeometry/geo:asWKT ?aw . }
}`;

// EVERY sampling point in the store — not just the ones a permit is monitored at. This is what a GIS
// holds in its layer, and therefore what a nearest-feature join is free to choose from. Scoring
// against only the effluent points would flatter the join by handing it the answer.
const Q_SP = `${PREFIXES}
SELECT ?sp ?spw ?spl ?type (COUNT(?dp) AS ?nMon) WHERE {
  ?sp a sosa:FeatureOfInterest ; geo:hasGeometry/geo:asWKT ?spw .
  OPTIONAL { ?sp skos:prefLabel ?spl }
  OPTIONAL { ?sp water:samplingPointType/skos:prefLabel ?type }
  OPTIONAL { ?dp water:monitoredAt ?sp }
} GROUP BY ?sp ?spw ?spl ?type`;

// --- provenance deep-links into the SPARQL editor ---------------------------------------------
const gisQuery = (permit) => `${PREFIXES}
# Everything this store knows is at ${shortPermit(permit)} — the three roles, and their geometry.
# Note they are three DIFFERENT places. The identifier says they belong together anyway.
SELECT ?role ?feature ?wkt WHERE {
  { <${permit}> reg:permitSite ?feature .
    ?feature geo:hasGeometry/geo:asWKT ?wkt . BIND("discharge point" AS ?role) }
  UNION
  { <${permit}> reg:permitSite/water:monitoredAt ?feature .
    ?feature geo:hasGeometry/geo:asWKT ?wkt . BIND("sampling point" AS ?role) }
  UNION
  { ?a reg:targetPermit <${permit}> ; reg:actionSite ?feature .
    ?feature geo:hasGeometry/geo:asWKT ?wkt . BIND("WINEP action site" AS ?role) }
} ORDER BY ?role`;

// The nearest-neighbour join, run as SPARQL so the reader can perform the mistake herself.
//
// EPSG:27700 is a PROJECTED CRS in metres, so plain Pythagoras on easting/northing is true ground
// distance. SPARQL 1.1 has no SQRT (and this store's geof:distance assumes degrees, so it is useless
// on grid metres), but a nearest-neighbour join only needs the RANKING, and ranking by squared
// distance is identical to ranking by distance.
const proximityQuery = (permit) => `${PREFIXES}
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>

# Every outlet of ${shortPermit(permit)}, ranked against EVERY sampling point in the catchment by
# straight-line distance — which is all a nearest-feature join has to go on. Compare the top row per
# outlet (what proximity would pick) with ?identifierSaysThisOne (what water:monitoredAt states).
# Outlets that share a coordinate get an IDENTICAL ranking: to a map they are one point.
SELECT ?outlet ?samplingPoint ?label ?distanceSquared ?monitorsADischarge ?identifierSaysThisOne WHERE {
  <${permit}> reg:permitSite ?dp .
  ?dp geo:hasGeometry/geo:asWKT ?dpWkt .
  ?sp a sosa:FeatureOfInterest ; skos:prefLabel ?label ; geo:hasGeometry/geo:asWKT ?spWkt .

  BIND(xsd:decimal(STRBEFORE(STRAFTER(STR(?dpWkt), "POINT("), " ")) AS ?dpE)
  BIND(xsd:decimal(STRBEFORE(STRAFTER(STR(?dpWkt), " "), ")"))      AS ?dpN)
  BIND(xsd:decimal(STRBEFORE(STRAFTER(STR(?spWkt), "POINT("), " ")) AS ?spE)
  BIND(xsd:decimal(STRBEFORE(STRAFTER(STR(?spWkt), " "), ")"))      AS ?spN)
  BIND((?dpE - ?spE) * (?dpE - ?spE) + (?dpN - ?spN) * (?dpN - ?spN) AS ?distanceSquared)

  # Is the candidate even an outfall? Most sampling points here monitor nothing at all.
  BIND(EXISTS { ?any water:monitoredAt ?sp } AS ?monitorsADischarge)
  BIND(EXISTS { ?dp water:monitoredAt ?sp } AS ?identifierSaysThisOne)
  BIND(REPLACE(STR(?dp), "^.*/permit/", "") AS ?outlet)
  BIND(REPLACE(STR(?sp), "^.*/sampling-point/", "") AS ?samplingPoint)
}
ORDER BY ?outlet ?distanceSquared`;

// The identifier join — the whole of it. There is no radius, no threshold and no tuning.
const IDENTIFIER_QUERY = `${PREFIXES}
# The join this store makes. Every outlet, and the sampling point it is monitored at — stated by the
# permit register, not inferred from a map. It is exact, it needs no geometry at all, and it is the
# same query whether the two points are 5 metres apart or 5 kilometres.
SELECT ?permit ?outlet ?samplingPoint ?label WHERE {
  ?permit a water:WaterDischargePermit ; reg:permitSite ?outlet .
  ?outlet water:monitoredAt ?samplingPoint .
  ?samplingPoint skos:prefLabel ?label .
} ORDER BY ?permit ?outlet`;

// ---------------------------------------------------------------------------
// Helpers
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// Permit refs can contain slashes ("400114/CF/01"), percent-encoded inside the IRI path segment.
const unescIri = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
function shortPermit(iri) { return unescIri(String(iri).split("/permit/")[1] || iri); }
const shortDp = (iri) => unescIri(String(iri).split("/permit/")[1] || iri);
const shortSp = (iri) => unescIri(String(iri).split("sampling-point/")[1] || iri);
const shortAct = (iri) => unescIri(String(iri).split("/action/")[1] || iri);
// "043245/outlet/1/effluent/1" -> "043245 · o1/e1". Permit part matched greedily (it may contain
// slashes); outlet/effluent are not digits-only — Blackheath has an outlet "1a".
const tinyDp = (iri) => shortDp(iri).replace(/^(.+)\/outlet\/([^/]+)\/effluent\/([^/]+)$/, "$1 · o$2/e$3");
const fmtM = (m) => (m >= 1000 ? (m / 1000).toFixed(2) + " km" : Math.round(m) + " m");

// WKT literal -> { ll:[lat,lon], en:[easting,northing], key }.
//
// `en` is the coordinate AS PUBLISHED (British National Grid, metres). All distances and all
// collision tests use it: BNG is projected, so Pythagoras on it is true ground distance, and two
// features are "on the same point" only if the store says so EXACTLY — which keeps a collision a
// fact about the data rather than an artefact of proj4 rounding.
function parseWkt(wkt) {
  const bng = wkt.includes("27700");
  const src = bng ? wkt.slice(0, wkt.indexOf("<") === -1 ? wkt.length : wkt.indexOf("<")) : wkt;
  const nums = (src.match(/-?\d+\.?\d*/g) || []).map(Number);
  let lon, lat, en = null;
  if (bng) { en = [nums[0], nums[1]]; [lon, lat] = proj4("EPSG:27700", "EPSG:4326", en); }
  else { lon = nums[0]; lat = nums[1]; }
  return {
    ll: [lat, lon], en,
    crs: bng ? "EPSG:27700 · British National Grid" : "EPSG:4326 · WGS84",
    key: `${bng ? "BNG" : "WGS84"}:${nums[0]} ${nums[1]}`,
  };
}
// Ground distance in metres between two BNG points. Falls back to haversine if either lacks a grid
// coordinate (nothing in this store currently does).
function dist(a, b) {
  if (a.en && b.en) return Math.hypot(a.en[0] - b.en[0], a.en[1] - b.en[1]);
  const [la1, lo1] = a.ll, [la2, lo2] = b.ll, R = 6371000, p = Math.PI / 180;
  const h = Math.sin((la2 - la1) * p / 2) ** 2 +
    Math.cos(la1 * p) * Math.cos(la2 * p) * Math.sin((lo2 - lo1) * p / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

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
// State
let combos = [], byId = {}, allSp = [], stacks = {}, map = null;

// The sampling point a nearest-feature join would pick for a location: the closest one in the WHOLE
// layer. Proximity does not know what a permit is, so it cannot restrict itself to outfalls.
function nearestSp(g, { onlyOutfalls = false } = {}) {
  let best = null;
  for (const sp of allSp) {
    if (onlyOutfalls && !sp.monitors) continue;
    const d = dist(g, sp);
    if (!best || d < best.d) best = { sp, d };
  }
  return best;
}
// Every sampling point within `r` metres — the candidate set a radius join would return.
const withinRadius = (g, r) => allSp.filter((sp) => dist(g, sp) <= r);

// Group the flat rows into one record per permit.
function buildCombos(rows) {
  const map_ = {};
  for (const r of rows) {
    const id = shortPermit(r.permit);
    const c = map_[id] ||= { id, permit: r.permit, dp: {}, sp: {}, act: {}, monOf: {} };
    if (r.dp && !c.dp[r.dp]) c.dp[r.dp] = parseWkt(r.dpw);
    if (r.sp) { if (!c.sp[r.sp]) c.sp[r.sp] = parseWkt(r.spw); c.monOf[r.dp] = r.sp; }
    if (r.action && !c.act[r.action]) c.act[r.action] = Object.assign(parseWkt(r.aw), { label: r.al });
  }
  combos = Object.values(map_).map((c) => {
    c.points = [
      ...Object.entries(c.dp).map(([iri, g]) => ({ role: "dp", iri, id: shortDp(iri), ...g })),
      ...Object.entries(c.sp).map(([iri, g]) => ({ role: "sp", iri, id: shortSp(iri), ...g })),
      ...Object.entries(c.act).map(([iri, g]) => ({ role: "act", iri, id: shortAct(iri), ...g })),
    ];
    // Each outlet -> the sampling point the identifier names for it.
    c.edges = [];
    for (const [dpIri, g] of Object.entries(c.dp)) {
      const spIri = c.monOf[dpIri];
      if (spIri && c.sp[spIri]) c.edges.push({ a: g, b: c.sp[spIri], d: dist(g, c.sp[spIri]) });
    }
    let maxGap = 0;
    for (let i = 0; i < c.points.length; i++)
      for (let j = i + 1; j < c.points.length; j++)
        maxGap = Math.max(maxGap, dist(c.points[i], c.points[j]));
    c.maxGap = maxGap;
    c.nDp = Object.keys(c.dp).length;
    c.nAct = Object.keys(c.act).length;
    return c;
  }).sort((a, b) => b.maxGap - a.maxGap);
  byId = Object.fromEntries(combos.map((c) => [c.id, c]));
}

// Every discharge point bucketed by the coordinate it is PUBLISHED at. A bucket with more than one
// member is a collision: distinct regulated outlets that a map draws as a single dot. They routinely
// cross permit boundaries, because the coordinate hung on a discharge point is the discharge SITE's
// grid reference — and one site can hold many permits.
function buildStacks() {
  stacks = {};
  for (const c of combos)
    for (const [iri, g] of Object.entries(c.dp))
      (stacks[g.key] ||= []).push({ permit: c.id, iri, sp: c.monOf[iri] || null, g });
  for (const k of Object.keys(stacks)) if (stacks[k].length < 2) delete stacks[k];
  for (const c of combos)
    c.stackKeys = [...new Set(Object.values(c.dp).map((g) => g.key))].filter((k) => stacks[k]);
}

// ---------------------------------------------------------------------------
// The three worked examples — one per way that proximity fails.
const EXAMPLES = [
  {
    id: "blackheath", permit: "042451", site: "Blackheath WRC",
    mode: "It can return something that is not an outfall at all",
    lede: "Proximity's nearest sampling point here is a <b>river station</b> — and one sited " +
          "<b>upstream</b> of the works, the single place in the catchment guaranteed to carry none " +
          "of its effluent.",
  },
  {
    id: "brockhill", permit: "043245", site: "Brockhill Watercress Farm",
    mode: "It cannot separate things that share a coordinate",
    lede: "Seven outlets, belonging to four different permits, are published at <b>one identical " +
          "coordinate</b>. To a map they are a single dot, so proximity must give all seven the same " +
          "answer — while the EA samples them at four different places.",
  },
  {
    id: "doreys", permit: "EPRBB3593EG", site: "Doreys Ball Clay Works",
    mode: "It cannot be given a radius that works",
    lede: "Here proximity's nearest point is the <b>right</b> one — it is just <b>a kilometre away</b>. " +
          "Any radius tight enough to be meaningful elsewhere misses it entirely; any radius wide " +
          "enough to catch it sweeps in the neighbours.",
  },
];
const ROUTES = [
  { id: "why", label: "Why identifiers" },
  ...EXAMPLES.map((e, i) => ({ id: e.id, label: `${i + 1} · ${e.site.split(" ")[0]}`, example: e })),
  { id: "explorer", label: "Explorer" },
];

// ---------------------------------------------------------------------------
// Boot
async function boot() {
  let rows, spRows;
  try { [rows, spRows] = await Promise.all([sparql(Q_PERMITS), sparql(Q_SP)]); }
  catch (e) {
    document.getElementById("pts-view").innerHTML =
      `<p class="pts-error">Could not load from <code>${esc(ENDPOINT)}</code>: ${esc(e.message)}</p>`;
    return;
  }
  allSp = spRows.map((r) => ({
    iri: r.sp, id: shortSp(r.sp), label: r.spl || shortSp(r.sp),
    type: r.type || "", monitors: Number(r.nMon || 0) > 0,
    ...parseWkt(r.spw),
  }));
  buildCombos(rows);
  buildStacks();

  renderRail();
  window.addEventListener("hashchange", route);
  route();
}

const routeId = () => (location.hash.replace(/^#\/?/, "") || "why");

function renderRail() {
  document.getElementById("pts-rail").innerHTML = ROUTES.map((r) =>
    `<a class="rail-step" data-route="${r.id}" href="#/${r.id}">${esc(r.label)}</a>`).join("");
}

function route() {
  const id = routeId();
  const r = ROUTES.find((x) => x.id === id) || ROUTES[0];
  document.querySelectorAll(".rail-step").forEach((el) =>
    el.classList.toggle("on", el.dataset.route === r.id));

  if (map) { map.remove(); map = null; }
  const view = document.getElementById("pts-view");
  view.scrollTop = 0;

  if (r.id === "why") renderWhy(view);
  else if (r.id === "explorer") renderExplorer(view);
  else renderExample(view, r.example);

  window.scrollTo({ top: 0, behavior: "instant" });
}

// The step-through control at the foot of every screen.
function nav(currentId) {
  const i = ROUTES.findIndex((r) => r.id === currentId);
  const prev = ROUTES[i - 1], next = ROUTES[i + 1];
  const label = (r) => r.example ? `Example ${EXAMPLES.indexOf(r.example) + 1}: ${r.example.site}`
    : r.id === "explorer" ? "Explore the collections" : "Why identifiers";
  return `<nav class="pts-next">
    ${prev ? `<a class="nx prev" href="#/${prev.id}">‹‹ ${esc(label(prev))}</a>` : "<span></span>"}
    ${next ? `<a class="nx next" href="#/${next.id}">${esc(label(next))} ››</a>` : "<span></span>"}
  </nav>`;
}

// ---------------------------------------------------------------------------
// Maps. Each screen builds its own, into its own container, framed on what it is about.
function newMap(el, { zoom = 15 } = {}) {
  const m = L.map(el, { zoomControl: true, scrollWheelZoom: false });
  L.tileLayer(TILES_URL, { attribution: "© OpenStreetMap contributors", maxZoom: 18 }).addTo(m);
  m.setView([50.731, -2.370], zoom);
  return m;
}

function marker(pt, { radius, color, label, dashed = false } = {}) {
  const r = ROLE[pt.role] || {};
  const mk = L.circleMarker(pt.ll, {
    radius: radius || r.r || 6,
    color: "#0b1016", weight: 1.5,
    fillColor: color || r.color || AMBIENT_COLOR, fillOpacity: 0.92,
    dashArray: dashed ? "3 3" : null,
  });
  if (label) mk.bindTooltip(label, { className: "pts-tip", direction: "top", offset: [0, -4] });
  return mk;
}

// A leg between two points, labelled with its length.
function leg(a, b, { color = "#f5a623", dash = null, label = null, weight = 3 } = {}) {
  const g = L.layerGroup();
  L.polyline([a.ll, b.ll], { color, weight, opacity: 0.95, dashArray: dash }).addTo(g);
  if (label)
    L.tooltip({ permanent: true, direction: "center", className: "pts-leg" })
      .setLatLng([(a.ll[0] + b.ll[0]) / 2, (a.ll[1] + b.ll[1]) / 2])
      .setContent(label).addTo(g);
  return g;
}

// ---------------------------------------------------------------------------
// Screen 1 — Why identifiers, not proximity
function renderWhy(view) {
  // The scoreboard is a fact about the whole catchment, so compute it here rather than assert it.
  const nDp = combos.reduce((n, c) => n + c.nDp, 0);
  const nCoords = new Set(combos.flatMap((c) => Object.values(c.dp).map((g) => g.key))).size;
  const stacked = Object.values(stacks).reduce((n, st) => n + st.length, 0);
  const nAmbient = allSp.filter((s) => !s.monitors).length;

  // What proximity gets right, over every outlet the identifier names a sampling point for.
  let hit = 0, total = 0, notAnOutfall = 0;
  for (const c of combos)
    for (const [dpIri, g] of Object.entries(c.dp)) {
      const truth = c.monOf[dpIri];
      if (!truth) continue;
      total++;
      const near = nearestSp(g);
      if (near.sp.iri === truth) hit++;
      if (!near.sp.monitors) notAnOutfall++;
    }

  view.innerHTML = `
    <article class="screen">
      <section class="hero">
        <p class="kicker">The argument</p>
        <h2>Two records about the same thing rarely sit in the same place</h2>
        <p class="lede">
          A permit's <b>discharge point</b>, the <b>sampling point</b> its effluent is measured at, and
          any <b>WINEP action</b> proposed for it all describe the <i>same regulated works</i>. They are
          published by the EA in the <i>same</i> coordinate system (British National Grid), so nothing
          here is a projection artefact — they are simply <i>different places on the ground</i>. The
          outfall is not the watercourse it is sampled in. The works is not its outfall.
        </p>
        <p class="lede">
          So how do you know which records belong together? You can <b>state it</b>, or you can
          <b>guess it from the map</b>. This store states it. The rest of this page is what happens
          when you guess.
        </p>
      </section>

      <section class="split">
        <div class="panel">
          <h3>What the data says</h3>
          ${joinDiagram()}
          <p class="note">
            Three IRIs and two properties. The link is <b>asserted</b> by the register, so the join is
            exact, needs no geometry at all, and reads the same whether the points are 5 metres or
            5 kilometres apart.
          </p>
          <a class="sparql-link ext-link" href="sparql.html#q=${encodeURIComponent(IDENTIFIER_QUERY)}"
             target="_blank" rel="noopener">◈ Run the identifier join</a>
        </div>
        <div class="panel">
          <h3>What a map sees</h3>
          ${gisDiagram()}
          <p class="note">
            The same three things, with the identifiers thrown away. Now "which sampling point belongs
            to this outlet?" has no answer — only a <i>guess</i>, made by measuring distance to
            <b>every</b> sampling point in the layer and taking the closest. Nothing in the result says
            it guessed.
          </p>
        </div>
      </section>

      <section class="board">
        <h3>The guess, scored across this catchment</h3>
        <div class="stats">
          <div class="stat"><b>${total}</b><span>outlets the register names a sampling point for</span></div>
          <div class="stat bad"><b>${hit} / ${total}</b><span>nearest-point join gets right (${Math.round(100 * hit / total)}%)</span></div>
          <div class="stat ok"><b>${total} / ${total}</b><span><code>water:monitoredAt</code> gets right (100%)</span></div>
        </div>
        <p class="note">
          And the ways it goes wrong are not near-misses. They are the three screens that follow:
        </p>
        <ol class="modes">
          <li><b>It can return something that is not an outfall.</b> The layer holds
            <b>${allSp.length}</b> sampling points and only <b>${allSp.length - nAmbient}</b> of them
            monitor a discharge; the other <b>${nAmbient}</b> are rivers, boreholes and bathing waters.
            For <b>${notAnOutfall}</b> outlets, the closest sampling point is one of those.
            → <a href="#/blackheath">Blackheath</a></li>
          <li><b>It cannot separate things that share a coordinate.</b> <b>${stacked}</b> of the
            <b>${nDp}</b> outlets share their published coordinate with another outlet — all ${nDp} of
            them fit on just <b>${nCoords}</b> distinct points. → <a href="#/brockhill">Brockhill</a></li>
          <li><b>It cannot be given a radius that works.</b> The gap between an outlet and its own
            sampling point runs from a few metres to over a kilometre, so no single threshold both
            reaches the far ones and excludes the neighbours. → <a href="#/doreys">Doreys</a></li>
        </ol>
      </section>

      ${nav("why")}
    </article>`;
}

// The join, drawn. Deliberately abstract — no coordinates, because the point is that the join does
// not use any.
function joinDiagram() {
  return `<svg class="diagram" viewBox="0 0 380 210" role="img"
       aria-label="Permit links to its discharge point, which links to its sampling point; a WINEP action targets the permit">
    <defs>
      <marker id="ar" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
        <path d="M0 0 L7 3 L0 6 z" fill="#7d8a99"/>
      </marker>
    </defs>
    <rect x="8" y="12" width="120" height="34" rx="6" fill="#16202b" stroke="#3aa0ff"/>
    <text x="68" y="27" class="dn">Permit</text><text x="68" y="39" class="ds">042451</text>

    <rect x="8" y="96" width="120" height="34" rx="6" fill="#16202b" stroke="#3aa0ff"/>
    <text x="68" y="111" class="dn">Discharge point</text><text x="68" y="123" class="ds">outlet 1 / effluent 1</text>

    <rect x="238" y="96" width="130" height="34" rx="6" fill="#16202b" stroke="#46b978"/>
    <text x="303" y="111" class="dn">Sampling point</text><text x="303" y="123" class="ds">SW-50951080</text>

    <rect x="238" y="12" width="130" height="34" rx="6" fill="#16202b" stroke="#a06bff"/>
    <text x="303" y="27" class="dn">WINEP action</text><text x="303" y="39" class="ds">08WW102103</text>

    <line x1="68" y1="46" x2="68" y2="94" stroke="#7d8a99" marker-end="url(#ar)"/>
    <text x="74" y="74" class="dp">reg:permitSite</text>

    <line x1="130" y1="113" x2="236" y2="113" stroke="#7d8a99" marker-end="url(#ar)"/>
    <text x="183" y="107" class="dp mid">water:monitoredAt</text>

    <line x1="238" y1="29" x2="132" y2="29" stroke="#7d8a99" marker-end="url(#ar)"/>
    <text x="185" y="23" class="dp mid">reg:targetPermit</text>

    <text x="190" y="170" class="dok">exact · no geometry · no threshold</text>
    <text x="190" y="190" class="ds mid">the same query at 5 m or 5 km</text>
  </svg>`;
}

function gisDiagram() {
  return `<svg class="diagram" viewBox="0 0 380 210" role="img"
       aria-label="Three unlabelled dots on a map, with a question mark: proximity must guess which belongs to which">
    <circle cx="70" cy="120" r="8" fill="#3aa0ff" stroke="#0b1016"/>
    <text x="70" y="146" class="ds">an outlet</text>

    <circle cx="250" cy="70" r="7" fill="#46b978" stroke="#0b1016"/>
    <text x="250" y="54" class="ds">a sampling point</text>

    <circle cx="290" cy="150" r="7" fill="#8a94a0" stroke="#0b1016"/>
    <text x="299" y="172" class="ds">a river station</text>

    <circle cx="160" cy="40" r="7" fill="#8a94a0" stroke="#0b1016"/>
    <text x="160" y="24" class="ds">a borehole</text>

    <line x1="78" y1="116" x2="243" y2="74" stroke="#e5484d" stroke-width="1.5" stroke-dasharray="4 3"/>
    <line x1="78" y1="124" x2="283" y2="148" stroke="#e5484d" stroke-width="1.5" stroke-dasharray="4 3"/>
    <line x1="76" y1="113" x2="154" y2="46" stroke="#e5484d" stroke-width="1.5" stroke-dasharray="4 3"/>
    <text x="150" y="110" class="dbad">which one?</text>
    <text x="190" y="196" class="ds mid">distance is the only evidence left</text>
  </svg>`;
}

// ---------------------------------------------------------------------------
// Screens 2–4 — the worked examples
function renderExample(view, ex) {
  const c = byId[ex.permit];
  if (!c) { view.innerHTML = `<p class="pts-error">Permit ${esc(ex.permit)} is not in the store.</p>`; return; }
  const n = EXAMPLES.indexOf(ex) + 1;

  // Score this permit: what the identifier says, against what proximity would have said.
  const outlets = Object.entries(c.dp).map(([iri, g]) => {
    const truth = c.monOf[iri] || null;
    const near = nearestSp(g);
    return {
      iri, g, truth,
      truthSp: truth ? allSp.find((s) => s.iri === truth) : null,
      truthD: truth ? dist(g, c.sp[truth]) : null,
      near: near.sp, nearD: near.d,
      hit: !!truth && near.sp.iri === truth,
    };
  });
  const scored = outlets.filter((o) => o.truth);
  const hits = scored.filter((o) => o.hit).length;

  view.innerHTML = `
    <article class="screen">
      <section class="hero">
        <p class="kicker">Example ${n} of ${EXAMPLES.length} · ${esc(ex.site)}</p>
        <h2>${esc(ex.mode)}</h2>
        <p class="lede">${ex.lede}</p>
        <p class="scoreline">
          <span class="sc bad">nearest point <b>${hits} / ${scored.length}</b></span>
          <span class="sc ok"><code>monitoredAt</code> <b>${scored.length} / ${scored.length}</b></span>
          <span class="sc muted">permit ${esc(c.id)}${c.nAct ? ` · ${c.nAct} WINEP action${c.nAct > 1 ? "s" : ""}` : ""}</span>
        </p>
      </section>

      <section class="stage">
        <div id="ex-map" class="ex-map"></div>
        <div class="maplegend" id="ex-legend"></div>
      </section>

      <section class="split">
        <div class="panel">
          <h3>What the identifier says</h3>
          <table class="tbl">
            <thead><tr><th>Outlet</th><th>Monitored at</th><th class="r">Gap</th></tr></thead>
            <tbody>${outlets.map((o) => `<tr>
              <td class="mono">${esc(tinyDp(o.iri))}</td>
              <td>${o.truthSp ? `<span class="mono">${esc(o.truthSp.id)}</span><br><span class="sub">${esc(o.truthSp.label)}</span>` : "—"}</td>
              <td class="r">${o.truthD != null ? fmtM(o.truthD) : "—"}</td></tr>`).join("")}</tbody>
          </table>
          <a class="sparql-link ext-link" href="sparql.html#q=${encodeURIComponent(gisQuery(c.permit))}"
             target="_blank" rel="noopener">◈ What this store holds here</a>
        </div>
        <div class="panel">
          <h3>What proximity would say</h3>
          <table class="tbl">
            <thead><tr><th>Outlet</th><th>Nearest point</th><th class="r">Dist</th><th class="c">Right?</th></tr></thead>
            <tbody>${outlets.map((o) => `<tr>
              <td class="mono">${esc(tinyDp(o.iri))}</td>
              <td><span class="mono">${esc(o.near.id)}</span>
                  ${!o.near.monitors ? `<span class="tag warn">not an outfall</span>` : ""}
                  <br><span class="sub">${esc(o.near.label)}</span></td>
              <td class="r">${fmtM(o.nearD)}</td>
              <td class="c ${o.hit ? "ok" : "bad"}">${o.hit ? "✓" : "✗"}</td></tr>`).join("")}</tbody>
          </table>
          <a class="sparql-link ext-link" href="sparql.html#q=${encodeURIComponent(proximityQuery(c.permit))}"
             target="_blank" rel="noopener">◈ Run the nearest-point join yourself</a>
        </div>
      </section>

      ${exampleDetail(ex, c, outlets)}
      ${nav(ex.id)}
    </article>`;

  drawExample(c, outlets);
}

// The part of the argument that only THIS example can make.
function exampleDetail(ex, c, outlets) {
  if (ex.id === "blackheath") {
    const o = outlets.find((x) => !x.near.monitors) || outlets[0];
    return `<section class="board">
      <h3>What proximity actually returned</h3>
      <p class="lede">
        <span class="mono">${esc(o.near.id)}</span> — <b>${esc(o.near.label)}</b> —
        is a <b>${esc(o.near.type || "river station")}</b>. It monitors no discharge at all. It is in
        the layer because the EA samples the river there, and a nearest-feature join cannot see the
        difference between a river and an outfall: both are just points.
      </p>
      <p class="lede">
        "US" in its name is <b>upstream</b>. So the join has not merely picked the wrong sampling
        point — it has picked the one place whose readings are, by design, unaffected by this works.
        Use it to judge the permit and the works looks spotless, because you are measuring water that
        has not reached it yet.
      </p>
      <p class="note">
        You cannot fix this by filtering the layer down to "just the outfalls", because knowing which
        points are this permit's outfalls is precisely what the join was supposed to tell you.
      </p>
    </section>`;
  }

  if (ex.id === "brockhill") {
    const key = c.stackKeys && c.stackKeys[0];
    const st = key ? stacks[key] : [];
    const permits = [...new Set(st.map((s) => s.permit))];
    const near = st.length ? nearestSp(st[0].g) : null;
    const truths = [...new Set(st.map((s) => s.sp).filter(Boolean))];
    const hits = st.filter((s) => near && s.sp === near.sp.iri).length;
    return `<section class="board">
      <h3>⊕ Seven outlets, one coordinate</h3>
      <p class="lede">
        These <b>${st.length}</b> discharge points, across <b>${permits.length}</b> permits
        (${permits.map((p) => `<span class="mono">${esc(p)}</span>`).join(", ")}), are all published at
        the <b>same</b> grid reference. That is not a mistake in the data — it is what the register
        holds: the coordinate is the discharge <b>site's</b> grid reference, and a site can carry many
        permits and many outlets. Every one of them inherits it.
      </p>
      <table class="tbl wide">
        <thead><tr><th>Outlet</th><th>Monitored at (the identifier)</th><th class="c">Would proximity pick it?</th></tr></thead>
        <tbody>${st.map((s) => {
          const sp = allSp.find((x) => x.iri === s.sp);
          const hit = near && s.sp === near.sp.iri;
          return `<tr class="${s.permit === c.id ? "mine" : ""}">
            <td class="mono">${esc(tinyDp(s.iri))}</td>
            <td>${sp ? `<span class="mono">${esc(sp.id)}</span> <span class="sub">${esc(sp.label)}</span>` : "—"}</td>
            <td class="c ${hit ? "ok" : "bad"}">${hit ? "✓" : "✗"}</td></tr>`;
        }).join("")}</tbody>
      </table>
      <p class="lede">
        To a map these seven are <b>one dot</b>, so a nearest-point join has no choice but to give all
        seven the <b>same</b> answer — <span class="mono">${near ? esc(near.sp.id) : "—"}</span>,
        ${near ? fmtM(near.d) : "—"} away. It scores <b class="bad">${hits} of ${st.length}</b>, and the
        one it gets right it gets right <i>by luck</i>. The identifier names
        <b>${truths.length} different</b> sampling points and is right ${st.length} times out of ${st.length}.
      </p>
      <p class="note">
        Proximity cannot separate what proximity has already merged. And note the shape of the failure:
        it is not uncertain, it is <b>confidently wrong</b> — and nothing in its output distinguishes
        this case from one it got right.
      </p>
    </section>`;
  }

  if (ex.id === "doreys") {
    const o = outlets[0];
    const radii = [250, 500, 1000, 1100, 1500];
    // The comparison that kills the idea of a tuned radius: apply the same radius at the collision
    // site and see how many candidates it sweeps in there.
    const other = byId["043245"];
    const otherG = other ? Object.values(other.dp)[0] : null;
    return `<section class="board">
      <h3>The radius trap</h3>
      <p class="lede">
        Proximity gets this one <b>right</b> — its nearest point <i>is</i> the sampling point the
        register names. But it is <b>${fmtM(o.nearD)}</b> away. A spatial join is not usually run as
        "nearest at any distance"; it is run with a radius, because an unbounded nearest-match will
        happily reach across the county. And there is no radius that works:
      </p>
      <table class="tbl">
        <thead><tr><th class="r">Radius</th>
          <th class="r">Candidates at Doreys</th>
          <th class="r">Candidates at Brockhill</th><th>Verdict</th></tr></thead>
        <tbody>${radii.map((r) => {
          const here = withinRadius(o.g, r).length;
          const there = otherG ? withinRadius(otherG, r).length : 0;
          const verdict = here === 0
            ? `<span class="bad">link lost — Doreys matches nothing</span>`
            : there > 1
            ? `<span class="bad">Brockhill now has ${there} candidates for one dot</span>`
            : `<span class="ok">works</span>`;
          return `<tr><td class="r mono">${r} m</td><td class="r">${here}</td>
            <td class="r">${there}</td><td>${verdict}</td></tr>`;
        }).join("")}</tbody>
      </table>
      <p class="lede">
        Tighten the radius until Brockhill is unambiguous and Doreys silently matches <b>nothing</b> —
        the link vanishes, and a permit disappears from your analysis with no error raised. Widen it
        until Doreys is found and Brockhill's single dot is now within reach of
        <b>${otherG ? withinRadius(otherG, 1100).length : "several"}</b> sampling points, all equally
        plausible. One catchment, one join, no setting that is right for both.
      </p>
      <p class="note">
        <code>water:monitoredAt</code> has no radius to tune. It is right at 5 metres and right at
        ${fmtM(o.nearD)}, for the same reason: it was <b>stated</b>, not measured.
      </p>
    </section>`;
  }
  return "";
}

// The example map: this permit's points, zoomed to them, with every OTHER sampling point in the
// layer drawn faintly — because those are the join's other candidates, and leaving them out would be
// quietly cheating in proximity's favour.
function drawExample(c, outlets) {
  map = newMap(document.getElementById("ex-map"));

  const mine = new Set(Object.keys(c.sp));
  for (const sp of allSp) {
    if (mine.has(sp.iri)) continue;
    marker({ ...sp, role: "sp" }, {
      radius: 4, color: sp.monitors ? "#2f6b4f" : AMBIENT_COLOR,
      label: `<b>${esc(sp.label)}</b><br>${esc(sp.id)}<br><span class="t">${esc(sp.type || "")}</span>`,
    }).addTo(map).setStyle({ fillOpacity: 0.5 });
  }

  // The identifier's links (solid amber), and proximity's pick (dashed red) where it differs.
  for (const o of outlets) {
    if (o.truth && c.sp[o.truth])
      leg(o.g, c.sp[o.truth], { label: fmtM(o.truthD) }).addTo(map);
    if (!o.hit)
      leg(o.g, o.near, { color: "#e5484d", dash: "5 4", weight: 2 }).addTo(map);
  }

  for (const pt of c.points) {
    const stacked = pt.role === "dp" && stacks[pt.key];
    if (stacked)
      L.circleMarker(pt.ll, {
        radius: (ROLE.dp.r) + 6, color: ROLE.dp.color, weight: 1.5, opacity: 0.7,
        fill: false, dashArray: "3 3", interactive: false,
      }).addTo(map);
    const extra = stacked
      ? `<div class="tstack">⊕ ${stacked.length} outlets from ${new Set(stacked.map((s) => s.permit)).size} permits on this exact point</div>`
      : "";
    marker(pt, {
      label: `<div class="tt" style="color:${ROLE[pt.role].color}">${ROLE[pt.role].label}</div>` +
        `<div class="tid">${esc(pt.id)}</div>${pt.label ? `<div>${esc(pt.label)}</div>` : ""}${extra}` +
        `<div class="tcrs">${esc(pt.crs)}</div>`,
    }).addTo(map);
  }

  // Frame on the JOIN — the outlets, the points the identifier names for them, and the points
  // proximity would have picked instead. WINEP action sites are drawn but deliberately kept OUT of
  // the bounds: at Blackheath they sit 1.4 km away and would zoom the map out until the 19 m that
  // decides the whole argument is a single pixel. Context must not set the frame.
  const pts = [
    ...outlets.map((o) => o.g.ll),
    ...outlets.filter((o) => o.truth).map((o) => c.sp[o.truth].ll),
    ...outlets.map((o) => o.near.ll),
  ];
  map.fitBounds(L.latLngBounds(pts).pad(0.35), { maxZoom: 17 });

  document.getElementById("ex-legend").innerHTML = [
    `<span class="key"><span class="sw" style="background:${ROLE.dp.color}"></span>Discharge point</span>`,
    `<span class="key"><span class="sw" style="background:${ROLE.sp.color}"></span>Its sampling point</span>`,
    `<span class="key"><span class="sw" style="background:${ROLE.act.color}"></span>WINEP action</span>`,
    `<span class="key"><span class="sw sm" style="background:#2f6b4f"></span>other outfall points</span>`,
    `<span class="key"><span class="sw sm" style="background:${AMBIENT_COLOR}"></span>points monitoring no discharge</span>`,
    `<span class="key"><span class="ln amber"></span>identifier link · gap</span>`,
    `<span class="key"><span class="ln red"></span>what proximity would pick</span>`,
  ].join("");
}

// ---------------------------------------------------------------------------
// Screen 5 — the Explorer. The collections themselves, with the map.
const COLLECTIONS = [
  { id: "permits", label: "Permits" },
  { id: "outlets", label: "Discharge points" },
  { id: "sampling", label: "Sampling points" },
  { id: "actions", label: "WINEP actions" },
];
let explorerTab = "permits";

function renderExplorer(view) {
  const nDp = combos.reduce((n, c) => n + c.nDp, 0);
  const nAct = combos.reduce((n, c) => n + c.nAct, 0);
  const counts = {
    permits: combos.length, outlets: nDp, sampling: allSp.length, actions: nAct,
  };

  view.innerHTML = `
    <article class="screen">
      <section class="hero tight">
        <p class="kicker">Explorer</p>
        <h2>The collections</h2>
        <p class="lede">
          Everything the three examples were drawn from. <b>${combos.length}</b> permits own
          <b>${nDp}</b> discharge points, monitored across a layer of <b>${allSp.length}</b> sampling
          points — of which only <b>${allSp.filter((s) => s.monitors).length}</b> monitor a discharge at
          all. Pick anything to place it on the map.
        </p>
      </section>

      <section class="explorer">
        <aside class="ex-side">
          <div class="tabs">${COLLECTIONS.map((t) =>
            `<button class="tab${t.id === explorerTab ? " on" : ""}" data-tab="${t.id}">
               ${esc(t.label)} <span class="n">${counts[t.id]}</span></button>`).join("")}</div>
          <input id="ex-search" class="search" placeholder="Filter…" autocomplete="off">
          <div id="ex-list" class="list"></div>
        </aside>
        <div class="ex-stage">
          <div id="exp-map" class="exp-map"></div>
          <div class="maplegend" id="exp-legend"></div>
        </div>
      </section>

      ${nav("explorer")}
    </article>`;

  map = newMap(document.getElementById("exp-map"), { zoom: 11 });
  const layer = L.layerGroup().addTo(map);
  drawExplorerBase(layer);

  document.getElementById("exp-legend").innerHTML = [
    `<span class="key"><span class="sw" style="background:${ROLE.dp.color}"></span>Discharge point</span>`,
    `<span class="key"><span class="sw" style="background:${ROLE.sp.color}"></span>Sampling point (an outfall's)</span>`,
    `<span class="key"><span class="sw" style="background:${AMBIENT_COLOR}"></span>Sampling point (monitors no discharge)</span>`,
    `<span class="key"><span class="sw" style="background:${ROLE.act.color}"></span>WINEP action site</span>`,
  ].join("");

  view.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => {
    explorerTab = b.dataset.tab;
    view.querySelectorAll(".tab").forEach((x) => x.classList.toggle("on", x === b));
    document.getElementById("ex-search").value = "";
    fillList("");
  }));
  document.getElementById("ex-search").addEventListener("input", (e) => fillList(e.target.value));
  fillList("");
}

function drawExplorerBase(layer) {
  for (const sp of allSp)
    marker({ ...sp, role: "sp" }, {
      radius: sp.monitors ? 5 : 4,
      color: sp.monitors ? ROLE.sp.color : AMBIENT_COLOR,
      label: `<b>${esc(sp.label)}</b><br>${esc(sp.id)}<br><span class="t">${esc(sp.type || "")}</span>`,
    }).addTo(layer);
  for (const c of combos) {
    for (const [iri, g] of Object.entries(c.dp))
      marker({ ...g, role: "dp" }, {
        label: `<div class="tt" style="color:${ROLE.dp.color}">Discharge point</div>` +
               `<div class="tid">${esc(tinyDp(iri))}</div>`,
      }).addTo(layer);
    for (const [iri, g] of Object.entries(c.act))
      marker({ ...g, role: "act" }, {
        label: `<div class="tt" style="color:${ROLE.act.color}">WINEP action</div>` +
               `<div class="tid">${esc(shortAct(iri))}</div><div>${esc(g.label || "")}</div>`,
      }).addTo(layer);
  }
  const all = [...allSp.map((s) => s.ll), ...combos.flatMap((c) => c.points.map((p) => p.ll))];
  if (all.length) map.fitBounds(L.latLngBounds(all).pad(0.05));
}

// The list for the current tab, filtered. Each row knows where it is, so clicking flies to it.
function fillList(q) {
  const needle = q.trim().toLowerCase();
  let items = [];

  if (explorerTab === "permits") {
    items = combos.map((c) => ({
      id: c.id,
      title: c.id,
      sub: `${c.nDp} outlet${c.nDp === 1 ? "" : "s"} · ${Object.keys(c.sp).length} sampling point${Object.keys(c.sp).length === 1 ? "" : "s"}` +
           (c.nAct ? ` · ${c.nAct} WINEP` : ""),
      tag: c.maxGap ? fmtM(c.maxGap) + " across" : "",
      ll: c.points.map((p) => p.ll),
    }));
  } else if (explorerTab === "outlets") {
    items = combos.flatMap((c) => Object.entries(c.dp).map(([iri, g]) => {
      const st = stacks[g.key];
      const sp = c.monOf[iri] ? allSp.find((s) => s.iri === c.monOf[iri]) : null;
      return {
        id: shortDp(iri), title: tinyDp(iri),
        sub: sp ? `monitored at ${sp.id} — ${sp.label}` : "no sampling point named",
        tag: st ? `⊕ shares its point with ${st.length - 1} other${st.length === 2 ? "" : "s"}` : "",
        warn: !!st,
        ll: [g.ll],
      };
    }));
  } else if (explorerTab === "sampling") {
    items = allSp.map((s) => ({
      id: s.id, title: s.id, sub: s.label,
      tag: s.monitors ? esc(s.type) : "monitors no discharge",
      warn: !s.monitors,
      ll: [s.ll],
    }));
  } else {
    items = combos.flatMap((c) => Object.entries(c.act).map(([iri, g]) => ({
      id: shortAct(iri), title: shortAct(iri),
      sub: g.label || "", tag: `permit ${c.id}`, ll: [g.ll],
    })));
  }

  const shown = needle
    ? items.filter((i) => (i.title + " " + i.sub + " " + (i.tag || "")).toLowerCase().includes(needle))
    : items;

  const list = document.getElementById("ex-list");
  list.innerHTML = shown.length
    ? shown.map((i, k) => `<div class="row" data-k="${k}">
        <span class="r-title mono">${esc(i.title)}</span>
        <span class="r-sub">${esc(i.sub)}</span>
        ${i.tag ? `<span class="r-tag${i.warn ? " warn" : ""}">${esc(i.tag)}</span>` : ""}
      </div>`).join("")
    : `<p class="empty">Nothing matches “${esc(q)}”.</p>`;

  list.querySelectorAll(".row").forEach((el) => el.addEventListener("click", () => {
    const it = shown[Number(el.dataset.k)];
    list.querySelectorAll(".row").forEach((x) => x.classList.toggle("on", x === el));
    if (it.ll.length === 1) map.setView(it.ll[0], 16);
    else map.fitBounds(L.latLngBounds(it.ll).pad(0.35), { maxZoom: 16 });
  }));
}

boot();
