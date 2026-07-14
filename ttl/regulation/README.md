# Regulation dataset — scope

The regulation graph (permits, conditions, limits, discharge points, sampling points) for the
**Poole Harbour Rivers** operational catchment. Built by `regulation_to_db.py` (shreds the source
registers into a small star schema in `regulation.duckdb`) → ontop (`regulation.obda`) →
`../regulation.ttl`.

```
python link_data.py                              # upstream join → output_data/observations_with_permits_and_rules.csv
python ttl/regulation/fetch_version_dates.py     # (occasional) refresh permit_version_dates.csv from the EA public register
python ttl/regulation/fetch_sampling_points.py   # (occasional) refresh sampling_points.csv from the EA Water Quality Archive
python ttl/regulation/regulation_to_db.py
./ontop/ontop materialize --mapping ttl/regulation/regulation.obda \
    --properties ontop/duckdb-regulation.properties \
    --output ttl/regulation/regulation_raw.ttl --format turtle \
  && rdfpipe -i turtle -o turtle ttl/regulation/regulation_raw.ttl > ttl/regulation.ttl
```

Both `fetch_*` scripts need egress to `environment.data.gov.uk`, and both cache to a committed CSV,
so the normal build is offline.

## How the scope was whittled down (for convenience)

The national permitting data is enormous; this demonstrator is deliberately cut to one catchment
and the simplest defensible model. Conditions, limits and breaches narrow upstream in `link_data.py`
(which writes `output_data/observations_with_permits_and_rules.csv`); permits, outlets and sampling
points are scoped from the registers themselves (see *What exists vs. what was measured* below):

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
- **Only permits monitored here.** A permit is in scope if the register says one of its outlets is
  sampled at a sampling point this catchment holds observations for → **61 permits**. Note what this
  scopes on: a fact of the *register*, not of the observations. Once a permit is in, **all** of its
  outlets come with it.

### What exists vs. what was measured

The two are sourced from different places, and the split is deliberate:

| | source | why |
| --- | --- | --- |
| Permits, outlets, `monitoredAt`, sampling points | the **registers** (`effluents.csv`, `consents_*.csv`) and the **Water Quality Archive** | An outlet is an outlet whether or not anyone sampled it this decade. |
| Conditions, limit values, breaches | the **observations** join (`observations_with_permits_and_rules.csv`) | These are claims about measurement, so measurement is the right source. |

This was **not** always so, and the bug it caused is worth stating. Everything used to be
materialised from the observations CSV, so a thing existed only if it had a *numeric result matching
a permit rule*. That silently deleted real regulated outlets: permit `043231` showed 1 of its 2
outlets and `400114/CF/01` showed 1 of its 3, because every 2020–2026 sample at the missing ones
reads *"No flow/discharge at sampling point"* — a true and useful fact, dropped by the numeric filter
in `link_data.py`. Permit `050922` vanished entirely (its only samples are a site inspection). And
the store could hold **no ambient sampling point at all** — a river or a borehole has no permit to
join through, so nothing in the old pipeline could have reached one.

Result: **61 permits, 170 permit versions, 1,277 conditions, 1,565 limits, 122 discharge points
(115 of them with a published location, 102 with a sampling point), 161 sampling points, 17
sampling-point types, 38 regulated determinands.** (Breaches are a derived judgement and live in their
own graph — see [../breaches/README.md](../breaches/README.md).)

Substances keep leading zeros and are padded to 4 digits (`0111`). **Permit refs are *mostly* 6-digit**
— three are not: `400114/CF/01`, `EPRBB3593EG`, `EPRYP3399VF`. The slashes are percent-encoded in the
IRI (`400114%2FCF%2F01`) and decoded at the display boundary; a ref is an **identifier that happens to
look like a number**, which is why the app's table sort treats a column holding any of these as text.

> **The same bug, one level up — now FIXED.** *Conditions* used to be observation-sourced, so a permit
> limit existed only if somebody had sampled that substance at that permit and the result happened to be
> numeric. **Twenty-seven of the catchment's outlets therefore carried no condition at all**, while the
> register plainly limits them: Blackheath's storm overflow is capped at BOD **200 mg/l** and suspended
> solids **200 mg/l**; the watercress outlets at pH **6–9** and solids **20 mg/l**. The breach engine had
> nothing to judge them against — and an outlet judged against nothing does not read as *unknown*, it
> reads as **no breach**.
>
> A limit is a **register fact**. It is true whether or not anyone sampled. Conditions now come from
> `determinands.csv`, which takes the catchment from 587 conditions over 12 substances to **1,277 over
> 38**. The 26 new determinands are flow and dry-weather flow, weir settings, storm-overflow telemetry
> (spill days, FPF data coverage), heavy metals, pesticides and solvents, and a pass/fail site
> inspection. (An earlier draft of this note claimed the extras included "colour, turbidity and pH" —
> they do not: all three were already among the 12.)
>
> The app's substance **filter** still offers only the **12** determinands the archive holds a time
> series for, because those are the only ones it can chart. That is a fact about the *observations*, and
> the store keeps the two apart as two SKOS schemes: `wr:substance` (everything the register regulates)
> and `wr:substance/monitored` (the subset we can plot). What we must never do again is let the second
> define the first — which is precisely what the old pipeline did, allowing the app's dropdown to decide
> what the law said.

## What this pipeline adds on top of the CSVs

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
  from the active register); together they cover **115 of the 122** discharge points. Lets breaches and
  permits appear on the map.

  > **No fallback. An outlet with no grid reference gets no geometry.** The other **7** discharge
  > points belong to permits the consents extracts give no `DISCHARGE_NGR` for, so they are published
  > with **no coordinate at all** — never a guessed one. This used to fall back to the coordinates of
  > the sampling point the outlet is `monitoredAt`, "so it still maps rather than vanishing", and that
  > was wrong three times over: it **fabricated a fact** (asserting the outfall sits exactly on the
  > watercourse location it is sampled at — the precise conflation this store exists to disprove); it
  > **corrupted the scoring**, since those outlets sat 0 m from their own sampling point and so scored
  > a free hit for any nearest-point join (the catchment score was inflated from 42/91 to 47/96 by
  > them); and it **made the map lie**, putting an outlet's marker on top of a sampling point's marker,
  > so that a leg drawn from *another* permit's outlet to that shared sampling point looked like a link
  > between two discharge points. Losing them from the map costs nothing that matters:
  > `water:monitoredAt` still names their sampling point, which is the whole thesis — the join does not
  > depend on the geometry being right, or on there being any geometry at all.
  >
  > (One outlet, `040111/1/1`, *does* coincide with its sampling point — but genuinely: the register
  > publishes `DISCHARGE_NGR = SY9750080700` and the archive puts `SW-50900956` on the same 100 m grid
  > square. That is the sources agreeing, not us inventing, so it stands. The build reports it, because
  > it too hands a proximity join a free hit.)

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
  > In this catchment that leaves **115 mapped discharge points on just 37 distinct coordinates** — 104
  > of them share a coordinate with another outlet. That is 3.1 outlets per dot. At *Brockhill Watercress Farm*, 7 outlets across 4
  > permits (`043244`, `043245`, `401057`, `401058`) all sit on `POINT(383690 92820)` — while the EA
  > samples them at 4 different sampling points 120–265 m away.
  >
  > **All three are now PUBLISHED, so you do not have to take our word for it.** The discharge point
  > carries a geometry for each level, tagged `wr:gridReferenceLevel` (`site` / `outlet` / `effluent`);
  > the **site** one is its `geo:hasGeometry` default because that is what the public register surfaces
  > as "the" discharge location, and it is therefore what a consumer of that register actually gets.
  > [Points apart](../../app/points.html) scores a nearest-neighbour join against **all three** at render
  > time and puts the result on screen — the counter-argument, computed rather than dodged.
  >
  > Scored over the **87** outlets for which the register carries all three refs (so the rows compare
  > the same outlets three ways), choosing from the whole **161-point** sampling layer — which is what a
  > GIS actually holds:
  >
  > | geometry hung on the discharge point | distinct coords | nearest-neighbour correct |
  > | --- | --- | --- |
  > | `DISCHARGE_NGR` — site (**the store's default**) | 37 | **41 / 87** (47%) |
  > | `OUTLET_GRID_REF` — outlet | 74 | 64 / 87 (74%) |
  > | `EFFLUENT_GRID_REF` — effluent | 80 | 66 / 87 (76%) |
  > | `water:monitoredAt` — **the identifier** | — | **87 / 87** (100%) |
  >
  > Two things to notice. **Precision is not accuracy:** the effluent ref resolves 80 distinct
  > coordinates to the outlet ref's 74 and buys almost nothing for it, so "just use the most precise
  > coordinate" is not a rule that saves you. And the 47%-vs-76% gap is **not a fact about the world**
  > — it is decided by which column of a spreadsheet the geometry was hung on, two levels above the
  > feature being joined. Change that schema choice and the "answer" changes. The identifier does not
  > move.
  >
  > Note the *finest* geometry does no better than the outlet ref, despite resolving more distinct
  > coordinates (66 vs 60): accuracy is not monotonic in coordinate precision, so "just use the most
  > precise coordinate" is not a rule that saves you. The spatial join tops out around three in four,
  > and which quarter it drops is decided by a schema choice taken two levels above the feature being
  > joined. The identifier does not care.
  >
  > **Worse: the join need not return an outfall at all.** Only 70 of the 161 sampling points monitor
  > any discharge; the other 91 are rivers, boreholes and bathing waters. A nearest-feature join picks
  > from all of them, and for **8 of the mapped outlets** its nearest hit monitors no discharge whatsoever.
  > (Within the 69-outlet set scored in the table above it is **5** — three of the eight carry no outlet or
  > effluent grid ref, so they are not among the 69. An earlier draft said "8 of the scored outlets",
  > which conflated the two populations.)
  > At *Blackheath WRC* (`042451`) the nearest point is `SW-50951085`, **"SHERFORD AT SNAILS BRIDGE US
  > BLACKHEATH"** — a river station sited *upstream* of the works, the one place guaranteed to carry
  > none of its effluent. Proximity scores **0 of 5** on that permit's outlets. Restricting the layer to
  > "just the effluent points" would hide this, but you can only do that if you already know which
  > points those are — which is what the join was for.
  >
  > To publish finer geometry instead, join `OUTLET_GRID_REF` / `EFFLUENT_GRID_REF` on
  > `(PERMIT_NUMBER, OUTLET_NUMBER[, EFFLUENT_NUMBER])` rather than on `permit_ref` — see the
  > `discharge_point_geometry` block in `regulation_to_db.py`.
- **Sampling points, from the archive.** `fetch_sampling_points.py` resolves every sampling point the
  store needs straight from the WQA as `application/ld+json` and caches the reference facts into the
  committed `sampling_points.csv`, which `regulation_to_db.py` reads like any other table: the
  `skos:prefLabel`, the geometry in the **source EPSG:27700 encoding** (carrying the OGC CRS URI, not a
  convenience reprojection), the `samplingPointType` and the status. The archive nests type and status
  as blank-node concepts with no resolvable IRI, so the store mints `wr:sampling-point-type/{notation}`
  from the notation — the same pattern it uses for substances.

  Which points? The union of **every sampling point in the catchment observation download** (149 — the
  ambient layer: rivers, boreholes, bathing waters, investigation points) and **every point the register
  names as a permit's effluent sample point** (adding 12 more, including storm overflows the download
  never mentioned). 161 in all, of which only 70 monitor a discharge. Observational *values* (result,
  unit, determinand, dates) are deliberately **not** stored — they stay federated, pulled live via the
  `/observations` proxy. WQA IRIs come back `https:` and are normalised to `http:` on the way in.

  This replaced an earlier `enrich_sampling_points.py`, which patched labels and geometry into the
  materialised Turtle with regexes. It could only ever *rewrite* facts the observations had already put
  in the graph, so a sampling point with no observations behind it — every ambient point in the
  catchment — had nothing to patch and could not be represented at all. Its other job, the
  `<observation> sosa:hasFeatureOfInterest <sampling-point>` edge, is now emitted by the breaches
  pipeline (see [../breaches/README.md](../breaches/README.md)); that edge is the real join key the
  breach query uses **instead of** an IRI-prefix `STRSTARTS` filter, which the engine cannot key on and
  which fans out to a Cartesian product.
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
