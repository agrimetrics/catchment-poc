/* Points apart
 * ------------
 * The demonstrator's central argument, laid out as six screens rather than one crowded page:
 *
 *   #/why         the argument, an abstracted example, and the joins this store actually makes
 *   #/blackheath  Example 1 — proximity returns a river, sited UPSTREAM of the works
 *   #/brockhill   Example 2 — seven outlets on one coordinate; proximity cannot tell them apart
 *   #/doreys      Example 3 — the right answer is a kilometre away; no radius works
 *   #/unlocatable Example 4 — outlets with no coordinate at all; proximity has nothing to measure
 *   #/explorer    the collections themselves: permits, outlets, sampling points, WINEP actions
 *
 * EA records about the same regulated thing can be merged reliably only by identifier, not by
 * location, and there are four ways proximity fails. Each example is one of them.
 *
 * ASSERTED vs DRAWABLE — the distinction this page must never blur, because blurring it is the exact
 * mistake it exists to warn about. The store holds 122 outlets. 115 of them have a coordinate; 102
 * have a sampling point; 91 have BOTH, and only those 91 can be SCORED — you cannot test a proximity
 * join on an outlet that has no position to measure from, or no stated answer to check against.
 * So 91 is the scoring denominator and it is honest. What it is NOT is "the number of outlets", or
 * "the outlets the register names a sampling point for". Every count on these screens says which of
 * the three it means. The page that argues "do not let the presence of geometry decide what exists"
 * cannot itself quietly count only the things it can draw.
 *
 * The counts are COMPUTED FROM THE STORE at render time, so they cannot drift from the data. The
 * example ledes are hand-written prose and DO name specific figures ("seven outlets", "a kilometre
 * away"); those are checked against the build output, not derived at runtime.
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
PREFIX wr:    <http://example.com/water-regulation/>
PREFIX geo:   <http://www.opengis.net/ont/geosparql#>
PREFIX rdfs:  <http://www.w3.org/2000/01/rdf-schema#>
PREFIX skos:  <http://www.w3.org/2004/02/skos/core#>
PREFIX sosa:  <http://www.w3.org/ns/sosa/>`;

// THIS PAGE READS THE SOURCE GEOMETRY, NOT THE DERIVED ONE.
//
// Every point in the store now carries TWO geometries — the EA's own EPSG:27700 (British National
// Grid, metres) and a CRS84 one derived from it so that GeoSPARQL's geof: functions can run. That
// means a bare `geo:hasGeometry/geo:asWKT` now matches BOTH and silently doubles every row. (It did:
// the app briefly reported 328 breaches for a store holding 164.)
//
// So the geometry is selected by CRS, explicitly. This page must have the BRITISH NATIONAL GRID one:
//
//   * BNG is a PROJECTED CRS in metres, so Pythagoras on easting/northing is true ground distance.
//     Every score, radius and leg label on these screens is a real number of metres because of that.
//   * The collision test — "these two outlets are on the SAME point" — has to be exact equality on
//     the published coordinate. It must be a fact about the register, not an artefact of reprojection
//     rounding. Seven outlets sharing one grid reference is the whole of Example 2.
const BNG = "<http://www.opengis.net/def/crs/EPSG/0/27700>";
const srcGeom = (feat, out) => `${feat} geo:hasGeometry ?g_${out} .
             ?g_${out} wr:crs ${BNG} ; geo:asWKT ?${out} .`;

// One row per (discharge point × sampling point × action) for a permit; deduped into sets below.
//
// EVERY GEOMETRY HERE IS OPTIONAL, and each OPTIONAL is load-bearing. This query is the page's own
// data, and the page's argument is that geometry must not decide what exists — so it would be an
// embarrassment for the query to make exactly that mistake. It did, twice:
//
//   ?dpw   Seven outlets have no published coordinate at all — the consents register gives their
//          permit no grid reference and this store refuses to invent one. Requiring ?dpw deletes
//          them. They have no location and their link is still exact; that IS the argument.
//
//   ?spw   Six sampling points are NAMED by the register but not published by the Water Quality
//          Archive, so the store holds their IRI and nothing else. `?sp geo:hasGeometry ?spw` as a
//          hard join dropped those six monitoredAt edges — the page reported 96 links where the
//          register states 102. On the page whose whole thesis is "the identifier keeps working when
//          the geometry is missing", six identifier links were being thrown away FOR HAVING NO
//          GEOMETRY. Now the edge is kept and only the drawing of it is conditional.
//
// The discharge point's geometry is also pinned to the SITE level. The register carries a grid
// reference at three levels and the store now publishes all three (see Q_ALT_GEOM below); the SITE
// reference is the one this store publishes as "the" location, because it is what the public register
// surfaces. Without the pin, ?dpw would match all three and every row would triple.
const SITE = "<http://example.com/water-regulation/grid-level/site>";
const Q_PERMITS = `${PREFIXES}
SELECT ?permit ?dp ?dpw ?sp ?spw ?action ?al ?aw WHERE {
  ?permit a water:WaterDischargePermit ; reg:permitSite ?dp .
  OPTIONAL { ?dp geo:hasGeometry ?gdp . ?gdp wr:gridReferenceLevel ${SITE} ; wr:crs ${BNG} ; geo:asWKT ?dpw . }
  OPTIONAL { ?dp water:monitoredAt ?sp .
             OPTIONAL { ?sp geo:hasGeometry ?gsp . ?gsp wr:crs ${BNG} ; geo:asWKT ?spw . } }
  OPTIONAL { ?action reg:targetPermit ?permit ; rdfs:label ?al ; reg:actionSite ?s .
             ?s geo:hasGeometry ?ga . ?ga wr:crs ${BNG} ; geo:asWKT ?aw . }
}`;

// THE OPPOSITION'S BEST CASE, fetched so the page can score it instead of ducking it.
//
// The obvious objection to everything on this page is: "you chose the COARSEST of the three grid
// references the register carries, and then complained that proximity could not use it." It is a fair
// objection and it deserves a number, not a paragraph. The register carries:
//
//     DISCHARGE_NGR      the SITE      — what the public register surfaces, and what this store publishes
//     OUTLET_GRID_REF    the OUTLET    — finer
//     EFFLUENT_GRID_REF  the EFFLUENT  — finest
//
// All three are now in the store, each tagged `wr:gridReferenceLevel`. This query pulls the other two
// so the Why screen can run the same nearest-neighbour join against each and show the result. The
// argument does not need proximity to look bad; it needs proximity to be shown at its BEST and still
// be the wrong tool. It is: the finest reference reaches about three in four, and — the part worth
// noticing — the finest is NOT reliably the most accurate.
const Q_ALT_GEOM = `${PREFIXES}
SELECT ?dp ?level ?w WHERE {
  ?dp a reg:DischargePoint ; geo:hasGeometry ?g .
  ?g wr:gridReferenceLevel ?lv ; wr:crs ${BNG} ; geo:asWKT ?w .
  ?lv skos:notation ?level .
  FILTER(?level != "site")
}`;

// EVERY sampling point in the store — not just the ones a permit is monitored at. This is what a GIS
// holds in its layer, and therefore what a nearest-feature join is free to choose from. Scoring
// against only the effluent points would flatter the join by handing it the answer.
const Q_SP = `${PREFIXES}
SELECT ?sp ?spw ?spl ?type (COUNT(?dp) AS ?nMon) WHERE {
  ?sp a sosa:FeatureOfInterest ; geo:hasGeometry ?gsp .
  ?gsp wr:crs <http://www.opengis.net/def/crs/EPSG/0/27700> ; geo:asWKT ?spw .
  OPTIONAL { ?sp skos:prefLabel ?spl }
  OPTIONAL { ?sp wr:samplingPointType/skos:prefLabel ?type }
  OPTIONAL { ?dp water:monitoredAt ?sp }
} GROUP BY ?sp ?spw ?spl ?type`;

// --- provenance deep-links into the SPARQL editor ---------------------------------------------

// The counter-argument, runnable. Every outlet, with each of the three grid references the register
// carries and the sampling point the identifier states — so a reader can score all three themselves
// and see that the store is not hiding behind the coarsest one.
const THREE_GEOM_QUERY = `${PREFIXES}
# The register carries a grid reference at THREE levels, and this store publishes all three.
# The one hung on the discharge point by default is the SITE reference (DISCHARGE_NGR) — the coarsest,
# because it is what the public register surfaces as "the" discharge location.
#
# Run this, then score a nearest-sampling-point join from each column against ?identifierSaysThisOne.
# The finest reference is not reliably the most accurate. The identifier does not care either way.
SELECT ?outlet ?level ?gridReference ?identifierSaysThisOne WHERE {
  ?dp a reg:DischargePoint ; geo:hasGeometry ?g ; water:monitoredAt ?sp .
  ?g wr:gridReferenceLevel ?lv ; wr:crs ${BNG} ; geo:asWKT ?gridReference .
  ?lv skos:notation ?level .
  BIND(REPLACE(STR(?dp), "^.*/permit/", "") AS ?outlet)
  BIND(REPLACE(STR(?sp), "^.*/sampling-point/", "") AS ?identifierSaysThisOne)
}
ORDER BY ?outlet ?level`;

const gisQuery = (permit) => `${PREFIXES}
# Everything this store knows is at ${shortPermit(permit)} — the three roles, and their geometry.
# Note they are three DIFFERENT places. The identifier says they belong together anyway.
SELECT ?role ?feature ?wkt WHERE {
  { <${permit}> reg:permitSite ?feature .
    ?feature geo:hasGeometry ?g . ?g wr:crs <http://www.opengis.net/def/crs/EPSG/0/27700> ; geo:asWKT ?wkt . BIND("discharge point" AS ?role) }
  UNION
  { <${permit}> reg:permitSite/water:monitoredAt ?feature .
    ?feature geo:hasGeometry ?g . ?g wr:crs <http://www.opengis.net/def/crs/EPSG/0/27700> ; geo:asWKT ?wkt . BIND("sampling point" AS ?role) }
  UNION
  { ?a reg:targetPermit <${permit}> ; reg:actionSite ?feature .
    ?feature geo:hasGeometry ?g . ?g wr:crs <http://www.opengis.net/def/crs/EPSG/0/27700> ; geo:asWKT ?wkt . BIND("WINEP action site" AS ?role) }
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
  ?dp geo:hasGeometry ?gdp . ?gdp wr:crs <http://www.opengis.net/def/crs/EPSG/0/27700> ; geo:asWKT ?dpWkt .
  ?sp a sosa:FeatureOfInterest ; skos:prefLabel ?label ; geo:hasGeometry ?gsp .
  ?gsp wr:crs <http://www.opengis.net/def/crs/EPSG/0/27700> ; geo:asWKT ?spWkt .

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
// The CRS URI comes FIRST and is stripped before any number is read — it is itself full of digits
// (".../EPSG/0/27700"), so scraping numbers from the whole literal invents coordinates out of the
// namespace. See app.js parseWkt for the same note.
const CRS_URI = /^\s*<([^>]+)>\s*/;
function parseWkt(wkt) {
  const m = CRS_URI.exec(wkt);
  const crs = m ? m[1] : "";
  const body = m ? wkt.slice(m[0].length) : wkt;
  const bng = crs.includes("27700");
  const nums = (body.match(/-?\d+\.?\d*/g) || []).map(Number);
  let lon, lat, en = null;
  if (bng) { en = [nums[0], nums[1]]; [lon, lat] = proj4("EPSG:27700", "EPSG:4326", en); }
  else { lon = nums[0]; lat = nums[1]; }
  return {
    ll: [lat, lon], en,
    crs: bng ? "EPSG:27700 · British National Grid" : "CRS84 · WGS84 lon/lat",
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
// { dischargePointIri: { outlet: {en,…}, effluent: {en,…} } } — the register's finer grid references,
// used ONLY to score the counter-argument on the Why screen. Nothing is ever drawn from them: the
// store publishes the SITE reference as the discharge point's location, and that is what the map shows.
let altGeom = {};
// Explorer layers: the markers, every asserted link drawn faintly, and the selected chain on top.
let baseLayer = null, linkLayer = null, focusLayer = null;

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
    const c = map_[id] ||= {
      id, permit: r.permit,
      dp: {},        // outlets we can draw          (have a coordinate)
      noGeom: {},    // outlets we cannot draw       (the register gives their permit no grid ref)
      sp: {},        // sampling points we can draw  (the archive publishes them)
      spNoGeom: {},  // sampling points we cannot    (named by the register, unpublished by the archive)
      act: {}, monOf: {},
    };
    // An outlet the register gives no coordinate for goes in `noGeom`: it exists, it is monitored at
    // a sampling point, and it cannot be drawn. It must never be quietly dropped.
    if (r.dp && r.dpw && !c.dp[r.dp]) c.dp[r.dp] = parseWkt(r.dpw);
    if (r.dp && !r.dpw) c.noGeom[r.dp] = true;
    // The EDGE is recorded whether or not the sampling point can be drawn. `monOf` is the identifier
    // join — the thing this page exists to defend — and it does not depend on geometry any more than
    // the register's own statement does.
    if (r.sp) {
      c.monOf[r.dp] = r.sp;
      if (r.spw) { if (!c.sp[r.sp]) c.sp[r.sp] = parseWkt(r.spw); }
      else c.spNoGeom[r.sp] = true;
    }
    if (r.action && !c.act[r.action]) c.act[r.action] = Object.assign(parseWkt(r.aw), { label: r.al });
  }
  combos = Object.values(map_).map((c) => {
    c.points = [
      ...Object.entries(c.dp).map(([iri, g]) => ({ role: "dp", iri, id: shortDp(iri), ...g })),
      ...Object.entries(c.sp).map(([iri, g]) => ({ role: "sp", iri, id: shortSp(iri), ...g })),
      ...Object.entries(c.act).map(([iri, g]) => ({ role: "act", iri, id: shortAct(iri), ...g })),
    ];
    // THE CHAIN, drawn. Every link here is an ASSERTED one — an IRI naming another IRI — and every
    // one of them spans a real distance on the ground, which is the entire point of this page:
    //
    //   WINEP action --reg:targetPermit--> permit --reg:permitSite--> outlet --water:monitoredAt--> sampling point
    //
    // A permit has no geometry of its own (it is a licence, not a place), so the action's leg is
    // drawn to the permit's PRIMARY outlet — outlet 1 / effluent 1 where there is one. That is a
    // drawing convention, not a claim: what the data says is that the action targets the permit.
    const dpIris = Object.keys(c.dp);
    const anchorIri = dpIris.find((i) => /\/outlet\/1\/effluent\/1$/.test(i)) || dpIris[0];
    const anchor = anchorIri ? c.dp[anchorIri] : null;

    c.legs = [];
    for (const [dpIri, g] of Object.entries(c.dp)) {
      const spIri = c.monOf[dpIri];
      if (spIri && c.sp[spIri])
        c.legs.push({
          kind: "mon", a: g, b: c.sp[spIri], d: dist(g, c.sp[spIri]),
          from: tinyDp(dpIri), to: shortSp(spIri), rel: "water:monitoredAt",
        });
    }
    if (anchor)
      for (const [actIri, g] of Object.entries(c.act))
        c.legs.push({
          kind: "winep", a: anchor, b: g, d: dist(anchor, g),
          from: shortAct(actIri), to: c.id, rel: "reg:targetPermit",
        });

    let maxGap = 0;
    for (let i = 0; i < c.points.length; i++)
      for (let j = i + 1; j < c.points.length; j++)
        maxGap = Math.max(maxGap, dist(c.points[i], c.points[j]));
    c.maxGap = maxGap;
    c.nDp = Object.keys(c.dp).length + Object.keys(c.noGeom).length;  // outlets that EXIST
    c.nMapped = Object.keys(c.dp).length;                             // outlets we can draw
    c.nNoGeom = Object.keys(c.noGeom).length;
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
// The four worked examples — one per way that proximity fails.
// (EXAMPLES holds three; the fourth, UNLOCATABLE, is defined separately because it has no geometry
//  to build a map from. N_EXAMPLES is the total BOTH of them count to — they used to disagree, so
//  the kicker read "Example 3 of 3" on one screen and "Example 4 of 4" on the next.)
const EXAMPLES = [
  {
    id: "blackheath", permit: "042451", site: "Blackheath WRC",
    mode: "It can return something that is not an outfall at all",
    // "the NEAREST place guaranteed to carry none of its effluent" — not "the single place". Ninety-one
    // sampling points in this catchment carry none of Blackheath's effluent; what makes this one damning
    // is that it is the one proximity CHOOSES. The overstatement is easy to make and easy to catch.
    lede: "Proximity's nearest sampling point here is a <b>river station</b> — and one sited " +
          "<b>upstream</b> of the works, so it is the nearest place in the catchment guaranteed to " +
          "carry none of its effluent.",
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
// Example 4 is a different shape from the other three — it is not one site but a set of outlets, and
// its subject is the ABSENCE of geometry — so it gets its own renderer rather than the common one.
const UNLOCATABLE = {
  id: "unlocatable", site: "Outlets with no location",
  mode: "And where there is no geometry, it cannot be run at all",
};
// The total BOTH the common renderer and the unlocatable one count to. They used to disagree — the
// first said "Example 3 of 3" and the next said "Example 4 of 4" — because one used EXAMPLES.length
// (3) and the other hard-coded 4. Derive it once.
const N_EXAMPLES = EXAMPLES.length + 1;
const ROUTES = [
  { id: "why", label: "Why identifiers", nav: "Why identifiers" },
  ...EXAMPLES.map((e, i) => ({
    id: e.id, label: `${i + 1} · ${e.site.split(" ")[0]}`, example: e,
    nav: `Example ${i + 1}: ${e.site}`,
  })),
  { id: UNLOCATABLE.id, label: `${N_EXAMPLES} · No location`,
    nav: `Example ${N_EXAMPLES}: outlets with no location` },
  { id: "explorer", label: "Explorer", nav: "Explore the collections" },
];
// The radii the reader is invited to draw around a sampling point when asked to guess where the
// outfall is. They are deliberately generous, and still not generous enough — see the scoreboard.
const RADII = [5, 50, 500];

// ---------------------------------------------------------------------------
// Boot
async function boot() {
  let rows, spRows, altRows;
  try {
    [rows, spRows, altRows] =
      await Promise.all([sparql(Q_PERMITS), sparql(Q_SP), sparql(Q_ALT_GEOM)]);
  } catch (e) {
    document.getElementById("pts-view").innerHTML =
      `<p class="pts-error">Could not load from <code>${esc(ENDPOINT)}</code>: ${esc(e.message)}</p>`;
    return;
  }
  allSp = spRows.map((r) => ({
    iri: r.sp, id: shortSp(r.sp), label: r.spl || shortSp(r.sp),
    type: r.type || "", monitors: Number(r.nMon || 0) > 0,
    ...parseWkt(r.spw),
  }));
  // the register's OTHER two grid references, per outlet: { dpIri: { outlet: geom, effluent: geom } }
  altGeom = {};
  for (const r of altRows) (altGeom[r.dp] ||= {})[r.level] = parseWkt(r.w);
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
  else if (r.id === UNLOCATABLE.id) renderUnlocatable(view);
  else renderExample(view, r.example);

  window.scrollTo({ top: 0, behavior: "instant" });
}

// The step-through control at the foot of every screen.
function nav(currentId) {
  const i = ROUTES.findIndex((r) => r.id === currentId);
  const prev = ROUTES[i - 1], next = ROUTES[i + 1];
  return `<nav class="pts-next">
    ${prev ? `<a class="nx prev" href="#/${prev.id}">‹‹ ${esc(prev.nav)}</a>` : "<span></span>"}
    ${next ? `<a class="nx next" href="#/${next.id}">${esc(next.nav)} ››</a>` : "<span></span>"}
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

// The two kinds of asserted link, and how each is drawn. Proximity's guess is drawn in red, dashed,
// so it never reads as one of them.
const LEG_STYLE = {
  mon:   { color: "#f5a623", dash: null,  label: "identifier link · monitoredAt" },
  winep: { color: "#a06bff", dash: "6 4", label: "identifier link · targetPermit" },
};

// A leg between two points, optionally labelled with its length. `dim` draws it as background: the
// explorer shows every link in the catchment at once, and 111 bold lines would be a ball of wool.
function leg(a, b, { kind = "mon", label = null, dim = false, color = null, dash, weight } = {}) {
  const s = LEG_STYLE[kind] || LEG_STYLE.mon;
  const g = L.layerGroup();
  L.polyline([a.ll, b.ll], {
    color: color || s.color,
    weight: weight != null ? weight : (dim ? 1.25 : 3),
    opacity: dim ? 0.35 : 0.95,
    dashArray: dash !== undefined ? dash : (dim ? "4 4" : s.dash),
  }).addTo(g);
  if (label)
    L.tooltip({ permanent: true, direction: "center", className: `pts-leg ${kind}` })
      .setLatLng([(a.ll[0] + b.ll[0]) / 2, (a.ll[1] + b.ll[1]) / 2])
      .setContent(label).addTo(g);
  return g;
}
// Every leg of a permit, drawn and labelled with its length.
function drawLegs(c, target, { dim = false, labels = true } = {}) {
  for (const l of c.legs)
    leg(l.a, l.b, { kind: l.kind, dim, label: labels ? fmtM(l.d) : null }).addTo(target);
}

// ---------------------------------------------------------------------------
// Screen 1 — Why identifiers, not proximity
function renderWhy(view) {
  // Every number here is a fact about the whole catchment, so compute it rather than assert it.
  //
  // THREE DIFFERENT COUNTS OF "OUTLET", and they must not be merged:
  //   nDp     the outlets that EXIST     — what the register says
  //   nMapped the outlets we can DRAW    — what has a coordinate
  //   nMon    the outlets that are MONITORED — what has a sampling point
  //   total   the outlets we can SCORE   — both of the above; the only fair test of a spatial join
  const nDp = combos.reduce((n, c) => n + c.nDp, 0);
  const nMapped = combos.reduce((n, c) => n + c.nMapped, 0);
  const nNoGeom = combos.reduce((n, c) => n + c.nNoGeom, 0);
  const nMon = combos.reduce((n, c) => n + Object.keys(c.monOf).length, 0);
  const nNoSp = nDp - nMon;                                   // exist, but nobody monitors them
  const nCoords = new Set(combos.flatMap((c) => Object.values(c.dp).map((g) => g.key))).size;
  const stacked = Object.values(stacks).reduce((n, st) => n + st.length, 0);
  const nAmbient = allSp.filter((s) => !s.monitors).length;
  const nOutfall = allSp.length - nAmbient;

  // What proximity gets right, over every outlet that has BOTH a coordinate and a stated answer.
  //
  // Scored twice. The first is the real test: the join may choose from the WHOLE layer, because that
  // is what a GIS actually holds. The second is the ORACLE — restrict the layer to the points that
  // genuinely monitor a discharge, which is the standard objection to this page ("just filter the
  // layer") and which is circular, since you can only build that filter from the answer. We run it
  // anyway, because the argument is stronger when it survives its own best objection with a number.
  let hit = 0, oracleHit = 0, total = 0, notAnOutfall = 0, unscorable = 0;
  for (const c of combos)
    for (const [dpIri, g] of Object.entries(c.dp)) {
      const truth = c.monOf[dpIri];
      if (!truth) continue;
      // The stated answer is not in the map layer AT ALL — the archive does not publish that point, so
      // it has no coordinate and a nearest-feature join could never return it however close it is.
      // Counting these as misses would rig the test in our favour, so they are excluded from the score
      // and reported on their own. They are the purest form of the argument: geometry cannot even
      // REPRESENT the answer here, and the identifier names it without difficulty.
      if (!c.sp[truth]) { unscorable++; continue; }
      total++;
      const near = nearestSp(g);
      if (near.sp.iri === truth) hit++;
      if (!near.sp.monitors) notAnOutfall++;
      if (nearestSp(g, { onlyOutfalls: true }).sp.iri === truth) oracleHit++;
    }

  // --- THE OBJECTION, ANSWERED WITH THE OPPOSITION'S OWN BEST WEAPON -----------------------------
  // Score the same join against ALL THREE grid references the register carries, over the outlets that
  // carry all three (so the rows compare the same outlets three ways and the comparison is honest).
  const three = [];
  for (const c of combos)
    for (const [dpIri, site] of Object.entries(c.dp)) {
      const truth = c.monOf[dpIri];
      const alt = altGeom[dpIri];
      if (!truth || !c.sp[truth] || !alt || !alt.outlet || !alt.effluent) continue;
      three.push({ truth, site, outlet: alt.outlet, effluent: alt.effluent });
    }
  const scoreLevel = (key) => {
    let ok = 0;
    const coords = new Set();
    for (const t of three) {
      coords.add(t[key].key);
      if (nearestSp(t[key]).sp.iri === t.truth) ok++;
    }
    return { ok, coords: coords.size, pct: Math.round(100 * ok / three.length) };
  };
  const LEVELS = [
    { key: "site", col: "DISCHARGE_NGR", what: "the discharge <b>site</b>",
      note: "coarsest — one per site, inherited by every outlet of every permit there" },
    { key: "outlet", col: "OUTLET_GRID_REF", what: "the <b>outlet</b>", note: "finer" },
    { key: "effluent", col: "EFFLUENT_GRID_REF", what: "the <b>effluent</b>", note: "finest" },
  ].map((l) => ({ ...l, ...scoreLevel(l.key) }));
  const best = LEVELS.reduce((a, b) => (b.ok > a.ok ? b : a));

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
        <h3>What the catchment actually holds</h3>
        <div class="stats">
          <div class="stat"><b>${nDp}</b><span>outlets the register states exist</span></div>
          <div class="stat"><b>${nMapped}</b><span>of them have a coordinate — the rest cannot be drawn <i>or</i> guessed at</span></div>
          <div class="stat"><b>${nMon}</b><span>have a sampling point named by the register</span></div>
        </div>
        <p class="note">
          Those three numbers are deliberately kept apart. <b>${nDp} outlets exist</b>; a map can only
          show <b>${nMapped}</b> of them; only <b>${total}</b> have <i>both</i> a position to measure
          from <i>and</i> a stated answer to check against — so <b>${total}</b> is the only honest
          denominator for scoring a guess. Collapsing them into one figure would be this page's own
          argument turned on its head: letting the presence of geometry decide what counts as real.
        </p>

        <h3>How much of the register can a map recover?</h3>
        <p class="note">
          The question is not "which join is better" — that would be circular, because
          <code>water:monitoredAt</code> <i>is</i> the register's own statement of the answer, and
          scoring it against itself would return 100% by construction. It would prove nothing, and this
          page used to show it as a green tile as though it had.
          <b>The honest question is the other one:</b> if you threw the identifier away, how much of it
          could you get back from the map? That is falsifiable, and this is the answer.
        </p>
        <div class="stats">
          <div class="stat bad"><b>${hit} / ${total}</b><span>recovered from the ${allSp.length}-point layer (${Math.round(100 * hit / total)}%)</span></div>
          <div class="stat bad"><b>${oracleHit} / ${total}</b><span>recovered <i>even if you already knew which points are outfalls</i> (${Math.round(100 * oracleHit / total)}%)</span></div>
        </div>
        <p class="note">
          The second column is the objection this page has to answer, so it answers it with a number
          rather than an argument. <i>"Just restrict the layer to outfall points"</i> — very well: hand
          the join an <b>oracle</b>, a layer containing only the <b>${nOutfall}</b> sampling points that
          genuinely monitor a discharge, a layer you could only build if you already possessed the answer
          you are trying to compute. It still recovers just <b>${oracleHit} of ${total}</b>. Even
          cheating, proximity barely beats a coin toss — and the radius trap below survives the oracle
          intact.
        </p>
        <p class="note">
          One thing this page cannot show you, and should say so: it can demonstrate that
          <code>monitoredAt</code> is <b>stated</b>, not that it is <b>correct</b>. If the register's own
          link were wrong, nothing here would catch it. What it can demonstrate is that a map cannot
          reconstruct it — and that a link you can check is worth more than one you have to infer.
        </p>
      </section>

      <section class="board">
        <h3>"But you used the worst coordinate"</h3>
        <p class="note">
          The fair objection to everything above is that we hung the join on the <b>coarsest</b> of the
          three grid references the register carries, and then complained that it did not work. So here
          is the same join, run against <b>all three</b>, over the <b>${three.length}</b> outlets that
          carry every one of them — the same outlets, three ways.
        </p>
        <table class="geo-table">
          <thead><tr>
            <th>Grid reference the register carries</th>
            <th>Locates</th>
            <th class="num">Distinct coords</th>
            <th class="num">Nearest point correct</th>
          </tr></thead>
          <tbody>
            ${LEVELS.map((l) => `
              <tr${l.key === "site" ? ' class="ours"' : ""}>
                <td><code>${l.col}</code>${l.key === "site" ? ' <span class="tag">what this store publishes</span>' : ""}</td>
                <td>${l.what} <span class="muted">— ${l.note}</span></td>
                <td class="num">${l.coords}</td>
                <td class="num bad"><b>${l.ok} / ${three.length}</b> (${l.pct}%)</td>
              </tr>`).join("")}
            <tr class="truth">
              <td><code>water:monitoredAt</code> <span class="tag ok">the identifier</span></td>
              <td>nothing — it is <b>not a place</b></td>
              <td class="num">—</td>
              <td class="num ok"><b>${three.length} / ${three.length}</b> (100%)</td>
            </tr>
          </tbody>
        </table>
        <p class="note">
          <b>The objection is real, and it does not rescue the method.</b> The finest coordinate the
          register holds is worth roughly <b>${best.pct}%</b> — better than the site reference, and still
          a join you would not want to defend to a regulator. One outlet in four is filed under the wrong
          watercourse.
        </p>
        <p class="note">
          Two things are worth staring at. <b>Precision is not accuracy:</b> the effluent reference
          resolves ${LEVELS[2].coords} distinct coordinates against the outlet reference's
          ${LEVELS[1].coords}, and buys almost nothing for it — so <i>"just use the most precise
          coordinate"</i> is not a rule that saves you. And the ${LEVELS[0].pct}%-vs-${best.pct}% gap is
          not a fact about the world at all: it is decided by <b>which column of a spreadsheet</b>
          somebody hung the geometry on, two levels above the thing being joined. Change the schema
          choice and the "answer" changes.
        </p>
        <p class="note">
          <code>water:monitoredAt</code> is unmoved by any of it. It is not a better coordinate — it is
          <b>not a coordinate</b>. It is the regulator's own statement of which sampling point measures
          which outlet, and it reads the same whether the two are 5 metres apart, 5 kilometres apart, or
          <a href="#/${UNLOCATABLE.id}">nowhere at all</a>.
        </p>
        <a class="sparql-link ext-link" href="sparql.html#q=${encodeURIComponent(THREE_GEOM_QUERY)}"
           target="_blank" rel="noopener">◈ Run the comparison yourself — all three grid references</a>

        <p class="note">
          The ways it goes wrong are not near-misses. They are the four screens that follow:
        </p>
        <ol class="modes">
          <li><b>It can return something that is not an outfall.</b> The layer holds
            <b>${allSp.length}</b> sampling points and only <b>${nOutfall}</b> of them
            monitor a discharge; the other <b>${nAmbient}</b> are rivers, boreholes and bathing waters.
            For <b>${notAnOutfall}</b> outlets, the closest sampling point is one of those.
            → <a href="#/blackheath">Blackheath</a></li>
          <li><b>It cannot separate things that share a coordinate.</b> <b>${stacked}</b> of the
            <b>${nMapped}</b> mapped outlets share their published coordinate with another outlet — all
            ${nMapped} of them fit on just <b>${nCoords}</b> distinct points. To a map they are
            ${nCoords} things, not ${nMapped}.
            → <a href="#/brockhill">Brockhill</a></li>
          <li><b>It cannot be given a radius that works.</b> The gap between an outlet and its own
            sampling point runs from a few metres to over a kilometre, so no single threshold both
            reaches the far ones and excludes the neighbours. → <a href="#/doreys">Doreys</a></li>
          <li><b>And where there is no geometry, it cannot be run at all.</b> <b>${nNoGeom}</b> of the
            <b>${nDp}</b> outlets have <b>no coordinate at all</b> — the register gives their permit no
            grid reference, and this store refuses to invent one. A spatial join has nothing to measure
            from; the identifier does not notice.
            → <a href="#/${UNLOCATABLE.id}">Outlets with no location</a></li>
        </ol>
        <p class="note">
          Two more failures have no screen of their own, because neither is a <i>mis</i>-join — each is
          a <i>silence</i>. <b>${nNoSp}</b> outlets have no sampling point at all: nobody monitors them,
          and a proximity join will still hand each one its nearest point and report nothing amiss. And
          for <b>${unscorable}</b> outlets the correct answer <b>is not in the layer</b> — the register
          names their sampling point, the Water Quality Archive publishes no coordinate for it, so no
          spatial join could return it however close it stood. They are excluded from the score above
          rather than counted as misses, because a test proximity cannot possibly pass is not a fair
          one. <code>water:monitoredAt</code> names them without noticing the difficulty.
        </p>
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
        <p class="kicker">Example ${n} of ${N_EXAMPLES} · ${esc(ex.site)}</p>
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
        <div class="fitbar" id="ex-fit"></div>
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
        "US" in its name is the EA's own abbreviation for <b>upstream</b>. So the join has not merely
        picked the wrong sampling point — it has picked the one place whose readings are, by design,
        unaffected by this works. Use it to judge the permit and the works looks spotless, because you
        are measuring water that has not reached it yet.
      </p>
      <p class="note">
        A caveat we should own: <i>upstream</i> here rests on the <b>EA's naming convention</b>, not on
        anything this store can derive. It holds no flow direction and no river network, so it cannot
        prove which way the water runs. The convention is well corroborated — the other Sherford
        stations lie east, and the river runs east to Poole Harbour — but it is a convention, and the
        sentence above leans on it. Load the WFD river network and it becomes a derivation instead.
      </p>
      <p class="note">
        You cannot fix this by filtering the layer down to "just the outfalls", because knowing which
        points are this permit's outfalls is precisely what the join was supposed to tell you. And the
        <a href="#/why">scoreboard</a> settles it empirically: even <i>given</i> that filter, proximity
        recovers only about half the register.
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

  // Every ASSERTED link of this permit — outlet → sampling point (amber) AND WINEP action → permit
  // (purple) — each labelled with the distance it spans. Then, in red, what proximity would have
  // picked instead, wherever that differs. The red lines are the only guesses on the map.
  drawLegs(c, map);
  for (const o of outlets)
    if (!o.hit)
      leg(o.g, o.near, { color: "#e5484d", dash: "5 4", weight: 2, kind: "mon" }).addTo(map);

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

  // TWO frames, because they answer two different questions and no single zoom serves both.
  //
  //   "the join"  — the outlets, the points the identifier names for them, and the points proximity
  //                 would have picked instead. This is the argument, and it plays out over metres.
  //   "everything" — plus the WINEP action sites, which at Blackheath sit 1.4 km away. Fitting them
  //                 by default zooms out until the 19 m that decides the whole thing is one pixel.
  //
  // So the join frames the map, and the WINEP legs run off the edge until you ask for them. That is
  // itself the lesson: the things a permit ties together do not fit in one comfortable view.
  const joinPts = [
    ...outlets.map((o) => o.g.ll),
    ...outlets.filter((o) => o.truth).map((o) => c.sp[o.truth].ll),
    ...outlets.map((o) => o.near.ll),
  ];
  const allPts = [...joinPts, ...Object.values(c.act).map((g) => g.ll)];
  const fit = (pts) => map.fitBounds(L.latLngBounds(pts).pad(0.35), { maxZoom: 17 });
  fit(joinPts);

  const bar = document.getElementById("ex-fit");
  if (c.nAct) {
    const far = Math.max(...c.legs.filter((l) => l.kind === "winep").map((l) => l.d));
    bar.innerHTML =
      `<button class="fit on" data-fit="join">Frame the join</button>` +
      `<button class="fit" data-fit="all">Frame everything — the WINEP action${c.nAct > 1 ? "s sit" : " sits"} ${fmtM(far)} away</button>`;
    bar.querySelectorAll(".fit").forEach((b) => b.addEventListener("click", () => {
      bar.querySelectorAll(".fit").forEach((x) => x.classList.toggle("on", x === b));
      fit(b.dataset.fit === "all" ? allPts : joinPts);
    }));
  } else bar.innerHTML = "";

  document.getElementById("ex-legend").innerHTML = [
    `<span class="key"><span class="sw" style="background:${ROLE.dp.color}"></span>Discharge point</span>`,
    `<span class="key"><span class="sw" style="background:${ROLE.sp.color}"></span>Its sampling point</span>`,
    ...(c.nAct ? [`<span class="key"><span class="sw" style="background:${ROLE.act.color}"></span>WINEP action</span>`] : []),
    `<span class="key"><span class="sw sm" style="background:#2f6b4f"></span>other outfall points</span>`,
    `<span class="key"><span class="sw sm" style="background:${AMBIENT_COLOR}"></span>points monitoring no discharge</span>`,
    `<span class="key"><span class="ln amber"></span><code>monitoredAt</code> · outlet → sampling point</span>`,
    ...(c.nAct ? [`<span class="key"><span class="ln purple"></span><code>targetPermit</code> · WINEP → permit</span>`] : []),
    `<span class="key"><span class="ln red"></span>what proximity would pick</span>`,
  ].join("");
}

// ---------------------------------------------------------------------------
// Screen 5 — Example 4. The outlets the register gives no location for.
//
// The other three screens ask "does proximity get the right answer?". This one asks a prior question
// the other three take for granted: is there anything to measure from at all? For these outlets there
// is not, and the honest response to "where is the outfall?" is that the sources do not say.
let unlocatablePermit = null;

// Every gap the store CAN measure — outlet to the sampling point that monitors it. This is the only
// evidence anyone has about how far an outfall sits from where it is sampled, and it is what decides
// whether a circle drawn round a sampling point could ever be trusted to contain the outfall.
function knownGaps() {
  return combos.flatMap((c) => c.legs.filter((l) => l.kind === "mon").map((l) => l.d)).sort((a, b) => a - b);
}

function renderUnlocatable(view) {
  // The permits that own an outlet with no published coordinate.
  const affected = combos.filter((c) => c.nNoGeom > 0);
  if (!affected.length) { view.innerHTML = `<p class="pts-error">No unlocatable outlets in the store.</p>`; return; }
  if (!affected.some((c) => c.id === unlocatablePermit)) unlocatablePermit = affected[0].id;

  const nNoGeom = affected.reduce((n, c) => n + c.nNoGeom, 0);
  const nDp = combos.reduce((n, c) => n + c.nDp, 0);
  const gaps = knownGaps();
  const within = (r) => gaps.filter((d) => d <= r).length;
  const pct = (n) => Math.round((100 * n) / gaps.length);
  const beyond500 = gaps.length - within(500);
  const hectares = Math.round((Math.PI * 500 * 500) / 10000);

  view.innerHTML = `
    <article class="screen">
      <section class="hero">
        <p class="kicker">Example ${N_EXAMPLES} of ${N_EXAMPLES} · ${esc(UNLOCATABLE.site)}</p>
        <h2>${esc(UNLOCATABLE.mode)}</h2>
        <p class="lede">
          <b>${nNoGeom}</b> of this catchment's <b>${nDp}</b> outlets have <b>no coordinate at all</b>.
          The consents register gives their permit no site grid reference, and this store refuses to
          invent one — an outlet whose location is unknown is published with <i>no geometry</i>, not
          with a plausible guess borrowed from somewhere nearby.
        </p>
        <p class="lede">
          So the only fixed points we have for these permits are the <b>sampling points</b> the EA
          measures them at, and any <b>WINEP action site</b> proposed for them. The question this
          screen puts to you is the one a spatial join answers silently, every time, without being
          asked: <b>given only those, where is the outfall?</b>
        </p>
        <p class="scoreline">
          <span class="sc bad">a spatial join can attempt <b>0 of ${nNoGeom}</b></span>
          <span class="sc ok"><code>monitoredAt</code> names a sampling point for
            <b>${affected.reduce((n, c) => n + Object.keys(c.noGeom).filter((i) => c.monOf[i]).length, 0)} of ${nNoGeom}</b></span>
        </p>
      </section>

      <section class="picker">
        <span class="pick-label">Permit</span>
        ${affected.map((c) => `<button class="pick${c.id === unlocatablePermit ? " on" : ""}" data-permit="${esc(c.id)}">
            ${esc(c.id)} <span class="n">${c.nNoGeom} outlet${c.nNoGeom > 1 ? "s" : ""}</span>
          </button>`).join("")}
      </section>

      <section class="stage">
        <div class="mapwrap">
          <div id="un-map" class="ex-map"></div>
          <p class="mapnote">
            <b>The outfall is not on this map.</b> There is no honest place to put it — so it is not
            drawn, not even as a guess at the centre of these circles.
          </p>
        </div>
        <div class="maplegend" id="un-legend"></div>
      </section>

      <section class="split" id="un-panels"></section>

      <section class="board">
        <h3>So — could the outfall be anywhere in those circles?</h3>
        <p class="lede">
          No. And the store can prove it, because it holds <b>${gaps.length}</b> outlets whose location
          <i>is</i> published, each with a sampling point that monitors it. Measure how far apart those
          known pairs actually sit, and you have the only honest answer to "how close to its sampling
          point does an outfall lie?":
        </p>
        <table class="tbl">
          <thead><tr><th class="r">Circle</th><th class="r">Known outlets inside it</th>
            <th>What that means for the guess</th></tr></thead>
          <tbody>
            ${RADII.map((r) => {
              const k = within(r);
              return `<tr>
                <td class="r mono">${r} m</td>
                <td class="r"><b>${k} / ${gaps.length}</b> <span class="sub">(${pct(k)}%)</span></td>
                <td>${r === 5
                  ? `Assume the outfall is here and you would be right for <b class="bad">${pct(k)}%</b> of the outlets we <i>can</i> check.`
                  : r === 50
                  ? `Still wrong for <b class="bad">${100 - pct(k)}%</b> of them.`
                  : `Catches most — but <b class="bad">${beyond500}</b> known outlets lie <i>beyond</i> even this, and the circle is now <b>${hectares} hectares</b> of countryside.`}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
        <p class="lede">
          The median known gap is <b>${fmtM(gaps[Math.floor(gaps.length / 2)])}</b> and the largest is
          <b>${fmtM(gaps[gaps.length - 1])}</b>. So a circle small enough to be a useful answer is
          almost always the wrong one, and a circle large enough to be safe is not an answer at all —
          it is ${hectares} hectares and a shrug. There is no radius at which "the outfall is somewhere
          in here" becomes a statement you could put in a permit, a report, or a prosecution.
        </p>
        <p class="note">
          <b>The honest position:</b> without correcting the source data, the location of these
          ${nNoGeom} outfalls is <b>unknown</b> — not approximate, not uncertain-within-a-tolerance,
          <i>unknown</i>. A spatial pipeline cannot represent that. It either drops the outlet without
          telling you, or it fabricates a coordinate that looks exactly like the real ones (which is
          what this very store used to do — see
          <code>ttl/regulation/regulation_to_db.py</code>). Neither failure is visible downstream.
        </p>
        <p class="note">
          <b>And what does the identifier lose?</b> Nothing.
          <code>water:monitoredAt</code> still names the sampling point for these outlets, and
          <code>reg:targetPermit</code> still ties any WINEP action to the permit. The links were never
          computed from the geometry, so they do not degrade when it is missing. The right fix is to
          <b>correct the register</b> — and until someone does, the graph says plainly that it does not
          know, which is the one thing a coordinate can never say.
        </p>
      </section>

      ${nav(UNLOCATABLE.id)}
    </article>`;

  view.querySelectorAll(".pick").forEach((b) => b.addEventListener("click", () => {
    unlocatablePermit = b.dataset.permit;
    renderUnlocatable(view);   // re-render: the map, panels and circles are all per-permit
  }));

  drawUnlocatable(byId[unlocatablePermit]);
}

// The map for one such permit: what we DO know (sampling points, WINEP sites), the circles a reader
// might be tempted to draw round them — and, conspicuously, no outfall.
function drawUnlocatable(c) {
  map = newMap(document.getElementById("un-map"));
  const anchors = Object.values(c.sp);
  const acts = Object.values(c.act);

  // Concentric rings around every sampling point. Drawn in metres (Leaflet's L.circle takes a radius
  // in metres and is therefore correct on the ground, unlike a fixed pixel radius).
  for (const g of anchors)
    for (const r of RADII)
      L.circle(g.ll, {
        radius: r, color: "#e5484d", weight: 1.2, opacity: 0.55,
        fillColor: "#e5484d", fillOpacity: 0.04, dashArray: "4 4", interactive: false,
      }).addTo(map).bindTooltip(`${r} m`, { className: "pts-leg", direction: "top" });

  for (const [iri, g] of Object.entries(c.sp))
    marker({ ...g, role: "sp" }, {
      radius: 7,
      label: `<div class="tt" style="color:${ROLE.sp.color}">Sampling point</div>` +
             `<div class="tid">${esc(shortSp(iri))}</div>` +
             `<div>${esc((allSp.find((s) => s.iri === iri) || {}).label || "")}</div>` +
             `<div class="tcrs">This we know. The outfall it samples, we do not.</div>`,
    }).addTo(map);

  for (const [iri, g] of Object.entries(c.act))
    marker({ ...g, role: "act" }, {
      label: `<div class="tt" style="color:${ROLE.act.color}">WINEP action site</div>` +
             `<div class="tid">${esc(shortAct(iri))}</div><div>${esc(g.label || "")}</div>`,
    }).addTo(map);

  // NO marker is drawn for the outfall — not even a question mark on the sampling point. There is
  // nowhere on this map it could honestly go, and putting a glyph at the sampling point would assert
  // the outfall is there, which is precisely the fabrication this store had to be purged of (the
  // deleted geometry fallback did exactly that, in data rather than in ink). The absence IS the
  // finding, so it is stated in words over the map instead of drawn as a pin.
  const pts = [...anchors.map((g) => g.ll), ...acts.map((g) => g.ll)];
  if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.45), { maxZoom: 16 });

  document.getElementById("un-legend").innerHTML = [
    `<span class="key"><span class="sw" style="background:${ROLE.sp.color}"></span>Sampling point — known</span>`,
    ...(acts.length ? [`<span class="key"><span class="sw" style="background:${ROLE.act.color}"></span>WINEP action site — known</span>`] : []),
    `<span class="key"><span class="ln red"></span>5 m · 50 m · 500 m from the sampling point</span>`,
    `<span class="key"><span class="sw" style="background:#0b1016;border:1px solid var(--red)"></span>Discharge point — <b>no location published</b></span>`,
  ].join("");

  // The two panels: what the store knows, and what it refuses to guess.
  const noGeomIris = Object.keys(c.noGeom);
  document.getElementById("un-panels").innerHTML = `
    <div class="panel">
      <h3>The outlets — and where they are</h3>
      <table class="tbl">
        <thead><tr><th>Outlet</th><th>Location</th><th>Monitored at</th></tr></thead>
        <tbody>${noGeomIris.map((iri) => {
          const sp = c.monOf[iri] ? allSp.find((s) => s.iri === c.monOf[iri]) : null;
          return `<tr>
            <td class="mono">${esc(tinyDp(iri))}</td>
            <td><span class="tag warn">none published</span></td>
            <td>${sp
              ? `<span class="mono">${esc(sp.id)}</span><br><span class="sub">${esc(sp.label)}</span>`
              : `<span class="sub">the register names none either</span>`}</td>
          </tr>`;
        }).join("")}</tbody>
      </table>
      <p class="note">
        The outlet exists, it is permitted, and it is sampled. The one thing nobody has written down
        is where it is.
      </p>
    </div>
    <div class="panel">
      <h3>Future works on this permit</h3>
      ${acts.length ? `
        <table class="tbl">
          <thead><tr><th>Action</th><th>Name</th></tr></thead>
          <tbody>${Object.entries(c.act).map(([iri, g]) => `<tr>
            <td class="mono">${esc(shortAct(iri))}</td><td>${esc(g.label || "—")}</td></tr>`).join("")}</tbody>
        </table>
        <p class="note">
          <code>reg:targetPermit</code> ties this action to the permit — <b>not</b> to a coordinate. It
          would survive the outfall's location being corrected, or never being known at all.
        </p>`
      : `<p class="lede">No WINEP action targets permit <span class="mono">${esc(c.id)}</span>.</p>
         <p class="note">
           Worth saying what this does <i>not</i> mean: a WINEP site would not have located the outfall
           anyway. It marks the <b>works</b>, which is a third place again — as
           <a href="#/blackheath">Blackheath</a> shows, where the action sites sit 1.35 km from the
           outlet they are meant to improve. Another known point is not another clue.
         </p>`}
    </div>`;
}

// ---------------------------------------------------------------------------
// Screen 6 — the Explorer. The collections themselves, with the map.
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
  // ASSERTED vs DRAWABLE, again, and this is the count most easily got wrong. `legs` are the links we
  // can DRAW — both ends need a coordinate. The links the store ASSERTS are more numerous, because an
  // outlet with no coordinate, or a sampling point the archive does not publish, still has its edge.
  // Saying "every monitoredAt in the catchment, N of them" while N counts only the drawable ones would
  // be this page committing its own cardinal sin in its own summary.
  const nLegs = combos.reduce((n, c) => n + c.legs.length, 0);
  const nAsserted = combos.reduce((n, c) => n + Object.keys(c.monOf).length + c.nAct, 0);
  const counts = {
    permits: combos.length, outlets: nDp, sampling: allSp.length, actions: nAct,
  };

  view.innerHTML = `
    <article class="screen">
      <section class="hero tight">
        <p class="kicker">Explorer</p>
        <h2>The collections</h2>
        <p class="lede">
          Everything the four examples were drawn from. <b>${combos.length}</b> permits own
          <b>${nDp}</b> discharge points, monitored across a layer of <b>${allSp.length}</b> sampling
          points — of which only <b>${allSp.filter((s) => s.monitors).length}</b> monitor a discharge at
          all — and <b>${nAct}</b> WINEP actions target those permits.
        </p>
        <p class="lede">
          The faint lines are the <b>asserted links</b> — every <code>reg:targetPermit</code> and every
          <code>water:monitoredAt</code> in the catchment, <b>${nAsserted}</b> of them. Only
          <b>${nLegs}</b> can be <i>drawn</i>: a line needs a coordinate at both ends, and
          ${nAsserted - nLegs} of these links have an end the map cannot place. They are no less true
          for it, which is the entire argument — so they are counted here even though they are not
          shown. Pick anything and its chain lights up —
          <b>WINEP action → permit → outlet → sampling point</b> — with the distance each link spans.
          None of those distances is small, and none of them is used to make the join.
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
          <p class="focusbar" id="ex-focus">
            <span class="muted">Pick anything on the left to light up its chain.</span>
          </p>
          <div class="maplegend" id="exp-legend"></div>
        </div>
      </section>

      ${nav("explorer")}
    </article>`;

  map = newMap(document.getElementById("exp-map"), { zoom: 11 });
  baseLayer = L.layerGroup().addTo(map);
  linkLayer = L.layerGroup().addTo(map);   // every asserted link, drawn faintly
  focusLayer = L.layerGroup().addTo(map);  // the selected thing's chain, bold and labelled
  drawExplorerBase(baseLayer);
  for (const c of combos) drawLegs(c, linkLayer, { dim: true, labels: false });

  document.getElementById("exp-legend").innerHTML = [
    `<span class="key"><span class="sw" style="background:${ROLE.dp.color}"></span>Discharge point</span>`,
    `<span class="key"><span class="sw" style="background:${ROLE.sp.color}"></span>Sampling point (an outfall's)</span>`,
    `<span class="key"><span class="sw" style="background:${AMBIENT_COLOR}"></span>Sampling point (monitors no discharge)</span>`,
    `<span class="key"><span class="sw" style="background:${ROLE.act.color}"></span>WINEP action site</span>`,
    `<span class="key"><span class="ln amber"></span><code>monitoredAt</code> · outlet → sampling point</span>`,
    `<span class="key"><span class="ln purple"></span><code>targetPermit</code> · WINEP → permit</span>`,
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

// The list for the current tab, filtered. Each row carries the CHAIN it belongs to — not just its
// own coordinates — because the thing worth seeing is never the point, it is what the point is tied
// to and how far away that is.
function fillList(q) {
  const needle = q.trim().toLowerCase();
  let items = [];

  if (explorerTab === "permits") {
    // A permit's whole chain: every WINEP action pointing at it, every outlet it owns, every
    // sampling point those outlets are monitored at.
    items = combos.map((c) => ({
      id: c.id,
      title: c.id,
      sub: `${c.nDp} outlet${c.nDp === 1 ? "" : "s"} · ${Object.keys(c.sp).length} sampling point${Object.keys(c.sp).length === 1 ? "" : "s"}` +
           (c.nAct ? ` · ${c.nAct} WINEP` : ""),
      tag: c.maxGap ? fmtM(c.maxGap) + " across" : "",
      legs: c.legs,
      ll: c.points.map((p) => p.ll),
    }));
  } else if (explorerTab === "outlets") {
    const mapped = combos.flatMap((c) => Object.entries(c.dp).map(([iri, g]) => {
      const st = stacks[g.key];
      const sp = c.monOf[iri] ? allSp.find((s) => s.iri === c.monOf[iri]) : null;
      const legs = c.legs.filter((l) => l.kind === "mon" && l.from === tinyDp(iri));
      return {
        id: shortDp(iri), title: tinyDp(iri),
        sub: sp ? `monitored at ${sp.id} — ${sp.label}` : "no sampling point named",
        tag: st ? `⊕ shares its point with ${st.length - 1} other${st.length === 2 ? "" : "s"}` : "",
        warn: !!st,
        legs,
        ll: [g.ll, ...legs.map((l) => l.b.ll)],
      };
    }));
    // The outlets with NO coordinate. They belong in this list — leaving them out because they cannot
    // be drawn is how a map quietly decides what exists.
    const unmapped = combos.flatMap((c) => Object.keys(c.noGeom).map((iri) => {
      const sp = c.monOf[iri] ? allSp.find((s) => s.iri === c.monOf[iri]) : null;
      return {
        id: shortDp(iri), title: tinyDp(iri),
        sub: sp ? `monitored at ${sp.id} — ${sp.label}` : "no sampling point named",
        tag: "no published location",
        warn: true,
        legs: [],
        ll: sp ? [sp.ll] : [],   // we can show where it is SAMPLED; never where it discharges
      };
    }));
    items = [...mapped, ...unmapped];
  } else if (explorerTab === "sampling") {
    // Read the other way round: a sampling point may be monitored FROM several outlets, across
    // several permits — so its chain fans out, and every strand of it is drawn.
    items = allSp.map((s) => {
      const legs = combos.flatMap((c) => c.legs.filter((l) => l.kind === "mon" && l.to === s.id));
      return {
        id: s.id, title: s.id, sub: s.label,
        tag: s.monitors ? `${legs.length} outlet${legs.length === 1 ? "" : "s"} monitored here` : "monitors no discharge",
        warn: !s.monitors,
        legs,
        ll: [s.ll, ...legs.map((l) => l.a.ll)],
      };
    });
  } else {
    items = combos.flatMap((c) => Object.entries(c.act).map(([iri, g]) => {
      const legs = c.legs.filter((l) => l.kind === "winep" && l.from === shortAct(iri));
      return {
        id: shortAct(iri), title: shortAct(iri),
        sub: g.label || "",
        tag: `permit ${c.id}`,
        // An action's chain runs all the way through: action → permit → its outlets → their
        // sampling points. Showing only action → permit would stop one link short of the point.
        legs: [...legs, ...c.legs.filter((l) => l.kind === "mon")],
        ll: [g.ll, ...c.points.map((p) => p.ll)],
      };
    }));
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
    focusChain(it);
  }));
}

// Light up one chain: its links drawn bold and labelled with the distance each one spans, the rest
// of the catchment left faint behind it. Then frame the whole chain — which is the moment the
// argument lands, because the frame it needs is usually far wider than the map you were looking at.
function focusChain(it) {
  focusLayer.clearLayers();
  for (const l of it.legs || [])
    leg(l.a, l.b, { kind: l.kind, label: fmtM(l.d) }).addTo(focusLayer);

  const pts = it.ll.filter(Boolean);
  if (pts.length > 1) map.fitBounds(L.latLngBounds(pts).pad(0.35), { maxZoom: 16 });
  else if (pts.length) map.setView(pts[0], 16);

  // What the chain spans, said in words — the number a spatial join would have had to guess.
  const spans = (it.legs || []).map((l) => l.d);
  const bar = document.getElementById("ex-focus");
  if (!bar) return;
  const lo = Math.min(...spans), hi = Math.max(...spans);
  const span = lo === hi ? fmtM(lo) : `${fmtM(lo)}–${fmtM(hi)}`;
  bar.innerHTML = spans.length
    ? `<b>${esc(it.title)}</b> — ${spans.length} asserted link${spans.length === 1 ? "" : "s"}, ` +
      `spanning ${span}. ` +
      `<span class="muted">Every one stated by an identifier; not one of them inferred from these distances.</span>`
    : it.tag === "no published location"
    // No geometry, so no leg can be drawn — and yet the link is not in doubt.
    ? `<b>${esc(it.title)}</b> — <span class="muted">no published location. Nothing to draw, nothing for a ` +
      `spatial join to measure — and its sampling point is still named exactly: ${esc(it.sub)}.</span>`
    : `<b>${esc(it.title)}</b> — <span class="muted">no asserted links: nothing in the register ties this to anything.</span>`;
}

boot();
