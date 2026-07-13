# Regulation dataset — scope

The regulation graph (permits, conditions, limits, discharge points, breaches) for the
**Poole Harbour Rivers** operational catchment. Built by `regulation_to_db.py` (shreds a CSV
into a small star schema in `regulation.duckdb`) → ontop (`regulation.obda`) → `../regulation.ttl`.

```
python link_data.py                             # upstream join → output_data/observations_with_permits_and_rules.csv
python ttl/regulation/fetch_version_dates.py    # (occasional) refresh permit_version_dates.csv from the EA public register
python ttl/regulation/regulation_to_db.py
./ontop/ontop materialize --mapping ttl/regulation/regulation.obda \
    --properties ontop/duckdb-regulation.properties \
    --output ttl/regulation/regulation_raw.ttl --format turtle \
  && rdfpipe -i turtle -o turtle ttl/regulation/regulation_raw.ttl > ttl/regulation.ttl
```

## How the scope was whittled down (for convenience)

The national permitting data is enormous; this demonstrator is deliberately cut to one catchment
and the simplest defensible model. The narrowing happens mostly upstream in `link_data.py`
(which writes `output_data/observations_with_permits_and_rules.csv`, the shredder's only input):

- **One catchment.** Observations are the Poole Harbour Rivers water-quality file
  (`poole_harbour_rivers_water_quality_observations_2020_2026_combined.csv`), **2020–2026** only.
- **One region.** The permit side (`effluents.csv`, `determinands.csv`) is filtered to
  `EA_REGION = 'SW'` before joining, so only South-West permits are considered.
- **Numeric results only.** Non-detect results like `"<5"` are dropped (`to_numeric` → NaN → drop),
  so a breach is always a genuine numeric exceedance.
- **Absolute min/max rules only.** Permit rules are filtered to `METHOD = 'ABSOLUTE'` and
  `RULE_TYPE ∈ {MAXIMUM VALUE, MINIMUM VALUE}`. Percentile / rolling / load (kg/day) rules are out.
- **Seasonality collapsed.** Rows are kept only where the sample month is within the rule's
  `MONTH_FROM..MONTH_TO`, but the model carries **one limit per (permit, version, substance)** —
  summer/winter splits are not represented.
- **Only permits actually monitored here.** A permit appears only if one of its discharge points
  is monitored at a sampling point that has observations in the file → **52 permits**.

Result: 52 permits, 125 permit versions, 342 conditions, 67 discharge points, 10 substances,
64 breaches. Substances keep leading zeros and are padded to 4 digits (`0111`); permit refs are
6-digit.

## Three enrichments this pipeline adds

- **Discharge-point geometry.** The discharge point gets a `#geography` from the permit register's
  own National Grid Reference (`DISCHARGE_NGR`) — decoded to Easting/Northing and tagged
  **EPSG:27700**. This is the site's real location, distinct from the sampling point it is
  `monitoredAt`, so we surface it rather than hide it behind the sampling point's coordinates. The
  sampling point in turn carries **its own** `#geometry`, captured from the EA Water Quality Archive
  in the **source CRS the WQA publishes — EPSG:27700** (British National Grid), not a convenience
  reprojection (see the sampling-point enrichment below). Both points are therefore in the national
  grid: they differ by *location*, not projection — the discharge outfall vs. the watercourse it is
  monitored at, sitting hundreds of metres to over a kilometre apart. The NGR is read from two extracts
  in `../../raw_datasets/access_database_csv_files/`: `consents_active.csv` (in-force permits) and
  `consents_all.csv` (a cut of the *revoked* permits that still carry observations here but are absent
  from the active register); together they cover all 67 monitored discharge points, so every one gets
  a real NGR. Lets breaches/permits appear on the map (the app reprojects EPSG:27700 → WGS84 with proj4).
- **Sampling-point capture & observation linkage.** `enrich_sampling_points.py` dereferences each
  breach-evidencing observation and each sampling point from the WQA as `application/ld+json` and
  writes two things back into `regulation.ttl`: the sampling point's `skos:prefLabel` and its geometry
  in the **source EPSG:27700 encoding** (carrying the OGC CRS URI), and the structural edge
  `<observation> sosa:hasFeatureOfInterest <sampling-point>`. That edge is the real join key the breach
  query uses **instead of** an IRI-prefix `STRSTARTS` filter — which the engine cannot key on, so it
  fans out to a Cartesian product and trips *"Size Limit Exceeded"* on any store larger than this demo.
  Observational *values* (result, unit, determinand, dates) are deliberately **not** stored — they stay
  federated, pulled live via the `/observations` proxy. WQA IRIs come back `https:` and are normalised
  to the store's `http:` convention on the way in.
- **Permit-version effective dates.** Not in any source CSV, so `fetch_version_dates.py` pulls each
  version's `effectiveDate`/`revocationDate` from the EA public register into the committed
  `permit_version_dates.csv` (see that script's header). Only **numeric** permit refs fit the
  `SW-{permit:06d}-{version:03d}` scheme — 3 EPR/non-numeric permits (5 versions) are left undated.

## Modelling notes

- **Breaches are periods**, not single failing observations: a maximal run of consecutive failing
  observations with no pass in between (gaps-and-islands). `applicableFrom/To` = first/last fail;
  an open period (no `applicableTo`) = current/unresolved.
- Regenerable intermediates (`regulation.duckdb`, `regulation_raw.ttl`) are gitignored;
  `permit_version_dates.csv` is committed (it's a fetched input, not a rebuild artifact).
