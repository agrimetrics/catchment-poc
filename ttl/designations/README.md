# Designations dataset — scope

The statutory conservation designations — **SSSI** (Sites of Special Scientific Interest), **SAC**
(Special Areas of Conservation) and **SPA** (Special Protection Areas) — clipped to the **Poole
Harbour Rivers** catchment and modelled as GeoSPARQL features. Built by
`designations_to_ttl.py` straight from the source GeoJSON (geopandas → WKT → rdflib):

```
python ttl/designations/designations_to_ttl.py
```

It emits **two** products from the same clip:

- **`../designations.ttl`** — the RDF graph (this is the portable, RDF-native representation loaded
  into the triplestore and deployable to GraphDB).
- **`app/{sssi,sac,spa}.geojson`** — small coarse GeoJSON the current frontend still fetches to draw
  the legend/map underlays (the display path, unchanged for now — see `TODO.md`).

Unlike the other pipelines there is no DuckDB/ontop step: the data is purely geometry + a name +
a code, so it goes directly to RDF.

Every source-data claim in this file is recomputed from the source layers in
[`notebooks/05_designations.ipynb`](../../notebooks/05_designations.ipynb).

## How the scope was whittled down (for convenience)

- **Clipped to the catchment.** The source layers are national. Only sites **intersecting** the
  Poole Harbour operational-catchment boundary (buffered ~3 km so edge sites are kept whole) survive.
- **One feature per named site.** The sources publish **one feature per polygon, not per site**, so a
  site is spread across many rows: the SPA layer's 195 features are **6** designated sites, and *Dorset
  Heathlands* alone accounts for **177** of them. Any "how many SPAs are here?" answered from the row
  count is out by a factor of ~30. Name and code are 1:1, so the pipeline dissolves multipart geometries
  by site name → **71 SSSI, 7 SAC, 3 SPA** (81 sites) after the catchment clip. The official code is
  retained (`ref_code` for SSSI, `sac_code`/`spa_code` for SAC/SPA).
- **Two resolutions.** The **RDF** keeps near-full geometry fidelity (~2 m simplification) for
  accurate spatial queries; the **display GeoJSON** stays coarse (~30 m) for a light browser payload.

## Model (GeoSPARQL)

- **Class** — `defra-nature:ProtectedSite` (defined in [`canwaf/ontology-work`](https://github.com/canwaf/ontology-work) → `defra-nature.ttl`; that repo is a **sibling**, not a directory of this one), a subclass of
  `defra-core:Site`, which is itself `⊆ geo:Feature` — so a protected site is a GeoSPARQL feature by
  subsumption, with no explicit `geo:Feature` typing on the instances.
- **Designation type** — a `defra-core:hasClassification` to a SKOS concept. The SSSI/SAC/SPA concept
  scheme is a **codelist in `raw_datasets/designation_types.ttl`** (reference data, *not* ontology —
  instances never belong in the ontology); the pipeline bakes it into `designations.ttl`, so the
  graph is self-contained (type labels included).

```turtle
<http://example.com/nature/sac/UK0019857> a defra-nature:ProtectedSite ;
    rdfs:label "Dorset Heaths" ;
    skos:notation "UK0019857" ;
    core:hasClassification <http://example.com/nature/designation/SAC> ;
    geo:hasGeometry <http://example.com/nature/sac/UK0019857#geometry> .
<http://example.com/nature/sac/UK0019857#geometry> a geo:Geometry ;
    geo:asWKT "<http://www.opengis.net/def/crs/OGC/1.3/CRS84> MULTIPOLYGON (((...)))"^^geo:wktLiteral .
```

- **Namespaces.** Instances (sites *and* the designation concepts) live under
  `http://example.com/nature/`; the ontology term `defra-nature:ProtectedSite` lives under
  `http://environment.data.gov.uk/ontology/nature/`. Different layers that happen to share the word
  "nature" — the same data-vs-ontology split as everywhere else (`http://example.com/sfi/…` instances
  vs `defra-farming:` classes).
- **IRIs.** Sites are `http://example.com/nature/{sssi|sac|spa}/{code}`; geometry is a `#geometry`
  fragment of the site IRI.
- **CRS.** WGS84 lon/lat with an explicit `CRS84` URI at the **start** of every `wktLiteral`, which is
  where GeoSPARQL requires it.

  > **The source declares a CRS its own coordinates contradict.** All three layers carry a `crs`
  > member — deprecated by RFC 7946, which specifies that GeoJSON coordinates are CRS84
  > longitude/latitude — and it names `urn:ogc:def:crs:EPSG::4326`. EPSG:4326 is **latitude-then-
  > longitude** by its own definition; the coordinates are longitude-then-latitude, e.g.
  > `[-1.167102, 50.852577]`. The declaration and the data disagree about axis order, and the pipeline
  > follows RFC 7946 (CRS84) — which means being right by *ignoring what the file says*.
  >
  > This matters precisely because mixing CRSs is otherwise routine: the EA publishes water data in
  > EPSG:27700 and any full GeoSPARQL engine reprojects as a matter of course. But reprojection is only
  > as good as the CRS it is told. An engine that honours `EPSG::4326` as written reads a site at
  > lon −2.0, lat 50.7 as lon 50.7, lat −2.0 — a point in the South Atlantic, produced without error,
  > from coordinates that were correct on the way in.
  >
  > **A second coordinate system rides along in the attributes** of the very same feature: `easting` /
  > `northing` (British National Grid metres), `grid_ref`, and `latitude` / `longitude` as DMS strings
  > (`50:44:13N`, `1:00:22W`), with nothing marking any of them authoritative. The pipeline takes the
  > geometry and ignores the attribute pair.

  The graph as a whole is in **two** CRSs. Discharge, sampling and
  WINEP points are published by the EA in **EPSG:27700** (British National Grid, metres) and the store
  reproduces those numbers verbatim; the designations and SFI options are CRS84. To make a cross-source
  `geof:distance` possible at all, every BNG point *also* carries a **derived CRS84 geometry**
  (`#geography-crs84`, marked `geo:hasDefaultGeometry`), because `geof:` functions are defined over
  CRS84 and most engines — oxigraph included — will not reproject. Every geometry says which it is;
  see [`TODO.md`](TODO.md) for what a mis-stated CRS costs a query.

## Notes

- `designations.ttl` is committed (like the other graphs). The display GeoJSON in `app/` is committed
  too (the frontend fetches it). There are no gitignored intermediates — the whole thing rebuilds
  from the raw datasets in one script.
- The spatial use case (e.g. "discharges within 200 m of a protected area that discharge nutrients")
  needs a full GeoSPARQL engine. The bundled pyoxigraph store evaluates only *basic* point-geometry
  `geof:` functions (its `spargeo` plugin — see [oxigraph#1560](https://github.com/oxigraph/oxigraph/issues/1560)):
  `geof:distance` works point-to-point but returns **unbound** for the site *polygons*, and
  `geof:buffer` is unimplemented — so accurate point-to-polygon proximity needs **GraphDB** (or a
  future oxigraph). `TODO.md` has the GraphDB query plus a centroid approximation that runs on the
  bundled endpoint.
