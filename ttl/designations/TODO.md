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
  ?dp geo:hasGeometry/geo:asWKT ?dpWkt .
  ?cond reg:regulatedProperty ?sub . ?sub skos:notation ?substance ; skos:prefLabel ?subLabel .
  FILTER(CONTAINS(LCASE(?subLabel), "nitrogen") || CONTAINS(LCASE(?subLabel), "phosph")
         || CONTAINS(LCASE(?subLabel), "nitrate") || CONTAINS(LCASE(?subLabel), "ammonia"))
  # within 200 m
  BIND(geof:distance(?dpWkt, ?siteWkt, uom:metre) AS ?d)
  FILTER(?d <= 200)
}
```

> ⚠️ **This query returns nothing on the bundled `/sparql` — it needs a full GeoSPARQL engine.**
> The in-memory pyoxigraph store ships only the basic `spargeo` geometry functions (tracking issue for
> full GeoSPARQL 1.1: [oxigraph#1560](https://github.com/oxigraph/oxigraph/issues/1560)). Verified
> against the bundled endpoint: `geof:distance` computes **only between two POINTs** — given a
> POLYGON (or MULTIPOINT) operand it returns *unbound*, so `FILTER(?d …)` drops every row — and
> `geof:buffer` is not implemented at all. (The `CRS84` prefix is fine; that is **not** the cause.)
> Every protected site is a MULTIPOLYGON, so this whole query is empty locally. Run it on **GraphDB**
> (GeoSPARQL plugin + spatial index) for accurate point-to-polygon **boundary** distance.

### A version that runs on the bundled endpoint (centroid approximation)

To demonstrate the same join in the app's SPARQL editor today, measure to each site's **centroid** —
a point, which pyoxigraph *can* handle — instead of its boundary. Swap only the distance `BIND`:

```sparql
  BIND(geof:distance(?dpWkt, geof:centroid(?siteWkt), uom:metre) AS ?d)
  FILTER(?d <= 1000)
```

Caveat: this measures to the site **centre**, so it over-states distance for large sites and can
misrank them — treat it as a rough "is anything nearby?" screen, not a metric. Worked example:
permit **042451** (Ammoniacal Nitrogen as N) is **86 m** from the *boundary* of Morden Bog & Hyde
Heath SSSI (and the co-located Dorset Heaths SAC / Dorset Heathlands SPA) — but that heath's
*centroid* is ~2.1 km away, so the centroid query instead surfaces 042451 at **948 m from East
Coppice SSSI**. The permit shows up (which is the point of the demo), just against a farther,
smaller neighbour. Use the GraphDB boundary query for anything quantitative.

**To do:** pin the nutrient determinand set to an explicit codelist (rather than a label match), and
add this as a first-class app view once the frontend talks to GraphDB.

## 2. CRS / geodesic-distance caveat — verify on GraphDB

Separate from the point-only limitation above (which is why the polygon query is empty *locally*),
this is the caveat for when it runs *on GraphDB*: everything is stored WGS84/CRS84 (one CRS across all
graphs) on the assumption that GraphDB's GeoSPARQL `geof:distance(…, …, uom:metre)` returns
**geodesic metres** on geographic coordinates. **Verify this once** against the target GraphDB. If it
turns out to compute planar degrees instead, the fallback is to also emit a projected **EPSG:27700
(British National Grid, metres)** geometry on both the designations *and* the discharge points and
compute distance there — the shredder already has the reprojection machinery.

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
