# Regulation dataset — scope

The regulation graph (permits, conditions, limits, discharge points) for the
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
  so a limit is only ever compared against a real numeric result. (This drops the `"<5"` non-detects
  entirely, which is WRONG for compliance assessment — the EA records them as zero. The breach
  pipeline therefore does not use this file; it re-fetches the archive's compliance samples itself.
  See [../breaches/README.md](../breaches/README.md).)
- **Absolute rules only.** Permit rules are filtered to `METHOD = 'ABSOLUTE'`, so the 1,354
  `COMPARATIVE` (differential inlet-vs-discharge) rules in the region are out. **All** absolute
  rule types are kept — `MAXIMUM VALUE`, `MINIMUM VALUE`, `95 PERCENTILE`, `MEAN VALUE` — each
  carried as its own bound with its own statistical modifier (see *Limits carry their statistic*
  below).
- **Seasonality collapsed.** Rows are kept only where the sample month is within the rule's
  `MONTH_FROM..MONTH_TO`, but the model carries **one condition per (permit, version, substance)** —
  summer/winter splits are not represented.
- **Only permits actually monitored here.** A permit appears only if one of its discharge points
  is monitored at a sampling point that has observations in the file → **58 permits**.

Result: 58 permits, 170 permit versions, 587 conditions, 800 condition bounds, 75 discharge points,
12 substances. (Breaches are a derived judgement and live in their own graph — see
[../breaches/README.md](../breaches/README.md).) Substances keep leading zeros and are padded to 4 digits (`0111`);
permit refs are 6-digit.

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

  > **A coarse coordinate on a fine feature — read this before trusting the geometry.**
  > The register carries a grid reference at **three** levels: `DISCHARGE_NGR` (the discharge **site**),
  > `OUTLET_GRID_REF` (the **outlet**) and `EFFLUENT_GRID_REF` (the **effluent**). A discharge point
  > here is keyed at the *finest* level — `(permit, outlet, effluent)` — but is given the *coarsest*
  > coordinate. And there is **no such thing as a per-permit NGR**: `DISCHARGE_NGR` belongs to the site,
  > and one site can hold many permits (across the national register, 1085 grid refs are shared by more
  > than one permit, and in 1083 of them every permit names the same discharge site — RAF Brize Norton
  > has 13 permits on a single ref). Joining it on `permit_ref` alone therefore turns a **site** fact
  > into a **permit** fact, and every outlet of every permit at a site inherits one identical point.
  >
  > In this catchment that leaves **67 discharge points on just 32 distinct coordinates**. At *Brockhill
  > Watercress Farm*, 7 outlets across 4 permits (`043244`, `043245`, `401057`, `401058`) all sit on
  > `POINT(383690 92820)` — while the EA samples them at 4 different sampling points 120–265 m away.
  >
  > This is kept deliberately: the site NGR is what the public register surfaces as "the" discharge
  > location, so the store reproduces what a consumer of that register actually gets — and it is the
  > worked example behind [Points apart](../../app/points.html), which shows why a spatial join cannot
  > be trusted to reconstruct a link that an identifier already states. Scored over the 64 discharge
  > points matchable to a register row, a nearest-sampling-point join gets:
  >
  > | geometry hung on the discharge point | distinct coords | nearest-neighbour correct |
  > | --- | --- | --- |
  > | `DISCHARGE_NGR` — site (**what this store uses**) | 32 | **38 / 64** (59%) |
  > | `OUTLET_GRID_REF` — outlet | 61 | 56 / 64 (88%) |
  > | `EFFLUENT_GRID_REF` — effluent | 60 | 54 / 64 (84%) |
  > | `water:monitoredAt` — **the identifier** | — | **64 / 64** (100%) |
  >
  > Note the *finest* geometry scores *worse* than the outlet ref: accuracy is not even monotonic in
  > coordinate precision, so "just use the most precise coordinate" is not a rule that saves you. The
  > spatial join tops out around seven in eight, and which eighth it drops is decided by a schema choice
  > taken two levels above the feature being joined. The identifier does not care.
  >
  > To publish finer geometry instead, join `OUTLET_GRID_REF` / `EFFLUENT_GRID_REF` on
  > `(PERMIT_NUMBER, OUTLET_NUMBER[, EFFLUENT_NUMBER])` rather than on `permit_ref` — see the
  > `discharge_point_geometry` block in `regulation_to_db.py`.
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

### Limits carry their statistic

A permit limit is not just a number. `20 mg/l` means something entirely different depending on
whether no single sample may exceed it, the discharge must sit under it 95% of the time, or it is a
12-month mean. A `reg:Limit` therefore carries **one bound per statistic**, each a
`qudt:QuantityValue` with an `iop:hasStatisticalModifier`:

```turtle
wr:permit/401747/version/3/condition/0111#limit a reg:Limit ;
    reg:upperBound  …#limit-percentile-95 , …#limit-maximum .

…#limit-percentile-95 a qudt:QuantityValue ;      # the BINDING limit
    qudt:numericValue 20.0000 ; qudt:unit wr:unit/milligram-per-litre ;
    iop:hasStatisticalModifier wr:statistical-modifier/percentile-95 .

…#limit-maximum a qudt:QuantityValue ;            # the upper-tier BACKSTOP
    qudt:numericValue 48.0000 ; qudt:unit wr:unit/milligram-per-litre ;
    iop:hasStatisticalModifier wr:statistical-modifier/maximum .
```

`MAXIMUM VALUE`, `95 PERCENTILE` and `MEAN VALUE` are **all** `reg:upperBound`; only `MINIMUM VALUE`
is a `reg:lowerBound`. It is the modifier, not the bound direction, that says which obligation a
value carries. Bounds are keyed by statistic slug (`#limit-percentile-95`), never by source column
position — the register uses no fixed order (permit `042451` puts the maximum in `CODE_1` and the
percentile in `CODE_2`; permit `401747` does the reverse).

The `iop:StatisticalModifier` concepts are **reused, not reinvented**: `ttl/winep` already mints
`wr:statistical-modifier/{percentile-95,annual-average,maximum}` for WINEP's *proposed* limits,
per the [Agrimetrics application profile](https://agrimetrics.github.io/application-profile/#iop-statisticalmodifier).
The regulation graph adopts the same concepts for *current* limits, and that single decision is what
makes a current limit and a proposed limit comparable. `MEAN VALUE` maps onto `annual-average`
rather than a new concept because the EA defines the mean compliance limit **as** an annual 12-month
mean — the same thing WINEP's "annual average" column means. Each concept carries a `skos:definition`
and a `dcterms:source` pointing at the [EA guidance](https://www.gov.uk/government/publications/site-specific-quality-numeric-permit-limits-discharges-to-surface-water-and-groundwater/site-specific-quality-numeric-permit-limits-discharges-to-surface-water-and-groundwater),
so the graph explains how each limit is assessed instead of leaving `20 mg/l` to mean whatever the
reader assumes.

> **Why this mattered — the graph was understating nitrogen.** Restricting rules to `MAXIMUM`/`MINIMUM`
> did not merely narrow the data, it systematically published permits as slacker than they are. At a
> sewage works the binding ammonia limit is the 95th percentile and the maximum is an upper-tier
> backstop 2–4× looser — so the store showed Wool WRC's ammonia limit as **48 mg/l** when the real
> limit is **20**, Dorchester's as 20 when it is 5, Blackheath's as 27 when it is 7. Worse, **63
> permit-versions had ammonia limited by a percentile and nothing else**, so their ammonia condition
> did not exist at all — for the app's own default substance. And **Total Nitrogen (`9686`) is limited
> only ever by `MEAN VALUE`**, so the determinand never reached the graph in any form, despite 473
> observations of it sitting in the catchment.

### Every limit carries what the source actually said

The structured bounds above are our **interpretation** of the register's `CODE_n`/`VAL_n` columns. A
reader is entitled to see the source in the source's own words rather than take that structuring on
trust, so every `reg:Limit` also carries a `reg:limitStatement` — rendered verbatim from the
register's own tokens:

```turtle
wr:permit/401747/version/3/condition/0111#limit a reg:Limit ;
    reg:limitStatement "95 PERCENTILE 20 MILLIGRAM PER LITRE; MAXIMUM VALUE 48 MILLIGRAM PER LITRE" ;
    reg:upperBound …#limit-percentile-95 , …#limit-maximum .
```

`defra-reg:limitStatement` is defined for use "in place of (**or alongside**) a quantity-value bound",
and *alongside* is the point — this is not a fallback for un-parsable text, it is provenance on every
limit. `ttl/winep` now does the same: all 27 proposed limits keep their verbatim source cell, where
before only the 2 un-parsable ones did.

That is also the honest answer to nitrogen. WINEP's nitrogen cells read literally `2025 N = 10 mg/l`
and **name no statistic**, so rather than assert an `iop:hasStatisticalModifier` the source never
stated, the graph carries the text and lets the gap show:

```
permit 401354  (Poole WRC - Phosphorus & Nitrogen Removal)
    register says : MEAN VALUE 10 MILLIGRAM PER LITRE
    WINEP says    : N 5mg/l
```

### Nitrogen has two determinand codes

The permit register codes Total Nitrogen **`9686`**; WINEP's proposed-limit columns code it **`9194`**.
The EA determinand codelist gives *both* the label "Nitrogen, Total as N" — they are one observable
property under two notations. `regulation.ttl` therefore asserts `skos:exactMatch` between them.
Without that triple a current nitrogen limit and a proposed nitrogen limit never meet, and the
catchment's nitrogen story stays untellable: Poole WRC (`401354`) holds a current mean Total-N limit
of **10 mg/l** while WINEP action `08WW102107` proposes **5 mg/l** — a halving that no query could
surface before.

### Per-sample rules vs period statistics

`MAXIMUM` and `MINIMUM` can be judged from a single sample. **`95 PERCENTILE` and `MEAN VALUE` cannot** —
they are period statistics, and a lone result above a 95th-percentile limit is an *exceedance*, not a
*breach*. The EA assesses the percentile by counting look-up-table exceedances over a rolling 12-month
sample set, and the mean by testing whether the lower bound of the 90% confidence interval exceeds the
limit.

So `link_data.py` gives those rows a pass status of **NA — "not assessable from this sample"** — and
excludes them from the per-observation grouping. This is load-bearing: leaving them at the old default
of `False` would have poisoned every group they touch and invented a breach for *every* ammonia
observation at the 26 permits whose ammonia limit is a percentile.

**Breaches are not in this graph.** A permit, a condition and a limit are *asserted* facts — the EA
published them and this graph reproduces them. A breach is a *derived judgement*: nobody published it,
we computed it. It lives in [`ttl/breaches/`](../breaches/README.md), with its own compliance-sample
fetch, the EA's real assessment methods, and its own graph (`ttl/breaches.ttl`).
