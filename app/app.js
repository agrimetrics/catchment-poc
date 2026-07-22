/* Poole Harbour — Three Ways
 *
 * A single static page over an Oxigraph SPARQL endpoint (served from the same
 * origin at /sparql). It loads a handful of queries once, caches the rows, then
 * switches between three "views" — the regulated world, the measured world, and farming — and
 * filters by substance entirely client-side.
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
  "SFI EO": { label: "SFI Expanded Offer", color: "#00703c", priced: true },
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
PREFIX ex-farm:    <http://example.com/farming/>
PREFIX qudt:  <http://qudt.org/schema/qudt/>
PREFIX iop:   <https://w3id.org/iadopt/ont/>
PREFIX geo:   <http://www.opengis.net/ont/geosparql#>
PREFIX skos:  <http://www.w3.org/2004/02/skos/core#>
PREFIX sosa:  <http://www.w3.org/ns/sosa/>
PREFIX ssn:   <http://www.w3.org/ns/ssn/>
PREFIX rdfs:  <http://www.w3.org/2000/01/rdf-schema#>
PREFIX dcterms: <http://purl.org/dc/terms/>
PREFIX wr:    <http://example.com/water-regulation/>
`;

// Catchment Data Explorer namespaces. Separate from PREFIXES because these are the ONLY vocabularies
// in this app whose subjects keep real Environment Agency URIs rather than example.com ones — see
// ttl/catchment/README.md. Nothing here is minted by this repository.
const CP_PREFIXES = `
PREFIX wfd:  <http://environment.data.gov.uk/catchment-planning/def/water-framework-directive/>
PREFIX wbc:  <http://environment.data.gov.uk/catchment-planning/def/waterbody-classification/>
PREFIX rff:  <http://environment.data.gov.uk/catchment-planning/def/reason-for-failure/>
PREFIX cpg:  <http://environment.data.gov.uk/catchment-planning/def/geometry/>
PREFIX ver:  <http://purl.org/linked-data/version#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX dcterms: <http://purl.org/dc/terms/>
PREFIX geo:  <http://www.opengis.net/ont/geosparql#>
`;

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------
const Q = {
  // -------------------------------------------------------------------------
  // Water bodies (Catchment Data Explorer). See ttl/catchment/ISSUES.md before editing any of these.
  // -------------------------------------------------------------------------
  // One row per water body, and the joins are what keep it that way:
  //
  //   ver:currentVersion  not dcterms:hasVersion — there are 39 versions over 19 bodies, so joining
  //                       hasVersion doubles every row. The name and the designation BOTH live on the
  //                       version, never on the base water body.
  //   a cpg:Catchment     each body carries two geometries, a catchment POLYGON and a river-line
  //                       MULTILINESTRING. Without this the layer draws each body twice, once as an
  //                       area and once as a line that looks like a sliver of a polygon.
  //   ?d rdfs:label       NOT skos:prefLabel. The designation concepts are typed
  //                       wfd:HydromorphologicalDesignation and carry rdfs:label only; asking for
  //                       prefLabel returns 19 rows with a blank designation, which reads exactly
  //                       like "this catchment has no designations" and is how that wrong conclusion
  //                       got made once already.
  waterbodies: `${CP_PREFIXES}
    SELECT ?wb ?notation ?label ?desig ?desigLabel ?wkt WHERE {
      ?wb wfd:inOperationalCatchment ?oc ; skos:notation ?notation ; ver:currentVersion ?cv .
      ?cv rdfs:label ?label ; wfd:hydromorphologicalDesignation ?desig .
      ?desig rdfs:label ?desigLabel .
      ?wb geo:hasGeometry ?g . ?g a cpg:Catchment ; geo:asWKT ?wkt .
    } ORDER BY ?label`,

  // Every version, so the panel can show that the designation MOVED. Read only the current version
  // and this vocabulary looks dead: all 19 bodies are "not designated" today. Three of them
  // (Sydling Water, Frome Dorset (Upper), Piddle (Lower)) were heavily modified at version 1.
  // That change is the only movement this vocabulary has, and it is invisible in the published CSV.
  wbVersions: `${CP_PREFIXES}
    SELECT ?notation ?v ?label ?desigLabel WHERE {
      ?wb wfd:inOperationalCatchment ?oc ; skos:notation ?notation ; dcterms:hasVersion ?v .
      ?v rdfs:label ?label ; wfd:hydromorphologicalDesignation ?d . ?d rdfs:label ?desigLabel .
    } ORDER BY ?notation ?v`,

  // Classification history, restricted to the four headline items — the full set is 74 items over
  // 5,852 records and no panel can show that.
  //
  // The FILTER is also a fan-out guard. 372 classifications carry TWO classificationValues
  // ("Supports Good" AND "Not High", from one scheme), and every one of them is a Hydromorphological
  // Supporting Elements or Morphology record. None of the four items below is affected, so this
  // returns exactly one row per (body, item, year, cycle). Add an item here and check that again.
  wbClassifications: `${CP_PREFIXES}
    SELECT ?notation ?item ?year ?cycle ?status WHERE {
      ?wb skos:notation ?notation .
      ?c a wbc:Classification ; wfd:waterBody ?wb ; wbc:classificationItem ?i ;
         wbc:classificationYear ?year ; wfd:cycle ?cyU ; wbc:classificationValue ?sv .
      ?i skos:prefLabel ?il . ?sv skos:prefLabel ?sl .
      FILTER(STR(?il) IN ("Overall Water Body", "Ecological", "Chemical", "Phosphate"))
      BIND(STR(?il) AS ?item) BIND(STR(?sl) AS ?status)
      BIND(REPLACE(STR(?cyU), "^.*/", "") AS ?cycle)
    } ORDER BY ?notation ?item ?year`,

  // The challenges (RNAGs). Both OPTIONALs matter: 57 of the 95 have no nationalSWMIheader and would
  // vanish from an inner join, taking with them every "measures delivered, awaiting recovery" record.
  // A challenges table that silently drops 60% of the challenges is worse than no table.
  //
  // STR() on every label: these are language-tagged ("Bad"@en), and comparing a tagged literal to a
  // plain string matches nothing — which returns an empty table that looks like a finding.
  wbRnags: `${CP_PREFIXES}
    SELECT ?notation ?swmi ?sector ?p3 ?item ?status ?activity ?cycle WHERE {
      ?wb skos:notation ?notation .
      ?x a rff:ReasonForFailure ; wfd:waterBody ?wb ; rff:pressureTier3 ?p3L ;
         wbc:classification ?cl ; wbc:classificationItem ?i ; wfd:cycle ?cyU .
      # classificationItem is what actually failed, and without it challenges are indistinguishable:
      # Bere Stream's two both render as "Fail / Chemicals / no sector responsible" and look like one
      # record duplicated. They are a mercury failure and a PBDE failure.
      ?i skos:prefLabel ?itemL .
      ?cl wbc:classificationValue ?sv . ?sv rdfs:label ?statusL .
      # EVERY REQUIRED PATTERN FIRST, OPTIONALs LAST. This is not style. With these three OPTIONALs
      # placed above the classificationValue join, and the BINDs below present, this query took
      # 30 SECONDS against a 51k-triple store and stalled the whole layer behind it; moving them here
      # takes it to ~0.01s. The planner will not reorder joins across an OPTIONAL, so an OPTIONAL
      # written early forces the required joins to be evaluated against its partial results.
      OPTIONAL { ?x rff:nationalSWMIheader ?swmiL }
      OPTIONAL { ?x rff:category ?cat . ?cat rdfs:label ?sectorL }
      OPTIONAL { ?x rff:activity ?act . ?act rdfs:label ?actL }
      BIND(STR(?p3L) AS ?p3) BIND(STR(?statusL) AS ?status) BIND(STR(?itemL) AS ?item)
      BIND(STR(?swmiL) AS ?swmi) BIND(STR(?sectorL) AS ?sector) BIND(STR(?actL) AS ?activity)
      BIND(REPLACE(STR(?cyU), "^.*/", "") AS ?cycle)
    }`,

  // The substance FILTER offers only what the app can chart: the determinands the archive holds a
  // time series for here (12 of the 38 the register regulates). The other 26 — flow, dry-weather
  // flow, weir settings, storm-overflow telemetry, metals, pesticides — are real permit conditions,
  // are in the store, and appear on their permit; they just have no series to plot, so putting them
  // in a filter that opens a chart would offer an empty promise.
  //
  // Note which way round this is. The scheme is a fact about the OBSERVATIONS, not about the permits.
  // Until this rebuild the store's whole substance vocabulary WAS "things somebody sampled", so a
  // permit condition on an unsampled determinand did not exist at all — the app's dropdown was
  // silently defining what the law said.
  substances: `${PREFIXES}
    SELECT ?s ?label ?notation WHERE {
      ?s skos:inScheme <http://example.com/water-regulation/substance/monitored> ;
         skos:prefLabel ?label ; skos:notation ?notation .
    } ORDER BY ?label`,

  // reg:breachesLimit is what makes a breach legible. breachesCondition alone cannot tell a single
  // sample over an absolute maximum from a year-long 95th-percentile failure — both breach the same
  // condition. Each Limit is ONE obligation (one statistic, one season, one bound), so naming the
  // Limit is a complete answer; ?limStmt carries the register's own words for it and ?assessment
  // (rdfs:comment) states the arithmetic ("6 exceedances … 5 permitted for 48 samples").
  //
  // The store used to mint `reg:breachesBound` under DEFRA's namespace for exactly this job, because
  // one Limit carried every bound and naming it discriminated nothing. The ontology now defines
  // reg:LimitBreach + reg:breachesLimit, the Limits were split, and the invented term is gone.
  // A breach now names the outlet it happened at, because the CONDITION does (core:appliesTo). That
  // removes a whole layer of guesswork: this used to reach the sampling point by walking out to the
  // permit, back down to ANY of its discharge points, and collapsing the fan-out with SAMPLE — so a
  // breach of one outlet could be reported at another outlet's monitoring point. Now it is a keyed
  // join with one answer, and the GROUP BY is gone with it.
  //
  // Geometry is OPTIONAL, deliberately. It used to be required, which meant a breach at an outlet
  // with no coordinate would have vanished from the app with no error — the exact failure this store
  // exists to warn about. Today 7 outlets have no coordinate; if one ever breaches, it will show.
  breaches: `${PREFIXES}
    SELECT ?breach ?type ?from ?to ?subLabel ?subNotation ?permit ?cond ?dp ?sp
           ?stat ?statLabel ?limit ?unitLabel ?assessment ?limStmt ?undated ?wkt WHERE {
      ?breach reg:breachesCondition ?cond ;
              core:hasApplicability/core:applicabilityPeriod ?period .
      ?period core:applicableFrom ?from .
      OPTIONAL { ?period core:applicableTo ?to }
      OPTIONAL { ?breach a ?type . FILTER(?type IN (reg:ExceedanceBreach, reg:ShortfallBreach)) }
      OPTIONAL { ?breach rdfs:comment ?assessment }
      OPTIONAL { ?breach wr:judgedOnUndatedVersion ?undated }
      OPTIONAL { ?breach reg:breachesLimit ?lim .
                 OPTIONAL { ?lim reg:limitStatement ?limStmt }
                 OPTIONAL { ?lim reg:upperBound|reg:lowerBound ?bound .
                            OPTIONAL { ?bound qudt:numericValue ?limit }
                            OPTIONAL { ?bound qudt:unit/skos:prefLabel ?unitLabel }
                            OPTIONAL { ?bound iop:hasStatisticalModifier ?stat . ?stat skos:prefLabel ?statLabel } } }
      ?cond reg:regulatedProperty ?sub ; core:hasApplicability/core:appliesTo ?dp .
      ?sub skos:prefLabel ?subLabel ; skos:notation ?subNotation .
      ?permit reg:hasCondition ?cond .
      OPTIONAL { ?dp water:monitoredAt ?sp }
      OPTIONAL { ?dp geo:hasDefaultGeometry/geo:asWKT ?wkt }
    }`,

  // Geometry is OPTIONAL: 7 outlets have no site grid reference in the register, and the store
  // publishes them with no coordinate rather than a guessed one. They cannot be drawn — render()
  // filters on lat — but they still exist, still belong to their permit, and still name the sampling
  // point they are monitored at. Requiring ?w here would let the presence of geometry decide what
  // exists, which is the mistake this whole store is arguing against.
  dischargePoints: `${PREFIXES}
    SELECT ?dp ?permit (SAMPLE(?w) AS ?wkt) ?sp WHERE {
      ?permit a water:WaterDischargePermit ; reg:permitSite ?dp .
      OPTIONAL { ?dp geo:hasDefaultGeometry/geo:asWKT ?w }
      OPTIONAL { ?dp water:monitoredAt ?sp }
    } GROUP BY ?dp ?permit ?sp`,

  // A condition belongs to a DISCHARGE POINT, not to a permit at large — `core:appliesTo` names the
  // outlet it governs. That is the grain the register sets limits at, and it matters: permit 042116
  // caps BOD at 15 mg/l on effluent 1 and 25 mg/l on effluent 2, sampled at two different points.
  // Reading a permit's limit without saying which outlet gives you one of them at random.
  //
  // A condition holds SEVERAL Limits — one per statistic, and one per SEASON — and each is a separate
  // obligation with a single bound. At a sewage works the 95th percentile is the binding limit and the
  // MAXIMUM is an upper-tier backstop 2-4x looser; permit 040067's percentile itself changes with the
  // month (15 mg/l May–Oct, 20 mg/l Nov–Apr). One row per Limit, and the statistic and month range
  // come back with the value — without them, bounds that mean entirely different things look alike.
  //
  // ?assessed / ?notAssessed say whether the breach engine could examine this condition at all. A
  // condition with ?assessed false was NOT examined — it is not a condition that passed, and the app
  // must never draw it as one. That is the whole point of the ledger the breach pipeline emits.
  conditions: `${PREFIXES}
    SELECT ?permit ?cond ?dp ?subLabel ?subNotation ?lim ?upper ?lower ?stat ?statLabel ?unitLabel
           ?monthFrom ?monthTo ?stmt ?assessed ?notAssessed WHERE {
      ?permit a water:WaterDischargePermit ; reg:hasCondition ?cond .
      ?cond reg:regulatedProperty ?sub ; core:hasApplicability/core:appliesTo ?dp .
      ?sub skos:prefLabel ?subLabel ; skos:notation ?subNotation .
      OPTIONAL { ?cond wr:assessed ?assessed }
      OPTIONAL { ?cond wr:notAssessedBecause/skos:notation ?notAssessed }
      OPTIONAL {
        ?cond reg:hasLimit ?lim .
        OPTIONAL { ?lim reg:limitStatement ?stmt }
        OPTIONAL { ?lim wr:appliesFromMonth ?monthFrom ; wr:appliesToMonth ?monthTo }
        OPTIONAL { ?lim reg:upperBound ?ub . ?ub qudt:numericValue ?upper . }
        OPTIONAL { ?lim reg:lowerBound ?lb . ?lb qudt:numericValue ?lower . }
        OPTIONAL { ?lim reg:upperBound|reg:lowerBound ?b .
                   OPTIONAL { ?b iop:hasStatisticalModifier ?stat . ?stat skos:prefLabel ?statLabel }
                   OPTIONAL { ?b qudt:unit/skos:prefLabel ?unitLabel } }
      }
    }`,

  // The dated version windows behind the chart's stepped limit line. Keyed by DISCHARGE POINT, like
  // the conditions above — the history of "BOD at THIS outlet", not "BOD somewhere on this permit".
  limitHistory: `${PREFIXES}
    SELECT ?dp ?subNotation ?version ?from ?to ?upper ?lower ?stat ?monthFrom ?monthTo WHERE {
      ?permit a water:WaterDischargePermit ; reg:hasCondition ?cond .
      ?cond reg:regulatedProperty ?sub ; core:hasApplicability/core:appliesTo ?dp .
      ?sub skos:notation ?subNotation .
      BIND(REPLACE(STR(?cond), ".*/version/([^/]+)/.*", "$1") AS ?version)
      BIND(IRI(CONCAT(STR(?permit), "/version/", ?version)) AS ?doc)
      ?doc core:hasApplicability/core:applicabilityPeriod ?p .
      ?p core:applicableFrom ?from .
      OPTIONAL { ?p core:applicableTo ?to }
      OPTIONAL {
        ?cond reg:hasLimit ?lim .
        OPTIONAL { ?lim wr:appliesFromMonth ?monthFrom ; wr:appliesToMonth ?monthTo }
        OPTIONAL { ?lim reg:upperBound ?ub . ?ub qudt:numericValue ?upper . }
        OPTIONAL { ?lim reg:lowerBound ?lb . ?lb qudt:numericValue ?lower . }
        OPTIONAL { ?lim reg:upperBound|reg:lowerBound ?b . ?b iop:hasStatisticalModifier ?stat }
      }
    }`,

  actions: `${PREFIXES}
    SELECT ?action ?label ?desc ?completion ?permit (SAMPLE(?w) AS ?wkt) WHERE {
      ?action a reg:Action ; rdfs:label ?label ; reg:actionSite ?site .
      ?site geo:hasDefaultGeometry/geo:asWKT ?w .
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
  // ?dets is the point's OWN determinand list — what the archive actually holds a series for here,
  // swept from the archive and asserted as ssn:hasProperty. It is what lets the view filter by the
  // chosen substance. It is OPTIONAL because a point measured for nothing is still a point, and it
  // must come back (with an empty ?dets) rather than being dropped by the join.
  samplingPoints: `${PREFIXES}
    SELECT ?sp ?label ?typeLabel ?status (SAMPLE(?w) AS ?wkt) (SAMPLE(?p) AS ?permit)
           (GROUP_CONCAT(DISTINCT ?dn; separator=",") AS ?dets) WHERE {
      ?sp a sosa:FeatureOfInterest ; geo:hasDefaultGeometry/geo:asWKT ?w .
      OPTIONAL { ?sp skos:prefLabel ?label }
      OPTIONAL { ?sp wr:samplingPointType/skos:prefLabel ?typeLabel }
      OPTIONAL { ?sp wr:samplingPointStatus ?status }
      OPTIONAL { ?dp water:monitoredAt ?sp . ?p reg:permitSite ?dp }
      OPTIONAL { ?sp ssn:hasProperty/skos:notation ?dn }
    } GROUP BY ?sp ?label ?typeLabel ?status`,

  // Farming: one row per application with its option count and TOTAL annual payment summed live.
  // COALESCE(?c,0): an application's options are OPTIONALly priced, so unpriced options leave ?c
  // unbound — and SUM over a group containing an unbound value yields unbound (not 0). Coalescing to
  // 0 lets the priced options still sum (otherwise any mixed application totals £0).
  applications: `${PREFIXES}
    SELECT ?app ?appId ?scheme (SUM(COALESCE(?c, 0)) AS ?total) (COUNT(DISTINCT ?opt) AS ?n) WHERE {
      ?app a farm:Application ; core:hasPart ?opt .
      OPTIONAL { ?app skos:notation ?appId }
      OPTIONAL { ?app ex-farm:scheme ?scheme }
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

  // One row per DRAWN PARCEL (SFIParcels in sfi.ttl), with its own point and extent -- area (ha) for
  // area-based actions, mtl (metres) for linear ones. This is what lets an extent question scoped to a
  // sub-catchment be exact: the per-option MULTIPOINT + SUMMED extent in sfi.ttl can only be
  // apportioned by point count, which is wrong by ~25% on a single water body. Joined to its option by
  // core:partOf. See sfiByCatchment.
  sfiParcels: `${PREFIXES}
    SELECT ?opt ?wkt ?area ?mtl WHERE {
      ?parcel core:partOf ?opt ; geo:asWKT ?wkt .
      OPTIONAL { ?parcel ex-farm:area ?area }
      OPTIONAL { ?parcel ex-farm:mtl ?mtl }
    }`,

  // MODELLED pollutant removal, per application and per option (FARMSCOPER via the SFI concept
  // scheme). These are a SEPARATE query rather than columns on `applications`/`sfiOptions` for a
  // plain reason: an application carries one impact PER SUBSTANCE, so folding them in would multiply
  // every row by the substance count and quietly double the option counts and cost sums.
  //
  // This is also the join the whole exercise exists for: farm:substance points at the SAME
  // skos:Concept the Water Quality Archive's observations are measured against, so `?sub` here is the
  // very notation the substance dropdown filters water by. Nitrogen and Phosphorus are therefore the
  // two substances that mean something on BOTH sides of the app — which is what the dropdown's
  // "Water & Land" group is derived from (at runtime, from this result — not hard-coded).
  //
  // Values are NEGATIVE = a reduction in pollutant loss. Nothing here is measured; see landCaveat().
  appImpacts: `${PREFIXES}
    SELECT ?app ?sub ?label ?kg WHERE {
      ?app a farm:Application ; farm:annualPollutantImpact ?i .
      ?i farm:substance ?s ; qudt:numericValue ?kg .
      ?s skos:notation ?sub ; skos:prefLabel ?label .
    }`,

  optionImpacts: `${PREFIXES}
    SELECT ?opt ?sub ?kg WHERE {
      ?opt a farm:Option ; farm:annualPollutantImpact ?i .
      ?i farm:substance ?s ; qudt:numericValue ?kg .
      ?s skos:notation ?sub .
    }`,
};

// ---------------------------------------------------------------------------
// Provenance queries — the "◈ SPARQL" link on each table card.
// ---------------------------------------------------------------------------
// Each of these reproduces, as ONE declarative query, the row set the table shows — so a viewer can
// open the exact question the table answers and run it. They are a SEPARATE, hand-maintained
// representation from the runtime `Q` queries above: the app still runs the split `Q` queries once
// and joins them in JavaScript (to reuse results across the three views), while these fold that merge
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
  // point: make it a plain join and the 91 points that belong to no permit vanish, which is exactly
  // the blind spot this view exists to remove.
  // GROUP BY + SAMPLE, because 22 points are monitored by MORE THAN ONE outlet and the table shows one
  // row per point. Without it this returned 187 rows for a 161-row table — and a provenance link that
  // returns more rows than the table it claims to reproduce makes the app look like it is hiding some.
  // The ssn:hasProperty line appears only when a substance is chosen, because that is when the table is
  // filtered by it — a provenance link that returns the unfiltered 161 for a 123-row table is not
  // provenance, it is a different query wearing its badge.
  samplingPoints: (sub) => `${PREFIXES}
    SELECT ?sp ?label ?typeLabel (SAMPLE(?p) AS ?permit) WHERE {
      ?sp a sosa:FeatureOfInterest ; geo:hasDefaultGeometry/geo:asWKT ?wkt .
      OPTIONAL { ?sp skos:prefLabel ?label }
      OPTIONAL { ?sp wr:samplingPointType/skos:prefLabel ?typeLabel }
      OPTIONAL { ?dp water:monitoredAt ?sp . ?p reg:permitSite ?dp }${sub ? `
      ?sp ssn:hasProperty wr:substance/${sub} .   # sampled for the chosen determinand` : ""}
    } GROUP BY ?sp ?label ?typeLabel ORDER BY ?typeLabel ?label`,

  // Breaches — one row per breach period. reg:breachesLimit names the LIMIT that actually failed:
  // breachesCondition alone cannot separate a single sample over an absolute maximum from a year-long
  // 95th-percentile failure, because both breach the same condition. And the outlet comes from the
  // condition itself (core:appliesTo) rather than from walking out to the permit and back down to any
  // of its discharge points — so no SAMPLE, no GROUP BY, and no chance of reporting a breach of one
  // outlet at another outlet's monitoring point.
  breaches: (sub) => `${PREFIXES}
    SELECT ?breach ?type ?from ?to ?subLabel ?subNotation ?statLabel ?limit ?limStmt ?assessment
           ?permit ?dp ?sp WHERE {
      ?breach reg:breachesCondition ?cond ;
              core:hasApplicability/core:applicabilityPeriod ?period .
      ?period core:applicableFrom ?from .
      OPTIONAL { ?period core:applicableTo ?to }
      OPTIONAL { ?breach a ?type . FILTER(?type IN (reg:ExceedanceBreach, reg:ShortfallBreach)) }
      OPTIONAL { ?breach rdfs:comment ?assessment }
      OPTIONAL { ?breach wr:judgedOnUndatedVersion ?undated }
      OPTIONAL { ?breach reg:breachesLimit ?lim .
                 OPTIONAL { ?lim reg:limitStatement ?limStmt }
                 OPTIONAL { ?lim reg:upperBound|reg:lowerBound ?b .
                            OPTIONAL { ?b qudt:numericValue ?limit }
                            OPTIONAL { ?b iop:hasStatisticalModifier/skos:prefLabel ?statLabel } } }
      ?cond reg:regulatedProperty ?sub ; core:hasApplicability/core:appliesTo ?dp .
      ?sub skos:prefLabel ?subLabel ; skos:notation ?subNotation .
      ?permit reg:hasCondition ?cond .
      OPTIONAL { ?dp water:monitoredAt ?sp }${sub ? `\n      FILTER(?subNotation = "${sub}")` : ""}
    }`,

  // Permits & limits — one row per permit: current version, and counts of its current-version limits,
  // discharge points, breaches, and — the column that matters most — the limits we could NOT assess.
  // A permit with 0 breaches and 14 unassessed limits is not a compliant permit; it is an unexamined
  // one, and the query that reproduces the table has to be able to say so.
  permits: (sub) => `${PREFIXES}${XSD_PFX}
    SELECT ?permit (MAX(?curV) AS ?version)
           (COUNT(DISTINCT ?curCond) AS ?currentLimits)
           (COUNT(DISTINCT ?dp) AS ?dischargePoints)
           (COUNT(DISTINCT ?breach) AS ?breaches)
           (COUNT(DISTINCT ?unassessed) AS ?notAssessed) WHERE {
${CUR_VERSION}
      ?permit a water:WaterDischargePermit .
      OPTIONAL {
        ?permit reg:hasCondition ?curCond .
        FILTER(xsd:integer(REPLACE(STR(?curCond), ".*/version/([0-9]+)/.*", "$1")) = ?curV)
      }
      OPTIONAL {
        ?permit reg:hasCondition ?unassessed .
        FILTER(xsd:integer(REPLACE(STR(?unassessed), ".*/version/([0-9]+)/.*", "$1")) = ?curV)
        ?unassessed wr:assessed false .
      }
      OPTIONAL { ?permit reg:permitSite ?dp }
      OPTIONAL { ?breach reg:breachesCondition ?bc . ?permit reg:hasCondition ?bc }${sub ? `
      FILTER EXISTS { ?permit reg:hasCondition ?sc .
        FILTER(xsd:integer(REPLACE(STR(?sc), ".*/version/([0-9]+)/.*", "$1")) = ?curV)
        ?sc reg:regulatedProperty ?scp . ?scp skos:notation "${sub}" }` : ""}
    } GROUP BY ?permit`,

  // Substance story — the current permit limit, AT ITS OUTLET, beside any WINEP action proposing a
  // future limit for the same permit and substance. Two things this has to get right, and neither is
  // incidental:
  //
  //  1. A condition holds SEVERAL Limits — one per statistic, one per season. The table shows a
  //     condition on ONE row, so the query GROUP_CONCATs the register's own statement of each Limit
  //     rather than emitting a row per bound. (Left as a plain join it returned 56 rows for a 34-row
  //     ammonia table — a provenance link that returns more rows than the table it claims to reproduce
  //     is worse than no link at all.)
  //
  //  2. The UNION is the proposed-only case: a WINEP action proposing a limit for a substance the
  //     permit does NOT currently regulate — a genuinely NEW limit. That is the entire nitrogen story
  //     in this catchment (7 actions propose a total-nitrogen limit; exactly 1 permit has one today),
  //     and the query used to omit it, so the link under-reported the table by 6 rows on the one
  //     substance the demonstrator exists to talk about.
  substanceStory: (sub) => `${PREFIXES}${XSD_PFX}
    SELECT ?permit ?dp ?subLabel
           (GROUP_CONCAT(DISTINCT ?limitText; separator=" · ") AS ?currentLimit)
           ?assessed ?monitoredAt ?action ?actionName ?completion ?proposedLimit WHERE {
      {
        # the permit currently regulates this substance, at this outlet
${CUR_VERSION}
        ?permit reg:hasCondition ?cond .
        FILTER(xsd:integer(REPLACE(STR(?cond), ".*/version/([0-9]+)/.*", "$1")) = ?curV)
        ?cond reg:regulatedProperty ?sub ; core:hasApplicability/core:appliesTo ?dp .
        ?sub skos:notation ?subNotation ; skos:prefLabel ?subLabel .${sub ? `
        FILTER(?subNotation = "${sub}")` : ""}
        OPTIONAL { ?cond wr:assessed ?assessed }
        OPTIONAL { ?cond reg:hasLimit/reg:limitStatement ?limitText }
        OPTIONAL { ?dp water:monitoredAt ?monitoredAt }
        OPTIONAL { ?action reg:targetPermit ?permit ; reg:proposesLimit ?lim ; rdfs:label ?actionName .
                   ?lim reg:regulatedProperty/skos:notation ?subNotation .
                   OPTIONAL { ?action core:applicabilityPeriod/core:applicableFrom ?completion }
                   OPTIONAL { ?lim reg:limitStatement ?proposedLimit } }
      } UNION {
        # a proposed limit for a substance this permit does NOT currently regulate — a NEW limit
        ?action reg:targetPermit ?permit ; reg:proposesLimit ?lim ; rdfs:label ?actionName .
        ?lim reg:regulatedProperty ?sub .
        ?sub skos:notation ?subNotation ; skos:prefLabel ?subLabel .${sub ? `
        FILTER(?subNotation = "${sub}")` : ""}
        OPTIONAL { ?action core:applicabilityPeriod/core:applicableFrom ?completion }
        OPTIONAL { ?lim reg:limitStatement ?proposedLimit }
        FILTER NOT EXISTS { ?permit reg:hasCondition ?c2 . ?c2 reg:regulatedProperty ?sub }
      }
    } GROUP BY ?permit ?dp ?subLabel ?assessed ?monitoredAt ?action ?actionName ?completion ?proposedLimit`,

  // WINEP actions — one row per action with a count of the future limits it proposes. The substance
  // filter is applied here too: it used to be ignored entirely, so with a substance selected this
  // returned all 11 actions for a table showing 1.
  actions: (sub) => `${PREFIXES}
    SELECT ?action ?label ?completion ?permit (COUNT(DISTINCT ?limit) AS ?limits) WHERE {
      ?action a reg:Action ; rdfs:label ?label .
      OPTIONAL { ?action reg:targetPermit ?permit }
      OPTIONAL { ?ap core:applicabilityPeriod/core:applicableFrom ?completion .
                 FILTER(STRSTARTS(STR(?ap), CONCAT(STR(?action), "#"))) }
      OPTIONAL { ?action reg:proposesLimit ?limit }${sub ? `
      FILTER EXISTS { ?action reg:proposesLimit/reg:regulatedProperty/skos:notation "${sub}" }` : ""}
    } GROUP BY ?action ?label ?completion ?permit ORDER BY ?completion`,

  // Applications — one row per SFI application with its option count, total annual payment, and the
  // MODELLED annual removal of nitrogen (9686) and phosphorus (0348). The two impact figures are
  // pulled through scalar sub-selects rather than joined in, for the same reason the runtime keeps
  // them in a separate query: an application has one impact per substance, so a plain join would
  // multiply the rows and inflate ?total and ?options. Impact values are negative (a reduction), so
  // the sign is flipped here to read as "removed", exactly as the table shows it.
  applications: () => `${PREFIXES}
    SELECT ?app ?appId ?scheme (SUM(COALESCE(?c, 0)) AS ?total) (COUNT(DISTINCT ?opt) AS ?options)
           ?nitrogenRemovedKgYr ?phosphorusRemovedKgYr WHERE {
      ?app a farm:Application ; core:hasPart ?opt .
      OPTIONAL { ?app skos:notation ?appId }
      OPTIONAL { ?app ex-farm:scheme ?scheme }
      OPTIONAL { ?opt farm:annualPayment/qudt:numericValue ?c }
      OPTIONAL { ?app farm:annualPollutantImpact ?ni .
                 ?ni farm:substance/skos:notation "9686" ; qudt:numericValue ?nkg .
                 BIND(-?nkg AS ?nitrogenRemovedKgYr) }
      OPTIONAL { ?app farm:annualPollutantImpact ?pi .
                 ?pi farm:substance/skos:notation "0348" ; qudt:numericValue ?pkg .
                 BIND(-?pkg AS ?phosphorusRemovedKgYr) }
    } GROUP BY ?app ?appId ?scheme ?nitrogenRemovedKgYr ?phosphorusRemovedKgYr
    ORDER BY DESC(?total)`,

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
// A GeoSPARQL wktLiteral is an OPTIONAL CRS URI, then the WKT:
//
//     <http://www.opengis.net/def/crs/EPSG/0/27700> POINT(400690 93850)
//     MULTIPOINT (-2.64 50.78, …)                       <- no URI: CRS84 by default
//
// The URI must be cut off BEFORE the numbers are read, and not merely ignored — it is full of digits
// ("…/EPSG/0/27700", "…/OGC/1.3/CRS84"), and a regex that scrapes every number out of the raw literal
// happily turns them into a phantom coordinate pair. That bug was live here: it survived only because
// the literals carrying a CRS were all single POINTs and only points[0] was ever read.
const CRS_URI = /^\s*<([^>]+)>\s*/;
function parseWkt(wkt) {
  // Returns { points: [[lat, lon], ...] } in WGS84.
  const m = CRS_URI.exec(wkt);
  const crs = m ? m[1] : "";
  const body = m ? wkt.slice(m[0].length) : wkt;
  const bng = crs.includes("27700");
  const nums = body.match(/-?\d+\.?\d*/g);
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
// "…/permit/042116/outlet/1/effluent/2" -> "1/2". The outlet is now part of a condition's identity, so
// the app has to be able to name it: a permit does not have a BOD limit, each of its outlets does.
const outletOf = (dpIri) => {
  const m = /\/outlet\/([^/]+)\/effluent\/([^/#]+)/.exec(dpIri || "");
  return m ? `${unescIri(m[1])}/${unescIri(m[2])}` : null;
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

// `uppers` maps a statistic slug to the LIST of bounds carrying it — a list, because a bound can also
// vary by SEASON. Permit 040067's 95th-percentile BOD limit is 15 mg/l from May to October and 20 mg/l
// from November to April: one statistic, two obligations. Reducing that to a single number means
// publishing one of them all year, and the old pipeline picked the loosest.
//
// tightest() is what the app shows when it has to show ONE number: the strictest value the permit ever
// requires. That is the honest summary — it never claims the permit is slacker than it is. The seasonal
// detail is never lost: it is on the condition (c.seasonal), in the limit statement, and on the chart,
// whose limit line steps with the month.
const tightest = (bounds) => bounds.reduce((a, b) => (b.value < a.value ? b : a), bounds[0]);

// From a {statSlug: [bound]} map, the binding bound: {stat, value, seasonal} | null.
function bindingBound(uppers) {
  if (!uppers) return null;
  const pick = (stat) => {
    const bs = uppers[stat];
    if (!bs || !bs.length) return null;
    return { stat, value: tightest(bs).value, seasonal: bs.length > 1 ? bs : null };
  };
  for (const stat of BINDING) { const b = pick(stat); if (b) return b; }
  const first = Object.keys(uppers)[0];
  return first ? pick(first) : null;
}
// The per-sample ceiling, if any — the only upper bound a single observation can actually breach.
const perSampleUpper = (uppers) => {
  if (!uppers) return null;
  for (const stat of PER_SAMPLE)
    if (uppers[stat] && uppers[stat].length) return tightest(uppers[stat]).value;
  return null;
};
// Does month m (1-12) fall in the register's [from, to] range? The range wraps: 11 -> 04 is winter.
const inSeason = (m, from, to) => {
  const a = Number(from), b = Number(to);
  return a <= b ? m >= a && m <= b : m >= a || m <= b;
};
// The bound in force at time t, from a statistic's (possibly seasonal) bounds.
function boundAt(bounds, t) {
  if (!bounds || !bounds.length) return null;
  if (bounds.length === 1) return bounds[0];
  const m = new Date(t).getMonth() + 1;
  return bounds.find((b) => b.from && inSeason(m, b.from, b.to)) || bounds[0];
}

// Current + proposed limits for the substance AT THE OUTLET MONITORED BY `sp`, and the monitored unit.
//
// The sampling point is what picks the condition, and it has to be. A permit does not have one BOD
// limit: permit 042116 caps BOD at 15 mg/l on effluent 1 and 25 mg/l on effluent 2, and those two
// effluents are sampled at two DIFFERENT points. Charting SW-50440194's series against "042116's BOD
// limit" would draw the wrong line — 25 where the permit says 15 — which is exactly what the app did
// before the conditions carried their outlet. The identifier the register states (water:monitoredAt)
// is what resolves it; nothing about the geometry helps at all.
function chartContext(subNotation, permit, sp) {
  const sub = DB.substances.find((s) => s.notation === subNotation);
  const forSub = (c) => c.permit === permit && c.subNotation === subNotation;
  // The outlet this sampling point actually monitors. Fall back to any condition on the permit only
  // when the point names none — and say so, rather than quietly charting another outlet's limit.
  const dps = DB.dischargePoints.filter((d) => d.permit === permit && d.sp === sp).map((d) => d.iri);
  const exact = DB.conditionsCurrent.filter((c) => forSub(c) && dps.includes(c.dp));
  const cond = exact[0] || null;
  const others = DB.conditionsCurrent.filter(forSub);
  // more than one outlet of this permit is monitored HERE, and they disagree: say so on the chart
  const ambiguous = exact.length > 1 && new Set(exact.map((c) => c.upper)).size > 1;
  const unresolved = !cond && others.length > 0;

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
    subNotation,                                           // determinand id, for the tab label
    sp,                                                    // sampling point id, for the tab label
    spName: (DB.samplingPoints.find((s) => s.id === sp) || {}).label || sp,  // its name, for the chart header
    unit: (cond && cond.unit) || (proposed[0] && proposed[0].unit) || "",
    upper: binding ? binding.value : null,            // THE limit (binding), drawn as the limit line
    upperStat: binding ? binding.stat : null,
    upperStatLabel: binding && cond.statLabels ? cond.statLabels[binding.stat] : null,
    seasonal: binding ? binding.seasonal : null,      // the limit line steps with the month
    // the per-sample ceiling, only when it is NOT already the binding bound — i.e. the upper tier
    maxUpper: binding && binding.stat !== "maximum" ? maxUpper : null,
    lower: cond && cond.lower != null ? Number(cond.lower) : null,
    outlet: cond ? cond.outlet : null,
    assessed: cond ? cond.assessed : null,
    notAssessed: cond ? cond.notAssessed : null,
    ambiguous,
    unresolved,
    version: DB.currentVersion[permit], // current (latest) version number
    steps: (cond && DB.limitHistory[`${cond.dp}|${subNotation}`]) || [], // dated windows for the step line
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
    if (s.from <= t && (s.to == null || t <= s.to)) {
      // Within the version, the bound can still change with the MONTH (permit 040067's BOD is 15 mg/l
      // May–Oct and 20 mg/l Nov–Apr). Pick the one that was actually in force on the day.
      const b = s.upperStat ? boundAt(s.uppersRaw && s.uppersRaw[s.upperStat], t) : null;
      return {
        upper: b ? b.value : s.upper, upperStat: s.upperStat,
        maxUpper: s.maxUpper, lower: s.lower,
      };
    }
  }
  const lastEnd = Math.max(...steps.map((s) => (s.to == null ? Infinity : s.to)));
  if (t > lastEnd) return fb;                                          // beyond the last dated window
  return { upper: null, upperStat: null, maxUpper: null, lower: null }; // before v1, or in a gap
}

// The chart on screen, kept so a window resize can redraw it at the panel's new size (the plot is
// drawn AT the panel's dimensions, not scaled to them — see chartBox).
let shownChart = null; // { ctx, obs, meta } | null

// ---------------------------------------------------------------------------
// Side-panel TABS. The panel (#chart) holds up to four tabs, one per category, that behave like a
// browser's: they persist across the regulated / measured / farming views and stay switchable. The
// tab set is DERIVED from selection state, so there is one source of truth and nothing to keep in
// sync by hand:
//   selectedApp   -> "app"        (Chart: SFI Application — cost pie / count / removals)
//   activePoint   -> "point"      (Chart: Substance at a sampling point — the time series)
//   selectedWb    -> "challenges" (Catchment: Challenges) AND "sfi" (Catchment: SFI Summary)
// A catchment selection yields two tabs; closing either clears the catchment (both go).
let activeTab = null;      // "app" | "point" | "challenges" | "sfi" | null
let activePoint = null;    // { sub, sp, permit, at, label } for the substance time-series tab

// Fixed order + labels, matching the four the brief names. `kind` is the small grey badge.
const TAB_DEFS = [
  { id: "app",        kind: "Chart",     label: "SFI Application" },
  { id: "point",      kind: "Chart",     label: "Substance @ Point" },
  { id: "challenges", kind: "Catchment", label: "Challenges" },
  { id: "sfi",        kind: "Catchment", label: "SFI Summary" },
];

// The tabs that currently exist, in fixed order, with their live per-instance titles.
function tabList() {
  const out = [];
  const wb = selectedWb ? WB.get(selectedWb) : null;
  for (const t of TAB_DEFS) {
    if (t.id === "app") { if (selectedApp) out.push({ ...t, title: `SFI Application ${appLabel(selectedApp)}` }); }
    else if (t.id === "point") { if (activePoint) out.push({ ...t, label: `${activePoint.sub} at ${activePoint.sp}`, title: `${activePoint.label} at ${activePoint.spName || activePoint.sp}` }); }
    else if (t.id === "challenges") { if (wb) out.push({ ...t, title: `${wb.label} — challenges` }); }
    else if (t.id === "sfi") { if (wb) out.push({ ...t, title: `${wb.label} — SFI summary` }); }
  }
  return out;
}
function appLabel(iri) { const a = DB.appById[iri]; return a ? a.id : last(iri); }

// Rebuild the tab bar + active body from state. Called at the end of render() and whenever a
// selection changes. Hides the whole panel when nothing is open.
function renderTabs() {
  const tabs = tabList();
  const chart = document.getElementById("chart");
  if (!tabs.length) { closeChartPanel(); return; }
  if (!tabs.some((t) => t.id === activeTab)) activeTab = tabs[tabs.length - 1].id; // fall back to the last
  chart.classList.remove("hidden");
  renderTabBar(tabs);
  renderActiveTabBody();
  setTimeout(() => map.invalidateSize(), 60);
}

function renderTabBar(tabs) {
  document.getElementById("chart-tabs").innerHTML = tabs.map((t) =>
    `<button class="chart-tab${t.id === activeTab ? " active" : ""}" data-tab="${t.id}" title="${esc(t.title || t.label)}">
       <span class="tab-kind">${esc(t.kind)}</span>
       <span class="tab-label">${esc(t.label)}</span>
       <span class="tab-close" data-close="${t.id}" title="Close this tab">✕</span>
     </button>`).join("");
}

// Render the active tab's content into #chart-body. Only the time-series is height-fitted and
// collapses the legend; the others scroll and leave the legend up for context.
function renderActiveTabBody() {
  const body = document.getElementById("chart-body");
  if (activeTab === "point") { collapseLegend(); renderPointTab(); return; }  // renderPointTab owns .fit
  body.classList.remove("fit"); expandLegend();
  if (activeTab === "app") renderAppChart(selectedApp);
  else if (activeTab === "challenges") body.innerHTML = waterbodyPanel(WB.get(selectedWb));
  else if (activeTab === "sfi") renderSfiCatchmentChart(selectedWb);
}

// Progress of an in-flight observation walk, so a render() mid-load repaints the bar rather than a
// bare "Loading…". Cleared when the series resolves (or errors).
let pointLoad = null;   // { loaded, total, ctx } | null

function pointProgressHtml(pl) {
  const head = `<p class="chart-scope">${esc(pl.ctx.label)} <span class="muted">at</span> <b>${esc(pl.ctx.spName || pl.ctx.sp)}</b></p>`;
  if (pl.total) {
    const pct = Math.min(100, Math.round((pl.loaded / pl.total) * 100));
    return head +
      `<div class="obs-bar"><div class="obs-bar-fill" style="width:${pct}%"></div></div>` +
      `<p class="chart-note">Loading observations from the EA Water Quality Archive — ` +
      `<b>${pl.loaded.toLocaleString()}</b> of <b>${pl.total.toLocaleString()}</b> (${pct}%)</p>`;
  }
  return head +
    `<div class="obs-bar indet"><div class="obs-bar-fill"></div></div>` +
    `<p class="chart-note">Loading observations from the EA Water Quality Archive…</p>`;
}

function renderPointTab() {
  const body = document.getElementById("chart-body");
  if (shownChart) { body.classList.add("fit"); body.innerHTML = renderChart(shownChart.ctx, shownChart.obs, shownChart.meta); return; }
  body.classList.remove("fit");   // the loading view is prose + a bar, not a fitted plot
  body.innerHTML = pointLoad ? pointProgressHtml(pointLoad) : `<p class="chart-note">Loading observations…</p>`;
}

// Update the loading bar as pages arrive; also stashes progress so a mid-load render() repaints it.
function renderPointProgress(ctx, loaded, total) {
  pointLoad = { loaded, total, ctx };
  if (activeTab === "point") renderPointTab();
}

// Close one tab by clearing the state that produces it. Closing a catchment tab clears the whole
// catchment selection, so both catchment tabs go together (they are two views of one thing).
function closeTab(id) {
  if (id === "app") { clearAppFocus(); return; }          // render() rebuilds the tab bar
  if (id === "point") { activePoint = null; shownChart = null; pointLoad = null; renderTabs(); return; }
  if (id === "challenges" || id === "sfi") { closeWaterbody(); return; }  // clears selectedWb -> renderTabs
}
const closeActiveTab = () => { if (activeTab) closeTab(activeTab); };

// Hide the whole panel (no tabs open). Restores the full-screen map and the legend.
function closeChartPanel() {
  document.getElementById("chart").classList.add("hidden");
  document.getElementById("chart-body").classList.remove("fit");
  document.getElementById("chart-tabs").innerHTML = "";
  expandLegend();
  setTimeout(() => map.invalidateSize(), 60);
}

// `permit` may be null — an ambient sampling point has no permit, so no limit line, no proposed
// limit and no version history: chartContext returns an empty frame and the chart is just the
// observations. `at` pins the map on the point itself when there is no discharge point to fly to.
async function openChart(subNotation, sp, permit, at) {
  const ctx = chartContext(subNotation, permit, sp);
  // Open (or refocus) the point tab. shownChart is cleared until the walk resolves so a stale series
  // is never shown under the new title.
  activePoint = { sub: subNotation, sp, permit, at, label: ctx.label, spName: ctx.spName };
  shownChart = null;
  pointLoad = null;
  activeTab = "point";
  renderTabs();                                    // shows the point tab (loading state)
  // resize the (now narrower) map and zoom it to the charted sampling point's discharge point
  const dp = permit && (DB.dischargePoints.find((d) => d.permit === permit && d.sp === sp && d.lat != null)
    || DB.dischargePoints.find((d) => d.permit === permit && d.lat != null));
  const target = dp ? [dp.lat, dp.lon] : at;
  document.getElementById("map").scrollIntoView({ behavior: "smooth", block: "start" });
  setTimeout(() => {
    map.invalidateSize();
    if (target) map.setView(target, 13);
  }, 80);
  loadObservations(subNotation, sp, ctx);          // paginated walk; fills the tab as pages arrive
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One /observations page, with client-side backoff for the hop to our server (the server itself backs
// off on the upstream archive). Retries a 429 / 5xx / network error a few times, doubling the wait and
// honouring Retry-After when present.
async function fetchObsPage(sp, sub, skip, limit) {
  let delay = 1000;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(`${OBSERVATIONS_ENDPOINT}?samplingPoint=${encodeURIComponent(sp)}` +
        `&determinand=${encodeURIComponent(sub)}&skip=${skip}&limit=${limit}`);
    } catch (e) {
      if (attempt >= 3) throw e;
      await sleep(delay); delay *= 2; continue;
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 3) throw new Error(`observations HTTP ${res.status}`);
      const ra = parseFloat(res.headers.get("retry-after"));
      await sleep(Number.isFinite(ra) ? ra * 1000 : delay); delay *= 2; continue;
    }
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }
}

// Walk every page of a series, ONE REQUEST PER SECOND, updating the loading bar from the archive's
// x-total-items (surfaced by the server as `total`). A complete cached set comes back on the first
// page, so a repeat view is a single request and the bar barely flashes. Aborts silently if the user
// has moved to another point mid-walk (its token no longer matches activePoint).
async function loadObservations(sub, sp, ctx) {
  const LIMIT = 250;
  const token = `${sub}|${sp}`;
  const mine = () => activePoint && `${activePoint.sub}|${activePoint.sp}` === token;
  let skip = 0, total = null, stale = false;
  const all = [];
  renderPointProgress(ctx, 0, null);               // "Loading…" until the first page returns
  try {
    while (true) {
      const data = await fetchObsPage(sp, sub, skip, LIMIT);
      if (!mine()) return;                          // user switched points — drop this walk
      if (data.total != null) total = data.total;
      stale = stale || !!data.stale;
      const page = data.observations || [];
      all.push(...page);
      renderPointProgress(ctx, all.length, total);
      if (data.complete || !page.length || (total != null && all.length >= total)) break;
      skip += page.length;
      await sleep(1000);                            // one request per second
    }
  } catch (err) {
    if (!mine()) return;
    shownChart = null; pointLoad = null;
    if (activeTab === "point")
      document.getElementById("chart-body").innerHTML =
        `<p class="chart-scope">${esc(ctx.label)} <span class="muted">at</span> <b>${esc(ctx.spName || ctx.sp)}</b></p>` +
        `<p class="chart-note">Could not load observations: ${esc(err.message)}</p>`;
    return;
  }
  if (!mine()) return;
  const obs = all.map((o) => ({ t: Date.parse(o.time), v: parseResult(o.result) }))
    .filter((o) => Number.isFinite(o.t) && o.v != null)
    .sort((a, b) => a.t - b.t);
  // The determinand's unit, taken from the observations themselves (the archive reports e.g.
  // "MILLIGRAM PER LITRE"); it is what labels the y-axis when the point carries no permit unit.
  const obsUnit = (all.find((o) => o.unit) || {}).unit || "";
  shownChart = { ctx: { ...ctx, obsUnit }, obs, meta: { stale } };
  pointLoad = null;
  if (activeTab === "point") renderPointTab();
}

// The panel next to the map is the plot's canvas: draw at ITS size rather than at a fixed aspect
// scaled to fit, or a wide window (the panel is 44% of the stage) would make the plot taller than
// the map and the panel would scroll. Height leaves room for the legend above and the note below.
function chartBox() {
  const body = document.getElementById("chart-body");
  const r = body.getBoundingClientRect();
  return {
    W: Math.max(360, Math.round(r.width - 14)),   // minus #chart-body's horizontal padding
    H: Math.max(220, Math.round(r.height - 104)), // minus padding + the header, legend and note lines
  };
}

// Redraw at the new panel size so the plot keeps filling the map's height as the window changes.
let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    // Only the time-series is drawn at panel size, so only redraw when it is the active tab.
    if (activeTab !== "point" || !shownChart || document.getElementById("chart").classList.contains("hidden")) return;
    const { ctx, obs, meta } = shownChart;
    document.getElementById("chart-body").innerHTML = renderChart(ctx, obs, meta);
  }, 150);
});

function renderChart(ctx, obs, meta = {}) {
  // The chart's own header: the determinand's full label at the sampling point's NAME — the human
  // reading of the tab, which carries only the ids (determinand at sampling-point id).
  const head = `<p class="chart-scope">${esc(ctx.label)} <span class="muted">at</span> <b>${esc(ctx.spName || ctx.sp || "")}</b></p>`;
  if (!obs.length) return `${head}<p class="chart-note">No observations for this substance at this sampling point.</p>`;
  const { W, H } = chartBox();
  const m = { l: 52, r: 16, t: 14, b: 38 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b, y0 = m.t + ih;
  // Fixed timeline — 1 Jan 2000 (the archive's reach) to today — rather than the series' own span.
  // Every chart then shares one x-axis, and a run of samples reads against the whole period: a series
  // that stops in 2017 shows the years of silence since, instead of being stretched to fill the panel.
  const tMin = Date.parse("2000-01-01T00:00:00"), tMax = Date.now();
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
    grid += `<line x1="${m.l}" y1="${yy}" x2="${W - m.r}" y2="${yy}" stroke="#b1b4b6"/>` +
      `<text x="${m.l - 6}" y="${yy + 3}" fill="#505a5f" font-size="10" text-anchor="end">${val.toFixed(dp)}</text>`;
  }
  const yr1 = new Date(tMin).getFullYear(), yr2 = new Date(tMax).getFullYear();
  const step = Math.max(1, Math.ceil((yr2 - yr1) / 8));
  for (let yr = yr1; yr <= yr2; yr += step) {
    const xx = x(Date.parse(`${yr}-01-01`));
    if (xx < m.l - 1 || xx > W - m.r + 1) continue;
    grid += `<line x1="${xx}" y1="${m.t}" x2="${xx}" y2="${y0}" stroke="#b1b4b6"/>` +
      `<text x="${xx}" y="${y0 + 14}" fill="#505a5f" font-size="10" text-anchor="middle">${yr}</text>`;
  }

  // Limit line. If we have dated version windows, draw the limit as a STEP line following the
  // versions (red dashed segment per window, vertical connector at each change); else a flat line.
  let lines = "";
  const hasSteps = ctx.steps.some((s) => s.upper != null || s.lower != null);
  // plain stepped segments (used for the lower bound and the upper-tier backstop; no per-segment labels)
  const stepLine = (pick, width, colour = "#d4351c") => {
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
      svg += `<text x="${run.xLeft + 3}" y="${run.yy - 4}" fill="#d4351c" font-size="10">${esc(label)}</text>`;
    };
    for (const s of ctx.steps) {
      if (!Number.isFinite(s.upper)) continue;
      const from = Math.max(s.from, tMin), to = Math.min(s.to == null ? tMax : s.to, tMax);
      if (to < tMin || from > tMax) continue;
      const yy = y(s.upper);
      svg += `<line x1="${x(from)}" y1="${yy}" x2="${x(to)}" y2="${yy}" stroke="#d4351c" stroke-width="1.75" stroke-dasharray="6 4"/>`;
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
      lines += `<text x="${W - m.r}" y="${y(ctx.upper) - 4}" fill="#d4351c" font-size="10" text-anchor="end">${fmtNum(ctx.upper)} ${prettyUnit(ctx.unit)}${statSuffix}</text>`;
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
      lines += `<line x1="${m.l}" y1="${yy}" x2="${W - m.r}" y2="${yy}" stroke="#d4351c" stroke-width="1.75" stroke-dasharray="6 4"/>`
        + (ctx.version != null ? `<text x="${m.l + 3}" y="${yy - 4}" fill="#d4351c" font-size="10">v${esc(ctx.version)}</text>` : "")
        + `<text x="${W - m.r}" y="${yy - 4}" fill="#d4351c" font-size="10" text-anchor="end">${fmtNum(ctx.upper)} ${prettyUnit(ctx.unit)}${statSuffix}</text>`;
    }
    if (ctx.lower != null) {
      const yy = y(ctx.lower);
      lines += `<line x1="${m.l}" y1="${yy}" x2="${W - m.r}" y2="${yy}" stroke="#d4351c" stroke-width="1.5" stroke-dasharray="6 4"/>`;
    }
  }
  const seen = new Set();
  for (const b of ctx.proposed) {
    const v = Number(b.val);
    if (!Number.isFinite(v) || seen.has(v)) continue;
    seen.add(v);
    const yy = y(v);
    // "proposed" on the LEFT of the line; value + unit + method on the RIGHT
    lines += `<line x1="${m.l}" y1="${yy}" x2="${W - m.r}" y2="${yy}" stroke="#4c2c92" stroke-width="1.75" stroke-dasharray="6 4"/>`
      + `<text x="${m.l + 3}" y="${yy - 4}" fill="#4c2c92" font-size="10">proposed</text>`
      + `<text x="${W - m.r}" y="${yy - 4}" fill="#4c2c92" font-size="10" text-anchor="end">${fmtNum(v)} ${prettyUnit(b.unit)}${b.stat ? " (" + esc(b.stat) + ")" : ""}</text>`;
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
      pts += `<path d="M${px - s} ${py - s}L${px + s} ${py + s}M${px - s} ${py + s}L${px + s} ${py - s}" stroke="#d4351c" stroke-width="1.7"/>`;
    } else if (st === "exceedance") {
      nExc++;
      const s = 4;
      pts += `<path d="M${px} ${py - s}L${px + s} ${py + s * 0.75}L${px - s} ${py + s * 0.75}Z" fill="none" stroke="${EXC}" stroke-width="1.5"/>`;
    } else {
      pts += `<circle cx="${px}" cy="${py}" r="3" fill="none" stroke="#1d70b8" stroke-width="1.5"/>`;
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
        <span class="item" style="color:#d4351c">✕ miss (${nMiss})</span>
        ${nExc || ctx.maxUpper != null ? `<span class="item" style="color:${EXC}">△ over ${excLabel} (${nExc})</span>` : ""}
        <span class="item" style="color:#1d70b8">◯ hit (${obs.length - nMiss - nExc})</span>
        <span class="item" style="color:#d4351c">– – enforced limit${hasSteps ? " (by version)" : ""}</span>
        ${ctx.maxUpper != null ? `<span class="item" style="color:${TIER}">– – upper tier</span>` : ""}
        ${ctx.proposed.length ? `<span class="item" style="color:#4c2c92">– – proposed limit</span>` : ""}
      </div>`
    : `<div class="chart-legend">
        <span class="item" style="color:#1d70b8">◯ observation (${obs.length})</span>
        <span class="item muted">measured, not regulated — no permit limit here</span>
        ${ctx.proposed.length ? `<span class="item" style="color:#4c2c92">– – proposed limit</span>` : ""}
      </div>`;
  // Y-axis label: the permit unit if there is one, else the determinand's own unit from the
  // observations (e.g. "mg/l"). Only truly unitless series fall back to the word "value".
  const yLabel = prettyUnit(ctx.unit) || prettyUnit(ctx.obsUnit) || "value";
  return `${head}${legend}<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
    ${grid}
    <text transform="translate(13 ${m.t + ih / 2}) rotate(-90)" fill="#505a5f" font-size="11" text-anchor="middle">${esc(yLabel)}</text>
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

// Removals view: the application's MODELLED annual pollutant removal for one substance, split into
// the intervention groups that contribute it — "the high-level code which produced that share of the
// nitrogen reduction". Sums the per-option impact up to the broader group, exactly as the cost view
// sums payments. Values are negative (a reduction in loss) and stay negative: the chart plots them
// below a zero baseline rather than quietly flipping the store's sign.
function groupRemovalsForApp(appIri, sub) {
  const byGroup = {};
  for (const o of DB.optionsByApp[appIri] || []) {
    const kg = (DB.optionImpacts[o.iri] || {})[sub];
    if (kg == null) continue;
    (byGroup[o.broader] ||= { code: o.broader, label: o.broaderLabel, value: 0 }).value += kg;
  }
  // Biggest CONTRIBUTOR first — i.e. most negative first, since these are reductions.
  return Object.values(byGroup).sort((a, b) => a.value - b.value);
}

// Which substances the removals view can speak about for this application, honouring the substance
// filter. An empty list is a real answer, not a bug, and the view says which kind of empty it is.
function removalSubstancesFor(appIri) {
  const have = Object.keys(DB.appImpacts[appIri] || {});
  return currentSubstance ? have.filter((s) => s === currentSubstance) : have;
}

// The "SFI Application" tab body: cost pie, count bars or modelled removals for the selected
// application. Priced applications default to the cost pie with a Cost/Count/Removals toggle; unpriced
// ones fall back to the count bar chart (no prices to show). Opening/closing is handled by the tab
// system (renderTabs); this only fills #chart-body.
function renderAppChart(appIri) {
  const app = DB.appById[appIri];
  const slices = groupCostsForApp(appIri);
  const total = slices.reduce((s, g) => s + g.value, 0);
  const unpriced = (DB.optionsByApp[appIri] || []).filter((o) => o.cost == null).length;
  const hasPrices = total > 0;
  // Cost is the only mode that can be unavailable (SFI 2023 has no published rates). Count and
  // Removals always have something to say — including "nothing modelled here", which is an answer.
  let mode = farmChartMode;
  if (mode === "value" && !hasPrices) mode = "count";
  const btn = (m, lbl) => `<button class="${mode === m ? "on" : ""}" onclick="setFarmChartMode('${m}')">${lbl}</button>`;
  const toggle = `<div class="chart-toggle">${hasPrices ? btn("value", "Cost") : ""}${btn("count", "Count")}${btn("removal", "Removals")}</div>`;
  const body = mode === "value" ? renderPie(slices, total, unpriced, app)
    : mode === "removal" ? renderRemovals(appIri)
    : renderBars(groupCountsForApp(appIri), app, hasPrices, unpriced);
  document.getElementById("chart-body").innerHTML = toggle + body;
}

// Removals: one small multiple per substance, each a single bar stacked by intervention group.
//
// TWO CHARTS, NOT TWO BARS ON ONE AXIS. Nitrogen and phosphorus differ by roughly 24x (the catchment
// models -120t N/yr against -5t P/yr), so a shared y-axis would render phosphorus as a sliver a few
// pixels tall and invite the eye to read "phosphorus barely matters" — which is a statement about the
// axis, not about phosphorus. Different measures, different scales, separate axes, each labelled.
function renderRemovals(appIri) {
  const subs = removalSubstancesFor(appIri);
  if (!subs.length) {
    // Distinguish the two ways this can be empty. They mean completely different things and the
    // store should not blur them: one is "we modelled it and there is nothing", the other is
    // "nobody has ever modelled this substance on land".
    const filtered = currentSubstance && !(currentSubstance in DB.landSubstances);
    const sub = DB.substances.find((s) => s.notation === currentSubstance);
    return filtered
      ? `<p class="chart-note">No modelled land impact for <b>${esc(sub ? sub.label : currentSubstance)}</b>. ` +
        `FARMSCOPER models this scheme's effect on <b>nitrogen</b> and <b>phosphorus</b> only — the store ` +
        `holds no land figure for any other substance, so there is nothing to show rather than nothing to find.</p>`
      : `<p class="chart-note">No modelled removal for this application — none of its options has a ` +
        `FARMSCOPER-modelled impact (only options measured in hectares can carry one).</p>`;
  }
  // ONE chart, both substances on a shared x-axis and a single y-axis — never two y-scales. They are
  // the same measure (kg/yr of pollutant) so a common mass axis is legitimate, and it says something
  // true: nitrogen removal dwarfs phosphorus BY MASS. What a common axis cannot say is that the two
  // matter equally per kilogram — they do not — so each bar is direct-labelled with its own total and
  // phosphorus stays readable as a number even when its bar is only a few pixels tall.
  const bars = subs.map((sub) => {
    const groups = groupRemovalsForApp(appIri, sub);
    return { sub, label: DB.landSubstances[sub] || sub, groups, total: groups.reduce((s, g) => s + g.value, 0) };
  }).filter((b) => b.total);
  if (!bars.length) return `<p class="chart-note">No modelled removal for this application.</p>`;

  // The legend is shared by the bars — colour follows the intervention group, the same group colours
  // the cost pie and the count bars use, so identity carries across all three modes.
  const seen = {};
  for (const b of bars) for (const g of b.groups) seen[g.code] = g;
  const legend = Object.values(seen).map((g) =>
    `<div class="pie-leg"><span class="dot" style="background:${groupColor(g.code)}"></span>` +
    `<span class="pie-name">${esc(g.label)} <span class="mono">${esc(g.code)}</span></span></div>`).join("");

  return removalChart(bars) +
    `<p class="chart-note modelled-note"><b>Modelled, not measured.</b> FARMSCOPER estimates a per-hectare ` +
    `change in loss for each intervention; this is that rate × the option's mapped area. Negative = kept out ` +
    `of the catchment. Both bars share one kg/yr axis, so phosphorus reads small <i>by mass</i> — that is a ` +
    `fact about kilograms, not about how much phosphorus matters.</p>` +
    `<div class="pie-legend">${legend}</div>`;
}

// One stacked bar per substance on a shared x- and y-axis. Segments run DOWNWARD from the zero
// baseline (the values are negative and stay negative), biggest contributor first.
function removalChart(bars) {
  const W = 340, H = 290, m = { l: 54, r: 14, t: 20, b: 58 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const yMin = niceFloor(Math.min(...bars.map((b) => b.total)));
  const y = (v) => m.t + (ih * v) / yMin;   // v=0 -> top (zero baseline); v=yMin -> bottom
  const zero = y(0);

  // Gridlines. The axis runs 0 down to yMin, so every tick below the baseline is a negative kg/yr.
  let grid = "";
  for (let i = 0; i <= 4; i++) {
    const v = (yMin * i) / 4, yy = y(v);
    grid += `<line x1="${m.l}" y1="${yy.toFixed(1)}" x2="${W - m.r}" y2="${yy.toFixed(1)}" stroke="${i ? "#b1b4b6" : "#4a5b6b"}"/>` +
      `<text x="${m.l - 6}" y="${(yy + 3).toFixed(1)}" fill="#505a5f" font-size="10" text-anchor="end">${fmtNum(Math.round(v))}</text>`;
  }

  const slot = iw / bars.length, bw = Math.min(96, slot * 0.5);
  let cols = "";
  bars.forEach((b, i) => {
    const bx = m.l + i * slot + (slot - bw) / 2;
    let cursor = 0;
    for (const g of b.groups) {
      const yTop = y(cursor), yBot = y(cursor + g.value);
      const h = Math.max(1, yBot - yTop - 2);   // 2px surface gap between stacked segments
      const share = Math.round((g.value / b.total) * 100);
      cols += `<rect x="${bx.toFixed(1)}" y="${yTop.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${groupColor(g.code)}" rx="2">` +
        `<title>${esc(g.label)} (${esc(g.code)}) — ${fmtKg(g.value)} · ${share}% of the ${esc(b.label)} reduction</title></rect>`;
      // Direct-label only segments with room for the code; the tooltip and legend carry the rest.
      if (h >= 15) cols += `<text x="${(bx + bw / 2).toFixed(1)}" y="${(yTop + h / 2 + 3.5).toFixed(1)}" fill="#0b0c0c" font-size="10" font-weight="600" text-anchor="middle">${esc(g.code)}</text>`;
      cursor += g.value;
    }
    // Name and total both sit UNDER the axis, stacked. Putting the total at the bar's end instead
    // would collide with the axis label whenever a bar runs the full height of the plot — which the
    // biggest one always does, since the scale is built from it. Down here it is legible for a bar of
    // any length, which is the point: phosphorus's bar can be four pixels tall and still be readable.
    const cx = (bx + bw / 2).toFixed(1);
    cols += `<text x="${cx}" y="${(m.t + ih + 16).toFixed(1)}" fill="#0b0c0c" font-size="11" text-anchor="middle">${esc(shortSub(b.label))}</text>` +
      `<text x="${cx}" y="${(m.t + ih + 31).toFixed(1)}" fill="#00703c" font-size="11" font-weight="600" text-anchor="middle">${fmtKg(b.total)}</text>`;
  });

  return `<div class="removal-chart">
    <svg viewBox="0 0 ${W} ${H}" class="bars" preserveAspectRatio="xMidYMid meet">${grid}${cols}
      <line x1="${m.l}" y1="${m.t}" x2="${m.l}" y2="${(m.t + ih).toFixed(1)}" stroke="#4a5b6b"/>
      <line x1="${m.l}" y1="${zero.toFixed(1)}" x2="${W - m.r}" y2="${zero.toFixed(1)}" stroke="#4a5b6b"/>
      <text transform="translate(13 ${(m.t + ih / 2).toFixed(1)}) rotate(-90)" fill="#505a5f" font-size="10" text-anchor="middle">modelled change in loss (kg/yr)</text>
    </svg></div>`;
}

// "Nitrogen, Total as N" -> "Nitrogen". The axis tick has room for the element, not the determinand's
// full registry name; the legend, tooltip and table all still carry it in full.
const shortSub = (label) => String(label).split(",")[0];

// Round a negative total outward to a readable axis minimum (-5,343 -> -6,000).
function niceFloor(v) {
  if (!v) return -1;
  const mag = Math.pow(10, Math.floor(Math.log10(Math.abs(v))));
  return -Math.ceil(Math.abs(v) / (mag / 2)) * (mag / 2);
}
// kg/yr, sign preserved. The graph's sign IS the meaning (negative = a reduction in loss), so the
// charts never strip it — only the applications table flips it, under a column that says "Removed".
const fmtKg = (v) => `${v < 0 ? "−" : ""}${fmtNum(Math.abs(Math.round(v)))} kg/yr`;

// The Cost/Count/Removals mode is shared by the two SFI charts (application and catchment summary);
// the toggle re-renders whichever of them is the active tab.
function setFarmChartMode(m) {
  farmChartMode = m;
  if (activeTab === "app" && selectedApp) renderAppChart(selectedApp);
  else if (activeTab === "sfi" && selectedWb) renderSfiCatchmentChart(selectedWb);
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
    grid += `<line x1="${m.l}" y1="${yy}" x2="${W - m.r}" y2="${yy}" stroke="#b1b4b6"/>` +
      `<text x="${m.l - 5}" y="${yy + 3}" fill="#505a5f" font-size="10" text-anchor="end">${v}</text>`;
  }
  let bars = "";
  groups.forEach((g, i) => {
    const x0 = m.l + i * bw + bw * 0.16, w = bw * 0.68, yy = y(g.count);
    bars += `<rect x="${x0}" y="${yy}" width="${w}" height="${y0 - yy}" fill="${groupColor(g.code)}" rx="2"><title>${esc(g.label)} — ${g.count}</title></rect>` +
      `<text x="${x0 + w / 2}" y="${yy - 4}" fill="#0b0c0c" font-size="10" text-anchor="middle">${g.count}</text>` +
      `<text transform="translate(${x0 + w / 2} ${y0 + 9}) rotate(35)" fill="#505a5f" font-size="9.5" text-anchor="start">${esc(g.code)}</text>`;
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
    <text transform="translate(11 ${m.t + ih / 2}) rotate(-90)" fill="#505a5f" font-size="10" text-anchor="middle">locations</text>
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
      : `<path d="M${cx} ${cy} L${x0.toFixed(1)} ${y0.toFixed(1)} A${R} ${R} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)} Z" fill="${groupColor(g.code)}" stroke="#0b0c0c" stroke-width="1"><title>${esc(g.label)} — ${fmtGBP(g.value)}</title></path>`;
    a0 = a1;
  }
  const legend = slices.map((g) =>
    `<div class="pie-leg"><span class="dot" style="background:${groupColor(g.code)}"></span>` +
    `<span class="pie-name">${esc(g.label)} <span class="mono">${esc(g.code)}</span></span>` +
    `<span class="pie-val">${fmtGBP(g.value)} · ${Math.round((g.value / total) * 100)}%</span></div>`).join("");
  return `<svg viewBox="0 0 ${S} ${S}" class="pie" preserveAspectRatio="xMidYMid meet">${paths}
    <circle cx="${cx}" cy="${cy}" r="58" fill="#ffffff"/>
    <text x="${cx}" y="${cy - 3}" text-anchor="middle" fill="#0b0c0c" font-size="22" font-weight="700">${fmtGBP(total)}</text>
    <text x="${cx}" y="${cy + 17}" text-anchor="middle" fill="#505a5f" font-size="12">per annum</text>
  </svg>
  <p class="chart-note">${fmtGBP(total)} per annum · cost per intervention${unpriced ? ` · <b>${unpriced}</b> option${unpriced === 1 ? "" : "s"} unpriced` : ""}</p>
  <div class="pie-legend">${legend}</div>`;
}

// Select (toggle) an application: redraw the map emphasis + spider + tables, and open its tab.
function selectApp(iri) {
  selectedApp = selectedApp === iri ? null : iri;
  // Each new selection defaults to the cost view (falling back to count if unpriced) — unless a
  // substance the land side models is filtered on, in which case that IS the question being asked.
  farmChartMode = currentSubstance in DB.landSubstances ? "removal" : "value";
  if (selectedApp) activeTab = "app";              // bring the SFI Application tab to the front
  render();                                        // render() -> renderTabs() rebuilds the bar
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

// Filter the breach table down to one permit. Set from a discharge point's popup, so "12 past
// breaches" can be a link to the rows rather than twelve lines of popup nobody will read.
let breachPermit = null;
window.filterBreaches = (permitIri) => {
  breachPermit = permitIri;
  render();
  const el = document.getElementById("breach-card");
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
};
window.clearBreachFilter = () => { breachPermit = null; render(); };

const permitMarkers = {}; // permit IRI -> [marker] for the current render, for zoom-to-permit
const actionMarkers = {}; // WINEP action IRI -> marker (current render), for table<->map focus
const spMarkers = {};     // sampling point id -> marker (current render), so the table can open its popup
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
// Water bodies: notation -> { label, notation, desigLabel, layer, on, versions, classifications, rnags }
const WB = new Map();
// The water body whose panel is open, as a NOTATION (skos:notation), never a label. Labels live on
// versions and vary in case between them — "PIDDLE (Lower)" at v1/v2, "Piddle (Lower)" at v3 — so a
// label is not an identifier here. This is the fan-out failure app/TODO.md already documents.
let selectedWb = null;
let currentView = "regulated";
let currentSubstance = ""; // notation or ""
let currentOptionType = ""; // farming: broader option-group code filter, or ""
let selectedApp = null;    // farming: selected application IRI (or null)
let selectedAction = null; // WINEP: focused action IRI (or null) — links the table row and map marker
let farmChartMode = "value"; // farming chart: "value" (cost pie) | "count" (bar)
let farmDisplay = "applications"; // farming map: "applications" (hull polygons) | "options" (parcel points)
let optionRenderer = null;   // shared L.canvas() for the ~12,900 option-point dots
let farmDisplayControl = null;
// The parcels currently plotted in options view, as {lat, lon, opt}. Rebuilt each time the option
// points are drawn; read by openOptionPicker to gather everything under a click.
let plottedOptionDots = [];
let actionTableEl = null;  // the WINEP table wrapper, so a map click can page to the action's row

// Focus a WINEP action, keeping the table row and its map marker in sync (the dashed-underlined
// action id in the table and the marker both call this). fromMap=true means the click came from the
// marker, so we bring the table row into view; otherwise we pan the map to the marker + open it.
function focusAction(iri, fromMap) {
  selectedAction = iri;
  // The table is paged, so the row may not be rendered right now. Turn to its page FIRST — otherwise
  // clicking a marker would silently do nothing whenever its action happened to be on page 2.
  if (fromMap && actionTableEl && actionTableEl.revealRow)
    actionTableEl.revealRow((tr) => tr.dataset.action === iri);
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
  mk.setStyle({ color: "#0b0c0c", weight: 1.5, fillColor: on ? "#c9aaff" : "#4c2c92", fillOpacity: on ? 1 : 0.85 });
  mk.setRadius(on ? 9 : 7);
  if (on) mk.bringToFront();
}

// ---------------------------------------------------------------------------
// Load everything once
// ---------------------------------------------------------------------------
async function loadAll() {
  const [substances, breaches, dps, conditions, actions, proposed, applications, groupLabels, sfiOptions, limitHistory, samplingPoints, appImpacts, optionImpacts, sfiParcels] =
    await Promise.all([
      sparql(Q.substances), sparql(Q.breaches), sparql(Q.dischargePoints),
      sparql(Q.conditions), sparql(Q.actions), sparql(Q.proposed),
      sparql(Q.applications), sparql(Q.groupLabels), sparql(Q.sfiOptions), sparql(Q.limitHistory),
      sparql(Q.samplingPoints), sparql(Q.appImpacts), sparql(Q.optionImpacts), sparql(Q.sfiParcels),
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
      // The determinands this point is actually sampled for. A Set, because the only question ever
      // asked of it is membership.
      dets: new Set((r.dets || "").split(",").filter(Boolean)),
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
    const key = `${r.dp}|${r.subNotation}`;                 // per OUTLET, not per permit
    const vk = `${key}|${r.version}`;
    const h = (histMap[vk] ||= {
      key, version: r.version, from: Date.parse(r.from), to: r.to ? Date.parse(r.to) : null,
      uppers: {}, lower: null,
    });
    if (r.upper != null) {
      const stat = r.stat ? last(r.stat) : "maximum";
      (h.uppers[stat] ||= []).push({
        value: Number(r.upper), from: r.monthFrom || null, to: r.monthTo || null,
      });
    }
    if (r.lower != null) h.lower = h.lower == null ? Number(r.lower) : Math.max(h.lower, Number(r.lower));
  }
  DB.limitHistory = {};
  for (const h of Object.values(histMap)) {
    const b = bindingBound(h.uppers);
    const mx = perSampleUpper(h.uppers);
    (DB.limitHistory[h.key] ||= []).push({
      version: h.version, from: h.from, to: h.to,
      upper: b ? b.value : null,
      upperStat: b ? b.stat : null,
      // the raw per-statistic bounds, so limitAt() can pick the one in force in the sample's MONTH
      uppersRaw: h.uppers,
      maxUpper: b && b.stat !== "maximum" ? mx : null,
      lower: h.lower,
    });
  }
  for (const k in DB.limitHistory) DB.limitHistory[k].sort((a, b) => a.from - b.from);

  // Breaches are periods. current = the period is still open (no applicableTo) i.e. nothing has
  // passed since it started; past = closed with a from/to. A lone failure has from == to.
  DB.breaches = breaches.map((b) => {
    const p = b.wkt ? (parseWkt(b.wkt).points[0] || null) : null;
    return {
      iri: b.breach, from: b.from, to: b.to || null, current: !b.to,
      subLabel: b.subLabel, subNotation: b.subNotation, permit: b.permit,
      version: verOf(b.cond), // the permit version whose limit was breached
      dp: b.dp, outlet: outletOf(b.dp),   // the OUTLET it happened at — the condition names it
      sp: spOf(b.sp), type: b.type ? last(b.type) : "LimitBreach",
      // WHICH limit failed — the statistic, the value, the register's own words, and the arithmetic.
      stat: b.stat ? last(b.stat) : null,
      statLabel: b.statLabel || null,
      limit: b.limit != null ? Number(b.limit) : null,
      limStmt: b.limStmt || null,
      unit: b.unitLabel || null,
      assessment: b.assessment || null,
      undated: b.undated === "true",   // judged against a version the register does not date
      lat: p ? p[0] : null, lon: p ? p[1] : null,
    };
  });

  // Discharge points
  // ?wkt is unbound for the outlets the register gives no location for; they keep lat/lon null and
  // are simply not drawn.
  DB.dischargePoints = dps.map((d) => {
    const p = d.wkt ? (parseWkt(d.wkt).points[0] || null) : null;
    return { iri: d.dp, permit: d.permit, sp: spOf(d.sp), lat: p ? p[0] : null, lon: p ? p[1] : null };
  });

  // Conditions, one per (permit VERSION, discharge point, substance) — the grain the register sets
  // limits at. `dp` is the outlet the condition governs (core:appliesTo). A permit's in-force limits
  // are those of its latest (max) version, so mark current vs superseded.
  const condMap = {};
  for (const c of conditions) {
    const key = c.cond;
    const e = (condMap[key] ||= {
      permit: c.permit, cond: c.cond, dp: c.dp, version: verOf(c.cond),
      outlet: outletOf(c.dp),
      subLabel: c.subLabel, subNotation: c.subNotation,
      uppers: {}, statLabels: {}, lower: null, unit: null, stmts: [],
      // wr:assessed absent => the breach pipeline never saw this condition at all.
      assessed: c.assessed === "true", notAssessed: c.notAssessed || null,
    });
    // One row per LIMIT. Bounds are keyed by statistic and collected as a LIST, because a statistic
    // can carry more than one bound — one per season. Flattening to a single value is what the old
    // pipeline did, and it published the loosest: permit 040067's BOD read 20 mg/l all year when from
    // May to October the permit requires 15.
    if (c.upper != null || c.lower != null) {
      const stat = c.stat ? last(c.stat) : "maximum"; // an unqualified bound is an absolute ceiling
      if (c.statLabel) e.statLabels[stat] = c.statLabel;
      if (c.upper != null) {
        (e.uppers[stat] ||= []).push({
          value: Number(c.upper), from: c.monthFrom || null, to: c.monthTo || null,
        });
      }
      // No seasonal lower bound exists in this catchment; keep the tightest (highest) if one appears.
      if (c.lower != null) e.lower = e.lower == null ? Number(c.lower)
        : Math.max(e.lower, Number(c.lower));
    }
    if (c.unitLabel) e.unit = c.unitLabel;
    if (c.stmt && !e.stmts.includes(c.stmt)) e.stmts.push(c.stmt);
  }
  // Flatten each condition's bounds to the binding limit + the per-sample ceiling (see BINDING).
  for (const c of Object.values(condMap)) {
    const b = bindingBound(c.uppers);
    c.upper = b ? b.value : null;
    c.upperStat = b ? b.stat : null;
    c.upperStatLabel = b ? c.statLabels[b.stat] : null;
    c.seasonal = b ? b.seasonal : null;   // [{value, from, to}] when the bound changes with the month
    const mx = perSampleUpper(c.uppers);
    c.maxUpper = b && b.stat !== "maximum" ? mx : null;
  }
  DB.conditions = Object.values(condMap);
  DB.currentVersion = {};
  for (const c of DB.conditions)
    DB.currentVersion[c.permit] = Math.max(DB.currentVersion[c.permit] ?? -Infinity, Number(c.version) || 0);
  for (const c of DB.conditions) c.current = Number(c.version) === DB.currentVersion[c.permit];
  DB.conditionsCurrent = DB.conditions.filter((c) => c.current);
  // Current conditions per discharge point — what a given outlet is actually required to do.
  DB.condByDp = groupBy(DB.conditionsCurrent, "dp");

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

  // MODELLED pollutant impact. The graph stores these NEGATIVE (a reduction in loss). We keep that
  // sign here — it is the store's sign and the removals chart plots it as-is, below a zero baseline.
  // Only the applications table flips it, because a column headed "Removed" showing "−5,344" would
  // read as an increase. `landSubstances` is derived from what the graph actually carries, so the
  // dropdown's Water & Land group cannot drift from the data: add sediment tomorrow and it appears.
  DB.appImpacts = {};       // app IRI  -> { notation: kg/yr (negative) }
  DB.landSubstances = {};   // notation -> label, for the substances land can speak about at all
  for (const r of appImpacts) {
    (DB.appImpacts[r.app] ||= {})[r.sub] = Number(r.kg);
    DB.landSubstances[r.sub] = r.label;
  }
  DB.optionImpacts = {};    // option IRI -> { notation: kg/yr (negative) }
  for (const r of optionImpacts) (DB.optionImpacts[r.opt] ||= {})[r.sub] = Number(r.kg);

  // Farming applications: id, option count, total annual payment (£), modelled removals. Keyed by
  // IRI for selection.
  DB.applications = applications.map((a) => ({
    iri: a.app, id: a.appId || last(a.app), scheme: a.scheme || "—",
    total: a.total != null ? Number(a.total) : 0,
    n: a.n != null ? Number(a.n) : 0,
    impact: DB.appImpacts[a.app] || {},
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
      // Per-parcel geometry+extent, filled in below from DB.sfiParcels. Each entry {lat,lon,area,mtl}.
      parcels: [],
    };
  }).filter((o) => o.points.length);
  // Attach each option's drawn parcels (point + own extent). Keyed by option IRI. These carry the
  // per-parcel area/length that makes a sub-catchment extent exact; the MULTIPOINT above stays the
  // rendering geometry. The two describe the same points, so parcels.length == points.length.
  const optByIri = {};
  for (const o of DB.sfiOptions) optByIri[o.iri] = o;
  for (const p of sfiParcels) {
    const o = optByIri[p.opt];
    if (!o) continue;
    const pt = parseWkt(p.wkt).points[0];
    if (!pt) continue;
    o.parcels.push({ lat: pt[0], lon: pt[1],
      area: p.area != null ? Number(p.area) : null,
      mtl: p.mtl != null ? Number(p.mtl) : null });
  }
  const parcelMismatch = DB.sfiOptions.filter((o) => o.parcels.length !== o.points.length).length;
  if (parcelMismatch)
    console.error(`SFI parcels: ${parcelMismatch} options where parcel count != multipoint count — ` +
      `the SFIParcels nodes are out of step with the option MULTIPOINTs.`);
  // An option's total extent, summed from its parcels: hectares for area-based actions, metres for
  // linear ones (hedgerows). One of the two is 0. Shown in the option-point detail floater.
  for (const o of DB.sfiOptions) {
    o.ha = o.parcels.reduce((s, p) => s + (p.area || 0), 0);
    o.m = o.parcels.reduce((s, p) => s + (p.mtl || 0), 0);
  }

  DB.optionsByApp = groupBy(DB.sfiOptions, "app");
  // How many of each application's options have no published rate (superseded SFI 2023 codes).
  for (const a of DB.applications) {
    const opts = DB.optionsByApp[a.iri] || [];
    a.unpriced = opts.filter((o) => o.cost == null).length;
    a.priced = opts.length - a.unpriced;
  }

  // Substance dropdown — now a WATER & LAND filter, grouped by which domains can actually answer for
  // the substance. The split is computed from the graph (`DB.landSubstances`), not hard-coded:
  //
  //   Water & Land  — the store holds BOTH measured observations AND a modelled land impact
  //                   (nitrogen, phosphorus: the two FARMSCOPER binds to monitored determinands)
  //   Water only    — a monitored determinand with nothing on the land side to say about it
  //
  // There is no "Land only" group, and that is a fact about the data rather than an omission: every
  // substance the SFI graph models an impact for is also one the archive samples. If a land-only
  // substance ever appears (sediment is the live candidate — see ttl/sfi/TODO.md), it belongs in a
  // third optgroup, and the code below will need one; today asserting an empty group would be a
  // promise the store cannot keep.
  DB.substances = substances;
  const isLand = (n) => n in DB.landSubstances;
  const opt = (s) => `<option value="${s.notation}">${esc(s.label)} (${s.notation})</option>`;
  const both = substances.filter((s) => isLand(s.notation));
  const waterOnly = substances.filter((s) => !isLand(s.notation));
  const sel = document.getElementById("substance");
  sel.innerHTML =
    `<option value="">All substances</option>` +
    (both.length ? `<optgroup label="Water &amp; Land — measured and modelled">${both.map(opt).join("")}</optgroup>` : "") +
    `<optgroup label="Water only — measured, no modelled land impact">${waterOnly.map(opt).join("")}</optgroup>`;
  document.getElementById("substance-note").innerHTML =
    `<b>${both.length}</b> of ${substances.length} substances carry both measured water quality and a modelled land impact.`;

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

  // Water bodies sit just above the conservation underlays and, unlike them, ARE clickable — the
  // whole point is selecting one. They stay below the marker pane (600), so a discharge point or
  // sampling point on top of a water body still takes the click.
  map.createPane("waterbodies");
  map.getPane("waterbodies").style.zIndex = 260;

  fetch("catchment.geojson").then((r) => r.json()).then((gj) => {
    catchmentLayer = L.geoJSON(gj, {
      // interactive:false because this outline has no click behaviour and is filled. It sits in the
      // default overlayPane (z-index 400), ABOVE the water bodies pane (260), so while it was
      // interactive it silently ate clicks aimed at a water body wherever the two overlap — which is
      // everywhere, since every water body is inside the catchment.
      interactive: false,
      style: { color: "#5aa9ff", weight: 1.5, fillColor: "#1d70b8", fillOpacity: 0.06 },
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

  // The individual-options view (farmDisplay === "options") plots every drawn parcel as a dot — up to
  // ~12,900 of them. A canvas renderer draws them all onto one <canvas> instead of one SVG node each,
  // which is the difference between smooth and unusable at that count.
  //
  // The canvas is VISUAL ONLY — its own pane, pointer-events:none. A full-viewport interactive canvas
  // sits above the water-bodies pane and swallows every click meant for a sub-catchment (the bug this
  // replaced). Instead, clicks are resolved in the map handler below: dots first (openOptionPicker
  // gathers by proximity to plottedOptionDots), then the sub-catchment under the click. z 270 keeps the
  // dots above the water-body fills so they stay visible.
  map.createPane("optionpts");
  map.getPane("optionpts").style.zIndex = 270;
  map.getPane("optionpts").style.pointerEvents = "none";
  optionRenderer = L.canvas({ pane: "optionpts", padding: 0.5 });
  layers.optionPoints = L.layerGroup();

  // While the application picker popup is open, suppress the hover tooltip; restore polygon fills
  // when it closes.
  map.on("popupopen", (e) => { if (e.popup.options.className === "picker-popup") { pickerOpen = true; hideOverlapTip(); } });
  map.on("popupclose", (e) => { if (e.popup.options.className === "picker-popup") { pickerOpen = false; restoreAllShapes(); } });

  // Farming map clicks.
  //   OPTIONS view: the dots and the water bodies are both non-interactive (their panes are
  //   pointer-events:none in this mode — see syncFarmPanes), so this one handler arbitrates. A dot
  //   (or cluster) under the click wins; failing that, a sub-catchment under the click opens. That
  //   ordering is why a filtered, sparse point cloud no longer blocks clicking the sub-catchment.
  //   APPLICATIONS view: unchanged — a genuine background click (no hull under it) deselects.
  map.on("click", (e) => {
    if (currentView !== "farming") return;
    if (farmDisplay === "options") {
      if (openOptionPicker(e.latlng)) return;
      const n = waterbodyAt(e.latlng);
      if (n) openWaterbody(n, true);
      return;
    }
    if (selectedApp && !containingApps(e.latlng).length) clearAppFocus();
  });

  // Applications (polygons) ↔ Options (points) toggle for the farming map. Same segmented style as the
  // base-map control; shown only in the farming view (see syncFarmDisplayControl, called from render).
  const FarmDisplayControl = L.Control.extend({
    options: { position: "topright" },
    onAdd() {
      const div = L.DomUtil.create("div", "basemap-control farm-display");
      div.innerHTML =
        `<button type="button" data-fd="applications" title="Show each agreement as a polygon (its option footprint)">Applications</button>` +
        `<button type="button" data-fd="options" title="Plot every option's parcels as points you can click">Options</button>`;
      div.querySelectorAll("button").forEach((b) => {
        b.classList.toggle("on", b.dataset.fd === farmDisplay);
        b.addEventListener("click", () => {
          if (b.dataset.fd === farmDisplay) return;
          div.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
          farmDisplay = b.dataset.fd;
          selectedApp = null;             // the two modes have different notions of "selected"; start clean
          render();
        });
      });
      L.DomEvent.disableClickPropagation(div);
      return div;
    },
  });
  farmDisplayControl = new FarmDisplayControl();
  map.addControl(farmDisplayControl);
}

// Show the Applications/Options toggle only in the farming view, and keep its buttons in step with
// farmDisplay (which an agreement link in the option floater can flip back to "applications").
function syncFarmDisplayControl() {
  const el = farmDisplayControl && farmDisplayControl.getContainer();
  if (!el) return;
  el.style.display = currentView === "farming" ? "" : "none";
  el.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.fd === farmDisplay));
}

// Toggle the base-map tiles between full colour and desaturated (greyscale). The filter is applied
// to the tile layer's container, so only the basemap is affected, not the vector overlays.
function setBasemap(mode) {
  const container = base && base.getContainer();
  if (container) container.classList.toggle("basemap-desaturated", mode === "desaturated");
  try { localStorage.setItem("basemap", mode); } catch (e) {}
}

function dot(color, r = 7, opacity = 0.9) {
  return { radius: r, color: "#0b0c0c", weight: 1.5, fillColor: color, fillOpacity: opacity };
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
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;

const LEDE = {
  // TWO SENTENCES, and the substance case gets its own. They used to share one, which produced
  // "61 discharge permits for Nitrogen, Total as N (60 with limits in the store): 1 limits in force" —
  // because the permit and outlet counts were the WHOLE catchment while the limit and breach counts
  // were filtered to the substance. Mixing a filtered count and an unfiltered one in a single sentence
  // is not a wording problem; it is two different questions answered as though they were one.
  regulated: (n, lbl) => {
    const notAssessed = n.notAssessed
      ? ` <b>${n.notAssessed}</b> of those limits <b>could not be assessed at all</b> ` +
        `<span class="muted">(no dated permit version, no sampling point, or no sample ever taken)</span> — ` +
        `which is not the same as passing. `
      : "";
    const geometry =
      `Every one of these is linked to its permit <b>by identifier, not by location</b>: the catchment's ` +
      `<b>${n.mapped}</b> mapped outlets sit on just <b>${n.coords} distinct coordinates</b>, and ` +
      `<b>${n.unmapped}</b> more have no coordinate at all — so a map alone cannot tell them apart, or ` +
      `in ${n.unmapped === 1 ? "one case" : "those cases"} even find them ` +
      `(<a href="points.html" target="_blank" rel="noopener">why that matters</a>).`;

    const breached = n.breaches === 0
      ? `and <b>none has been breached</b>`
      : `and <b>${plural(n.breaches, "breach", "breaches")}</b> of them (<b>${n.current}</b> still open)`;
    const works = (what) => n.works === 0
      ? `No WINEP action proposes to change ${what}. `
      : `<b>${plural(n.works, "WINEP action")}</b> propose${n.works === 1 ? "s" : ""} to change ${what}. `;

    if (n.substance) {
      return `<b>The regulated world</b>, for <b>${esc(lbl)}</b>. ` +
        `<b>${plural(n.permitsForSub, "permit")}</b> ${n.permitsForSub === 1 ? "sets" : "set"} a limit ` +
        `for it, across <b>${plural(n.outletsForSub, "outlet")}</b>: ` +
        `<b>${plural(n.limits, "limit")}</b> in force, ${breached}. ` + notAssessed +
        works("them") + geometry;
    }
    // The store holds outlets for every scoped permit, but a permit only has limits here if the
    // register sets one. Say so rather than let the table's count silently disagree with the headline.
    const withLimits = n.permitsWithLimits < n.permits
      ? ` <span class="muted">(${n.permitsWithLimits} of them carry limits)</span>` : "";
    return `<b>The regulated world</b> — what the register permits, and what has failed it. ` +
      `<b>${plural(n.permits, "discharge permit")}</b>${withLimits} over ` +
      `<b>${plural(n.outlets, "outlet")}</b>: <b>${plural(n.limits, "limit")}</b> in force, ${breached}. ` +
      notAssessed + works("the limits in force") + geometry;
  },
  // `catchment` is how many points there ARE; `shown` is how many survived the substance filter. They
  // have to be two numbers: with a substance chosen, "123 sampling points in the catchment" would be
  // a plain untruth about the world dressed up as a headline.
  // `lbl` is "" when no substance is chosen, and the closing sentence changes rather than naming one
  // anyway: with "All substances" the point tells you what IT holds, which is the only truthful way to
  // offer a time series when the filter is off — a chart is always OF a determinand.
  measured: (n, lbl) =>
    `<b>The measured world</b> — what the sampling actually finds, whatever the source. ` +
    `<b>${n.catchment} sampling points</b> in the catchment, of which <b>${n.unpermitted}</b> belong to ` +
    `<b>no permit at all</b> (rivers, boreholes, bathing waters), so the regulated world is ` +
    `structurally blind to them — there is no permit to reach them through. Coloured by what the EA ` +
    `samples there. ` + (lbl
      ? `Click a point for its <b>${esc(lbl)}</b> time series, pulled live from the Water Quality Archive.`
      : `Click a point to see <b>which determinands it is sampled for</b>, and pick one to chart — ` +
        `pulled live from the Water Quality Archive. Choose a substance above to filter the map to ` +
        `the points that measure it.`) + unsampledNote(n, lbl),
};

// The filter's receipt. A hidden point is a fact about the monitoring network — 38 places nobody tests
// for phosphate is the kind of thing this app exists to show — so it is never merely dropped: the count
// is stated, and the points can be put back. Says nothing when nothing is hidden.
function unsampledNote(n, lbl) {
  if (!n.hidden) return "";
  const s = n.hidden === 1;
  return showUnsampled
    ? ` <span class="note">Showing <b>all ${n.catchment}</b>, including the <b>${n.hidden}</b> the ` +
      `archive holds no <b>${esc(lbl)}</b> series for (drawn hollow) — those cannot be charted for it. ` +
      `<a href="#" id="toggle-unsampled">Hide them</a>.</span>`
    : ` <span class="note">Showing the <b>${n.shown}</b> that are sampled for <b>${esc(lbl)}</b>. The ` +
      `other <b>${n.hidden}</b> ${s ? "is" : "are"} <b>not sampled for it</b> and ${s ? "is" : "are"} ` +
      `hidden — that is an absence of measurement, not an absence of pollution. ` +
      `<a href="#" id="toggle-unsampled">Show them</a>.</span>`;
}

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
  layers.optionPoints.clearLayers();
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

// The Waterbody Catchments picker is a native <select> in the Water super-box, styled like the
// Substance and Option-type dropdowns. Single-choice: "None" hides every catchment, "All
// sub-catchments" draws all 19 outlines as context, and a named catchment shows + focuses that one
// (openWaterbody flies to it and opens its side panel). Populated by buildWaterbodySelect.
const WB_ALL = "__all";
function onWaterbodySelect(e) {
  const v = e.target.value;
  if (v === "") setAllWb(false);              // hide all (closes the panel if one was focused)
  else if (v === WB_ALL) { closeWaterbody(); setAllWb(true); }   // all outlines, none focused
  else openWaterbody(v, false);               // show + focus + fly to this one, open its panel
}

// ---------------------------------------------------------------------------
// Water bodies (Catchment Data Explorer) — layer, legend control, detail panel
// ---------------------------------------------------------------------------
// The water bodies have to read as a distinct layer against a catchment outline that is ALREADY blue
// (#1d70b8 at 0.06) and a basemap full of blue watercourses. The first attempt — #4fd1c5 at 0.14 —
// was technically drawn and technically clickable, and invisible: ticking the control produced no
// change a user could see, so there was nothing to click. Opacity and stroke weight here are the
// affordance, not decoration.
const WB_COLOR = "#00e0c6";
const WB_SEL = "#ffb340";
const WB_STYLE = { color: WB_COLOR, weight: 2, fillColor: WB_COLOR, fillOpacity: 0.3 };
const WB_HOVER = { color: "#7dffe9", weight: 3, fillColor: "#7dffe9", fillOpacity: 0.42 };
const WB_STYLE_SEL = { color: WB_SEL, weight: 3.5, fillColor: WB_SEL, fillOpacity: 0.5 };

// Status colours. "Does not require assessment" and "Not assessed" are deliberately NOT the same
// grey as a missing value would be — they are recorded facts about what was tested, and the app's
// standing rule is that an absence of measurement never gets painted as a result.
const STATUS_COLOR = {
  "High": "#2f9e5a", "Good": "#57b85c", "Supports Good": "#57b85c",
  "Moderate": "#e0a020", "Poor": "#e5762d", "Bad": "#d4351c",
  "Fail": "#d4351c", "Does Not Support Good": "#e5762d", "Not High": "#8a94a6",
};
// Shortened for the pills only — "Does not require assessment" is wider than the column it sits in.
// The full wording stays in the title attribute; nothing is shortened into something that reads as a
// different verdict ("not required" is not "passed").
const SHORT_STATUS = {
  "Does not require assessment": "not required",
  "Does Not Support Good": "not supporting",
  "Supports Good": "supports good",
};

// A status pill. `absent` is deliberately a different THING rather than a paler shade of the same
// thing: "not assessed" is the absence of a verdict, and the one mistake this panel must not make is
// letting it read as a quiet pass.
function pill(status) {
  if (!status) return `<span class="wb-pill wb-pill-absent" title="not assessed in this year">not assessed</span>`;
  const bg = STATUS_COLOR[status] || "#5b6472";
  return `<span class="wb-pill" style="background:${bg}" title="${esc(status)}">` +
         `${esc(SHORT_STATUS[status] || status)}</span>`;
}

// Statuses that count as "below good" — the filter behind the published challenges cross-table.
const BELOW_GOOD = new Set(["Bad", "Poor", "Moderate", "Fail", "Does Not Support Good"]);

async function loadWaterbodies() {
  let rows, versions, classifications, rnags;
  try {
    [rows, versions, classifications, rnags] = await Promise.all([
      sparql(Q.waterbodies), sparql(Q.wbVersions), sparql(Q.wbClassifications), sparql(Q.wbRnags),
    ]);
  } catch (err) {
    console.error("Water bodies unavailable:", err);
    window.__wbErr = `${err.name}: ${err.message}`;  // readable from a test harness
    return;                            // no control is built; the rest of the app is unaffected
  }
  if (rows.length !== 19)
    console.error(`FAN-OUT: ${rows.length} water body rows, expected 19 — a join is duplicating.`);

  for (const r of rows) {
    // A catchment POLYGON, drawn as its outer ring. parseWkt flattens the coordinate list, which is
    // right for a simple polygon and would be wrong for one with holes; none of these 19 has one.
    const pts = parseWkt(r.wkt).points;
    if (!pts.length) continue;
    const layer = L.polygon(pts, { pane: "waterbodies", ...WB_STYLE });
    // Behave like the sampling-point and permit markers: hover feedback, a pointer cursor and a name
    // under the cursor, so it is visibly a thing you can click before you click it.
    layer.on("click", () => openWaterbody(r.notation, true));
    // No bringToFront() on hover. These catchments nest and abut, so raising the hovered polygon
    // re-stacks the pane mid-gesture: the shape under the cursor when the click lands is not the one
    // that was under it when the pointer arrived, and you open a neighbour. Stacking is fixed once,
    // by area, below. Only the SELECTED polygon is ever raised.
    layer.on("mouseover", () => { if (selectedWb !== r.notation) layer.setStyle(WB_HOVER); });
    layer.on("mouseout", () => { if (selectedWb !== r.notation) layer.setStyle(WB_STYLE); });
    layer.bindTooltip(r.label, { sticky: true });
    const b = layer.getBounds();
    WB.set(r.notation, {
      notation: r.notation, iri: r.wb, label: r.label,
      desig: r.desig, desigLabel: r.desigLabel,
      // Bounding-box area, used only to decide stacking order (see restackWb).
      area: (b.getNorth() - b.getSouth()) * (b.getEast() - b.getWest()),
      // The catchment polygon as a [lat,lon] ring, kept for point-in-polygon: it is what scopes SFI
      // parcels to this sub-catchment (see sfiByCatchment). Same ring the layer draws.
      ring: pts,
      layer, on: false, versions: [], classifications: [], rnags: [],
    });
  }
  for (const v of versions) { const w = WB.get(v.notation); if (w) w.versions.push(v); }
  for (const c of classifications) { const w = WB.get(c.notation); if (w) w.classifications.push(c); }
  for (const g of rnags) { const w = WB.get(g.notation); if (w) w.rnags.push(g); }

  buildWaterbodySelect();
}

// Largest catchment at the back, smallest at the front. Several of these nest — Frome Dorset (Lower)
// u/s and d/s Louds Mill, Piddle Upper and Lower — and in tick order alone a small water body can end
// up entirely beneath a large one, where no click can ever reach it. Re-run whenever the drawn set
// changes, because bringToFront() only affects layers currently on the map.
function restackWb() {
  [...WB.values()].filter((w) => w.on).sort((a, b) => b.area - a.area)
    .forEach((w) => w.layer.bringToFront());
  const sel = selectedWb && WB.get(selectedWb);
  if (sel && sel.on) sel.layer.bringToFront();
}

function setWb(notation, on) {
  const w = WB.get(notation);
  if (!w || w.on === on) return;
  w.on = on;
  if (on) { w.layer.addTo(map); restackWb(); } else map.removeLayer(w.layer);
  // Turning a water body off closes its panel: the panel describes a polygon that is no longer drawn,
  // and leaving it open invites reading it against whatever is still on screen.
  if (!on && selectedWb === notation) closeWaterbody();
}
function setAllWb(on) {
  for (const n of WB.keys()) setWb(n, on);
  syncWaterbodySelect();
}
// Reflect the current state into the <select>: a focused catchment shows its own name; otherwise
// "All sub-catchments" while any outline is drawn, or "None" when the layer is empty. Keeps the
// picker honest when polygons are turned on by other paths — a map click, or a cross-table highlight.
function syncWaterbodySelect() {
  const sel = document.getElementById("waterbody");
  if (!sel) return;
  const onCount = [...WB.values()].filter((w) => w.on).length;
  sel.value = selectedWb ? selectedWb : (onCount ? WB_ALL : "");
}

// Populate the Waterbody Catchments <select> (Water super-box), styled like Substance / Option type.
// "None" is the default off-state so the map stays clean until asked; "All sub-catchments" draws every
// outline; the named options each focus one catchment.
function buildWaterbodySelect() {
  if (!WB.size) return;
  const sel = document.getElementById("waterbody");
  if (!sel) return;
  const opts = [...WB.values()].sort((a, b) => a.label.localeCompare(b.label))
    .map((w) => `<option value="${esc(w.notation)}">${esc(w.label)}</option>`).join("");
  sel.innerHTML =
    `<option value="">None</option>` +
    `<option value="${WB_ALL}">All sub-catchments (${WB.size})</option>` +
    `<optgroup label="Focus a sub-catchment">${opts}</optgroup>`;
}

// Highlight is a style change on the drawn polygon, matching how a focused WINEP action is shown.
function styleWb(w, on) {
  w.layer.setStyle(on ? WB_STYLE_SEL : WB_STYLE);
  if (on) w.layer.bringToFront();
}

function closeWaterbody() {
  selectedWb = null;
  for (const w of WB.values()) styleWb(w, false);
  syncWaterbodySelect();               // no focus now: "All" if outlines remain, else "None"
  // Un-scoping: every view's map and tables return to the whole catchment, so re-render (which also
  // drops the Challenges + SFI Summary tabs via renderTabs).
  render();
}

// Open the detail panel for one water body. `fromMap` distinguishes a polygon click (leave the view
// alone — the user is already looking at it) from a programmatic open (fly to it).
function openWaterbody(notation, fromMap) {
  const w = WB.get(notation);
  if (!w) return;
  // Opening a body that is switched off would describe an invisible polygon. Switch it on instead.
  if (!w.on) setWb(notation, true);
  selectedWb = notation;
  syncWaterbodySelect();                          // reflect the focused catchment in the picker
  for (const x of WB.values()) styleWb(x, x.notation === notation);
  // A catchment selection produces two tabs — Challenges and SFI Summary; default to Challenges. The
  // panel itself is drawn by the tab system (renderTabs), which leaves the legend up for these tabs.
  activeTab = "challenges";
  // Every view now scopes its map AND tables to the focused catchment (renderX reads selectedWb via
  // scopeRing / inScope), so re-render the whole view. render() reconciles the tab bar at the end.
  render();
  setTimeout(() => {
    map.invalidateSize();
    if (!fromMap) map.fitBounds(w.layer.getBounds(), { padding: [30, 30] });
  }, 80);
}

// The Catchment Data Explorer serves a human-readable PAGE for each water body, but at a URL that is
// NOT the graph's own URI: the graph keeps the source's `/so/` URI, which 404s pasted verbatim, while
// the page drops the `/so/` and uses https. e.g.
//   graph URI : http://environment.data.gov.uk/catchment-planning/so/WaterBody/GB108044010130   (404)
//   the page  : https://environment.data.gov.uk/catchment-planning/WaterBody/GB108044010130     (200)
// It is an HTML page, not linked data (the site publishes no RDF). The mismatch is upstream's to
// reconcile; here we derive the page URL so the panel can link to it rather than dead-ending.
function cdePageUrl(iri) {
  return iri.replace(/^http:/, "https:").replace("/catchment-planning/so/", "/catchment-planning/");
}

function waterbodyPanel(w) {
  // --- designation, and whether it moved ------------------------------------
  const vs = [...w.versions].sort((a, b) => a.v.localeCompare(b.v));
  const distinct = new Set(vs.map((v) => v.desigLabel));
  const verNo = (v) => v.v.replace(/^.*\//, "");
  const desigHist = distinct.size > 1
    ? `<p class="wb-note wb-change"><b>This designation changed.</b> ` +
      vs.map((v) => `v${esc(verNo(v))} <i>${esc(v.desigLabel)}</i>`).join(" → ") + `.</p>`
    : `<p class="wb-note">Unchanged across ${vs.length} version${vs.length === 1 ? "" : "s"}.</p>`;

  // --- classification history, pivoted: one ROW per year, one column per item ------------------
  // Years down the side rather than across the top. With ten years as columns the table was wider
  // than the panel and had to scroll sideways; the number of headline items is fixed and small, so
  // pivoting makes it fit, and reading a water body's history top-to-bottom is the natural direction.
  const cls = w.classifications;
  const years = [...new Set(cls.map((c) => c.year))].sort();
  const ITEMS = ["Overall Water Body", "Ecological", "Chemical", "Phosphate"];
  const items = ITEMS.filter((i) => cls.some((c) => c.item === i));
  // Key on (item, year, cycle): cycles 2 and 3 BOTH published a 2019 assessment, so (item, year)
  // alone collides and one silently overwrites the other.
  const byKey = new Map(cls.map((c) => [`${c.item}|${c.year}|${c.cycle}`, c]));
  const cycleOf = (y) => [...new Set(cls.filter((c) => c.year === y).map((c) => c.cycle))].sort();

  const histHead = `<tr><th>Year</th>${items.map((i) => `<th class="ctr">${esc(i)}</th>`).join("")}</tr>`;
  const histRows = years.map((y) => {
    const cy = cycleOf(y);
    return `<tr><td class="wb-yr">${esc(y)}<span class="wb-cy">cycle ${cy.join(" & ")}</span></td>` +
      items.map((it) => {
        // Where two cycles both assessed this year, show the later cycle's verdict and name both.
        const hits = cy.map((c) => byKey.get(`${it}|${y}|${c}`)).filter(Boolean);
        if (!hits.length) return `<td class="ctr">${pill(null)}</td>`;
        const last = hits[hits.length - 1];
        const t = hits.map((h) => `cycle ${h.cycle}: ${h.status}`).join("; ");
        return `<td class="ctr" title="${esc(t)}">${pill(last.status)}</td>`;
      }).join("") + `</tr>`;
  }).join("");

  // --- the challenges themselves, listed ---------------------------------------------------------
  const UNATTR = "(not attributed)";
  const rnags = [...w.rnags].sort((a, b) =>
    (BELOW_GOOD.has(b.status) - BELOW_GOOD.has(a.status)) ||
    (a.swmi || "￿").localeCompare(b.swmi || "￿") ||
    a.p3.localeCompare(b.p3) || (a.item || "").localeCompare(b.item || ""));
  const below = rnags.filter((g) => BELOW_GOOD.has(g.status)).length;
  const unattr = rnags.filter((g) => !g.swmi).length;

  const chalList = rnags.length === 0
    ? `<p class="wb-note">No reasons for not achieving good are recorded for this water body.</p>`
    : rnags.map((g) => `
        <div class="wb-chal${g.swmi ? "" : " wb-chal-unattr"}">
          <div class="wb-chal-top">
            ${pill(g.status)}
            <span class="wb-chal-p3">${esc(g.item || g.p3)}</span>
          </div>
          <div class="wb-chal-swmi">${g.swmi ? esc(g.swmi) : UNATTR}</div>
          <div class="wb-chal-meta">
            ${esc(g.p3)} · ${g.sector ? esc(g.sector) : "no sector recorded"}${g.activity ? ` · ${esc(g.activity)}` : ""}
          </div>
        </div>`).join("");

  return `
    <div class="wb-panel">
      <p class="wb-id">${esc(w.notation)} <a class="wb-uri" href="${esc(cdePageUrl(w.iri))}" target="_blank" rel="noopener" title="Open this water body on the Catchment Data Explorer — a human-readable page (not linked data). The graph's own URI carries a /so/ segment and 404s; this is the resolvable page.">Catchment Data Explorer&nbsp;↗</a></p>

      <h3>How it is designated</h3>
      <p class="wb-desig"><b>${esc(w.desigLabel)}</b></p>
      ${desigHist}

      <h3>How it is classified</h3>
      <p class="wb-note">Four headline items of the 74 assessed. "Not assessed" means exactly that —
        it is not a pass.</p>
      <table class="wb-hist"><thead>${histHead}</thead><tbody>${histRows}</tbody></table>

      <h3>Challenges</h3>
      <p class="wb-note">${rnags.length === 0 ? "" :
        `<b>${rnags.length}</b> reason${rnags.length === 1 ? "" : "s"} for not achieving good status,
         of which <b>${below}</b> ${below === 1 ? "is" : "are"} against an element below good.` +
        (unattr ? ` <b>${unattr}</b> carr${unattr === 1 ? "ies" : "y"} no national challenge heading and
         ${unattr === 1 ? "is" : "are"} absent from the published cross-table.` : "")}</p>
      ${chalList}
    </div>`;
}

// The SFI per-group table for one sub-catchment — the "Count" mode of the Catchment: SFI Summary tab.
// Parcels is the count, payment the cost, extent each action's own exact area/length. No total extent —
// a field carries several actions at different areas, so one "area under improvement" figure would
// double-count and is not valid. (This is where the parcels/extent/payment numbers live now that the
// tab has replaced the table that used to be folded into the challenges panel.)
function sfiCatchmentTable(notation) {
  const groups = sfiByCatchment(notation);
  if (!groups.length)
    return `<p class="wb-note">No SFI option parcels fall within this sub-catchment.</p>`;
  const totParcels = groups.reduce((s, g) => s + g.parcels, 0);
  const totPay = groups.reduce((s, g) => s + g.payment, 0);
  const anyPriced = groups.some((g) => g.payment > 0);
  const extentCell = (g) => {
    if (g.ha > 0) return `${fmtNum(Math.round(g.ha))}<span class="unit"> ha</span>`;
    if (g.m > 0) return `${fmtNum(Math.round(g.m))}<span class="unit"> m</span>`;
    return `<span class="muted">—</span>`;
  };
  const rows = groups.map((g) => `
      <tr>
        <td>${swatch(groupColor(g.code))}${esc(g.label)} <span class="mono">${esc(g.code)}</span></td>
        <td class="num">${fmtNum(g.parcels)}</td>
        <td class="num">${extentCell(g)}</td>
        <td class="num">${g.payment > 0 ? fmtGBP(Math.round(g.payment)) + "/yr" : '<span class="muted">unpriced</span>'}</td>
      </tr>`).join("") +
    `<tr class="tot-row"><td><b>Total</b></td><td class="num"><b>${fmtNum(totParcels)}</b></td>` +
    `<td class="num"><span class="muted" title="Extent is per action type and cannot be summed — a field carries several actions">—</span></td>` +
    `<td class="num"><b>${anyPriced ? fmtGBP(Math.round(totPay)) + "/yr" : "—"}</b></td></tr>`;

  return `
    <p class="wb-note">Options whose parcels fall inside this sub-catchment.
      <b>Parcels</b> counts this action's mapped points; <b>payment</b> is apportioned by parcel share.
      Both sum cleanly. <b>Extent</b> is each action's own exact area or length and is
      <b>not totalled</b> — a field carries several actions, so a single footprint would double-count.</p>
    <table class="wb-sfi">
      <thead><tr><th>Option group</th><th class="num">Parcels</th><th class="num">Extent</th><th class="num">Annual payment</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

window.wbFocus = (notation) => openWaterbody(notation, false);

// The challenges cross-table: business sector × challenge (nationalSWMIheader), counting DISTINCT
// (water body, status, pressure) triples below good — the rule the published CDE table uses, verified
// cell for cell against it (8 cells, total 29) by ttl/catchment/verify_catchment.py.
//
// Scoped to one water body when one is selected, otherwise the whole catchment.
function wbCrosstab(tables) {
  if (!WB.size) return;
  const scope = selectedWb ? WB.get(selectedWb) : null;
  const rnags = scope ? scope.rnags : [...WB.values()].flatMap((w) => w.rnags);
  if (!rnags.length) return;

  const UNATTR = "(not attributed)";
  const sectors = [...new Set(rnags.map((g) => g.sector || UNATTR))].sort((a, b) =>
    a === UNATTR ? 1 : b === UNATTR ? -1 : a.localeCompare(b));
  const swmis = [...new Set(rnags.map((g) => g.swmi || UNATTR))].sort((a, b) =>
    a === UNATTR ? 1 : b === UNATTR ? -1 : a.localeCompare(b));

  // Count distinct (water body, status, pressure) per cell, matching the published rule.
  const cell = new Map();
  for (const g of rnags) {
    if (!BELOW_GOOD.has(g.status)) continue;
    const k = `${g.sector || UNATTR}|${g.swmi || UNATTR}`;
    if (!cell.has(k)) cell.set(k, new Set());
    cell.get(k).add(`${g.notation}|${g.status}|${g.p3}`);
  }
  const n = (sec, sw) => (cell.get(`${sec}|${sw}`) || new Set()).size;
  const total = [...cell.values()].reduce((t, s) => t + s.size, 0);

  const head = `<tr><th>Challenge</th>${sectors.map((s) =>
    `<th class="ctr${s === UNATTR ? " wb-unattr" : ""}">${esc(s)}</th>`).join("")}<th class="num">Total</th></tr>`;
  const rows = swmis.map((sw) => {
    const rowTotal = sectors.reduce((t, s) => t + n(s, sw), 0);
    return `<tr class="${sw === UNATTR ? "wb-unattr-row" : ""}"><td>${esc(sw)}</td>` +
      sectors.map((s) => {
        const v = n(s, sw);
        return `<td class="ctr">${v
          ? `<button class="wb-cell" onclick="window.wbHighlight('${esc(s)}','${esc(sw)}')" ` +
            `title="Highlight the water bodies behind this cell">${v}</button>`
          : `<span class="wb-zero">·</span>`}</td>`;
      }).join("") + `<td class="num">${rowTotal || ""}</td></tr>`;
  }).join("");

  const body = document.createElement("div");
  body.innerHTML = `<table class="wb-cross"><thead>${head}</thead><tbody>${rows}</tbody></table>`;

  // Two caveats that the table cannot state for itself, and both of which change what it means.
  const unattributed = rnags.filter((g) => !g.swmi).length;
  const cycles = [...new Set(rnags.map((g) => g.cycle))].sort();
  body.insertAdjacentHTML("beforeend", `
    <p class="wb-note">
      Counts are distinct (water body, status, pressure) below good, which is the rule the published
      Catchment Data Explorer table uses — not a count of records.
      ${unattributed
        ? `<b>${unattributed} of ${rnags.length}</b> challenges carry no national challenge heading and
           appear only in the <i>${UNATTR}</i> row; every "measures delivered, awaiting recovery"
           record is among them. Dropping that row would assert those challenges do not exist.`
        : ""}
    </p>
    <p class="wb-note">
      <b>One cycle, not three.</b> Every reason for not achieving good in this catchment belongs to
      cycle ${cycles.join(", ")}; cycles 1 and 2 published no RNAGs here, so there is nothing to
      compare across. The classification history in the water body panel does span all three cycles —
      that is where change over time is visible.
    </p>`);

  const title = scope
    ? `Challenges — ${esc(scope.label)}`
    : `Challenges — whole catchment`;
  const clear = scope
    ? ` <a class="sparql-link" href="#" onclick="window.wbClearScope();return false;">show all 19</a>`
    : "";
  const c = card(title + clear, total, body, CP_PREFIXES + Q.wbRnags.replace(CP_PREFIXES, ""));
  c.id = "wb-crosstab";
  tables.append(c);
}

window.wbClearScope = () => closeWaterbody();   // closeWaterbody() re-renders the current view

// Click a cross-table cell → highlight the water bodies that put a count in it. This is the
// "select a value and highlight the water bodies" interaction; it turns the polygons on, because
// highlighting something invisible is not highlighting.
window.wbHighlight = (sector, swmi) => {
  const UNATTR = "(not attributed)";
  const hit = new Set();
  for (const w of WB.values())
    for (const g of w.rnags)
      if (BELOW_GOOD.has(g.status) && (g.sector || UNATTR) === sector && (g.swmi || UNATTR) === swmi)
        hit.add(w.notation);
  for (const w of WB.values()) {
    setWb(w.notation, hit.has(w.notation));
    styleWb(w, hit.has(w.notation));
  }
  syncWaterbodySelect();
  const bounds = [...hit].map((n) => WB.get(n).layer.getBounds());
  if (bounds.length) {
    const b = bounds.reduce((acc, x) => acc.extend(x), L.latLngBounds(bounds[0].getSouthWest(), bounds[0].getNorthEast()));
    document.getElementById("map").scrollIntoView({ behavior: "smooth", block: "start" });
    setTimeout(() => { map.invalidateSize(); map.fitBounds(b, { padding: [30, 30] }); }, 80);
  }
};

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
// A seasonal limit is shown as BOTH values with their months, never as one. Permit 040067's BOD is
// 15 mg/l from May to October and 20 mg/l from November to April; collapsing that to a single figure
// is what the store used to do, and it published the winter number all year.
const MONTH = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const season = (b) => (b.from ? ` <span class="muted">${MONTH[+b.from]}–${MONTH[+b.to]}</span>` : "");

function limitBounds(c) {
  const parts = [];
  if (c.seasonal) {
    const statLbl = c.upperStatLabel && c.upperStat !== "maximum" ? ` (${esc(c.upperStatLabel)})` : "";
    parts.push(c.seasonal.slice()
      .sort((a, b) => a.value - b.value)
      .map((b) => "≤ " + fmtNum(b.value) + season(b))
      .join(" · ") + statLbl);
  } else if (c.upper != null) {
    const statLbl = c.upperStatLabel && c.upperStat !== "maximum" ? ` (${esc(c.upperStatLabel)})` : "";
    parts.push("≤ " + fmtNum(c.upper) + statLbl);
  }
  if (c.maxUpper != null) parts.push("≤ " + fmtNum(c.maxUpper) + " (upper tier)");
  if (c.lower != null) parts.push("≥ " + fmtNum(c.lower));
  return parts.join(" ") || "—";
}
// The same, with the unit appended.
function limitRange(c) {
  return limitBounds(c) + (c.unit ? " " + prettyUnit(c.unit) : "");
}
// Why a condition could not be assessed, in plain English. The graph gives the reason as a SKOS
// notation (wr:notAssessedBecause); this is the only place it is turned into prose.
const OBSTACLE = {
  "ambiguous-version-history": "the permit has several versions and the register dates none of them, so there is no way to tell which limits applied on the day a sample was taken",
  "no-sampling-point": "the register names no sampling point for this outlet — nothing monitors it",
  "sampling-point-unpublished": "the archive publishes no data for this outlet's sampling point",
  "no-observations": "no compliance sample has ever been taken for this determinand here",
  "no-observations-in-a-dated-window": "the samples we hold fall outside every dated version of the permit",
  "too-few-samples": "too few samples in any 12-month window for the method to reach a verdict",
};
// A condition's status as a pill. The distinction this draws is the entire point of the store: a
// condition NOT ASSESSED is not a condition that passed. Three states, never two.
function condStatus(c, breached) {
  if (breached) return '<span class="pill current">breached</span>';
  if (c.assessed) return '<span class="pill ok">assessed — no breach</span>';
  const why = OBSTACLE[c.notAssessed] || "not examined";
  return `<span class="pill unknown" title="${esc(why)}">not assessed</span>`;
}

// One unified popup per discharge point: identity + WQE link, its breaches, and the in-force limits —
// each with whether we could actually judge it.
//
// CURRENT breaches are listed: there are few, they are the news, and they are what a reader opened the
// popup for. PAST breaches are COUNTED, with a link that filters the breach table to this permit —
// because a works with a long history can carry dozens, and a popup that unrolls all of them is a wall
// of text that buries the one thing that matters. The table is where a list belongs; it sorts, it
// pages, and it carries the assessment detail the popup has no room for.
function dischargePopup(dp, currentConds, cur, past) {
  const wqe = dp.sp ? wqeLink(dp.sp) : '<span class="muted">no sampling point — the register names none</span>';
  const breachedSub = new Set([...cur, ...past].map((b) => b.subNotation));
  let breaches = "";
  if (cur.length || past.length) {
    const line = (b) => `${esc(b.subLabel)} — ${breachPeriod(b)}` +
      (b.undated ? ' <span class="muted">(undated permit version)</span>' : "");
    const pastCell = past.length
      ? `${plural(past.length, "breach", "breaches")} ` +
        `<span class="sub-link" onclick="event.stopPropagation();filterBreaches('${dp.permit}')">show in the table ↓</span>`
      : "none";
    breaches = `<hr><div class="kv"><b>Breaches</b><br>
      <b>Current:</b> ${cur.length ? cur.map(line).join("<br>") : "none"}<br>
      <b>Past:</b> ${pastCell}</div>`;
  }
  const limits = currentConds.length
    ? currentConds.slice().sort((a, b) => a.subLabel.localeCompare(b.subLabel))
        .map((c) => `${subLink(c.subLabel, c.subNotation, dp.sp, dp.permit)}: ${limitRange(c)} `
                  + condStatus(c, breachedSub.has(c.subNotation))).join("<br>")
    : "—";
  const nUn = currentConds.filter((c) => !c.assessed).length;
  const caveat = nUn
    ? `<div class="kv muted" style="margin-top:6px">${nUn} of ${currentConds.length} condition${
        currentConds.length === 1 ? "" : "s"} could not be assessed. That is not the same as passing.</div>`
    : "";
  return `<h3>Discharge point <span class="muted">${esc(outletOf(dp.iri) || "")}</span></h3>
    <div class="kv"><b>Permit:</b> ${permitRef(dp.permit)}<br>
    <b>Monitored at:</b> ${wqe}</div>
    ${breaches}
    <hr><div class="kv"><b>Current limits</b> <span style="color:#777">(v${DB.currentVersion[dp.permit] ?? "?"})</span><br>${limits}</div>
    ${caveat}`;
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

// The permit's current in-force limit for a substance, as text — for showing alongside a WINEP
// proposed limit. Returns null when the substance isn't currently regulated on that permit.
//
// A WINEP action names a PERMIT, not an outlet, and a permit's outlets can carry different limits for
// the same substance. So there may be several "current" limits and the action does not say which it
// means. Where they disagree we show the TIGHTEST and say how many there are, rather than picking one
// and presenting it as the answer — the ambiguity is in the source, and hiding it would be the same
// mistake as every other one this store is here to expose.
function currentLimitFor(permit, subNotation) {
  const cs = DB.conditionsCurrent.filter((x) => x.permit === permit && x.subNotation === subNotation);
  if (!cs.length) return null;
  const withUpper = cs.filter((c) => c.upper != null);
  const c = withUpper.length
    ? withUpper.reduce((a, b) => (b.upper < a.upper ? b : a))
    : cs[0];
  const u = prettyUnit(c.unit);
  const parts = [];
  if (c.upper != null && c.upper !== "") parts.push(`≤ ${fmtNum(c.upper)}`);
  if (c.lower != null && c.lower !== "") parts.push(`≥ ${fmtNum(c.lower)}`);
  if (!parts.length) return null;
  const distinct = new Set(cs.map((x) => `${x.upper}|${x.lower}`)).size;
  const note = distinct > 1 ? ` <span class="muted">(tightest of ${distinct} outlets)</span>` : "";
  return parts.join(" ") + (u ? " " + u : "") + note;
}

const drawnBounds = [];
// Set while re-rendering a view whose frame must be preserved (a view-switch with a catchment focused).
// Every fitBounds in the render paths honours it, so switching view keeps the current zoom and centre.
let suppressFit = false;

function render() {
  clearLayers();
  syncFarmDisplayControl();
  syncFarmPanes();
  drawnBounds.length = 0;
  for (const k in permitMarkers) delete permitMarkers[k];
  const sub = DB.substances.find((s) => s.notation === currentSubstance);
  const subLbl = sub ? sub.label : "all substances";
  const tables = document.getElementById("tables");
  tables.innerHTML = "";
  if (currentView === "farming") { renderFarming(tables); return; }

  // Catchment scope. A focused water body restricts every regulated slice to the outlets (and WINEP
  // action sites) inside its ring — by point-in-polygon, exactly as the map markers are. With nothing
  // focused (ring null) these are the whole-catchment collections unchanged.
  const ring = scopeRing();
  const dischargePoints = ring ? DB.dischargePoints.filter(inScope) : DB.dischargePoints;
  const scopedDp = ring ? new Set(dischargePoints.map((d) => d.iri)) : null;   // outlet iris in scope
  const atScopedDp = (x) => !ring || scopedDp.has(x.dp);                       // conditions/breaches carry .dp
  const actionsInScope = ring ? DB.actions.filter(inScope) : DB.actions;
  const scopedAct = ring ? new Set(actionsInScope.map((a) => a.iri)) : null;
  const atScopedAct = (l) => !ring || scopedAct.has(l.action);
  const conditionsCurrent = ring ? DB.conditionsCurrent.filter(atScopedDp) : DB.conditionsCurrent;
  const conditionsAll = ring ? DB.conditions.filter(atScopedDp) : DB.conditions;
  const breachesAll = ring ? DB.breaches.filter(atScopedDp) : DB.breaches;
  const proposedAll = ring ? DB.proposed.filter(atScopedAct) : DB.proposed;

  // Data slices with substance filter applied where relevant. "Current limits" are the latest
  // permit version's conditions only; the full history stays available for the expandable views.
  const breaches = breachesAll.filter((b) => matchSub(b.subNotation));
  const conditions = conditionsCurrent.filter((c) => matchSub(c.subNotation));
  const proposedForSub = proposedAll.filter((l) => matchSub(l.subNotation));
  const condByPermit = groupBy(conditionsCurrent, "permit"); // current limits per permit
  const condHistByPermit = groupBy(conditionsAll, "permit"); // all versions per permit
  const breachesByPermit = groupBy(breachesAll, "permit");
  // Breaches grouped by the discharge point they occurred at. This is now a DIRECT key — the breach
  // names its outlet, because its condition does. It used to be keyed on (permit, sampling point),
  // which put every breach of a permit onto every outlet sharing that point.
  const breachAtDp = groupBy(breachesAll, "dp");
  const dpByPermit = groupBy(dischargePoints, "permit");
  const limByAction = groupBy(proposedAll, "action");
  // (permit|version|outlet|substance) tuples that were actually breached, to flag them in the history.
  // The OUTLET belongs in the key: without it, a breach at one of a permit's outlets flagged the same
  // substance at all of them.
  const breachedKey = new Set(breachesAll.map((b) => `${b.permit}|${b.version}|${b.dp}|${b.subNotation}`));

  // Which actions are relevant to the substance
  const actionIdsWithSub = new Set(proposedForSub.map((l) => l.action));

  const show = { breach: false, discharge: false, action: false, sfi: false, sampling: false };

  if (currentView === "measured") {
    show.sampling = true;
    renderMeasured(tables);
    // The challenges cross-table, scoped to the selected water body if there is one. Appended after
    // the sampling tables because it answers a different question: not "what was measured" but
    // "what was blamed".
    wbCrosstab(tables);
  } else if (currentView === "regulated") {
    // ONE view over the regulated world: the limits, the breaches of them, and the works that will
    // change them. They used to be three tabs, which made them read as three subjects; they are one
    // subject — a permit — seen at three points in time (in force / failed / proposed).
    show.breach = show.discharge = show.action = true;
    // FOUR states, not three. "Not assessed" is its own colour because it is its own fact: the store
    // holds the permit's limit and could not test it — no dated version to attribute the sample to, no
    // sampling point, or no sample ever taken. Painting those blue alongside the outlets we DID examine
    // and cleared would be the single most damaging thing this app could do, because "no breach found"
    // is what a regulator reads as "compliant".
    setLegend([
      { c: "#1d70b8", t: "Discharge point — assessed, no breach" },
      { c: "#d4351c", t: "current breach" },
      { c: "#f47738", t: "past breach" },
      { c: "#8a94a0", t: "not assessed — we could not judge it" },
      { c: "#4c2c92", t: "WINEP action site (future works)" },
    ]);
    // The outlet/coordinate counts are the points.html argument, stated where the map is drawn: the
    // markers below are FEWER than the outlets they stand for, because outlets share a coordinate.
    // With a catchment focused these become that sub-catchment's counts (dischargePoints is scoped).
    const drawnDps = dischargePoints.filter((d) => d.lat != null);
    const coords = new Set(drawnDps.map((d) => `${d.lat},${d.lon}`)).size;
    document.getElementById("lede").innerHTML = scopeNote() + LEDE.regulated({
      // catchment facts (whole catchment, or the focused sub-catchment when one is selected)
      permits: new Set(dischargePoints.map((d) => d.permit)).size,
      permitsWithLimits: new Set(conditionsCurrent.map((c) => c.permit)).size,
      outlets: dischargePoints.length,               // what EXISTS — 122, not what we can draw
      mapped: drawnDps.length,                       // what we can DRAW — 115
      unmapped: dischargePoints.length - drawnDps.length,
      coords,
      // substance-scoped facts (`conditions` and `breaches` are already filtered by matchSub)
      permitsForSub: new Set(conditions.map((c) => c.permit)).size,
      outletsForSub: new Set(conditions.map((c) => c.dp)).size,
      limits: conditions.length,
      notAssessed: conditions.filter((c) => !c.assessed).length,
      breaches: breaches.length,
      current: breaches.filter((b) => b.current).length,
      works: currentSubstance ? actionIdsWithSub.size : actionsInScope.length,
      substance: !!currentSubstance,
    }, subLbl);
    // Substance chosen -> the limit/proposal story for it; otherwise the permit register at large.
    tables.append(
      currentSubstance
        ? substanceStoryTable(conditions, proposedForSub, dpByPermit)
        : permitTable(conditions, dpByPermit, condByPermit, condHistByPermit, breachedKey, breachesByPermit),
      breachTable(breaches),
      actionTable(currentSubstance ? actionsInScope.filter((a) => actionIdsWithSub.has(a.iri)) : actionsInScope, limByAction),
    );
  }

  // Draw layers. A discharge point is a single marker coloured by its worst status.
  //
  // "none" means ASSESSED AND CLEAN. An outlet we could not judge at all gets "unknown" and its own
  // grey, because those are different facts and only one of them is good news.
  //
  // "Unknown" means EVERY condition went unexamined — not merely one of them. Permit 040111 holds four
  // conditions of which three WERE assessed and passed; calling the whole outlet unknown throws away
  // three real results to flag one gap, which overstates our ignorance as badly as the old code
  // overstated our knowledge. The gap is not hidden: the popup lists each condition's own status, and
  // the permit table carries a separate "not assessed" count beside the breach count.
  const STATUS_COLOR = { current: "#d4351c", past: "#f47738", none: "#1d70b8", unknown: "#8a94a0" };
  const STATUS_R = { current: 8, past: 7, none: 6, unknown: 6 };
  if (show.discharge) {
    const order = { unknown: 0, none: 1, past: 2, current: 3 }; // draw current breaches on top
    const items = dischargePoints
      .filter((dp) => dp.lat != null)
      .map((dp) => {
        const allConds = DB.condByDp[dp.iri] || [];               // THIS outlet's limits, not the permit's
        const allBr = breachAtDp[dp.iri] || [];                   // breaches AT this outlet
        const fConds = allConds.filter((c) => matchSub(c.subNotation));
        const fBr = allBr.filter((b) => matchSub(b.subNotation));
        const scope = currentSubstance ? fConds : allConds;
        const status = fBr.some((b) => b.current) ? "current"
          : fBr.length ? "past"
          : !scope.length || scope.every((c) => !c.assessed) ? "unknown"
          : "none";
        return { dp, allConds, allBr, fConds, fBr, status };
      })
      // in a substance view, only show discharge points relevant to the substance
      .filter((x) => !currentSubstance || x.fConds.length || x.fBr.length)
      .sort((a, b) => order[a.status] - order[b.status]);
    for (const x of items) {
      const cur = x.allBr.filter((b) => b.current);
      const past = x.allBr.filter((b) => !b.current);
      const mk = circle(x.dp.lat, x.dp.lon,
        dot(STATUS_COLOR[x.status], STATUS_R[x.status], x.status === "unknown" ? 0.55 : 0.9),
        dischargePopup(x.dp, x.allConds, cur, past));
      mk.addTo(layers.dischargePoints);
      (permitMarkers[x.dp.permit] ||= []).push(mk);
      drawnBounds.push([x.dp.lat, x.dp.lon]);
    }
    layers.dischargePoints.addTo(map);
  }
  if (show.action) {
    for (const k in actionMarkers) delete actionMarkers[k];
    for (const a of actionsInScope) {
      if (a.lat == null) continue;
      if (currentSubstance && !actionIdsWithSub.has(a.iri)) continue;
      const on = a.iri === selectedAction;
      const mk = circle(a.lat, a.lon, dot(on ? "#c9aaff" : "#4c2c92", on ? 9 : 7, on ? 1 : 0.85), actionPopup(a, limByAction[a.iri] || []));
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
    for (const k in spMarkers) delete spMarkers[k];   // markers are rebuilt every render
    for (const s of measuredPoints()) {
      // Only reachable with the toggle on: a point kept on the map despite having no series for the
      // chosen substance. Drawn hollow and faint so it reads as "here, but not measured for this" —
      // if the escape hatch drew it like the rest, showing the gaps would just mean hiding them
      // among the points that do have data.
      const unsampled = currentSubstance && !s.dets.has(currentSubstance);
      const style = unsampled
        ? { radius: 5, color: s.family.color, weight: 1, opacity: 0.55, dashArray: "2,2",
            fillColor: s.family.color, fillOpacity: 0.08 }   // hollow: present, but not measured for this
        : dot(s.family.color, s.permit ? 6 : 7, 0.9);
      const mk = circle(s.lat, s.lon, style, samplingPointPopup(s));
      // Chart on click ONLY when a substance is chosen. With "All substances" there is nothing to
      // chart yet — the popup lists what this point holds and the choice is the user's, not a
      // constant's. The popup's links do the charting; see bindPopupDets.
      mk.on("click", () => {
        if (currentSubstance) openChart(currentSubstance, s.id, s.permit, [s.lat, s.lon]);
      });
      mk.on("popupopen", (e) => bindPopupDets(e.popup, s));
      mk.addTo(layers.samplingPoints);
      spMarkers[s.id] = mk;      // so the table can open the same popup the map does
      drawnBounds.push([s.lat, s.lon]);
    }
    layers.samplingPoints.addTo(map);
  }
  if (show.sfi) {
    for (const s of DB.sfi)
      L.circleMarker([s.lat, s.lon], dot("#00703c", 5, 0.8)).bindPopup(`<b>SFI option</b><br>${esc(s.code)}`).addTo(layers.sfi);
    layers.sfi.addTo(map);
  }

  // Frame whatever we drew (WINEP actions spread across the whole Wessex region,
  // well beyond the Poole Harbour catchment outline). Skipped on a frame-preserving view-switch.
  if (!suppressFit) {
    if (drawnBounds.length) {
      map.fitBounds(L.latLngBounds(drawnBounds).pad(0.15), { maxZoom: 12 });
    } else if (catchmentLayer) {
      map.fitBounds(catchmentLayer.getBounds());
    }
  }
  renderTabs();                        // reconcile the side-panel tab bar with the current selections
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

// ---------------------------------------------------------------------------
// Sortable, paginated tables
// ---------------------------------------------------------------------------
const PAGE_SIZE = 10;

// A cell's raw sort value. Prefer an explicit `data-sort` — the rendered text is for humans
// ("Jan 2021 – Mar 2021", "£1,234/yr", "≤ 20 mg/l") and sorting it as text would be wrong.
const rawKey = (td) =>
  !td ? "" : String(td.dataset.sort != null ? td.dataset.sort : td.textContent).trim();

// WHETHER A COLUMN IS NUMERIC IS A PROPERTY OF THE COLUMN, NOT OF EACH CELL. Decide it once, over
// every value in the column, and coerce the whole column the same way.
//
// Per-cell coercion looks reasonable and is wrong here. The permit column holds "400505", "040136"
// and "EPRBB3593EG": judged cell by cell, the first parses as a number and the other two do not, so
// one column ends up holding two incomparable kinds of key and the order comes out neither numeric
// nor alphabetical. Permit refs are IDENTIFIERS that merely look like digits — "040136" is a name,
// not forty thousand — and the giveaway is the leading zero. So a column counts as numeric only if
// EVERY value in it is a bare, unpadded number; one identifier anywhere makes the whole column text.
const NUMERIC = /^-?(0|[1-9]\d*)(\.\d+)?$/;
function columnKeys(groups, col) {
  const raw = groups.map((g) => rawKey(g[0].cells[col]).replace(/,/g, ""));
  const numeric = raw.every((s) => s === "" || NUMERIC.test(s));
  // Empty cells ("—", "TBC", no limit) have no value to compare, so they always sink to the bottom
  // whichever way the column is sorted — an absent value is not a small one.
  return raw.map((s) => (s === "" ? null : numeric ? Number(s) : s.toLowerCase()));
}

// Wraps a table in sorting + paging. Returns the element to hand to card().
//
// Rows travel in GROUPS. An expandable summary row OWNS the hidden detail row that follows it, so a
// sort or a page turn has to move the pair as one unit — otherwise a permit's limits would end up
// filed under a different permit. Everything below therefore operates on groups, never on <tr>s.
function pagedTable(head, rowsHtml, { pageSize = PAGE_SIZE, sortCol = null, sortDir = 1 } = {}) {
  const t = tableEl(head, rowsHtml);
  const wrap = document.createElement("div");
  wrap.className = "tbl-wrap";
  wrap.append(t);

  const tbody = t.tBodies[0];
  const groups = [];
  for (const tr of [...tbody.rows]) {
    if (tr.classList.contains("expand-row") && groups.length) groups[groups.length - 1].push(tr);
    else groups.push([tr]);
  }
  // A single row (or none) has nothing to sort and nothing to page. Bail — but note that this used to
  // bail at `< 2` AFTER the docs had promised "every table is paginated and sortable", and the same
  // early return also skipped the SORT handlers, so any table under two rows was silently neither.
  if (groups.length < 2) return wrap;

  const pager = document.createElement("div");
  pager.className = "pager";
  // A table that fits on one page needs no pager, but it still needs its column headers to sort.
  if (groups.length > pageSize) wrap.append(pager);

  let view = groups.slice();   // groups in current sort order
  let page = 0;
  let sort = { col: sortCol, dir: sortDir };

  const pageCount = () => Math.max(1, Math.ceil(view.length / pageSize));

  function draw() {
    page = Math.min(page, pageCount() - 1);
    tbody.replaceChildren(...view.slice(page * pageSize, (page + 1) * pageSize).flat());

    // Header state: which column is sorted, and which way.
    [...t.tHead.rows[0].cells].forEach((th, i) => {
      th.classList.toggle("sorted", sort.col === i);
      th.classList.toggle("asc", sort.col === i && sort.dir === 1);
      th.classList.toggle("desc", sort.col === i && sort.dir === -1);
    });

    // « ‹ 1 2 3 › » — page numbers windowed around the current page so a 40-page table does not
    // grow a 40-button pager.
    const n = pageCount();
    const from = Math.max(0, Math.min(page - 2, n - 5)), to = Math.min(n, from + 5);
    const btn = (label, go, cls = "", on = true) =>
      `<button class="pg ${cls}" ${on ? `data-go="${go}"` : "disabled"}>${label}</button>`;
    pager.innerHTML =
      btn("«", 0, "", page > 0) + btn("‹", page - 1, "", page > 0) +
      Array.from({ length: to - from }, (_, k) => from + k)
        .map((i) => `<button class="pg num${i === page ? " on" : ""}" data-go="${i}">${i + 1}</button>`).join("") +
      btn("›", page + 1, "", page < n - 1) + btn("»", n - 1, "", page < n - 1) +
      `<span class="pg-info">${page * pageSize + 1}–${Math.min((page + 1) * pageSize, view.length)} of ${view.length}</span>`;
  }

  function applySort() {
    if (sort.col == null) { view = groups.slice(); return; }
    const keys = columnKeys(groups, sort.col);
    const idx = groups.map((_, i) => i);
    idx.sort((i, j) => {
      const a = keys[i], b = keys[j];
      if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;  // empties last, always
      const c = typeof a === "number" ? a - b : String(a).localeCompare(String(b));
      return sort.dir * c;
    });
    view = idx.map((i) => groups[i]);
  }

  [...t.tHead.rows[0].cells].forEach((th, i) => {
    th.classList.add("sortable");
    th.addEventListener("click", () => {
      sort = { col: i, dir: sort.col === i ? -sort.dir : 1 };
      page = 0;                       // a re-sort makes the old page number meaningless
      applySort();
      draw();
    });
  });

  pager.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-go]");
    if (!b) return;
    page = Number(b.dataset.go);
    draw();
  });

  // Reveal the page holding a given row — so clicking a map marker can still bring its table row
  // into view even when that row is paged out of sight.
  wrap.revealRow = (match) => {
    const i = view.findIndex((g) => match(g[0]));
    if (i < 0) return null;
    page = Math.floor(i / pageSize);
    draw();
    return view[i][0];
  };

  applySort();
  draw();
  return wrap;
}

// Which LIMIT the breach failed, e.g. "≤ 20 mg/l (95th percentile)". A breach of an absolute maximum
// and a breach of a 95th-percentile limit are very different claims — the first is one bad sample, the
// second a year-long statistical failure — and they breach the same CONDITION, so without naming the
// limit the table would show them identically. reg:breachesLimit is what makes them distinguishable;
// hover gives the register's own words and the arithmetic in full.
function breachBound(b) {
  if (b.limit == null && !b.statLabel) return "—";
  const cmp = b.stat === "minimum" ? "≥" : "≤";
  const val = b.limit != null ? `${cmp} ${fmtNum(b.limit)}${b.unit ? " " + prettyUnit(b.unit) : ""}` : "";
  const stat = b.statLabel ? `<span class="stat">${esc(b.statLabel)}</span>` : "";
  const tip = [b.limStmt, b.assessment].filter(Boolean).join(" — ");
  const title = tip ? ` title="${esc(tip)}"` : "";
  return `<span${title}>${val}${val && stat ? " " : ""}${stat}</span>`;
}

function breachTable(all) {
  // The permit filter comes from a discharge point's popup ("12 past breaches — show in the table").
  const breaches = breachPermit ? all.filter((b) => b.permit === breachPermit) : all;
  const chip = breachPermit
    ? ` <span class="count">— permit <b>${esc(permitRef(breachPermit))}</b> only ` +
      `<span class="sub-link" onclick="clearBreachFilter()">show all ${all.length} ✕</span></span>`
    : "";
  if (!breaches.length) {
    const e = card("Breaches" + chip, "0", emptyBody("No breaches for this selection."), PQ.breaches(currentSubstance));
    e.id = "breach-card";
    return e;
  }
  // current first, then most-recently-started
  // data-sort: the rendered text is human ("Jan 2021 – Mar 2021", "≤ 20 mg/l (95th percentile)") and
  // sorting it as text would order breaches alphabetically by month name. Sort on the real values.
  // A breach judged against an UNDATED permit version is a weaker claim than one judged against a
  // dated window — we know what the permit required but not the period it required it for — so it says
  // so, on its own row, rather than sitting silently among the others as though it were the same thing.
  const UNDATED = '<span class="pill unknown" title="Judged against a permit version the register does not date. The permit has exactly one version, so WHICH limits applied is not in doubt — only the period it ran between.">undated version</span>';
  const rows = [...breaches].sort((a, b) => (b.current - a.current) || (a.from < b.from ? 1 : -1)).map((b) => `
    <tr>
      <td data-sort="${Date.parse(b.from) || 0}">${breachPeriod(b)}</td>
      <td>${subLink(b.subLabel, b.subNotation, b.sp, b.permit)}</td>
      <td data-sort="${b.limit != null ? b.limit : ""}">${breachBound(b)}</td>
      <td>${permitLink(b.permit)}</td>
      <td class="mono">${esc(b.outlet || "—")}</td>
      <td class="ctr" data-sort="${b.current ? 0 : 1}">${b.current ? '<span class="pill current">current</span>' : '<span class="pill past">past</span>'}${b.undated ? " " + UNDATED : ""}</td>
      <td>${wqeLink(b.sp)}</td>
    </tr>`).join("");
  const nUndated = breaches.filter((b) => b.undated).length;
  const note = nUndated
    ? ` <span class="count">— ${nUndated} judged against an undated permit version</span>` : "";
  const c = card("Breaches" + chip + note, breaches.length,
    pagedTable(["Period", "Substance", "Limit breached", "Permit", "Outlet", "Status|c", "Sampling point (WQE)"], rows),
    PQ.breaches(currentSubstance));
  c.id = "breach-card";
  return c;
}

function permitTable(conditions, dpByPermit, condByPermit, condHistByPermit, breachedKey, breachesByPermit) {
  const permits = [...new Set(conditions.map((c) => c.permit))].sort();
  if (!permits.length) return card("Permits &amp; limits", "0", emptyBody("No permits for this selection."), PQ.permits(currentSubstance));
  const rows = permits.map((p, i) => {
    const cur = (condByPermit[p] || []); // current-version conditions only
    const dps = dpByPermit[p] || [];
    const sp = dps.map((d) => d.sp).filter(Boolean)[0] || null;
    const nB = (breachesByPermit[p] || []).length;
    const nUn = cur.filter((c) => !c.assessed).length;
    // The two numbers that must never be conflated: how many of this permit's limits we FAILED, and
    // how many we never got to TEST. A table that shows only the first reads an untested permit as a
    // clean one.
    const judged = nB
      ? `<span class="pill current">${nB} breach${nB === 1 ? "" : "es"}</span>`
      : (cur.length && nUn < cur.length ? '<span class="pill ok">no breach</span>' : "—");
    const untested = nUn
      ? `<span class="pill unknown" title="${esc(nUn + " of this permit's " + cur.length + " current limits could not be assessed — see the expanded rows")}">${nUn} not assessed</span>`
      : "—";
    return `<tr class="expandable" data-row="${i}"><td data-sort="${esc(permitRef(p))}"><span class="caret">▸</span> ${permitLink(p)}
          <span style="color:#777"> v${DB.currentVersion[p] ?? "?"}</span></td>
        <td data-sort="${cur.length}">${cur.length} current limit${cur.length === 1 ? "" : "s"}</td><td>${dps.length}</td>
        <td class="ctr" data-sort="${nB}">${judged}</td>
        <td class="ctr" data-sort="${nUn}">${untested}</td>
        <td>${wqeLink(sp)}</td></tr>
      <tr class="expand-row hidden" data-exp="${i}"><td colspan="6"><div class="expand-inner"></div></td></tr>`;
  }).join("");
  const c = card("Permits &amp; limits", permits.length,
    pagedTable(["Permit", "Current limits", "Discharge points", "Breaches|c", "Not assessed|c", "Monitored at"], rows),
    PQ.permits(currentSubstance));
  wireExpand(c, permits, (p) => permitDetail(p, condByPermit, condHistByPermit, breachedKey, dpByPermit));
  return c;
}

// Expandable detail: current limits BY OUTLET, then the full version history with breached rows
// flagged. The outlet column is not decoration — it is the grain the register sets limits at, and
// without it permit 042116 appears to hold three contradictory BOD limits.
function permitDetail(p, condByPermit, condHistByPermit, breachedKey, dpByPermit) {
  const spOfDp = {};
  for (const d of (dpByPermit || {})[p] || []) spOfDp[d.iri] = d.sp;
  const byOutlet = (a, b) => String(a.outlet).localeCompare(String(b.outlet))
    || a.subLabel.localeCompare(b.subLabel);
  const cur = (condByPermit[p] || []).slice().sort(byOutlet);
  const hist = (condHistByPermit[p] || []).slice().sort((a, b) =>
    (Number(b.version) - Number(a.version)) || byOutlet(a, b));
  const breachedSub = new Set(
    (DB.breaches || []).filter((b) => b.permit === p).map((b) => `${b.dp}|${b.subNotation}`));

  // Both nested tables are paginated and sortable in their own right — they have to be, now that a
  // permit's limits are per-outlet: 042451 holds 14 outlets and 043091 dozens of conditions.
  const curTbl = pagedTable(["Outlet", "Substance", "Limit|r", "Unit", "Status|c"],
    cur.map((c) => `<tr>
      <td class="mono" data-sort="${esc(c.outlet || "")}">${esc(c.outlet || "—")}</td>
      <td>${subLink(c.subLabel, c.subNotation, spOfDp[c.dp], p)}</td>
      <td class="num" data-sort="${c.upper != null ? c.upper : ""}" title="${esc((c.stmts || []).join("; "))}">${limitBounds(c)}</td>
      <td>${prettyUnit(c.unit)}</td>
      <td class="ctr" data-sort="${c.assessed ? 1 : 0}">${condStatus(c, breachedSub.has(`${c.dp}|${c.subNotation}`))}</td></tr>`).join(""));

  const histTbl = pagedTable(["Version", "Outlet", "Substance", "Limit|r", "Unit", "|c"],
    hist.map((c) => {
      const breached = breachedKey.has(`${p}|${c.version}|${c.dp}|${c.subNotation}`);
      return `<tr${c.current ? ' style="font-weight:600"' : ""}>
        <td class="mono" data-sort="${Number(c.version) || 0}">v${c.version}${c.current ? " (current)" : ""}</td>
        <td class="mono" data-sort="${esc(c.outlet || "")}">${esc(c.outlet || "—")}</td>
        <td>${esc(c.subLabel)}</td>
        <td class="num" data-sort="${c.upper != null ? c.upper : ""}" title="${esc((c.stmts || []).join("; "))}">${limitBounds(c)}</td>
        <td>${prettyUnit(c.unit)}</td>
        <td class="ctr" data-sort="${breached ? 0 : 1}">${breached ? '<span class="pill current">breached</span>' : ""}</td></tr>`;
    }).join(""));

  const nVer = new Set(hist.map((c) => c.version)).size;
  const out = [subHead("Current limits, by outlet"), curTbl];
  if (nVer > 1) {
    const h = subHead(`Limit history — ${nVer} versions`);
    h.style.cssText = "padding:12px 0 8px";
    out.push(h, histTbl);
  }
  return out;
}

// Keyed by (OUTLET, substance) — because that is where a limit lives. A WINEP action, by contrast,
// names only a PERMIT: it does not say which of the permit's outlets its proposed limit lands on. So
// one action can pair with several current limits, and where those limits DIFFER (permit 042116's BOD
// is 15 mg/l at one effluent and 25 at another) the table shows a row for each. That is not clutter —
// it is a question the WINEP sheet leaves unanswered, made visible rather than settled by a coin toss.
function substanceStoryTable(conditions, proposed, dpByPermit) {
  const curByKey = {};
  for (const c of conditions) curByKey[`${c.dp} ${c.subNotation}`] = c;
  const futByPermit = {};
  for (const l of proposed) {
    const a = DB.actions.find((x) => x.iri === l.action);
    if (a && a.permit) (futByPermit[`${a.permit} ${l.subNotation}`] ||= []).push({ a, l });
  }
  const spOfDp = {};
  for (const p in dpByPermit) for (const d of dpByPermit[p]) spOfDp[d.iri] = d.sp;

  const rows = [];
  const paired = new Set();
  for (const c of conditions) {
    const pk = `${c.permit} ${c.subNotation}`;
    const futs = futByPermit[pk] || [null];
    if (futs[0]) paired.add(pk);
    for (const f of futs) rows.push({ p: c.permit, cur: c, sp: spOfDp[c.dp], ver: c.version, f });
  }
  // a proposed limit for a substance the permit does not currently regulate: a genuinely NEW limit
  for (const k in futByPermit) {
    if (paired.has(k)) continue;
    const permit = k.split(" ")[0];
    const sp = (dpByPermit[permit] || []).map((d) => d.sp).filter(Boolean)[0] || null;
    for (const f of futByPermit[k])
      rows.push({ p: permit, cur: null, sp, ver: DB.currentVersion[permit], f });
  }
  if (!rows.length) return card("Current limits &amp; future works", "0", emptyBody("Nothing for this substance."), PQ.substanceStory(currentSubstance));

  // current-bearing rows first (loosest first, so the worst offenders lead), then future-only
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
      <td data-sort="${esc(permitRef(p))}">${permitLink(p)}${ver != null ? ` <span style="color:#777">v${ver}</span>` : ""}</td>
      <td class="mono">${cur ? esc(cur.outlet || "—") : "—"}</td>
      <td>${subLink(subLabel, subNotation, sp, p)}</td>
      <td class="num" data-sort="${cur && cur.upper != null ? cur.upper : ""}" title="${esc(cur ? (cur.stmts || []).join("; ") : "")}">${limit}</td>
      <td>${cur ? prettyUnit(cur.unit) : ""}</td>
      <td class="ctr">${cur ? condStatus(cur, false) : "—"}</td>
      <td>${wqeLink(sp)}</td>
      <td class="mono">${f ? esc(f.a.id) : "—"}</td>
      <td>${f ? esc(f.a.label) : "—"}</td>
      <td data-sort="${f && f.a.completion ? Date.parse(f.a.completion) || "" : ""}">${f ? (fmtDate(f.a.completion) || "TBC") : "—"}</td>
      <td>${proposedCell}</td>
    </tr>`;
  }).join("");

  return card('Current limits &amp; future works <span class="count">— click a substance for its time-series chart</span>',
    `${conditions.length} current · ${proposed.length} proposed`,
    pagedTable(["Permit", "Outlet", "Substance", "Limit|r", "Unit", "Assessment|c", "Monitored at",
                "Action", "Name", "Completion", "Proposed limit"], body),
    PQ.substanceStory(currentSubstance));
}

function actionTable(actions, limByAction) {
  // No WINEP action survives the current substance / catchment filter — say so, as the breach table
  // does, rather than drawing an empty grid that reads as "nothing was looked for".
  if (!actions.length)
    return card("WINEP Actions", "0", emptyBody("No actions for this selection."), PQ.actions(currentSubstance));
  // Sort ONCE and use this order for both the rows (data-row=i) and the wireExpand keys, so each
  // expansion resolves to the action on its own row (previously rows were sorted but the keys were
  // not, cross-wiring one action's row to another action's limits).
  const sorted = [...actions].sort((a, b) => (a.completion < b.completion ? -1 : 1));
  const rows = sorted.map((a, i) => {
    const nLimits = limitLines(limByAction[a.iri] || []).length; // individual limit lines (matches the expansion)
    return `<tr class="expandable action-row${a.iri === selectedAction ? " sel" : ""}" data-row="${i}" data-action="${esc(a.iri)}">
        <td><span class="caret">▸</span> <span class="sub-link mono">${esc(a.id)}</span></td>
        <td>${esc(a.party)}</td><td>${esc(a.label)}</td>
        <td data-sort="${a.completion ? Date.parse(a.completion) || "" : ""}">${fmtDate(a.completion) || "TBC"}</td>
        <td class="mono">${permitRef(a.permit)}</td><td class="num">${nLimits}</td></tr>
      <tr class="expand-row hidden" data-exp="${i}"><td colspan="6"><div class="expand-inner"></div></td></tr>`;
  }).join("");
  const tbl = pagedTable(["Action", "Party", "Name", "Completion", "Target permit", "Limits|r"], rows, { sortCol: 3 });
  // The map's WINEP markers focus their table row, and that row may be paged out of sight — so the
  // table hands render() a way to turn to the page holding it (see focusAction).
  actionTableEl = tbl;
  const c = card("WINEP Actions", actions.length, tbl, PQ.actions(currentSubstance));
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
    return `${a?.desc ? `<p style="color:#505a5f">${esc(a.desc)}</p>` : ""}${hint}${body.outerHTML}`;
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
// Pick a substance and the map shows only the points that are actually sampled for it — drawing all
// 161 and letting you click one at a time to find the dozen with a nitrate series was not a view, it
// was a search.
//
// But a point with no ammonia record is NOT a point with no ammonia; it is a point nobody sampled for
// it, and a filter that simply deletes it turns an absence of measurement into an absence of
// pollution. That is the same mistake the breach pipeline shipped twice. So the filter is allowed
// here on two conditions, and it is only honest while both hold:
//
//   1. The absence must be KNOWN, not merely unrecorded. `dets` comes from a sweep of the archive
//      itself, and regulation_to_db.py refuses to build unless every point in the register was swept
//      — so "not in dets" means the archive was asked and holds nothing, never "we never looked".
//   2. What is hidden must still be SAID. renderMeasured reports the count of points removed and
//      offers to put them back; it never just shows a smaller map.

// The escape hatch behind condition (2): "not sampled for this" is itself a finding about the
// monitoring network, and someone looking for the gaps must be able to see them.
let showUnsampled = false;

// A focused catchment scopes the sampling network to the points inside it (map AND table), the same
// point-in-polygon test the farming map and SFI Summary use. `inScope` returns true when nothing is focused.
const inScope = (o) => { const r = scopeRing(); return !r || (o.lat != null && pointInRing(o.lat, o.lon, r)); };
const measuredPoints = () =>
  (currentSubstance && !showUnsampled
    ? DB.samplingPoints.filter((s) => s.dets.has(currentSubstance))
    : DB.samplingPoints).filter(inScope);

// The points the filter is currently removing — what renderMeasured has to account for.
const unsampledPoints = () =>
  currentSubstance ? DB.samplingPoints.filter((s) => !s.dets.has(currentSubstance) && inScope(s)) : [];

// The determinands a point is sampled for, as the dropdown would name them — its own menu, in the
// dropdown's order so the two never disagree about what a substance is called.
const detsAt = (s) => DB.substances.filter((x) => s.dets.has(x.notation));

// Make the popup's determinand menu live. Bound on popupopen because Leaflet builds the popup's DOM
// only when it is shown, so there is nothing to attach to before that. Charts the determinand WITHOUT
// touching currentSubstance: you asked to see one series at this point, not to filter the whole map
// down to it — that is what the dropdown is for, and doing both from one click would silently hide
// every point that lacks the substance you just glanced at.
function bindPopupDets(popup, s) {
  popup.getElement()?.querySelectorAll("[data-det]").forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault();
      openChart(a.dataset.det, s.id, s.permit, [s.lat, s.lon]);
    };
  });
}

function samplingPointPopup(s) {
  const permitted = s.permit
    ? `<div class="pp-row">Permit <span class="mono">${esc(permitRef(s.permit))}</span> discharges here` +
      ` <span class="muted">— this point is in the regulated world too</span></div>`
    : `<div class="pp-row muted">No permit discharges here — measured only, never regulated.</div>`;

  // NO SUBSTANCE CHOSEN. There is no honest single answer here: a time series is OF a determinand, and
  // "all substances" is not one. This used to quietly substitute ammoniacal nitrogen — the dropdown
  // said "All substances" and the app charted one, picked by a constant. So instead the point names
  // what it actually holds and lets you choose; that IS "all substances", per point.
  if (!currentSubstance) {
    const opts = detsAt(s);
    const menu = opts.length
      ? `<div class="pp-row">Sampled here — pick a series:</div>
         <div class="pp-dets">${opts.map((x) =>
           `<a href="#" class="sub-link" data-det="${esc(x.notation)}">${esc(x.label)}</a>`).join("")}</div>`
      : `<div class="pp-row muted">The archive holds no series here for any determinand this ` +
        `register governs.</div>`;
    return `<b>${esc(s.label)}</b><br>
      <span class="mono">${esc(s.id)}</span>
      <div class="pp-row"><span class="dot" style="background:${s.family.color}"></span>${esc(s.type || "untyped")}</div>
      ${s.status && s.status !== "OPEN" ? `<div class="pp-row muted">Status: ${esc(s.status)}</div>` : ""}
      ${permitted}
      ${menu}
      <a href="${WQE}${encodeURIComponent(s.id)}" target="_blank" rel="noopener">Water Quality Explorer ↗</a>`;
  }

  const subLbl = (DB.substances.find((x) => x.notation === currentSubstance) || {}).label || currentSubstance;
  // Say which of the two it is, rather than leaving the chart to break the news after the click.
  const series = s.dets.has(currentSubstance)
    ? `<div class="pp-row"><span class="sub-link">Charting ${esc(subLbl)}…</span></div>`
    : `<div class="pp-row muted">The archive holds no <b>${esc(subLbl)}</b> series here — this point ` +
      `is not sampled for it.</div>`;
  return `<b>${esc(s.label)}</b><br>
    <span class="mono">${esc(s.id)}</span>
    <div class="pp-row"><span class="dot" style="background:${s.family.color}"></span>${esc(s.type || "untyped")}</div>
    ${s.status && s.status !== "OPEN" ? `<div class="pp-row muted">Status: ${esc(s.status)}</div>` : ""}
    ${permitted}
    ${series}
    <a href="${WQE}${encodeURIComponent(s.id)}" target="_blank" rel="noopener">Water Quality Explorer ↗</a>`;
}

function renderMeasured(tables) {
  const pts = measuredPoints();
  // The sampling network, scoped to the focused sub-catchment when one is selected (else the whole
  // catchment). Counts below read against this base so the lede matches the map and table.
  const base = DB.samplingPoints.filter(inScope);
  // Counted over the (scoped) catchment, not the drawn set: this clause is the standing fact that many
  // of the EA's points belong to no permit, and it does not change because you picked a determinand.
  const unpermitted = base.filter((s) => !s.permit);
  const hidden = unsampledPoints();
  // No substance chosen means no series to name. The lede used to name ammoniacal nitrogen here, which
  // was the app quietly answering a question the user had explicitly declined to ask.
  const subLbl = currentSubstance
    ? (DB.substances.find((s) => s.notation === currentSubstance) || {}).label || currentSubstance
    : "";

  // Legend: one entry per family PRESENT, in the palette's fixed slot order — the order is the
  // colourblind-safety mechanism, so it never re-sorts by count.
  const present = [...SP_FAMILIES, OTHER_FAMILY].filter((f) => pts.some((s) => s.family.key === f.key));
  setLegend(present.map((f) => ({ c: f.color, t: `${f.label} (${pts.filter((s) => s.family.key === f.key).length})` })));

  document.getElementById("lede").innerHTML = scopeNote() + LEDE.measured({
    catchment: base.length,
    shown: base.length - hidden.length,   // what the filter WOULD leave, toggle aside
    unpermitted: unpermitted.length,
    hidden: hidden.length,
  }, subLbl);
  const toggle = document.getElementById("toggle-unsampled");
  if (toggle) toggle.onclick = (e) => { e.preventDefault(); showUnsampled = !showUnsampled; render(); };

  tables.append(measuredTable(pts));
}

// Every sampling point, with its EXACT archive type (the map colours by family, so the precise type
// has to be legible somewhere — colour is never the only encoding). Sorted with the unpermitted
// first: they are the ones the rest of this app cannot see.
function measuredTable(pts) {
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
    pagedTable(["Point", "Name", "What is sampled here", "Permit"], rows),
    PQ.samplingPoints(showUnsampled ? "" : currentSubstance));
  // Same gesture as the map: with a substance chosen, chart it. Without one there is nothing to chart,
  // so the row opens the point's own popup — the same menu the map offers — rather than charting a
  // determinand the user never picked.
  c.addEventListener("click", (e) => {
    const tr = e.target.closest(".sp-row");
    if (!tr) return;
    const s = DB.samplingPoints.find((x) => x.id === tr.dataset.sp);
    if (!s) return;
    if (currentSubstance) openChart(currentSubstance, s.id, s.permit, [s.lat, s.lon]);
    else spMarkers[s.id]?.openPopup();
  });
  return c;
}

// ---------------------------------------------------------------------------
// Farming view: application hulls on the map, a spider + pie for the selected one.
// ---------------------------------------------------------------------------
// Farming filter: does an application include an option of the given broader type; and the current
// application set after the Land "Option type" filter.
const appHasType = (iri, code) => (DB.optionsByApp[iri] || []).some((o) => o.broader === code);
// An application belongs to a focused catchment if any of its option parcels sits inside the ring.
const appInRing = (iri, ring) => (DB.optionsByApp[iri] || []).some((o) => o.parcels.some((p) => pointInRing(p.lat, p.lon, ring)));
const farmingApps = () => {
  const ring = scopeRing();
  const apps = currentOptionType ? DB.applications.filter((a) => appHasType(a.iri, currentOptionType)) : DB.applications;
  return ring ? apps.filter((a) => appInRing(a.iri, ring)) : apps;
};

// When a water-body catchment is focused, the farming map scopes to it: only parcels inside that body's
// ring are drawn, the same point-in-polygon test the SFI Summary tab aggregates with (sfiByCatchment).
// null (no focus) => the whole catchment, every parcel counts.
const scopeRing = () => (selectedWb ? (WB.get(selectedWb) || {}).ring || null : null);

// A banner for the lede telling the reader the map and tables are scoped to one water body, with a way
// out. Empty when nothing is focused. Counts in the lede below it are catchment-scoped to match.
const scopeNote = () => {
  const w = selectedWb && WB.get(selectedWb);
  return w
    ? `<div class="scope-note">Scoped to <b>${esc(w.label)}</b> — map and tables show this sub-catchment only.` +
      ` <button type="button" class="scope-clear" onclick="wbClearScope()">Show whole catchment</button></div>`
    : "";
};

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

  // What these agreements are modelled to remove, across whatever is currently in view. Scoped to the
  // substance filter when it names one the land side models; when it names a water-only substance we
  // say so outright rather than showing nitrogen and phosphorus as if they were the answer.
  const subs = currentSubstance
    ? (currentSubstance in DB.landSubstances ? [currentSubstance] : [])
    : Object.keys(DB.landSubstances);
  const totals = subs.map((s) => {
    const kg = apps.reduce((t, a) => t + ((a.impact || {})[s] || 0), 0);
    return `<span class="prog-chip removal-chip">${esc(DB.landSubstances[s])}: <b>${fmtKg(kg)}</b></span>`;
  }).join("");
  const sub = DB.substances.find((s) => s.notation === currentSubstance);
  const removalNote = currentSubstance && !subs.length
    ? ` The land side models <b>nitrogen</b> and <b>phosphorus</b> only, so it has nothing to say about ` +
      `<b>${esc(sub ? sub.label : currentSubstance)}</b> — the agreements below are shown unfiltered.`
    : ` Removal figures are <b>modelled</b> (FARMSCOPER), never measured.`;

  return `<b>Farming (SFI)</b> — ${apps.length} agreement${apps.length === 1 ? "" : "s"} ` +
    `paying farmers to cut diffuse pollution at source. Only <b>SFI Expanded Offer</b> rates are published in our ` +
    `source, so <b>SFI 2023</b> agreements show as <b>unpriced</b>.${filterNote}${removalNote} Click an application to value it.` +
    `<span class="prog-summary">${chips}${totals}</span>`;
}

function renderFarming(tables) {
  document.getElementById("lede").innerHTML = scopeNote() + farmingLede();
  if (farmDisplay === "options") renderOptionPoints();
  else renderApplicationHulls();

  tables.append(applicationsTable(), optionsTable(selectedApp), sfiCatchmentCard());
  renderTabs();                        // reconcile the side-panel tab bar with the current selections
}

// APPLICATIONS view: one polygon per agreement (convex hull of its option points), plus a spider of
// the selected agreement's options. This is the original farming map.
function renderApplicationHulls() {
  setLegend([
    { c: PROGRAMMES["SFI EO"].color, t: "SFI Expanded Offer — priced" },
    { c: PROGRAMMES["SFI 23"].color, t: "SFI 2023 — rates unavailable" },
    { c: "#f47738", t: "selected application" },
  ]);

  // Every application as a polygon (convex hull of all its option multipoints, or a small square when
  // degenerate), coloured by its programme. Applications overlap heavily, so hovering lists ALL of
  // them under the cursor and clicking opens a picker rather than selecting the topmost outright.
  for (const k in appShapes) delete appShapes[k];
  for (const k in appRings) delete appRings[k];
  hideOverlapTip();
  const wbRing = scopeRing();          // focused catchment: hull only its in-scope option points
  const bounds = [];
  for (const app of farmingApps()) {
    let pts = (DB.optionsByApp[app.iri] || []).flatMap((o) => o.points);
    if (wbRing) pts = pts.filter((p) => pointInRing(p[0], p[1], wbRing));
    if (!pts.length) continue;
    const sel = app.iri === selectedApp;
    const prog = progOf(app);
    const col = sel ? "#f47738" : prog.color;
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
  }
  // The side panel (app tab and any others) is drawn by renderTabs() at the end of renderFarming —
  // this function only draws the map layers.

  if (!suppressFit) {
    if (bounds.length) map.fitBounds(L.latLngBounds(bounds).pad(0.25), { maxZoom: 14 });
    else {
      const all = DB.sfiOptions.flatMap((o) => o.points);
      if (all.length) map.fitBounds(L.latLngBounds(all).pad(0.1));
    }
  }
}

// OPTIONS view: every option's individual parcels plotted as points, coloured by option group. There
// is no "selected application" here — you interrogate the map directly, clicking a point (or a cluster
// of overlapping points) to see the option(s) behind it. Respects the option-group filter so ticking
// "Soil management" shows only those parcels.
function renderOptionPoints() {
  // No "selected application" in this mode, but any catchment / point tabs stay open — the tab bar is
  // reconciled by renderTabs() at the end of renderFarming.
  const shownGroups = new Map();     // broader code -> { code, label, count } for the legend
  plottedOptionDots = [];
  const bounds = [];
  // Only agreements in view (option-group / substance filters), then only options of the filtered
  // group when one is picked — so "Options" honours the same filters "Applications" does.
  const wbRing = scopeRing();          // focused catchment: plot only its in-scope parcels
  const appSet = new Set(farmingApps().map((a) => a.iri));
  for (const o of DB.sfiOptions) {
    if (!appSet.has(o.app)) continue;
    if (currentOptionType && o.broader !== currentOptionType) continue;
    const parcels = wbRing ? o.parcels.filter((p) => pointInRing(p.lat, p.lon, wbRing)) : o.parcels;
    if (!parcels.length) continue;
    const col = groupColor(o.broader);
    const g = shownGroups.get(o.broader) || { code: o.broader, label: o.broaderLabel, count: 0 };
    for (const p of parcels) {
      // stroke off (weight 0): at this count a 1px ring per dot is visual noise and costs paint time.
      L.circleMarker([p.lat, p.lon], { renderer: optionRenderer, radius: 3, weight: 0, fillColor: col, fillOpacity: 0.85 })
        .addTo(layers.optionPoints);
      plottedOptionDots.push({ lat: p.lat, lon: p.lon, opt: o });
      bounds.push([p.lat, p.lon]);
    }
    g.count += parcels.length;
    shownGroups.set(o.broader, g);
  }
  layers.optionPoints.addTo(map);

  // Legend: the groups actually on the map, biggest first, capped so a 20-group legend doesn't wrap
  // into a wall. A dimmed tail entry names the remainder rather than dropping it silently.
  const groups = [...shownGroups.values()].sort((a, b) => b.count - a.count);
  const shown = groups.slice(0, 10);
  const items = shown.map((g) => ({ c: groupColor(g.code), t: `${g.label} (${fmtNum(g.count)})` }));
  if (groups.length > shown.length)
    items.push({ c: "#5b6472", t: `+${groups.length - shown.length} more group${groups.length - shown.length === 1 ? "" : "s"}` });
  setLegend(items);

  if (!suppressFit && bounds.length) map.fitBounds(L.latLngBounds(bounds).pad(0.1));
}

// Click on the option layer: gather EVERY plotted parcel within a few pixels of the click — the dots
// stack (73% of parcels share a location with another option), so the one you clicked is rarely alone
// — dedupe to distinct options, and show them all in a single floater. This is the point-cloud analogue
// of the application picker (openPicker); it means no option is unreachable under another.
// Returns true if it found and showed at least one option, so the map handler knows a dot took the
// click (and should not then open the sub-catchment underneath).
function openOptionPicker(latlng) {
  const R = 8;                        // pixels: how close counts as "under the click"
  const c = map.latLngToLayerPoint(latlng);
  const seen = new Map();             // option IRI -> option (dedupes an option's own nearby parcels)
  for (const d of plottedOptionDots) {
    if (map.latLngToLayerPoint([d.lat, d.lon]).distanceTo(c) <= R) seen.set(d.opt.iri, d.opt);
  }
  const opts = [...seen.values()].sort((a, b) => (b.cost || 0) - (a.cost || 0));
  if (!opts.length) return false;

  const extent = (o) => o.ha > 0 ? `${fmtNum(Math.round(o.ha))} ha`
    : o.m > 0 ? `${fmtNum(Math.round(o.m))} m` : "—";
  const MAX = 12;                     // a pathological cluster shouldn't produce an endless popup
  const cards = opts.slice(0, MAX).map((o) => {
    const app = DB.appById[o.app];
    const costHtml = o.cost != null ? `<b>${fmtGBP(o.cost)}</b>/yr` : `<span class="muted">unpriced</span>`;
    return `<div class="opt-card">
      <div class="opt-head">${swatch(groupColor(o.broader))}<b>${esc(o.broaderLabel)}</b>` +
      ` <span class="mono">${esc(o.code)}</span></div>` +
      (o.def ? `<div class="opt-def">${esc(o.def)}</div>` : "") +
      `<div class="opt-meta">` +
      `<span>${costHtml}</span>` +
      `<span>${esc(extent(o))}</span>` +
      `<span class="opt-app">agreement <span class="sub-link pick-opt-app" data-app="${esc(o.app)}">${esc(app ? app.id : "")}</span></span>` +
      `</div></div>`;
  }).join("");
  const more = opts.length > MAX ? `<div class="pick-head">+${opts.length - MAX} more here</div>` : "";

  const div = document.createElement("div");
  div.className = "app-picker opt-picker";
  div.innerHTML = `<div class="pick-head">${opts.length} option${opts.length === 1 ? "" : "s"} here</div>${cards}${more}`;
  // Click the agreement id to jump to it in the Applications view (where the cost pie and spider live).
  div.querySelectorAll(".pick-opt-app").forEach((el) => el.addEventListener("click", () => {
    map.closePopup();
    farmDisplay = "applications";
    selectApp(el.dataset.app);
  }));
  L.popup({ className: "picker-popup", maxHeight: 300 }).setLatLng(latlng).setContent(div).openOn(map);
  return true;
}

// The visible (toggled-on) water body whose catchment polygon contains the click. Prefers the
// smallest, since a few sub-catchments nest (Piddle Upper/Lower, Frome u/s & d/s) and the smaller is
// the more specific — and the one drawn on top.
function waterbodyAt(latlng) {
  let best = null;
  for (const w of WB.values())
    if (w.on && pointInRing(latlng.lat, latlng.lng, w.ring) && (!best || w.area < best.area)) best = w;
  return best ? best.notation : null;
}

// Options view makes both the dots and the water bodies non-interactive at the DOM level, so the map
// click handler alone decides what a click means (dot, then sub-catchment). Everywhere else the water
// bodies keep their own click behaviour.
function syncFarmPanes() {
  const wbPane = map.getPane("waterbodies");
  if (wbPane) wbPane.style.pointerEvents = (currentView === "farming" && farmDisplay === "options") ? "none" : "auto";
}

// The modelled-removal cell. The graph stores a NEGATIVE kg/yr (a reduction in loss); under a column
// headed "Removed" we show the magnitude, because "−5,344 removed" reads as an increase. The sign is
// not lost — the removals chart plots the store's own negative value against a zero baseline, and the
// column header carries the (Modelled) tag that explains what kind of number this is.
//
// A dash here is NOT zero. It means the application has no FARMSCOPER-modelled option at all, which is
// a different claim from "modelled, and removes nothing" — so it sorts as unknown (-1), below every
// real figure, rather than tying with a genuine zero.
function removalCell(a, sub) {
  const kg = (a.impact || {})[sub];
  if (kg == null) return `<td class="num" data-sort="-1"><span class="muted" title="No FARMSCOPER-modelled option in this agreement">—</span></td>`;
  return `<td class="num modelled" data-sort="${-kg}" title="Modelled by FARMSCOPER: an estimated rate per hectare of intervention x this agreement's mapped area. Not measured.">` +
    `${fmtNum(Math.round(-kg))}<span class="unit"> kg/yr</span></td>`;
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
      <td class="num" data-sort="${prog.priced ? a.total : -1}">${cost}</td>
      ${removalCell(a, "9686")}
      ${removalCell(a, "0348")}
    </tr>`;
  }).join("");
  const hint = selectedApp
    ? '<span class="count">— <span class="sub-link clear-sel" title="Reset focus back to the filters">✕ clear selection</span></span>'
    : '<span class="count">— click one to value it</span>';
  // The two removal columns are flagged in the header itself, not only in a footnote: a reader who
  // sorts by "Nitrogen Removed" and screenshots the top row must carry the word "modelled" with them.
  const modelled = (name) => `${name} Removed <span class="modelled-tag" title="Modelled by FARMSCOPER — an estimated per-hectare rate applied to mapped area. NOT measured, and not verified against water quality observations.">(Modelled)</span>`;
  const c = card(`Applications ${hint}`, apps.length,
    pagedTable(["Application", "Programme", "Options|r", "Total cost|r", `${modelled("Nitrogen")}|r`, `${modelled("Phosphorus")}|r`], rows),
    PQ.applications());
  c.append(modelledCaveat());
  c.addEventListener("click", (e) => {
    if (e.target.closest(".clear-sel")) { clearAppFocus(); return; }
    const tr = e.target.closest(".app-row");
    if (tr) selectApp(tr.dataset.app);
  });
  return c;
}

// The standing caveat under the applications table. This is deliberately not a tooltip-only note: the
// removal figures are the only numbers in this app that no one has ever measured, and they sit in the
// same row as a payment that is a real contractual rate. A reader is entitled to know which is which.
function modelledCaveat() {
  const d = document.createElement("p");
  d.className = "table-caveat";
  d.innerHTML =
    `<b>Nitrogen &amp; Phosphorus Removed are modelled, not measured.</b> They come from FARMSCOPER, ` +
    `which estimates a per-hectare change in pollutant loss for each intervention; the store multiplies ` +
    `that rate by the option's mapped area. No observation anywhere in this catchment has been used to ` +
    `check them, and what "per hectare per year" means at source is still being validated ` +
    `(<code>ttl/sfi/TODO.md</code>). Treat them as relative scale and ranking — not as a reportable load. ` +
    `A <span class="muted">—</span> means the agreement has no modelled option, which is not the same as zero.`;
  return d;
}

// Options for the selected application, grouped by broader concept (expandable to the components).
function optionsTable(appIri) {
  // No provenance link on the placeholder. The card shows NO rows until an application is picked, and
  // the query it used to offer returned all 1,115 options — a "◈ SPARQL" link that reproduces 1,115
  // rows for a table showing 0 is precisely the drift these links exist to disprove. A link is a
  // promise that the query answers the question the table answers; with no application selected there
  // is no question yet.
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
      <td class="num" data-sort="${g.total || -1}">${groupCost(g)}</td>
    </tr>
    <tr class="expand-row hidden" data-exp="${i}"><td colspan="3"><div class="expand-inner"></div></td></tr>`).join("");
  const c = card(`Options <span class="count">— ${esc(DB.appById[appIri]?.id || "")}</span>`, nOpts,
    pagedTable(["Group", "Options|r", "Cost|r"], rows), PQ.sfiOptions(appIri));
  wireExpand(c, groups, (g) => tableEl(["Option", "Description", "Cost|r"],
    g.items.slice().sort((a, b) => (b.cost || 0) - (a.cost || 0)).map((o) =>
      `<tr><td class="mono">${esc(o.code)}</td><td>${esc(o.def || "—")}</td>` +
      `<td class="num">${o.cost != null ? fmtGBP(o.cost) + "/yr" : '<span class="muted">unpriced</span>'}</td></tr>`).join("")).outerHTML);
  return c;
}

// ---------------------------------------------------------------------------
// SFI by option group, scoped to a sub-catchment (or the whole catchment)
// ---------------------------------------------------------------------------
// "How much hedgerow / soil management / organic farming is in this water body?" Attributes each
// option's MULTIPOINT parcels to the selected water-body catchment by point-in-polygon, exactly as
// ttl/sfi/waterbody_reconcile.py does offline, and aggregates by broader group.
//
// Per option group, scoped to a sub-catchment (null => whole catchment): the EXACT extent under each
// action type, from the per-parcel area/length (SFIParcels in sfi.ttl). Each parcel's hectares (or metres)
// belong to exactly one water body, so an in-scope parcel contributes its FULL own extent -- no
// apportionment, which the summed per-option area would have forced (wrong by ~25% on a water body).
//
// EXTENT IS PER ACTION TYPE AND IS NOT SUMMED into a catchment total. A field commonly carries several
// actions (73% of parcels here) and the source even records different areas for different actions at
// the same point, so "total area under actions" double-counts and is not a valid answer -- and a
// distinct land footprint is not recoverable from this data. So the card shows each group's extent and
// deliberately reports NO extent total. Payment (money) and parcel counts do sum; extent does not.
function sfiByCatchment(notation) {
  const w = notation ? WB.get(notation) : null;
  const ring = w ? w.ring : null;                    // null ring => whole catchment, every parcel counts
  const byGroup = {};
  for (const o of DB.sfiOptions) {
    const inParcels = ring ? o.parcels.filter((p) => pointInRing(p.lat, p.lon, ring)) : o.parcels;
    if (!inParcels.length) continue;
    const g = (byGroup[o.broader] ||= { code: o.broader, label: o.broaderLabel, parcels: 0, payment: 0, ha: 0, m: 0 });
    g.parcels += inParcels.length;
    // Payment is per-option, so apportion it by the option's in-scope parcel share (a field carries a
    // payment per action, not per land, so this does sum cleanly to the option and application totals).
    if (o.cost != null) g.payment += o.cost * (inParcels.length / o.parcels.length);
    for (const p of inParcels) {
      if (p.area != null) g.ha += p.area;            // EXACT: this parcel's own hectares
      if (p.mtl != null) g.m += p.mtl;               // EXACT: this parcel's own metres
    }
  }
  return Object.values(byGroup).sort((a, b) => b.parcels - a.parcels || b.payment - a.payment);
}

// Per-group MODELLED removal (kg/yr) for a sub-catchment, apportioned to it by the option's in-scope
// parcel share — the same apportionment payment uses, so it sums cleanly across sub-catchments. The
// per-option removal is a whole-option figure (FARMSCOPER rate × area), hence the apportionment.
function groupRemovalsForCatchment(notation, sub) {
  const w = notation ? WB.get(notation) : null;
  const ring = w ? w.ring : null;
  const byGroup = {};
  for (const o of DB.sfiOptions) {
    const kg = (DB.optionImpacts[o.iri] || {})[sub];
    if (kg == null) continue;
    const inParcels = ring ? o.parcels.filter((p) => pointInRing(p.lat, p.lon, ring)) : o.parcels;
    if (!inParcels.length) continue;
    (byGroup[o.broader] ||= { code: o.broader, label: o.broaderLabel, value: 0 })
      .value += kg * (inParcels.length / o.parcels.length);
  }
  return Object.values(byGroup).sort((a, b) => a.value - b.value);  // most negative (biggest cut) first
}

// The "Catchment: SFI Summary" tab body — the selected sub-catchment's SFI as cost pie / count bars /
// modelled removals, mirroring the application chart but scoped to the catchment. Shares farmChartMode
// with the application chart (one Cost/Count/Removals toggle idiom across both).
function renderSfiCatchmentChart(notation) {
  const w = notation ? WB.get(notation) : null;
  const scope = w ? esc(w.label) : "the whole catchment";
  const groups = sfiByCatchment(notation);
  const costSlices = groups.filter((g) => g.payment > 0)
    .map((g) => ({ code: g.code, label: g.label, value: g.payment }))
    .sort((a, b) => b.value - a.value);
  const total = costSlices.reduce((s, g) => s + g.value, 0);
  const hasPrices = total > 0;
  // in-scope options with no published rate, for the pie/count note
  const ring = w ? w.ring : null;
  let unpriced = 0;
  for (const o of DB.sfiOptions) {
    if (o.cost != null) continue;
    const inParcels = ring ? o.parcels.filter((p) => pointInRing(p.lat, p.lon, ring)) : o.parcels;
    if (inParcels.length) unpriced++;
  }

  let mode = farmChartMode;
  if (mode === "value" && !hasPrices) mode = "count";
  const btn = (m, lbl) => `<button class="${mode === m ? "on" : ""}" onclick="setFarmChartMode('${m}')">${lbl}</button>`;
  const toggle = `<div class="chart-toggle">${hasPrices ? btn("value", "Cost") : ""}${btn("count", "Count")}${btn("removal", "Removals")}</div>`;

  // Count is the per-group table (parcels / extent / payment) — it carries the exact numbers the pie
  // and removal bars abstract away, and is where the old folded table's content now lives.
  const body = mode === "value" ? renderPie(costSlices, total, unpriced, null)
    : mode === "removal" ? renderCatchmentRemovals(notation, scope)
    : sfiCatchmentTable(notation);

  const head = `<p class="chart-scope">SFI in <b>${scope}</b> · ${groups.length} option group${groups.length === 1 ? "" : "s"}</p>`;
  document.getElementById("chart-body").innerHTML = head + toggle + body;
}

// Removals for a sub-catchment: one stacked bar per land substance (nitrogen, phosphorus), honouring
// the substance filter, drawn by the same removalChart the application view uses.
function renderCatchmentRemovals(notation, scope) {
  const subs = currentSubstance
    ? (currentSubstance in DB.landSubstances ? [currentSubstance] : [])
    : Object.keys(DB.landSubstances);
  const bars = subs.map((sub) => {
    const groups = groupRemovalsForCatchment(notation, sub);
    return { sub, label: DB.landSubstances[sub] || sub, groups, total: groups.reduce((s, g) => s + g.value, 0) };
  }).filter((b) => b.total);
  if (!bars.length) {
    const filtered = currentSubstance && !(currentSubstance in DB.landSubstances);
    return filtered
      ? `<p class="chart-note">No modelled land impact for this substance in ${scope} — FARMSCOPER models nitrogen and phosphorus only.</p>`
      : `<p class="chart-note">No modelled removal in ${scope} — none of the options here carries a FARMSCOPER-modelled impact.</p>`;
  }
  const seen = {};
  for (const b of bars) for (const g of b.groups) seen[g.code] = g;
  const legend = Object.values(seen).map((g) =>
    `<div class="pie-leg"><span class="dot" style="background:${groupColor(g.code)}"></span>` +
    `<span class="pie-name">${esc(g.label)} <span class="mono">${esc(g.code)}</span></span></div>`).join("");
  return removalChart(bars) +
    `<p class="chart-note modelled-note"><b>Modelled, not measured.</b> FARMSCOPER's per-hectare change in ` +
    `loss × mapped area, apportioned to ${scope} by each option's in-scope parcel share. Negative = kept out ` +
    `of the catchment. Both bars share one kg/yr axis, so phosphorus reads small <i>by mass</i>.</p>` +
    `<div class="pie-legend">${legend}</div>`;
}

// The whole-catchment SFI overview, shown below the map in the farming view. Per-sub-catchment
// figures no longer live here — clicking a waterbody catchment scopes them into the "Catchment: SFI
// Summary" tab in the side panel (see renderSfiCatchmentChart / sfiCatchmentTable). This card is
// always the whole catchment, so it stays a stable reference the scoped tab reads against.
function sfiCatchmentCard() {
  const groups = sfiByCatchment(null);
  const totParcels = groups.reduce((s, g) => s + g.parcels, 0);
  const totPay = groups.reduce((s, g) => s + g.payment, 0);
  const anyPriced = groups.some((g) => g.payment > 0);

  // Extent in the group's OWN unit: hectares for area actions, metres for linear ones. Exact for the
  // scope. No total is offered (see note) — the value here is per action type only.
  const extentCell = (g) => {
    if (g.ha > 0) return `<td class="num" data-sort="${g.ha}">${fmtNum(Math.round(g.ha))}<span class="unit"> ha</span></td>`;
    if (g.m > 0) return `<td class="num" data-sort="${g.m}">${fmtNum(Math.round(g.m))}<span class="unit"> m</span></td>`;
    return `<td class="num" data-sort="-1"><span class="muted">—</span></td>`;
  };

  const rows = groups.map((g) => `
    <tr>
      <td>${swatch(groupColor(g.code))}${esc(g.label)} <span class="mono">${esc(g.code)}</span></td>
      <td class="num">${fmtNum(g.parcels)}</td>
      ${extentCell(g)}
      <td class="num" data-sort="${g.payment > 0 ? g.payment : -1}">${g.payment > 0 ? fmtGBP(Math.round(g.payment)) + "/yr" : '<span class="muted">unpriced</span>'}</td>
    </tr>`).join("") +
    // Extent is deliberately NOT totalled — the cell is a dash. Parcels and payment do sum.
    `<tr class="tot-row"><td><b>Total</b></td><td class="num"><b>${fmtNum(totParcels)}</b></td>` +
    `<td class="num"><span class="muted" title="Extent is per action type and cannot be summed — a field carries several actions">—</span></td>` +
    `<td class="num"><b>${anyPriced ? fmtGBP(Math.round(totPay)) + "/yr" : "—"}</b></td></tr>`;

  const hint = ` <span class="count">— whole catchment · turn on Waterbody Catchments and click a sub-catchment for its own breakdown in the side panel</span>`;

  const c = document.createElement("div");
  c.className = "card";
  c.id = "sfi-catchment";
  c.innerHTML = `<h2>Farming by option group${hint} <span class="count">${groups.length}</span></h2>`;
  c.append(tableEl(["Option group", "Parcels|r", "Extent|r", "Annual payment|r"], rows));

  const note = document.createElement("p");
  note.className = "table-caveat";
  note.innerHTML =
    `<b>Extent</b> is each action's own area (ha) or length (m), taken from the per-parcel figures in ` +
    `the source, so it is <b>exact</b> — a parcel's hectares belong to one water ` +
    `body, not split by apportionment. It is shown <b>per action type and is not totalled</b>: a field ` +
    `usually carries several actions (73% here do), and the source even records different areas for ` +
    `different actions on the same point, so a single "area under improvement" figure would double-count ` +
    `and is not a valid answer — a distinct land footprint is not recoverable from this data. ` +
    `<b>Parcels</b> is the count of that action's mapped points here; <b>payment</b> is apportioned by ` +
    `parcel share. Both of those do sum. This is not a count of whole agreements — a straddling option ` +
    `is split between sub-catchments.`;
  c.append(note);
  return c;
}

// Expandable rows: clicking a summary row toggles the detail row and lazily fills it.
// `build` may return an HTML string OR a list of Nodes. Nodes matter: a detail table built with
// pagedTable() carries its own sort + pager listeners, and stringifying it through innerHTML would
// throw them away — which is exactly why the nested tables used to be neither sortable nor paged while
// the docs claimed every table was both. Permit 042451 alone now has 14 outlets, so these are not
// small tables any more.
function wireExpand(cardEl, keys, build) {
  cardEl.addEventListener("click", (e) => {
    const tr = e.target.closest(".expandable");
    if (!tr) return;
    const i = tr.dataset.row;
    const exp = cardEl.querySelector(`.expand-row[data-exp="${i}"]`);
    const inner = exp.querySelector(".expand-inner");
    const opening = exp.classList.contains("hidden");
    if (opening && !inner.dataset.filled) {
      const out = build(keys[i]);
      if (typeof out === "string") inner.innerHTML = out;
      else inner.replaceChildren(...[].concat(out));
      inner.dataset.filled = "1";
    }
    exp.classList.toggle("hidden");
    tr.classList.toggle("open");
  });
}
// A small heading for a nested detail block.
function subHead(text) {
  const d = document.createElement("div");
  d.style.cssText = "padding:2px 0 8px";
  d.innerHTML = `<b style="color:#505a5f">${text}</b>`;
  return d;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function setView(v) {
  // With a catchment focused the map is framed on it; switching view should not re-fit and zoom back
  // out. Capture the frame and restore it after render() (which re-fits to the new view's data).
  const keep = selectedWb ? { c: map.getCenter(), z: map.getZoom() } : null;
  currentView = v;
  document.querySelectorAll("#views button").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
  // Tabs persist across views (the whole point of the tab bar), so leaving farming no longer clears the
  // application selection or closes the panel — the SFI Application tab stays open and switchable.
  if (v !== "regulated") { selectedAction = null; breachPermit = null; } // regulated map/table focuses only
  suppressFit = !!keep;                // a focused catchment: don't re-fit, keep the current frame
  render();
  suppressFit = false;
  if (keep) map.setView(keep.c, keep.z, { animate: false });
}

async function main() {
  initMap();
  const status = document.getElementById("status");
  try {
    await loadAll();
    // Designations (SSSI/SAC/SPA) build into the legend; the Waterbody Catchments <select> populates
    // its own element up in the Water super-box, so the two are independent. The ordering below is now
    // incidental, not a dependency.
    await loadDesignations();
    // Fire-and-forget from here: if catchment.ttl is missing from the store the control simply never
    // appears and every other view still works. The .catch is not decoration — an unhandled rejection
    // in a detached promise is invisible, so a failed build would leave no error and no clue.
    loadWaterbodies().catch((err) => {
      window.__wbErr = `${err.name}: ${err.message}`;
      console.error("Water body layer failed to build:", err);
    });
    // A count is only a fact if it is a count of DISTINCT things. Every one of these rows comes back
    // from a query that OPTIONALly joins several things to one subject, and any subject carrying two of
    // an OPTIONAL's object silently doubles. That has now happened twice — once when discharge points
    // gained a second geometry, once when breaches gained a second rdfs:comment — and on both occasions
    // every row-count check still passed, because the table and its provenance query fanned out
    // together. Matching counts prove the two AGREE; they do not prove either is right. So assert the
    // shape here, against the subject IRI, which cannot fan out.
    const distinct = (rows, key) => new Set(rows.map((r) => r[key])).size;
    if (distinct(DB.breaches, "iri") !== DB.breaches.length)
      console.error(`FAN-OUT: ${DB.breaches.length} breach rows for ` +
        `${distinct(DB.breaches, "iri")} distinct breaches — a query is duplicating.`);
    if (distinct(DB.dischargePoints, "iri") !== DB.dischargePoints.length)
      console.error(`FAN-OUT: ${DB.dischargePoints.length} discharge-point rows for ` +
        `${distinct(DB.dischargePoints, "iri")} distinct outlets — a query is duplicating.`);
    status.textContent = `Loaded ${DB.breaches.length} breaches · ${DB.conditions.length} conditions · ${DB.actions.length} actions · ${DB.applications.length} farming applications (${DB.sfiOptions.length} options)`;
  } catch (err) {
    status.textContent = "Error: " + err.message;
    console.error(err);
    return;
  }
  document.querySelectorAll("#views button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
  // showUnsampled resets with the substance: it is an answer to "who is not measured for THIS one?",
  // so carrying it silently into the next substance would show a different question's answer.
  document.getElementById("substance").addEventListener("change", (e) => {
    currentSubstance = e.target.value; breachPermit = null; showUnsampled = false;
    // Choosing a substance the land side can actually answer for is a request to see the land answer.
    if (currentSubstance in DB.landSubstances) farmChartMode = "removal";
    render();
  });
  document.getElementById("optionType").addEventListener("change", (e) => {
    currentOptionType = e.target.value;
    // drop the selection if the filter no longer includes it
    if (currentOptionType && selectedApp && !appHasType(selectedApp, currentOptionType)) selectedApp = null;
    render();
  });
  document.getElementById("waterbody").addEventListener("change", onWaterbodySelect);
  // Tab bar: click a tab to switch, click its ✕ to close it. Delegated so it survives every rebuild.
  document.getElementById("chart-tabs").addEventListener("click", (e) => {
    const x = e.target.closest(".tab-close");
    if (x) { closeTab(x.dataset.close); return; }
    const t = e.target.closest(".chart-tab");
    if (t && t.dataset.tab !== activeTab) { activeTab = t.dataset.tab; renderTabBar(tabList()); renderActiveTabBody(); }
  });
  // Escape closes the active tab (its selection), falling back through whatever tabs remain.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.getElementById("chart").classList.contains("hidden")) closeActiveTab();
  });

  // Deep-link support: ?view=regulated|measured|farming & ?sub=<notation>. This is a proof of
  // concept, so the view keys simply say what the views are; nothing outside this repo links here.
  const params = new URLSearchParams(location.search);
  const sub = params.get("sub");
  if (sub && DB.substances.some((s) => s.notation === sub)) {
    currentSubstance = sub;
    document.getElementById("substance").value = sub;
  }
  const view = params.get("view");
  setView(["regulated", "measured", "farming"].includes(view) ? view : "regulated");
}

main();
