# Designations TODO — spatial queries & the RDF-native frontend

The designations are now RDF (GeoSPARQL features) so that the app can eventually run **entirely off
processed RDF** against an external triplestore (GraphDB over VPN) with a static frontend — no
bespoke server, no data plugins. This file tracks what that unlocks and what's left.

## 1. The spatial use case (why this is RDF)

The reason for RDF-ifying the polygons is to ask spatial questions end-to-end in SPARQL, e.g.
**"which discharges are within 200 m of a protected area and discharge nutrients?"** Discharge points
already carry `geo:asWKT`, so once designations are loaded this is a pure GeoSPARQL join. On a
GeoSPARQL engine (GraphDB with the plugin + spatial index enabled):

```sparql
PREFIX geo:   <http://www.opengis.net/ont/geosparql#>
PREFIX geof:  <http://www.opengis.net/def/function/geosparql/>
PREFIX uom:   <http://www.opengis.net/def/uom/OGC/1.0/>
PREFIX rdfs:  <http://www.w3.org/2000/01/rdf-schema#>
PREFIX skos:  <http://www.w3.org/2004/02/skos/core#>
PREFIX reg:   <http://environment.data.gov.uk/ontology/regulation/>
PREFIX water: <http://environment.data.gov.uk/ontology/water/>
PREFIX dn:    <http://environment.data.gov.uk/ontology/nature/>

SELECT DISTINCT ?permit ?site ?siteName ?substance (?d AS ?metres) WHERE {
  # protected areas
  ?site a dn:ProtectedSite ; rdfs:label ?siteName ;
        geo:hasGeometry/geo:asWKT ?siteWkt .
  # discharge points regulated for a nutrient (Ammoniacal N / Nitrate / Total N / Phosphorus …)
  ?permit a water:WaterDischargePermit ; reg:permitSite ?dp ; reg:hasCondition ?cond .
  ?dp geo:hasDefaultGeometry/geo:asWKT ?dpWkt .        # CRS84 — see the CRS note below
  ?cond reg:regulatedProperty ?sub . ?sub skos:notation ?substance ; skos:prefLabel ?subLabel .
  FILTER(CONTAINS(LCASE(?subLabel), "nitrogen") || CONTAINS(LCASE(?subLabel), "phosph")
         || CONTAINS(LCASE(?subLabel), "nitrate") || CONTAINS(LCASE(?subLabel), "ammonia"))
  # within 200 m
  BIND(geof:distance(?dpWkt, ?siteWkt, uom:metre) AS ?d)
  FILTER(?d <= 200)
}
```

> ⚠️ **The polygon form needs a full GeoSPARQL engine.** The in-memory pyoxigraph store ships only the
> basic `spargeo` geometry functions (tracking issue for full GeoSPARQL 1.1:
> [oxigraph#1560](https://github.com/oxigraph/oxigraph/issues/1560)). Verified against the bundled
> endpoint: `geof:distance` computes **only between two POINTs** — given a POLYGON (or MULTIPOINT)
> operand it returns *unbound*, so `FILTER(?d …)` drops every row — and `geof:buffer` is not
> implemented at all. Every protected site is a MULTIPOLYGON, so run this on **GraphDB** (GeoSPARQL
> plugin + spatial index) for accurate point-to-polygon **boundary** distance. Use the centroid form
> below to demo the same join locally.

### What this query used to do, and why it is worth reading about

Until the 2026-07-14 rebuild, the centroid version below **silently returned nothing** — and it did so
for a reason that had nothing to do with polygons or with oxigraph's limitations. It is the single most
instructive bug this repo has produced, so it is recorded rather than quietly fixed.

The discharge points were published with the CRS URI in the **wrong place**:

```
POINT(389950 93850) <http://www.opengis.net/def/crs/EPSG/0/27700>     ← what we emitted
<http://www.opengis.net/def/crs/EPSG/0/27700> POINT(389950 93850)     ← what GeoSPARQL requires
```

GeoSPARQL says a `wktLiteral` is "an optional URI identifying the coordinate reference system
**followed by**" the WKT. A *trailing* URI is not part of the literal any parser reads, so every engine
ignored it and fell back to the default CRS — **CRS84, degrees**. It then read the easting `389950` as
a longitude, computed a distance of roughly **5,400 km**, and `FILTER(?d <= 1000)` dropped every row.

The result was not an error. It was **an answer**: *"no discharges lie near any protected site."*
Reassuring, precise-looking, and completely false. A query that crashes is a nuisance; a query that
confidently reports nothing wrong is a hazard — and this one shipped in a `README` as a worked example.
It is the same failure this whole project is a warning about, committed by the project itself.

### The fix, and the CRS story as it now stands

Two changes, both in the shredders:

1. **The CRS URI goes first**, everywhere (`ttl/regulation/regulation_to_db.py`, `ttl/winep/winep.obda`,
   `ttl/sfi/sfi_to_db.py`). The store is now GeoSPARQL-conformant.
2. **Every point carries TWO geometries.** Fixing (1) alone is not enough: with a *correct* BNG CRS URI,
   oxigraph returns **unbound** rather than a wrong number — honest, but still no answer. `geof:`
   functions are defined over CRS84 and most engines will not reproject. So each feature now has:

   | geometry | CRS | what it is |
   | --- | --- | --- |
   | `#geography` | EPSG:27700 | the **source** — the EA's own numbers, verbatim |
   | `#geography-crs84` | CRS84 | **derived** by reprojection, and `geo:hasDefaultGeometry` |

   The CRS84 one is the default because it is the one a consumer can *compute* with. The BNG one is
   never derived from it; the direction of travel is always source → derived.

So the graph is now in **two** CRSs, deliberately and explicitly, and says which is which on every
geometry (`rdfs:comment`). The old claim that it was "one CRS across the whole graph" was simply wrong:
discharge, sampling and WINEP points were BNG; designations were CRS84; SFI options carried no CRS URI
at all.

### The version that runs on the bundled endpoint (centroid approximation)

Measure to each site's **centroid** — a point, which pyoxigraph *can* handle — instead of its boundary,
and take the discharge point's **CRS84** geometry so both operands are in the same CRS:

```sparql
  ?dp geo:hasDefaultGeometry/geo:asWKT ?dpWkt .        # CRS84, not the BNG #geography
  BIND(geof:distance(?dpWkt, geof:centroid(?siteWkt), uom:metre) AS ?d)
  FILTER(?d <= 1000)
```

Caveat, and it is a real one: this measures to the site **centre**, so it over-states distance for large
sites and can misrank them. Treat it as a rough "is anything nearby?" screen, not a metric. The worked
example is a good illustration of exactly that — permit **042451** (Ammoniacal Nitrogen as N) is **14 m**
from the *boundary* of Morden Bog & Hyde Heath SSSI (and the co-located Dorset Heaths SAC / Dorset
Heathlands SPA), but that heath's *centroid* is ~2.2 km away, so the centroid query instead surfaces
042451 against **East Coppice SSSI at ~926 m** — a farther, smaller neighbour. The permit shows up, which
is the point of the demo; the ranking is wrong, which is the point of the caveat. Use the GraphDB
boundary query for anything quantitative.

**To do:** pin the nutrient determinand set to an explicit codelist (rather than a label match), and
add this as a first-class app view once the frontend talks to GraphDB.

## 2. Geodesic vs planar distance — verify on GraphDB

The remaining CRS question is not *which* CRS (that is settled above) but what `geof:distance(…, …,
uom:metre)` **means** on geographic coordinates. We assume GraphDB returns **geodesic metres** on CRS84.
**Verify this once** against the target GraphDB: if it computes planar degrees and scales them, distances
will be wrong by a latitude-dependent factor. If it does, switch the analysis to the EPSG:27700
`#geography` — which is projected, in metres, and already published for exactly this reason.

## 3. Geometry precision

RDF geometry is simplified to ~2 m — near-full fidelity, fine for a 200 m threshold. If exact
boundaries matter later, drop the `RDF_SIMPLIFY` tolerance (raw is available). If the frontend starts
rendering these from SPARQL (below) and payloads hurt, add a coarse `defra-nature:displayGeometry`
alongside the analysis geometry rather than coarsening the analysis one.

## 4. Frontend → SPARQL (the RDF-native switch)

Today the frontend still **fetches `app/{sssi,sac,spa}.geojson`** to draw the underlays — the one
remaining non-RDF data path for the designations. To reach the fully static + GraphDB target:

- Render designations by **querying the SPARQL endpoint** for `?site rdfs:label ?name ; geo:asWKT
  ?wkt` per type, and drop the GeoJSON files.
- Make the frontend's `ENDPOINT` **configurable** (build-time or `?endpoint=`) so it can point at the
  GraphDB URL instead of the local `/sparql`.
- **CORS:** GraphDB must allow the static site's origin (or sit behind a same-origin reverse proxy).

## 5. Out of scope here, but blocks "pure static" overall

The substance time-series chart still calls the EA Water Quality Archive live through the server's
`/observations` proxy (mandatory `accept: x-jsonlines` header + Link pagination + CORS). A static
site can't proxy. Options: call the EA API directly if it permits browser CORS; a tiny serverless
proxy; or snapshot observations into RDF too (fully static, but the chart stops being "live"). Not a
designations problem — noted so the static-deployment picture is complete.

## 6. Vocabulary reuse

`defra-nature` mints our own `ProtectedSite` / designation concepts. If Natural England / EA publish
authoritative linked-data IRIs for these sites or designation types, prefer `owl:sameAs`-linking (or
reusing) them over the bespoke vocabulary.
