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

## Two enrichments this pipeline adds

- **Discharge-point geometry.** Regulation has no coordinates of its own, so each discharge point
  gets a `#geography` (WGS84) transcribed from the coordinates of the sampling point it is
  `monitoredAt` — the sampling point itself stays a bare `geo:Feature` (owned by
  environment.data.gov.uk). Lets breaches/permits appear on the map.
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
