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
// Endpoints come from config.js (window.APP_CONFIG), loaded before this file, so the app can be
// pointed at another SPARQL server / observations proxy for a static deployment without a rebuild.
// Fall back to same-origin defaults if config.js is absent.
// Relative defaults (no leading slash) so the app works at the origin root AND under a sub-path.
const CONFIG = window.APP_CONFIG || {};
const ENDPOINT = CONFIG.sparqlEndpoint || "sparql";
const OBSERVATIONS_ENDPOINT = CONFIG.observationsEndpoint || "observations";
const TILES_URL = CONFIG.tilesUrl || "tiles/{z}/{x}/{y}.png";
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

// Sampling-point FAMILIES for the Ambient view.
//
// The archive types every sampling point, but with 17 distinct types in this catchment alone
// ("FRESHWATER - COMPARATIVE INLET POINTS", "SEWAGE DISCHARGES - STW STORM OVERFLOW/STORM TANK -
// WATER COMPANY", …) — far too many to tell apart as 17 map colours. The types are already
// hierarchical though: the EA's own label is "FAMILY - detail", so splitting on the first " - "
// recovers the archive's top-level split rather than inventing one. The exact type is never lost —
// it is on the marker's popup and in the table.
//
// Colours are the validated 8-slot categorical palette for a dark surface (worst adjacent CVD ΔE
// sits in the floor band, which is why the legend is always on and the table names every point's
// exact type — colour is never the only encoding).
const SP_FAMILIES = [
  { key: "FRESHWATER",                    label: "Freshwater — rivers, lakes, inlets", color: "#3987e5" },
  { key: "GROUNDWATER",                   label: "Groundwater — boreholes, springs",   color: "#199e70" },
  { key: "AGRICULTURE",                   label: "Agriculture — watercress, fish farms", color: "#c98500" },
  { key: "SALINE WATER",                  label: "Saline — bathing waters, estuary",   color: "#008300" },
  { key: "SEWAGE DISCHARGES",             label: "Sewage discharges",                  color: "#9085e9" },
  { key: "SEWAGE & TRADE COMBINED",       label: "Sewage & trade combined",            color: "#e66767" },
  { key: "TRADE DISCHARGES",              label: "Trade discharges",                   color: "#d55181" },
  { key: "POLLUTION/INVESTIGATION POINTS", label: "Pollution / investigation",         color: "#d95926" },
];
const OTHER_FAMILY = { key: "", label: "Other / untyped", color: "#8a94a0" };
// "SEWAGE DISCHARGES - FINAL/TREATED EFFLUENT - WATER COMPANY" -> the Sewage discharges family.
function familyOf(typeLabel) {
  const head = String(typeLabel || "").split(" - ")[0].trim();
  return SP_FAMILIES.find((f) => f.key === head) || OTHER_FAMILY;
}

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
PREFIX sosa:  <http://www.w3.org/ns/sosa/>
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

  // reg:breachesBound is what makes a breach legible. breachesCondition alone cannot tell a single
  // sample over an absolute maximum from a year-long 95th-percentile failure — both breach the same
  // condition. The bound carries the statistic, and ?assessment (rdfs:comment) states the arithmetic
  // in words ("6 exceedances ... 5 permitted for 48 samples").
  breaches: `${PREFIXES}
    SELECT ?breach ?type ?from ?to ?subLabel ?subNotation ?permit ?cond
           ?stat ?statLabel ?limit ?unitLabel ?assessment
           (SAMPLE(?sp) AS ?sp) (SAMPLE(?w) AS ?wkt) WHERE {
      ?breach reg:breachesCondition ?cond ;
              core:hasApplicability/core:applicabilityPeriod ?period .
      ?period core:applicableFrom ?from .
      OPTIONAL { ?period core:applicableTo ?to }
      OPTIONAL { ?breach a ?type . FILTER(?type IN (reg:ExceedanceBreach, reg:ShortfallBreach)) }
      OPTIONAL { ?breach rdfs:comment ?assessment }
      OPTIONAL { ?breach reg:breachesBound ?bound .
                 OPTIONAL { ?bound qudt:numericValue ?limit }
                 OPTIONAL { ?bound qudt:unit/skos:prefLabel ?unitLabel }
                 OPTIONAL { ?bound iop:hasStatisticalModifier ?stat . ?stat skos:prefLabel ?statLabel } }
      ?cond reg:regulatedProperty ?sub .
      ?sub skos:prefLabel ?subLabel ; skos:notation ?subNotation .
      ?permit reg:hasCondition ?cond ; reg:permitSite ?dp .
      ?dp water:monitoredAt ?sp ; geo:hasGeometry/geo:asWKT ?w .
      ?breach reg:evidencedByObservation ?obs .
      ?obs sosa:hasFeatureOfInterest ?sp .
    } GROUP BY ?breach ?type ?from ?to ?subLabel ?subNotation ?permit ?cond
             ?stat ?statLabel ?limit ?unitLabel ?assessment`,

  dischargePoints: `${PREFIXES}
    SELECT ?dp ?permit (SAMPLE(?w) AS ?wkt) ?sp WHERE {
      ?permit a water:WaterDischargePermit ; reg:permitSite ?dp .
      ?dp geo:hasGeometry/geo:asWKT ?w .
      OPTIONAL { ?dp water:monitoredAt ?sp }
    } GROUP BY ?dp ?permit ?sp`,

  // A condition can carry SEVERAL upper bounds — one per statistic. At a sewage works the 95th
  // percentile is the binding limit and the MAXIMUM is an upper-tier backstop 2-4x looser, so the
  // statistic has to come back with the value or the two are indistinguishable. ?stat is the
  // modifier IRI (…/statistical-modifier/percentile-95); see BINDING below.
  conditions: `${PREFIXES}
    SELECT ?permit ?cond ?subLabel ?subNotation ?upper ?stat ?statLabel ?lower ?unitLabel WHERE {
      ?permit a water:WaterDischargePermit ; reg:hasCondition ?cond .
      ?cond reg:regulatedProperty ?sub .
      ?sub skos:prefLabel ?subLabel ; skos:notation ?subNotation .
      OPTIONAL { ?cond reg:hasLimit/reg:upperBound ?ub . ?ub qudt:numericValue ?upper .
                 OPTIONAL { ?ub iop:hasStatisticalModifier ?stat . ?stat skos:prefLabel ?statLabel }
                 OPTIONAL { ?ub qudt:unit/skos:prefLabel ?unitLabel } }
      OPTIONAL { ?cond reg:hasLimit/reg:lowerBound/qudt:numericValue ?lower }
    }`,

  limitHistory: `${PREFIXES}
    SELECT ?permit ?subNotation ?version ?from ?to ?upper ?stat ?lower WHERE {
      ?permit a water:WaterDischargePermit ; reg:hasCondition ?cond .
      ?cond reg:regulatedProperty ?sub .
      ?sub skos:notation ?subNotation .
      BIND(IRI(REPLACE(STR(?cond), "/condition/.*", "")) AS ?doc)
      BIND(REPLACE(STR(?doc), ".*/version/", "") AS ?version)
      ?doc core:hasApplicability/core:applicabilityPeriod ?p .
      ?p core:applicableFrom ?from .
      OPTIONAL { ?p core:applicableTo ?to }
      OPTIONAL { ?cond reg:hasLimit/reg:upperBound ?ub . ?ub qudt:numericValue ?upper .
                 OPTIONAL { ?ub iop:hasStatisticalModifier ?stat } }
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

  // Every sampling point in the catchment, permitted or not. This is the Ambient view's whole
  // dataset, and it is deliberately NOT reached through a permit: `monitoredAt` is OPTIONAL here, so
  // a river, a borehole or a bathing water — which no permit will ever name — comes back alongside
  // the effluent points. (Before the store took its sampling points from the archive rather than
  // from the observations that happened to match a permit rule, only the 54 permit-monitored points
  // existed at all, and this query could not have been written.)
  samplingPoints: `${PREFIXES}
    SELECT ?sp ?label ?typeLabel ?status (SAMPLE(?w) AS ?wkt) (SAMPLE(?p) AS ?permit) WHERE {
      ?sp a sosa:FeatureOfInterest ; geo:hasGeometry/geo:asWKT ?w .
      OPTIONAL { ?sp skos:prefLabel ?label }
      OPTIONAL { ?sp water:samplingPointType/skos:prefLabel ?typeLabel }
      OPTIONAL { ?sp water:samplingPointStatus ?status }
      OPTIONAL { ?dp water:monitoredAt ?sp . ?p reg:permitSite ?dp }
    } GROUP BY ?sp ?label ?typeLabel ?status`,

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
// Provenance queries — the "◈ SPARQL" link on each table card.
// ---------------------------------------------------------------------------
// Each of these reproduces, as ONE declarative query, the row set the table shows — so a viewer can
// open the exact question the table answers and run it. They are a SEPARATE, hand-maintained
// representation from the runtime `Q` queries above: the app still runs the split `Q` queries once
// and joins them in JavaScript (to reuse results across the four views), while these fold that merge
// back into a single query for legibility. That means they CAN DRIFT from the JS join if the table
// logic changes and one side isn't updated. That trade-off is deliberate — this is a POC about *why*
// linked data, and the payoff is showing that every table is one answerable question, not a pile of
// imperative glue. See README → "Per-table SPARQL provenance links". A couple deliberately simplify
// (e.g. the substance story omits proposed-only rows); the drift note covers that.
const XSD_PFX = "PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>\n";
// A permit's in-force limits are its highest-numbered version's conditions; this sub-select finds
// that version per permit (the JS does it as Math.max over versions parsed from the condition IRI).
const CUR_VERSION = `      { SELECT ?permit (MAX(xsd:integer(REPLACE(STR(?c), ".*/version/([0-9]+)/.*", "$1"))) AS ?curV)
        WHERE { ?permit reg:hasCondition ?c } GROUP BY ?permit }`;

const PQ = {
  // Ambient sampling points — every place the EA samples in the catchment, with what is sampled
  // there and (only if there is one) the permit that discharges into it. The OPTIONAL is the whole
  // point: make it a plain join and the 95 points that belong to no permit vanish, which is exactly
  // the blind spot this view exists to remove.
  samplingPoints: () => `${PREFIXES}
    SELECT ?sp ?label ?typeLabel ?permit WHERE {
      ?sp a sosa:FeatureOfInterest ; geo:hasGeometry/geo:asWKT ?wkt .
      OPTIONAL { ?sp skos:prefLabel ?label }
      OPTIONAL { ?sp water:samplingPointType/skos:prefLabel ?typeLabel }
      OPTIONAL { ?dp water:monitoredAt ?sp . ?permit reg:permitSite ?dp }
    } ORDER BY ?typeLabel ?label`,

  // Breaches — one row per breach period. This is the single runtime query (Q.breaches): SAMPLE +
  // GROUP BY collapse the permit→discharge-point→sampling-point fan-out to one row per breach. The
  // observation is joined to its sampling point through the captured sosa:hasFeatureOfInterest edge
  // (see ttl/breaches/breaches_to_db.py), a real keyed join — not an IRI-prefix STRSTARTS filter,
  // which the engine can't key on and which fans out to a Cartesian product at scale.
  // reg:breachesBound names the bound that actually failed: breachesCondition alone cannot separate a
  // single sample over an absolute maximum from a year-long 95th-percentile failure.
  breaches: (sub) => `${PREFIXES}
    SELECT ?breach ?type ?from ?to ?subLabel ?subNotation ?statLabel ?limit ?assessment ?permit
           (SAMPLE(?sp) AS ?sp) WHERE {
      ?breach reg:breachesCondition ?cond ;
              core:hasApplicability/core:applicabilityPeriod ?period .
      ?period core:applicableFrom ?from .
      OPTIONAL { ?period core:applicableTo ?to }
      OPTIONAL { ?breach a ?type . FILTER(?type IN (reg:ExceedanceBreach, reg:ShortfallBreach)) }
      OPTIONAL { ?breach rdfs:comment ?assessment }
      OPTIONAL { ?breach reg:breachesBound ?bound .
                 OPTIONAL { ?bound qudt:numericValue ?limit }
                 OPTIONAL { ?bound iop:hasStatisticalModifier/skos:prefLabel ?statLabel } }
      ?cond reg:regulatedProperty ?sub .
      ?sub skos:prefLabel ?subLabel ; skos:notation ?subNotation .
      ?permit reg:hasCondition ?cond ; reg:permitSite ?dp .
      ?dp water:monitoredAt ?sp .
      ?breach reg:evidencedByObservation ?obs .
      ?obs sosa:hasFeatureOfInterest ?sp .${sub ? `\n      FILTER(?subNotation = "${sub}")` : ""}
    } GROUP BY ?breach ?type ?from ?to ?subLabel ?subNotation ?statLabel ?limit ?assessment ?permit`,

  // Permits & limits — one row per permit: current version, and counts of current-version limits,
  // discharge points and breaches. The app builds this by grouping conditions and joining three more
  // query results in JS; here it is one query with the current-version sub-select above.
  permits: (sub) => `${PREFIXES}${XSD_PFX}
    SELECT ?permit (MAX(?curV) AS ?version)
           (COUNT(DISTINCT ?curCond) AS ?currentLimits)
           (COUNT(DISTINCT ?dp) AS ?dischargePoints)
           (COUNT(DISTINCT ?breach) AS ?breaches) WHERE {
${CUR_VERSION}
      ?permit a water:WaterDischargePermit .
      OPTIONAL {
        ?permit reg:hasCondition ?curCond .
        FILTER(xsd:integer(REPLACE(STR(?curCond), ".*/version/([0-9]+)/.*", "$1")) = ?curV)
      }
      OPTIONAL { ?permit reg:permitSite ?dp }
      OPTIONAL { ?breach reg:breachesCondition ?bc . ?permit reg:hasCondition ?bc }${sub ? `
      FILTER EXISTS { ?permit reg:hasCondition ?sc .
        FILTER(xsd:integer(REPLACE(STR(?sc), ".*/version/([0-9]+)/.*", "$1")) = ?curV)
        ?sc reg:regulatedProperty ?scp . ?scp skos:notation "${sub}" }` : ""}
    } GROUP BY ?permit`,

  // Substance story — the current permit limit joined to any proposed WINEP future limit, per permit
  // and substance. (Simplification: this LEFT-joins from current limits, so it omits the rare
  // proposed-only row — a future limit for a permit/substance with no current limit.)
  substanceStory: (sub) => `${PREFIXES}${XSD_PFX}
    SELECT ?permit ?subLabel ?currentUpper ?currentStat ?unit ?monitoredAt ?action ?actionName ?completion ?proposedUpper WHERE {
${CUR_VERSION}
      ?permit reg:hasCondition ?cond .
      FILTER(xsd:integer(REPLACE(STR(?cond), ".*/version/([0-9]+)/.*", "$1")) = ?curV)
      ?cond reg:regulatedProperty ?sub . ?sub skos:notation ?subNotation ; skos:prefLabel ?subLabel .${sub ? `
      FILTER(?subNotation = "${sub}")` : ""}
      OPTIONAL { ?cond reg:hasLimit/reg:upperBound ?ub . ?ub qudt:numericValue ?currentUpper .
                 OPTIONAL { ?ub iop:hasStatisticalModifier ?currentStat }
                 OPTIONAL { ?ub qudt:unit/skos:prefLabel ?unit } }
      OPTIONAL { ?permit reg:permitSite/water:monitoredAt ?monitoredAt }
      OPTIONAL { ?action reg:targetPermit ?permit ; reg:proposesLimit ?lim ; rdfs:label ?actionName .
                 ?lim reg:regulatedProperty ?s2 . ?s2 skos:notation ?subNotation .
                 OPTIONAL { ?action core:applicabilityPeriod/core:applicableFrom ?completion }
                 OPTIONAL { ?lim reg:upperBound/qudt:numericValue ?proposedUpper } }
    }`,

  // WINEP actions — one row per action with a count of the future limits it proposes (Q.actions plus
  // the proposed-limit join the app does as limByAction).
  actions: () => `${PREFIXES}
    SELECT ?action ?label ?completion ?permit (COUNT(DISTINCT ?limit) AS ?limits) WHERE {
      ?action a reg:Action ; rdfs:label ?label .
      OPTIONAL { ?action reg:targetPermit ?permit }
      OPTIONAL { ?ap core:applicabilityPeriod/core:applicableFrom ?completion .
                 FILTER(STRSTARTS(STR(?ap), CONCAT(STR(?action), "#"))) }
      OPTIONAL { ?action reg:proposesLimit ?limit }
    } GROUP BY ?action ?label ?completion ?permit ORDER BY ?completion`,

  // Applications — one row per SFI application with its option count and total annual payment
  // (Q.applications; the runtime also filters by option-type in JS, which this base question omits).
  applications: () => `${PREFIXES}
    SELECT ?app ?appId ?scheme (SUM(COALESCE(?c, 0)) AS ?total) (COUNT(DISTINCT ?opt) AS ?options) WHERE {
      ?app a farm:Application ; core:hasPart ?opt .
      OPTIONAL { ?app skos:notation ?appId }
      OPTIONAL { ?app ex:scheme ?scheme }
      OPTIONAL { ?opt farm:annualPayment/qudt:numericValue ?c }
    } GROUP BY ?app ?appId ?scheme ORDER BY DESC(?total)`,

  // Options for the selected application — one row per option with its concept and payment.
  sfiOptions: (appIri) => `${PREFIXES}
    SELECT ?opt ?broaderLabel ?def ?cost WHERE {${appIri ? `
      BIND(<${appIri}> AS ?app)` : ""}
      ?app a farm:Application ; core:hasPart ?opt .
      OPTIONAL { ?opt core:hasClassification ?con .
                 OPTIONAL { ?con skos:definition ?def }
                 OPTIONAL { ?con skos:broader/skos:prefLabel ?broaderLabel } }
      OPTIONAL { ?opt farm:annualPayment/qudt:numericValue ?cost }
    }`,
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
// Some permit references contain slashes — "400114/CF/01" is a real permit in this catchment — so the
// IRI carries them percent-encoded inside the path segment: .../permit/400114%2FCF%2F01. That IRI is
// CORRECT and must stay: a raw slash would fake a path hierarchy and collide with the outlet IRIs
// minted under it (.../permit/{ref}/outlet/{n}/effluent/{n}). But %2F is an artefact of IRI syntax,
// not part of the permit's name, so it must never reach a human. Decode at the display boundary —
// the result is exactly the core:identifierValue the store carries alongside the IRI.
const unescIri = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
const permitRef = (iri) => (iri ? unescIri(last(iri)) : "—");
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

// --- Which upper bound is "the limit"? -------------------------------------------------------
// A condition may hold several upper bounds, one per statistic. They are NOT interchangeable:
//
//   percentile-95 / annual-average  the BINDING limit — what the permit actually requires. But a
//                                   PERIOD statistic: one sample above it is an *exceedance*, not a
//                                   breach (the EA judges it over a 12-month sample set).
//   maximum                         an absolute PER-SAMPLE ceiling. One sample above it IS a
//                                   failure. Where a percentile also exists, this is the looser
//                                   "upper tier" backstop, typically 2-4x the binding value.
//
// So the chart draws the binding limit as THE limit line, and only ever puts a ✕ (miss) on a point
// that fails a per-sample rule. Marking a lone sample above a 95th-percentile line as a breach
// would be the same falsehood the data pipeline is careful to avoid.
const BINDING = ["percentile-95", "annual-average", "median", "maximum"]; // first present wins
const PER_SAMPLE = ["maximum"];                                           // judgeable from one sample

// From a {statSlug: value} map, the binding bound: {stat, value} | null.
function bindingBound(uppers) {
  if (!uppers) return null;
  for (const stat of BINDING)
    if (uppers[stat] != null) return { stat, value: Number(uppers[stat]) };
  const [stat, value] = Object.entries(uppers)[0] || [];
  return stat ? { stat, value: Number(value) } : null;
}
// The per-sample ceiling, if any — the only upper bound a single observation can actually breach.
const perSampleUpper = (uppers) => {
  if (!uppers) return null;
  for (const stat of PER_SAMPLE) if (uppers[stat] != null) return Number(uppers[stat]);
  return null;
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
  const binding = bindingBound(cond && cond.uppers);
  const maxUpper = perSampleUpper(cond && cond.uppers);
  return {
    label: sub ? sub.label : subNotation,
    unit: (cond && cond.unit) || (proposed[0] && proposed[0].unit) || "",
    upper: binding ? binding.value : null,            // THE limit (binding), drawn as the limit line
    upperStat: binding ? binding.stat : null,
    upperStatLabel: binding && cond.statLabels ? cond.statLabels[binding.stat] : null,
    // the per-sample ceiling, only when it is NOT already the binding bound — i.e. the upper tier
    maxUpper: binding && binding.stat !== "maximum" ? maxUpper : null,
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
// `upper` is the BINDING bound, `maxUpper` the per-sample ceiling (see BINDING above) — a point is a
// miss only against maxUpper/lower; exceeding `upper` when it is a percentile/mean is an exceedance.
function limitAt(steps, t, fb) {
  if (!steps.length) return fb;
  for (const s of steps) {
    if (s.from <= t && (s.to == null || t <= s.to))
      return { upper: s.upper, upperStat: s.upperStat, maxUpper: s.maxUpper, lower: s.lower };
  }
  const lastEnd = Math.max(...steps.map((s) => (s.to == null ? Infinity : s.to)));
  if (t > lastEnd) return fb;                                          // beyond the last dated window
  return { upper: null, upperStat: null, maxUpper: null, lower: null }; // before v1, or in a gap
}

// The chart on screen, kept so a window resize can redraw it at the panel's new size (the plot is
// drawn AT the panel's dimensions, not scaled to them — see chartBox).
let shownChart = null; // { ctx, obs, meta } | null

// `permit` may be null — an ambient sampling point has no permit, so no limit line, no proposed
// limit and no version history: chartContext returns an empty frame and the chart is just the
// observations. `at` pins the map on the point itself when there is no discharge point to fly to.
async function openChart(subNotation, sp, permit, at) {
  const chart = document.getElementById("chart");
  const ctx = chartContext(subNotation, permit);
  document.getElementById("chart-title").textContent = `${ctx.label} at ${sp}`;
  const body = document.getElementById("chart-body");
  chart.classList.remove("hidden");
  body.classList.add("fit"); // the time-series chart sizes itself to the panel; it never scrolls
  collapseLegend();
  // resize the (now narrower) map and zoom it to the charted sampling point's discharge point
  const dp = permit && (DB.dischargePoints.find((d) => d.permit === permit && d.sp === sp && d.lat != null)
    || DB.dischargePoints.find((d) => d.permit === permit && d.lat != null));
  const target = dp ? [dp.lat, dp.lon] : at;
  document.getElementById("map").scrollIntoView({ behavior: "smooth", block: "start" });
  setTimeout(() => {
    map.invalidateSize();
    if (target) map.setView(target, 13);
  }, 80);
  body.innerHTML = `<p class="chart-note">Loading observations…</p>`;
  try {
    const res = await fetch(`${OBSERVATIONS_ENDPOINT}?samplingPoint=${encodeURIComponent(sp)}&determinand=${encodeURIComponent(subNotation)}`);
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    const obs = (data.observations || [])
      .map((o) => ({ t: Date.parse(o.time), v: parseResult(o.result) }))
      .filter((o) => Number.isFinite(o.t) && o.v != null)
      .sort((a, b) => a.t - b.t);
    shownChart = { ctx, obs, meta: data };
    body.innerHTML = renderChart(ctx, obs, data);
  } catch (err) {
    shownChart = null;
    body.innerHTML = `<p class="chart-note">Could not load observations: ${esc(err.message)}</p>`;
  }
}

function closeChart() {
  document.getElementById("chart").classList.add("hidden");
  document.getElementById("chart-body").classList.remove("fit");
  shownChart = null;
  expandLegend();
  setTimeout(() => map.invalidateSize(), 60);
}

// The panel next to the map is the plot's canvas: draw at ITS size rather than at a fixed aspect
// scaled to fit, or a wide window (the panel is 44% of the stage) would make the plot taller than
// the map and the panel would scroll. Height leaves room for the legend above and the note below.
function chartBox() {
  const body = document.getElementById("chart-body");
  const r = body.getBoundingClientRect();
  return {
    W: Math.max(360, Math.round(r.width - 14)),   // minus #chart-body's horizontal padding
    H: Math.max(220, Math.round(r.height - 78)),  // minus its padding + the legend and note lines
  };
}

// Redraw at the new panel size so the plot keeps filling the map's height as the window changes.
let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!shownChart || document.getElementById("chart").classList.contains("hidden")) return;
    const { ctx, obs, meta } = shownChart;
    document.getElementById("chart-body").innerHTML = renderChart(ctx, obs, meta);
  }, 150);
});

function renderChart(ctx, obs, meta = {}) {
  if (!obs.length) return `<p class="chart-note">No observations for this substance at this sampling point.</p>`;
  const { W, H } = chartBox();
  const m = { l: 52, r: 16, t: 14, b: 38 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b, y0 = m.t + ih;
  const tMin = obs[0].t, tMax = obs[obs.length - 1].t;
  const propVals = ctx.proposed.map((b) => Number(b.val)).filter(Number.isFinite);
  const stepUppers = ctx.steps.flatMap((s) => [s.upper, s.maxUpper]).filter(Number.isFinite);
  const yMax = (Math.max(ctx.upper || 0, ctx.maxUpper || 0, ...stepUppers,
                         ...obs.map((o) => o.v), ...propVals) || 1) * 1.1;
  const x = (t) => m.l + (iw * (t - tMin)) / (tMax - tMin || 1);
  const y = (v) => m.t + ih - (ih * v) / yMax;
  const fb = { upper: ctx.upper, upperStat: ctx.upperStat, maxUpper: ctx.maxUpper, lower: ctx.lower };

  // How a single observation stands against the limit IN FORCE at its time (per version):
  //   "miss"       it fails a PER-SAMPLE rule — over the absolute maximum, or under the minimum.
  //                This is a breach on its own.
  //   "exceedance" it is over a 95th-percentile / annual-mean limit. NOT a breach: those are judged
  //                over a 12-month sample set, so one point above the line proves nothing by itself.
  //                Shown, because a run of them is exactly what tips the annual assessment.
  //   "hit"        inside everything.
  const statusAt = (o) => {
    const { upper, upperStat, maxUpper, lower } = limitAt(ctx.steps, o.t, fb);
    const ceiling = upperStat === "maximum" ? upper : maxUpper; // the per-sample ceiling, if any
    if ((ceiling != null && o.v > ceiling) || (lower != null && o.v < lower)) return "miss";
    if (upper != null && upperStat !== "maximum" && o.v > upper) return "exceedance";
    return "hit";
  };

  // Tick decimals come from the AXIS RANGE, not from each tick's own magnitude. Ambient river
  // readings run around 0.03 mg/l, where a fixed 1-decimal format prints five ticks as
  // "0.1, 0.1, 0.1, 0.0, 0.0" — an axis that appears to repeat itself and cannot be read.
  const dp = yMax >= 10 ? 0 : yMax >= 1 ? 1 : yMax >= 0.1 ? 2 : 3;
  let grid = "";
  for (let i = 0; i <= 5; i++) {
    const val = (yMax * i) / 5, yy = y(val);
    grid += `<line x1="${m.l}" y1="${yy}" x2="${W - m.r}" y2="${yy}" stroke="#2b3a49"/>` +
      `<text x="${m.l - 6}" y="${yy + 3}" fill="#93a4b3" font-size="10" text-anchor="end">${val.toFixed(dp)}</text>`;
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
  // plain stepped segments (used for the lower bound and the upper-tier backstop; no per-segment labels)
  const stepLine = (pick, width, colour = "#e5484d") => {
    let svg = "";
    for (const s of ctx.steps) {
      const v = pick(s);
      if (!Number.isFinite(v)) continue;
      const from = Math.max(s.from, tMin), to = Math.min(s.to == null ? tMax : s.to, tMax);
      if (to < tMin || from > tMax) continue;
      const yy = y(v);
      svg += `<line x1="${x(from)}" y1="${yy}" x2="${x(to)}" y2="${yy}" stroke="${colour}" stroke-width="${width}" stroke-dasharray="6 4"/>`;
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
  // The statistic the binding limit is expressed in ("95th percentile", "Annual average"), shown on
  // the line so nobody reads a percentile limit as a value no sample may exceed.
  const statSuffix = ctx.upperStatLabel && ctx.upperStat !== "maximum"
    ? ` (${esc(ctx.upperStatLabel)})` : "";
  // The upper-tier backstop, when the binding limit is a percentile/mean: a looser absolute ceiling.
  // Drawn darker and thinner than the binding limit — it is the line a single sample can actually fail.
  const TIER = "#8c2f33";
  if (hasSteps) {
    lines += stepLine((s) => s.maxUpper, 1.25, TIER) + stepUpperLine() + stepLine((s) => s.lower, 1.5);
    // value + unit on the RIGHT, for the latest (current) enforced limit only
    if (ctx.upper != null)
      lines += `<text x="${W - m.r}" y="${y(ctx.upper) - 4}" fill="#e5484d" font-size="10" text-anchor="end">${fmtNum(ctx.upper)} ${prettyUnit(ctx.unit)}${statSuffix}</text>`;
    if (ctx.maxUpper != null)
      lines += `<text x="${W - m.r}" y="${y(ctx.maxUpper) - 4}" fill="${TIER}" font-size="10" text-anchor="end">${fmtNum(ctx.maxUpper)} ${prettyUnit(ctx.unit)} (upper tier)</text>`;
  } else {
    // undated permit: one flat enforced line — version on the left, value + unit on the right
    if (ctx.maxUpper != null) {
      const yy = y(ctx.maxUpper);
      lines += `<line x1="${m.l}" y1="${yy}" x2="${W - m.r}" y2="${yy}" stroke="${TIER}" stroke-width="1.25" stroke-dasharray="6 4"/>`
        + `<text x="${W - m.r}" y="${yy - 4}" fill="${TIER}" font-size="10" text-anchor="end">${fmtNum(ctx.maxUpper)} ${prettyUnit(ctx.unit)} (upper tier)</text>`;
    }
    if (ctx.upper != null) {
      const yy = y(ctx.upper);
      lines += `<line x1="${m.l}" y1="${yy}" x2="${W - m.r}" y2="${yy}" stroke="#e5484d" stroke-width="1.75" stroke-dasharray="6 4"/>`
        + (ctx.version != null ? `<text x="${m.l + 3}" y="${yy - 4}" fill="#e5484d" font-size="10">v${esc(ctx.version)}</text>` : "")
        + `<text x="${W - m.r}" y="${yy - 4}" fill="#e5484d" font-size="10" text-anchor="end">${fmtNum(ctx.upper)} ${prettyUnit(ctx.unit)}${statSuffix}</text>`;
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

  // ✕ miss = fails a per-sample rule (a breach on its own). △ exceedance = over a percentile/mean
  // limit, which one sample cannot breach. ◯ hit. Keeping these apart is the whole point: a lone
  // point above a 95th-percentile line is evidence, not a verdict.
  const EXC = "#e8a33d";
  let pts = "", nMiss = 0, nExc = 0;
  for (const o of obs) {
    const px = x(o.t), py = y(o.v), st = statusAt(o);
    if (st === "miss") {
      nMiss++;
      const s = 3.5;
      pts += `<path d="M${px - s} ${py - s}L${px + s} ${py + s}M${px - s} ${py + s}L${px + s} ${py - s}" stroke="#e5484d" stroke-width="1.7"/>`;
    } else if (st === "exceedance") {
      nExc++;
      const s = 4;
      pts += `<path d="M${px} ${py - s}L${px + s} ${py + s * 0.75}L${px - s} ${py + s * 0.75}Z" fill="none" stroke="${EXC}" stroke-width="1.5"/>`;
    } else {
      pts += `<circle cx="${px}" cy="${py}" r="3" fill="none" stroke="#3aa0ff" stroke-width="1.5"/>`;
    }
  }
  const excLabel = ctx.upperStatLabel ? esc(ctx.upperStatLabel).toLowerCase() : "period limit";
  // A point in the measured world but not the regulated one has no limit to hit or miss — the
  // readings are just readings. Saying "hit (52)" there would invent a pass mark nobody set: a river
  // is not "compliant", it is merely measured. So when the context carries no bound, the legend says
  // what the chart actually shows and nothing more.
  const regulated = hasSteps || ctx.upper != null || ctx.maxUpper != null || ctx.lower != null;
  const legend = regulated
    ? `<div class="chart-legend">
        <span class="item" style="color:#e5484d">✕ miss (${nMiss})</span>
        ${nExc || ctx.maxUpper != null ? `<span class="item" style="color:${EXC}">△ over ${excLabel} (${nExc})</span>` : ""}
        <span class="item" style="color:#3aa0ff">◯ hit (${obs.length - nMiss - nExc})</span>
        <span class="item" style="color:#e5484d">– – enforced limit${hasSteps ? " (by version)" : ""}</span>
        ${ctx.maxUpper != null ? `<span class="item" style="color:${TIER}">– – upper tier</span>` : ""}
        ${ctx.proposed.length ? `<span class="item" style="color:#a06bff">– – proposed limit</span>` : ""}
      </div>`
    : `<div class="chart-legend">
        <span class="item" style="color:#3aa0ff">◯ observation (${obs.length})</span>
        <span class="item muted">measured, not regulated — no permit limit here</span>
        ${ctx.proposed.length ? `<span class="item" style="color:#a06bff">– – proposed limit</span>` : ""}
      </div>`;
  return `${legend}<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
    ${grid}
    <text transform="translate(13 ${m.t + ih / 2}) rotate(-90)" fill="#93a4b3" font-size="11" text-anchor="middle">${esc(prettyUnit(ctx.unit) || "value")}</text>
    ${lines}${pts}
    <line x1="${m.l}" y1="${m.t}" x2="${m.l}" y2="${y0}" stroke="#4a5b6b"/>
    <line x1="${m.l}" y1="${y0}" x2="${W - m.r}" y2="${y0}" stroke="#4a5b6b"/>
  </svg><p class="chart-note">${obs.length}${meta.partial ? "+" : ""} observations · ${
    meta.stale
      ? "cached copy (EA archive unreachable — may be out of date)"
      : meta.partial
      ? "partial (EA archive slow) · live from the EA Water Quality Archive"
      : "live from the EA Water Quality Archive"
  }</p>`;
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
  // The farming pie/bars keep their own (scrollable) layout — only the time-series chart is
  // height-fitted to the panel.
  document.getElementById("chart-body").classList.remove("fit");
  shownChart = null;
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
// The sampling point a permit is monitored at — the chart fetches its observations from there. A
// permit can have several discharge points; the tables all chart the first one that names an sp.
const spForPermit = (permit) => (DB.dischargePoints.find((d) => d.permit === permit && d.sp) || {}).sp || null;

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
let currentView = "permits";
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
  const [substances, breaches, dps, conditions, actions, proposed, applications, groupLabels, sfiOptions, limitHistory, samplingPoints] =
    await Promise.all([
      sparql(Q.substances), sparql(Q.breaches), sparql(Q.dischargePoints),
      sparql(Q.conditions), sparql(Q.actions), sparql(Q.proposed),
      sparql(Q.applications), sparql(Q.groupLabels), sparql(Q.sfiOptions), sparql(Q.limitHistory),
      sparql(Q.samplingPoints),
    ]);

  // Sampling points (the Ambient view). `permit` is a SAMPLE: a point can be monitored by more than
  // one outlet, and all we need here is whether it is permitted at all, plus one permit to hang the
  // chart's limit lines off when it is.
  DB.samplingPoints = samplingPoints.map((r) => {
    const p = parseWkt(r.wkt).points[0] || null;
    return {
      iri: r.sp, id: spOf(r.sp), label: r.label || spOf(r.sp),
      type: r.typeLabel || "", family: familyOf(r.typeLabel),
      status: r.status || "", permit: r.permit || null,
      lat: p ? p[0] : null, lon: p ? p[1] : null,
    };
  }).filter((s) => s.lat != null);

  // Canonical broader-group label map (code -> label), for the option-type fallback below.
  DB.groupLabels = {};
  for (const r of groupLabels) DB.groupLabels[r.code] = r.label;

  // Dated limit history per (permit, substance): each permit version's bound(s) over its
  // effective window [from, to] (from the public register). Powers the chart's stepped limit line.
  // One row per (version, upper bound), so collect the bounds per version by statistic first, then
  // reduce each version to its binding limit + per-sample ceiling — same rule as the conditions above.
  const histMap = {};
  for (const r of limitHistory) {
    const key = `${r.permit}|${r.subNotation}`;
    const vk = `${key}|${r.version}`;
    (histMap[vk] ||= {
      key, version: r.version, from: Date.parse(r.from), to: r.to ? Date.parse(r.to) : null,
      uppers: {}, lower: null,
    });
    if (r.upper != null) histMap[vk].uppers[r.stat ? last(r.stat) : "maximum"] = r.upper;
    if (r.lower != null) histMap[vk].lower = Number(r.lower);
  }
  DB.limitHistory = {};
  for (const h of Object.values(histMap)) {
    const b = bindingBound(h.uppers);
    const mx = perSampleUpper(h.uppers);
    (DB.limitHistory[h.key] ||= []).push({
      version: h.version, from: h.from, to: h.to,
      upper: b ? b.value : null,
      upperStat: b ? b.stat : null,
      maxUpper: b && b.stat !== "maximum" ? mx : null,
      lower: h.lower,
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
      // WHICH bound failed — the statistic, the value it breached, and the assessment in words.
      stat: b.stat ? last(b.stat) : null,
      statLabel: b.statLabel || null,
      limit: b.limit != null ? Number(b.limit) : null,
      unit: b.unitLabel || null,
      assessment: b.assessment || null,
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
      subLabel: c.subLabel, subNotation: c.subNotation,
      uppers: {}, statLabels: {}, lower: null, unit: null,
    });
    // Several rows per condition — one per upper bound. Key them by statistic; anything else
    // (the old `upper = c.upper`) is last-one-wins across bounds that mean different things, so a
    // permit's binding 95th-percentile limit and its looser upper-tier maximum would race.
    if (c.upper != null) {
      const stat = c.stat ? last(c.stat) : "maximum"; // an unqualified bound is an absolute ceiling
      condMap[key].uppers[stat] = c.upper;
      if (c.statLabel) condMap[key].statLabels[stat] = c.statLabel;
    }
    if (c.lower != null) condMap[key].lower = c.lower;
    if (c.unitLabel) condMap[key].unit = c.unitLabel;
  }
  // Flatten each condition's bounds to the binding limit + the per-sample ceiling (see BINDING).
  for (const c of Object.values(condMap)) {
    const b = bindingBound(c.uppers);
    c.upper = b ? b.value : null;
    c.upperStat = b ? b.stat : null;
    c.upperStatLabel = b ? c.statLabels[b.stat] : null;
    const mx = perSampleUpper(c.uppers);
    c.maxUpper = b && b.stat !== "maximum" ? mx : null;
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
  base = L.tileLayer(TILES_URL, {
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
  layers.samplingPoints = L.layerGroup();
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
// The two water views are two different worlds, and the gap between them is the demonstrator's
// argument in miniature.
//
// THE REGULATED WORLD exists because a permit says so. Everything in it hangs off a permit
// identifier — the limits in force, the breaches of those limits, the WINEP works that will replace
// them — and it is knowable in advance, from a register, whether anyone ever visits.
//
// THE MEASURED WORLD exists because someone took a sample. Most of it belongs to no permit at all,
// so no permit-shaped query can reach it; and a river in it has no limit to pass or fail, only
// readings.
//
// Neither is a view of the other. A permit is not evidence that anything was measured, and a
// measurement is not evidence that anything was permitted. Keeping the two apart on the screen is
// what makes it possible to ask the question that matters — where do they disagree?
const LEDE = {
  permits: (n, lbl) => {
    const sub = n.substance ? ` for <b>${esc(lbl)}</b>` : "";
    // The store holds outlets for every scoped permit but limits only for the ones whose substances
    // were actually sampled (see ttl/regulation/regulation_to_db.py). Say so rather than let the
    // table's count silently disagree with the headline.
    const withLimits = n.permitsWithLimits < n.permits
      ? ` <span class="muted">(${n.permitsWithLimits} with limits in the store)</span>` : "";
    return `<b>The regulated world</b> — what the register permits, and what has failed it. ` +
      `<b>${n.permits} discharge permits</b>${sub}${withLimits}: <b>${n.limits} limits</b> in force, ` +
      `<b>${n.breaches} condition breaches</b> of them (<b>${n.current} current</b> — nothing has passed since the breach began), ` +
      `and <b>${n.works} WINEP actions</b> proposing the limits that will replace them. ` +
      `Each is linked to its permit by identifier, not by location: the ${n.outlets} outlets sit on just ` +
      `<b>${n.coords} distinct coordinates</b>, so a map alone cannot tell them apart ` +
      `(<a href="points.html" target="_blank" rel="noopener">why that matters</a>).`;
  },
  ambient: (n, lbl) =>
    `<b>The measured world</b> — what the sampling actually finds, whatever the source. ` +
    `<b>${n.total} sampling points</b> in the catchment, of which <b>${n.unpermitted}</b> belong to ` +
    `<b>no permit at all</b> (rivers, boreholes, bathing waters), so the regulated world is ` +
    `structurally blind to them — there is no permit to reach them through. Coloured by what the EA ` +
    `samples there. Click a point for its <b>${esc(lbl)}</b> time series, pulled live from the Water ` +
    `Quality Archive.`,
};

function clearLayers() {
  Object.values(layers).forEach((l) => map.removeLayer(l));
  layers.breachCurrent.clearLayers();
  layers.breachPast.clearLayers();
  layers.dischargePoints.clearLayers();
  layers.actions.clearLayers();
  layers.samplingPoints.clearLayers();
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
// A condition's bound(s) as "≤ X (95th percentile) ≤ Y (upper tier) ≥ Z", the statistic named on each.
// Without it "≤ 20" and "≤ 48" look like the same kind of promise, and they are not: the first is what
// the permit requires, the second is the ceiling a single sample may not cross.
function limitBounds(c) {
  const parts = [];
  if (c.upper != null) {
    const stat = c.upperStatLabel && c.upperStat !== "maximum" ? ` (${esc(c.upperStatLabel)})` : "";
    parts.push("≤ " + fmtNum(c.upper) + stat);
  }
  if (c.maxUpper != null) parts.push("≤ " + fmtNum(c.maxUpper) + " (upper tier)");
  if (c.lower != null) parts.push("≥ " + fmtNum(c.lower));
  return parts.join(" ") || "—";
}
// The same, with the unit appended.
function limitRange(c) {
  return limitBounds(c) + (c.unit ? " " + prettyUnit(c.unit) : "");
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
  // Substances here open the time-series chart for the action's target permit, exactly as they do in
  // the WINEP table — so the proposed limit can be read against the observations it lands on.
  const sp = spForPermit(a.permit);
  const l = limits.map((x) => {
    const name = x.subNotation ? subLink(x.subLabel || x.subNotation, x.subNotation, sp, a.permit) : esc(x.subLabel || "—");
    return `${name}: ${limitText(x)}`;
  }).join("<br>");
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

  // Which actions are relevant to the substance
  const actionIdsWithSub = new Set(proposedForSub.map((l) => l.action));

  const show = { breach: false, discharge: false, action: false, sfi: false, sampling: false };

  if (currentView === "ambient") {
    show.sampling = true;
    renderAmbient(tables);
  } else if (currentView === "permits") {
    // ONE view over the regulated world: the limits, the breaches of them, and the works that will
    // change them. They used to be three tabs, which made them read as three subjects; they are one
    // subject — a permit — seen at three points in time (in force / failed / proposed).
    show.breach = show.discharge = show.action = true;
    setLegend([
      { c: "#3aa0ff", t: "Discharge point — no breach" },
      { c: "#e5484d", t: "current breach" },
      { c: "#f5a623", t: "past breach" },
      { c: "#a06bff", t: "WINEP action site (future works)" },
    ]);
    // The outlet/coordinate counts are the points.html argument, stated where the map is drawn: the
    // markers below are FEWER than the outlets they stand for, because outlets share a coordinate.
    const drawnDps = DB.dischargePoints.filter((d) => d.lat != null);
    const coords = new Set(drawnDps.map((d) => `${d.lat},${d.lon}`)).size;
    document.getElementById("lede").innerHTML = LEDE.permits({
      permits: new Set(DB.dischargePoints.map((d) => d.permit)).size,
      permitsWithLimits: new Set(DB.conditionsCurrent.map((c) => c.permit)).size,
      limits: conditions.length,
      breaches: breaches.length,
      current: breaches.filter((b) => b.current).length,
      works: currentSubstance ? actionIdsWithSub.size : DB.actions.length,
      outlets: drawnDps.length,
      coords,
      substance: !!currentSubstance,
    }, subLbl);
    // Substance chosen -> the limit/proposal story for it; otherwise the permit register at large.
    tables.append(
      currentSubstance
        ? substanceStoryTable(conditions, proposedForSub, dpByPermit)
        : permitTable(conditions, dpByPermit, condByPermit, condHistByPermit, breachedKey, breachesByPermit),
      breachTable(breaches),
      actionTable(currentSubstance ? DB.actions.filter((a) => actionIdsWithSub.has(a.iri)) : DB.actions, limByAction),
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
    for (const k in actionMarkers) delete actionMarkers[k];
    for (const a of DB.actions) {
      if (a.lat == null) continue;
      if (currentSubstance && !actionIdsWithSub.has(a.iri)) continue;
      const on = a.iri === selectedAction;
      const mk = circle(a.lat, a.lon, dot(on ? "#c9aaff" : "#a06bff", on ? 9 : 7, on ? 1 : 0.85), actionPopup(a, limByAction[a.iri] || []));
      // The WINEP table is on this view, so a marker click can focus its row (and vice versa).
      mk.on("click", () => focusAction(a.iri, true));
      actionMarkers[a.iri] = mk;
      mk.addTo(layers.actions);
      drawnBounds.push([a.lat, a.lon]);
    }
    layers.actions.addTo(map);
  }
  // Ambient: every sampling point, coloured by the family of thing the EA samples there. No permit
  // status is encoded — that is the Permits view's job, and most of these have no permit at all.
  if (show.sampling) {
    for (const s of ambientPoints()) {
      const mk = circle(s.lat, s.lon, dot(s.family.color, s.permit ? 6 : 7, 0.9), samplingPointPopup(s));
      mk.on("click", () => openChart(currentSubstance || NITROGEN, s.id, s.permit, [s.lat, s.lon]));
      mk.addTo(layers.samplingPoints);
      drawnBounds.push([s.lat, s.lon]);
    }
    layers.samplingPoints.addTo(map);
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
function card(title, count, bodyEl, query) {
  const c = document.createElement("div");
  c.className = "card";
  // Optional provenance link: opens the SPARQL editor pre-loaded with the query that reproduces
  // this table's rows (see the PQ object). The query travels in the URL fragment so it never hits
  // the server. See README → "Per-table SPARQL provenance links".
  const link = query
    ? ` <a class="sparql-link" href="sparql.html#q=${encodeURIComponent(query)}" target="_blank" rel="noopener" title="Open the SPARQL query behind this table">◈ SPARQL</a>`
    : "";
  c.innerHTML = `<h2>${title} <span class="count">${count}</span>${link}</h2>`;
  c.append(bodyEl);
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

// Which bound the breach failed, e.g. "≤ 20 mg/l (95th percentile)". A breach of an absolute maximum
// and a breach of a 95th-percentile limit are very different claims — the first is one bad sample, the
// second a year-long statistical failure — and they breach the SAME condition, so without the bound's
// statistic the table would show them identically. Hover gives the assessment in full.
function breachBound(b) {
  if (b.limit == null && !b.statLabel) return "—";
  const cmp = b.stat === "minimum" ? "≥" : "≤";
  const val = b.limit != null ? `${cmp} ${fmtNum(b.limit)}${b.unit ? " " + prettyUnit(b.unit) : ""}` : "";
  const stat = b.statLabel ? `<span class="stat">${esc(b.statLabel)}</span>` : "";
  const title = b.assessment ? ` title="${esc(b.assessment)}"` : "";
  return `<span${title}>${val}${val && stat ? " " : ""}${stat}</span>`;
}

function breachTable(breaches) {
  if (!breaches.length) return card("Breaches", "0", emptyBody("No breaches for this selection."), PQ.breaches(currentSubstance));
  // current first, then most-recently-started
  const rows = [...breaches].sort((a, b) => (b.current - a.current) || (a.from < b.from ? 1 : -1)).map((b) => `
    <tr>
      <td>${breachPeriod(b)}</td>
      <td>${subLink(b.subLabel, b.subNotation, b.sp, b.permit)}</td>
      <td>${breachBound(b)}</td>
      <td>${permitLink(b.permit)}</td>
      <td class="ctr">${b.current ? '<span class="pill current">current</span>' : '<span class="pill past">past</span>'}</td>
      <td>${wqeLink(b.sp)}</td>
    </tr>`).join("");
  return card("Breaches", breaches.length,
    tableEl(["Period", "Substance", "Limit breached", "Permit", "Status|c", "Sampling point (WQE)"], rows),
    PQ.breaches(currentSubstance));
}

function permitTable(conditions, dpByPermit, condByPermit, condHistByPermit, breachedKey, breachesByPermit) {
  const permits = [...new Set(conditions.map((c) => c.permit))].sort();
  if (!permits.length) return card("Permits &amp; limits", "0", emptyBody("No permits for this selection."), PQ.permits(currentSubstance));
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
    tableEl(["Permit", "Current limits", "Discharge points", "Breaches|c", "Monitored at"], rows), PQ.permits(currentSubstance));
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
  if (!keys.length) return card("Current limits &amp; future works", "0", emptyBody("Nothing for this substance."), PQ.substanceStory(currentSubstance));

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
    const limit = cur ? limitBounds(cur) : "—";
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
    tableEl(["Permit", "Substance", "Limit|r", "Unit", "Monitored at", "Action", "Name", "Completion", "Proposed limit"], body),
    PQ.substanceStory(currentSubstance));
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
  const c = card("WINEP Actions", actions.length, tableEl(["Action", "Party", "Name", "Completion", "Target permit", "Limits|r"], rows), PQ.actions());
  // Clicking a row focuses the action on the map (marker highlight + pan + popup); it still expands.
  c.addEventListener("click", (e) => {
    const tr = e.target.closest(".action-row");
    if (tr) focusAction(tr.dataset.action, false);
  });
  wireExpand(c, sorted.map((a) => a.iri), (iri) => {
    const a = DB.actions.find((x) => x.iri === iri);
    const lines = limitLines(limByAction[iri] || []);
    // The substance opens the same time-series chart as in the other views, for THIS action's target
    // permit — so a proposed limit can be read against the observations it would be applied to.
    const sp = spForPermit(a?.permit);
    // One row per limit line; the substance label + its matching current limit show once per
    // substance (blank on that substance's subsequent tier rows). A "continued" limit is just the
    // pill (it keeps the current limit, shown to the right); a substance with no current limit shows
    // a "none" pill (i.e. a brand-new limit).
    const body = tableEl(["Substance", "New limit", "Current limit"],
      lines.map((ln, idx) => {
        const firstOfSub = idx === 0 || lines[idx - 1].subNotation !== ln.subNotation;
        const cur = firstOfSub ? currentLimitFor(a?.permit, ln.subNotation) : null;
        // A limit line with no substance (a statement-only limit) has nothing to chart: plain "—".
        const cell = !firstOfSub ? ""
          : ln.subNotation ? subLink(ln.subLabel || ln.subNotation, ln.subNotation, sp, a?.permit)
          : esc(ln.subLabel || "—");
        return `<tr>
          <td>${cell}</td>
          <td>${ln.carried ? '<span class="pill carried">continued</span>' : ln.text}</td>
          <td>${firstOfSub ? (cur || '<span class="pill none">none</span>') : ""}</td>
        </tr>`;
      }).join("") || `<tr><td colspan="3" class="empty">No structured limits.</td></tr>`);
    const hint = sp
      ? `<p class="expand-hint">Click a substance to chart its observations at ${esc(sp)} against the current and proposed limits.</p>`
      : "";
    return `${a?.desc ? `<p style="color:#93a4b3">${esc(a.desc)}</p>` : ""}${hint}${body.outerHTML}`;
  });
  return c;
}

// ---------------------------------------------------------------------------
// The measured world: pollution as sampled, wherever it was sampled.
// ---------------------------------------------------------------------------
// The regulated world can only ever show you a place a permit points at. This one shows every place
// the EA actually samples — and in this catchment most of them (rivers, boreholes, bathing waters,
// investigation points) belong to no permit at all, so they are invisible to a permit-shaped query.
// That is the "regardless of sampling-point source" bit: the effluent points are here too, drawn the
// same size and read the same way, because a nitrate reading is a nitrate reading.
//
// Sampling points are NOT filtered by the chosen substance. A point with no ammonia record is not a
// point with no ammonia — it is a point nobody sampled for it, and hiding it would quietly turn an
// absence of measurement into an absence of pollution. Instead every point is drawn, and the chart
// tells you (per point) whether the archive has anything for that substance.
const ambientPoints = () => DB.samplingPoints;

function samplingPointPopup(s) {
  const permitted = s.permit
    ? `<div class="pp-row">Permit <span class="mono">${esc(permitRef(s.permit))}</span> discharges here` +
      ` <span class="muted">— this point is in the regulated world too</span></div>`
    : `<div class="pp-row muted">No permit discharges here — measured only, never regulated.</div>`;
  const sub = currentSubstance || NITROGEN;
  const subLbl = (DB.substances.find((x) => x.notation === sub) || {}).label || sub;
  return `<b>${esc(s.label)}</b><br>
    <span class="mono">${esc(s.id)}</span>
    <div class="pp-row"><span class="dot" style="background:${s.family.color}"></span>${esc(s.type || "untyped")}</div>
    ${s.status && s.status !== "OPEN" ? `<div class="pp-row muted">Status: ${esc(s.status)}</div>` : ""}
    ${permitted}
    <div class="pp-row"><span class="sub-link">Charting ${esc(subLbl)}…</span></div>
    <a href="${WQE}${encodeURIComponent(s.id)}" target="_blank" rel="noopener">Water Quality Explorer ↗</a>`;
}

function renderAmbient(tables) {
  const pts = ambientPoints();
  const unpermitted = pts.filter((s) => !s.permit);
  // With no substance chosen, clicking a point charts the default (ammoniacal nitrogen) — so the
  // lede has to name THAT, not "all substances", which is not something a time series can be of.
  const sub = currentSubstance || NITROGEN;
  const subLbl = (DB.substances.find((s) => s.notation === sub) || {}).label || sub;

  // Legend: one entry per family PRESENT, in the palette's fixed slot order — the order is the
  // colourblind-safety mechanism, so it never re-sorts by count.
  const present = [...SP_FAMILIES, OTHER_FAMILY].filter((f) => pts.some((s) => s.family.key === f.key));
  setLegend(present.map((f) => ({ c: f.color, t: `${f.label} (${pts.filter((s) => s.family.key === f.key).length})` })));

  document.getElementById("lede").innerHTML =
    LEDE.ambient({ total: pts.length, unpermitted: unpermitted.length }, subLbl);

  tables.append(ambientTable(pts));
}

// Every sampling point, with its EXACT archive type (the map colours by family, so the precise type
// has to be legible somewhere — colour is never the only encoding). Sorted with the unpermitted
// first: they are the ones the rest of this app cannot see.
function ambientTable(pts) {
  const sorted = [...pts].sort((a, b) =>
    (!!a.permit - !!b.permit) || a.family.label.localeCompare(b.family.label) || a.label.localeCompare(b.label));
  const rows = sorted.map((s) => `
    <tr class="sp-row" data-sp="${esc(s.id)}" data-permit="${esc(s.permit || "")}">
      <td class="mono"><span class="sub-link">${esc(s.id)}</span></td>
      <td>${esc(s.label)}</td>
      <td>${swatch(s.family.color)}${esc(s.type || "untyped")}</td>
      <td class="mono">${s.permit ? permitRef(s.permit) : '<span class="pill none">none</span>'}</td>
    </tr>`).join("");
  const c = card(
    `Sampling points <span class="count">— ${pts.filter((s) => !s.permit).length} measured but never regulated</span>`,
    pts.length,
    tableEl(["Point", "Name", "What is sampled here", "Permit"], rows),
    PQ.samplingPoints());
  // Same gesture as the map: open the substance time series for this point.
  c.addEventListener("click", (e) => {
    const tr = e.target.closest(".sp-row");
    if (!tr) return;
    const s = DB.samplingPoints.find((x) => x.id === tr.dataset.sp);
    if (s) openChart(currentSubstance || NITROGEN, s.id, s.permit, [s.lat, s.lon]);
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
    apps.length, tableEl(["Application", "Programme", "Options|r", "Total cost|r"], rows), PQ.applications());
  c.addEventListener("click", (e) => {
    if (e.target.closest(".clear-sel")) { clearAppFocus(); return; }
    const tr = e.target.closest(".app-row");
    if (tr) selectApp(tr.dataset.app);
  });
  return c;
}

// Options for the selected application, grouped by broader concept (expandable to the components).
function optionsTable(appIri) {
  if (!appIri) return card("Options", "—", emptyBody("Select an application to see its options."), PQ.sfiOptions(null));
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
    tableEl(["Group", "Options|r", "Cost|r"], rows), PQ.sfiOptions(appIri));
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
  if (v !== "permits") selectedAction = null; // drop the WINEP action focus when leaving
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

  // Deep-link support: ?view=permits|ambient|farming & ?sub=<notation>. The three old water views
  // (breaches / substance / wessex) are now one Permits view, so their links land there rather than
  // 404-ing into the default.
  const ALIAS = { breaches: "permits", substance: "permits", wessex: "permits" };
  const params = new URLSearchParams(location.search);
  const sub = params.get("sub");
  if (sub && DB.substances.some((s) => s.notation === sub)) {
    currentSubstance = sub;
    document.getElementById("substance").value = sub;
  }
  const view = ALIAS[params.get("view")] || params.get("view");
  setView(["permits", "ambient", "farming"].includes(view) ? view : "permits");
}

main();
