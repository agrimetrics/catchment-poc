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

## How the scope was whittled down (for convenience)

- **Clipped to the catchment.** The source layers are national. Only sites **intersecting** the
  Poole Harbour operational-catchment boundary (buffered ~3 km so edge sites are kept whole) survive.
- **One feature per named site.** Multipart geometries are dissolved by site name → **71 SSSI, 7 SAC,
  3 SPA** (81 sites). The official code is retained (`ref_code` for SSSI, `sac_code`/`spa_code` for
  SAC/SPA).
- **Two resolutions.** The **RDF** keeps near-full geometry fidelity (~2 m simplification) for
  accurate spatial queries; the **display GeoJSON** stays coarse (~30 m) for a light browser payload.

## Model (GeoSPARQL)

- **Class** — `defra-nature:ProtectedSite` (in `ontology-work/defra-nature.ttl`), a subclass of
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
- **CRS.** WGS84 lon/lat with an explicit `CRS84` URI on every `wktLiteral` — one CRS across the whole
  graph (discharge points and SFI options are WGS84 too), so `geof:distance(…, …, units:metre)` works
  directly on GraphDB without reprojection. See `TODO.md` for the CRS caveat.

## Notes

- `designations.ttl` is committed (like the other graphs). The display GeoJSON in `app/` is committed
  too (the frontend fetches it). There are no gitignored intermediates — the whole thing rebuilds
  from the raw datasets in one script.
- The spatial use case (e.g. "discharges within 200 m of a protected area that discharge nutrients")
  needs a GeoSPARQL engine — **GraphDB**, not the local pyoxigraph store, which holds and serves the
  geometry but does not evaluate `geof:` functions. The worked query is in `TODO.md`.
