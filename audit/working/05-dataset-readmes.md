# Per-dataset documentation audit — evidence-backed findings

Audited against: live SPARQL (`http://127.0.0.1:8000/sparql`, union of `ttl/*.ttl`),
`ttl/regulation/regulation.duckdb`, `ttl/breaches/breaches.duckdb`, `ttl/winep/winep.duckdb`,
and the raw CSVs / xlsx in `raw_datasets/`. Every number was **re-derived**, not re-read — including
an independently written OSGB National Grid decoder (validated: `SY9750080700` → `397500, 80700`).

No project file was modified.

## Verdict summary

| | count |
| --- | --- |
| CONFIRMED | 46 |
| WRONG | 12 |
| STALE | 4 |
| UNVERIFIABLE | 2 |

**The headline numbers are in excellent shape.** Every count in the regulation README's result
line, the whole breaches result table, the scoring table, and the SFI/designations figures
re-derive exactly. The failures cluster in three places: (1) the **designations CRS claims**, which
were invalidated when discharge points moved to EPSG:27700 and are now actively wrong; (2) the
**WINEP TODO**, which describes a pre-clip population as though it were the delivered graph; and
(3) a **stale `permit_version_dates.csv` cache** that the regulation README papers over.

---

# 1. `ttl/regulation/README.md`

## 1.1 Scope and headline counts — all CONFIRMED

| LINE | CLAIM | VERDICT | EVIDENCE |
| --- | --- | --- | --- |
| 29–32 | Poole Harbour observations 2020–2026; permit side filtered `EA_REGION = 'SW'` | CONFIRMED | `link_data.py:6,25,39` |
| 33–37 | Numeric results only; `to_numeric` → NaN → drop | CONFIRMED | `link_data.py:29` |
| 38–39 | "the **1,354** `COMPARATIVE` … rules in the region are out" | **CONFIRMED** | `determinands.csv` where `EA_REGION='SW'`: `METHOD` value counts = ABSOLUTE 78,670 / **COMPARATIVE 1,354** |
| 40–42 | All absolute rule types kept (MAX/MIN/95%ile/MEAN) | CONFIRMED | `condition_bounds` statistics: percentile-95 345, maximum 337, minimum 102, annual-average 16 (= 800) |
| 43–45 | Seasonality collapsed via `MONTH_FROM..MONTH_TO` | CONFIRMED | `link_data.py:83-84` |
| 46–49 | "→ **61 permits**"; once a permit is in, all its outlets come with it | CONFIRMED | independent re-derivation from `effluents.csv` (SW + `EFF_SAMPLE_POINT`) ∩ catchment sampling points → **61** scoped permits |
| 60–67 | `043231` showed 1 of 2 outlets; `400114/CF/01` 1 of 3; `050922` vanished | **CONFIRMED** | store now: 043231 = 2 DPs, 400114/CF/01 = 3 DPs, 050922 = 1 DP / 0 conditions. Observation-sourced counts: 1, 1, **0 rows** respectively |
| 69–71 | "**61 permits, 170 permit versions, 587 conditions, 800 condition bounds, 102 discharge points (95 with a published location), 161 sampling points, 17 sampling-point types, 12 substances**" | **CONFIRMED — every one** | duckdb: permits 61, permit_versions 170, conditions 587, condition_bounds 800, discharge_points 102, discharge_point_geometry 95, sampling_points 161, sampling_point_types 17, substances 12. Live graph agrees: `water:WaterDischargePermit` 61, `reg:PermitDocument` 170, `reg:Condition` 587, `reg:DischargePoint` 102 (95 with `geo:hasGeometry`), `sosa:FeatureOfInterest` 161 |
| 77 | "61 permits have outlets but only **58** have limits" | **CONFIRMED** | `SELECT COUNT(DISTINCT permit_ref) FROM conditions` = 58. The 3 without: `040096`, `040137`, `050922` |

## 1.2 The 919/38 projection — number right, examples WRONG

| LINE | CLAIM | VERDICT | EVIDENCE |
| --- | --- | --- | --- |
| 78–79 | "would take the catchment from 587 conditions over 12 substances to **919 over 38**" | **CONFIRMED exactly** | `determinands.csv`, `EA_REGION='SW'` ∩ the 61 permits ∩ `METHOD='ABSOLUTE'`, distinct (PERMIT_REF, VERSION, DETE_CODE) = **919**; distinct `DETE_CODE` = **38** |
| 79–80 | "the extra 26 include flow, colour, turbidity and pH" | **WRONG** | 38 − 12 = **26** ✔, but **colour, turbidity and pH are ALREADY among the current 12 substances** (`0061` pH, `0072` Colour Filtered, `6396` Turbidity) — they cannot be "extra". Only **flow** is genuinely new. The real 26 are: flow determinands (`3527`, `3647`, `6425`, `7729`, `7782`, plus storm-overflow FPF metrics `2928`/`2932`/`2933`/`2934`), heavy metals (Cadmium `0108`, Copper `6452`, Nickel `6462`), pesticides/solvents (Dieldrin, Malathion, TCE, PCE, Chloroform, HCH, Malachite Green), Phenols, Detergents, Formaldehyde, Free Chlorine, Weir Setting, Site Inspection |

**Human must decide:** rewrite the example list. "flow, heavy metals, pesticides and storm-overflow
telemetry" is the true characterisation — and it makes the "would reshape the app's substance
vocabulary" argument *stronger*, not weaker.
**Note:** the identical stale sentence is duplicated in `ttl/regulation/regulation_to_db.py:30-35`.

## 1.3 Geometry, the fallback, and the coincidence — all CONFIRMED

| LINE | CLAIM | VERDICT | EVIDENCE |
| --- | --- | --- | --- |
| 93–95 | consents_active + consents_all "together cover **95 of the 102**" | CONFIRMED | 95 of 102 DPs get a site NGR |
| 98–99 | "The other **7** discharge points … no coordinate at all" | CONFIRMED | 102 − 95 = 7 |
| 106 | deleted fallback "inflated the catchment score **from 42/91 to 47/96**" | **CONFIRMED exactly** | Scoring monitored ∩ has-geometry over the 161-point layer: **42/91**. Simulating the old fallback (the 5 monitored DPs with no NGR take their own sampling point's coordinate → 0 m → free hit): **47/96**. The 5 free-hit outlets: `040070/1/1`, `040091/1/1`, `040091/1/2`, `040096/1/1`, `040137/1/1` |
| 112–115 | "`040111/1/1` *does* coincide … register publishes `DISCHARGE_NGR = SY9750080700` and the archive puts `SW-50900956` on the same 100 m grid square" | **CONFIRMED** | `consents` DISCHARGE_NGR for 040111 = `SY9750080700` → decodes to **(397500, 80700)**. `sampling_points.csv`: `SW-50900956` = `POINT(397500 80700)`. Not merely the same grid square — **the identical coordinate**. It is the only coincident DP in the store |
| 128–130 | "**95 mapped discharge points on just 37 distinct coordinates** — **83** share a coordinate with another outlet" | **CONFIRMED** | duckdb group-by wkt: 95 points, **37** distinct coords, **83** stacked |
| 129–130 | Brockhill: "**7 outlets across 4 permits** (`043244`, `043245`, `401057`, `401058`) all sit on `POINT(383690 92820)` — sampled at **4 different sampling points 120–265 m away**" | **CONFIRMED** | exactly 7 DPs, 4 permits, one coordinate (383690, 92820); 4 distinct sampling points at **121, 130, 162, 265 m**. ("120" is a rounding of 121 m — harmless) |

## 1.4 The scoring table — numbers CONFIRMED, but the provenance is inconsistent

> Claim (L136–145): scored over "the **69** monitored discharge points for which the register
> carries **all three** grid refs", choosing from "the whole 161-point sampling layer".
> Site 37 coords → **33/69 (48%)**; outlet 60 → **53/69 (77%)**; effluent 66 → **53/69 (77%)**;
> `monitoredAt` → **69/69**.

**VERDICT: CONFIRMED — but only under one reading of "the register."**

I re-derived the whole table from scratch (own NGR decoder, own nearest-neighbour over all 161
sampling points, Euclidean in EPSG:27700):

| grid-ref source read from | scored set | site coords / correct | outlet coords / correct | effluent coords / correct |
| --- | --- | --- | --- | --- |
| **`consents_active.csv` only** | **69** | **37** / **33 (48%)** | **60** / **53 (77%)** | **66** / **53 (77%)** |
| `consents_active.csv` + `consents_all.csv` (the union the pipeline actually reads) | 87 | 37 / 41 (47%) | 74 / 64 (74%) | 80 / 66 (76%) |

Every cell of the published table reproduces **exactly** — including the distinct-coords column
(37 / 60 / 66) — **if and only if** the three grid refs are read from `consents_active.csv` alone.

**The inconsistency:** the store's *published* discharge-point geometry (L93–95) is built from
**both** extracts (active + all). The *scoring table* is built from **active only**. So the row
labelled "`DISCHARGE_NGR` — site (**what this store uses**)" is not scored over the same population
the store actually publishes. Under the union, the score is 41/87 (47%) — the same *percentage*, so
the argument is unharmed, but the numbers in the table do not describe the shipped geometry.

**Human must decide:** either (a) state that the scoring is restricted to the in-force register
(and say why the revoked-permit extract is excluded), or (b) re-run the table over the union and
publish 87 / 41 / 64 / 66. The rhetorical conclusion holds either way — including the key
"accuracy is not monotonic in coordinate precision" point (under the union the effluent ref does
edge ahead, 66 vs 64, so **that sentence would need softening if you switch to the union**).

## 1.5 "Worse: the join need not return an outfall at all"

| LINE | CLAIM | VERDICT | EVIDENCE |
| --- | --- | --- | --- |
| 153–154 | "Only **70** of the **161** sampling points monitor any discharge; the other **91** are rivers, boreholes and bathing waters" | **CONFIRMED** | `COUNT(DISTINCT sp_notation) FROM discharge_point_monitoring` = **70**; 161 − 70 = **91**. Type mix of the 91 is indeed rivers (48), boreholes (18), investigation points (14), bathing beaches (2), lakes, springs … |
| 155 | "for **8 of the scored outlets** its nearest hit monitors no discharge whatsoever" | **WRONG (as worded)** | **8** is right for *all mapped + monitored* outlets, but **not for the scored set**. Within the **69** scored outlets the count is **5**. The 8 are: `041519/1/1`, `041519/2/1`, `042451/1/1`, `042451/1/2`, `042451/1a/1`, `042451/1a/2`, `042451/2/1`, `050753/1/1` — but `042451/1/1`, `042451/1/2` and `042451/2/1` carry no `OUTLET_GRID_REF`/`EFFLUENT_GRID_REF`, so they are **not in the 69**. Fix: say "8 of the mapped outlets" (drop "scored"), or say 5. |
| 156–158 | Blackheath `042451`: nearest is `SW-50951085` **"SHERFORD AT SNAILS BRIDGE US BLACKHEATH"**, a river station sited upstream; "Proximity scores **0 of 5**" | **CONFIRMED** | 042451 has exactly **5** outlets, all on one coordinate (389950, 93350). Nearest point in the 161-layer = `SW-50951085` at **19 m** — label confirms "US" (upstream) of Blackheath. None of the 5 outlets is monitored there (they are monitored at `SW-50951080` / `SW-50951082`) → **0/5**. (Caveat: only 2 of these 5 are inside the 69-point scored set — the "0 of 5" is over the permit's outlets, which is fine, but it is a different denominator from the table above.) |

## 1.6 Sampling points from the archive — all CONFIRMED

| LINE | CLAIM | VERDICT | EVIDENCE |
| --- | --- | --- | --- |
| 174–177 | union of "**149**" catchment-download points + "**12** more, including storm overflows the download never mentioned" = "**161** in all, of which only **70** monitor a discharge" | **CONFIRMED, all four** | distinct `samplingPoint.notation` in the bulk download = **149**; `sampling_points.csv` = **161**; register-only = **161 − 149 = 12**; monitoring = **70** |
| 176 | "storm overflows the download never mentioned" | **CONFIRMED** | **11** of the 12 register-only points are `SEWAGE DISCHARGES - STW STORM OVERFLOW/STORM TANK`; all **11** storm-overflow points in the store are register-only. (12th is Doddings Farm watercress) |
| — | (task) "fetch_sampling_points.py resolved **161 of 167**" | **CONFIRMED** | Re-ran the script's own `notations()` union logic: **wanted = 167**, resolved = **161**, unresolved = **6** (`SW-50410121`, `SW-50440124`, `SW-50520133`, `SW-50570248`, `SW-50959903`, `SW-6WXE0555`) |
| 180 | "This replaced an earlier `enrich_sampling_points.py`" | **CONFIRMED — no stale reference** | The file is deleted (`find` → nothing). This is the **only** mention in the repo and it is correctly past-tense. Nothing to fix. |
| 165–171 | geometry carried in source EPSG:27700 with OGC CRS URI; type/status minted from notation | CONFIRMED | `sampling_points.csv` wkt = `POINT(376300 102700) <…/EPSG/0/27700>`; 17 types |

## 1.7 Permit-version dates — **STALE, and the doc understates the gap ~13×**

| LINE | CLAIM | VERDICT | EVIDENCE |
| --- | --- | --- | --- |
| 188–191 | "Only **numeric** permit refs fit the `SW-{permit:06d}-{version:03d}` scheme — **3 EPR/non-numeric permits (5 versions) are left undated**" | **WRONG / STALE** | The *parenthetical* is right: there are exactly **3** non-numeric permits (`EPRBB3593EG`, `EPRYP3399VF`, `400114/CF/01`) carrying **5** versions. But the *implication* — that these are the only undated versions — is false. **67 of the 170 permit versions have no effective date, across 29 permits — and 62 of those are on NUMERIC permits** (e.g. `040725` 7 undated versions, `040015` 6, `041353` 5, `042453` 5). Only **103 of 170** versions are dated. |

**Root cause (diagnosed):** `permit_version_dates.csv` holds **120** rows (103 with a date).
`fetch_version_dates.py` "fills gaps only" and derives its work-list from
`output_data/observations_with_permits_and_rules.csv` — which now contains **165 numeric
(permit, version) pairs**. **45 of them are absent from the cache entirely.** The recent
"new limits" change (adding `95 PERCENTILE` / `MEAN VALUE` rule types) pulled in permit versions
that never existed when the cache was last built, and the script has not been re-run.

**Human must decide:** re-run `python ttl/regulation/fetch_version_dates.py` (needs egress), then
restate the limitation honestly — something like "*N* versions have no date the public register
will give us". This also silently affects **breaches**: `breaches_to_db.py`'s `version_at()` falls
back to the permit's *latest* version for wholly-undated permits, so 29 permits' samples may be
judged against the wrong version's limits.

## 1.8 Modelling notes

| LINE | CLAIM | VERDICT | EVIDENCE |
| --- | --- | --- | --- |
| 73 | "permit refs are 6-digit" | **WRONG (minor)** | 3 are not: `400114/CF/01`, `EPRBB3593EG`, `EPRYP3399VF`. The doc itself says so at L191 — the blanket statement at L73 contradicts it |
| 217–219 | "permit `042451` puts the maximum in `CODE_1` and the percentile in `CODE_2`; permit `401747` does the reverse" | **CONFIRMED exactly** | `determinands.csv`, ammonia `0111`: 042451 → `CODE_1 = MAXIMUM VALUE (27)`, `CODE_2 = 95 PERCENTILE (7)`; 401747 → `CODE_1 = 95 PERCENTILE (20)`, `CODE_2 = MAXIMUM VALUE (48)` |
| 232–240 | Nitrogen box: Wool WRC ammonia **48 vs real 20**; Dorchester **20 vs 5**; Blackheath **27 vs 7** | **CONFIRMED, all three** | latest-version `condition_bounds` for `0111`: 401747 (Wool) max 48 / p95 **20**; 401050 (Dorchester) max 20 / p95 **5**; 042451 (Blackheath) max 27 / p95 **7**. (Action labels in `winep.duckdb` confirm the works names) |
| 237–238 | "**63 permit-versions had ammonia limited by a percentile and nothing else**" | **CONFIRMED exactly** | permit-versions with a `percentile-95` ammonia bound and no `maximum`/`minimum` = **63** (of 120 with any ammonia bound) |
| 239–240 | "**Total Nitrogen (`9686`) is limited only ever by `MEAN VALUE`**… despite **473 observations** of it in the catchment" | **CONFIRMED** | `condition_bounds` for 9686: **only** `annual-average` (3 bounds, no other statistic). Bulk download rows with determinand 9686 = **473** |
| 257–258 | "all **27** proposed limits keep their verbatim source cell, where before only the **2** un-parsable ones did" | **CONFIRMED** | live graph: 27 `reg:ProposedLimit`, **27** carry `reg:limitStatement`; exactly **2** are un-parsable (`TBC` at 401242 and 401336) |
| 265–267 | "permit 401354 … register says MEAN VALUE 10 MILLIGRAM PER LITRE; WINEP says N 5mg/l" | **CONFIRMED verbatim** | `limit_statements` 401354/9686 = `"MEAN VALUE 10 MILLIGRAM PER LITRE"`; winep 401354 / 08WW102107 / 9686 statement = `"N 5mg/l"` |
| 272–278 | Nitrogen `9686` ↔ `9194` `skos:exactMatch`; Poole WRC (`401354`) 10 mg/l vs WINEP `08WW102107` 5 mg/l | **CONFIRMED** | `substance_aliases` = 1 row (9686 → 9194); values as above |
| 291 | "invented a breach for *every* ammonia observation at the **26 permits** whose ammonia limit is a percentile" | **WRONG (off by 2)** | `SELECT COUNT(DISTINCT permit_ref) FROM condition_bounds WHERE substance='0111' AND statistic='percentile-95'` = **24** |

## 1.9 Out-of-scope but directly contradicts this README

`ttl/regulation/regulation_to_db.py` — its own header comments are **STALE** and now contradict the
README they document:

- **L240**: "In this catchment that puts **67 discharge points on 32 distinct coordinates**" → actual **95 on 37** (as the README correctly says).
- **L246–249**: "Scored over the **64** discharge points matchable to a register row, a nearest-sampling-point join gets **38/64** … **56/64** … **54/64** … against **64/64**" → superseded by the README's 69 / 33 / 53 / 53 / 69. Neither set matches the other.
- **L527**: the comment still describes check "(2) How many outlets **fall back to their sampling point's coordinate**" — that fallback was **deleted**; the code below it no longer does this.

---

# 2. `ttl/breaches/README.md`

| LINE | CLAIM | VERDICT | EVIDENCE |
| --- | --- | --- | --- |
| 47–50 | complianceOnly set contains only `COMPLIANCE AUDIT (PERMIT)`, `COMPLIANCE FORMAL (PERMIT)`, `WATER QUALITY OPERATOR SELF MONITORING COMPLIANCE DATA`, `WATER QUALITY UWWTD MONITORING DATA` | **CONFIRMED — exactly those 4, nothing else** | `compliance_observations.csv` `samplingPurpose` value counts: 22,922 / 903 / 14,119 / 2,656 |
| 47–49 | "Verified: it takes an ambient river point from 149 observations to 0 and leaves a sewage-effluent point untouched" | **CONFIRMED (indirectly)** | All **91** ambient (non-monitoring) sampling points have **0** rows in the compliance set; **54 of the 70** effluent points are present. Cannot re-run the fetch offline, but the resulting set is exactly as claimed |
| 51–52 | "in the compliance set **34%** of results are `<` non-detects" | **CONFIRMED** | 13,892 / 40,600 = **34.2%** |
| 52 | "— **70.7% of BOD, 47.1% of ammonia**" | **WRONG** | Actual: **BOD (`0085`) 63.9%** (4,764/7,454); **Ammoniacal Nitrogen (`0111`) 35.9%** (2,320/6,462). I tested every plausible population — whole file, restricted to points that monitor a discharge, restricted to permit+substance pairs that carry a bound, deduped by observation id and not — and **none** yields 70.7 / 47.1. The overall 34% is robust across all of them, so only these two sub-figures are wrong |
| 58 | "`\">33\"` is read as 33" | CONFIRMED (rule exists; 10 `>` values in the set) | `parse_result()`; 10 rows start `>` |
| 59 | "Free text is not a measurement (`Trace present`, `Not found`, …) and is excluded" | CONFIRMED (as a rule) | The rule exists in `parse_result()`; **0** free-text results occur in the current set (so it is a no-op today, like the NO_DISCHARGE check the doc *does* flag as a no-op) |
| 55–57 | Worked example: "on the old numbers Poole WRC failed its BOD 95-percentile in 2023 (**3 exceedances, 2 allowed for 15 samples**). Counting the non-detects, the year has enough samples to allow 3 — and the breach disappears" | **CONFIRMED** | Poole WRC = `401354`, BOD 95%ile limit **20 mg/l**. Rolling 12-month window to **2023-12-08**, non-detects **dropped**: **n = 15, exceedances = 3**; LUT band `(8,16) → 2 allowed` → **FAIL**. Counting non-detects as 0: the same windows carry **n = 38–44**, still 3 exceedances, LUT allows **4–5** → **PASS**. And **0 BOD breaches are booked for 401354 today** ✔. (Nit: "enough samples to allow 3" understates — it allows 4–5) |
| 68–73 | "In the current compliance set **zero** [NO_DISCHARGE] results appear, so the check is a no-op today" | **CONFIRMED** | 0 rows match `No flow/discharge at sampling point` |
| 82 | "`median` bounds … (None occur in this catchment.)" | **CONFIRMED** | `condition_bounds` statistics: percentile-95, maximum, minimum, annual-average only |
| 90–94 | "That booked **64 breach rows for 39 real events**, with only **27** of the 64 sitting on the version actually in force" | **UNVERIFIABLE** | The code is deleted (last seen at `25c0013`), and its input (`output_data/`, **gitignored**) has since been regenerated with a different rule set (percentile/mean added, `NA` pass status introduced). The figures cannot be reproduced from the repo as it stands. Historical provenance claim — keep or drop, but it can never be re-checked |
| 117–120 | `rdfs:comment` example: *"6 exceedances of the 10 95th-percentile limit in the 12 months to 2002-06-26; 5 permitted for 48 samples"* | **CONFIRMED verbatim** | breach `043091` / `0111`: `detail` is that exact string, character for character |
| 124 | "**270 breaches** over **35 permits**, from **40,600 compliance observations** (2000–2026)" | **CONFIRMED, all three** | `breaches` table = **270** rows, `COUNT(DISTINCT permit_ref)` = **35**; `compliance_observations.csv` = **40,600** rows; `phenomenonTime` range **2000-01-04 → 2026-06-12** |
| 126–131 | table: maximum **229**, minimum **36**, percentile-95 **4**, annual-average **1** | **CONFIRMED, every cell** | `GROUP BY statistic` returns exactly those. Live graph cross-check: `ExceedanceBreach` 234 (= 229+4+1), `ShortfallBreach` 36 |
| 133 | "One is still open" | **CONFIRMED** | exactly **1** row with `applicable_to IS NULL` (`EPRYP3399VF` / `0135` / maximum, from 2025-12-04) |
| 136–138 | `breaches.duckdb` + `breaches_raw.ttl` gitignored; `compliance_observations.csv` committed | **CONFIRMED** | `git ls-files`: the two are ignored, the CSV is tracked |

**Human must decide (BOD/ammonia %):** recompute and replace `70.7%` → `63.9%` and `47.1%` → `35.9%`,
or say which population the old figures came from. The argument (non-detects are the *low* ones and
dropping them shrinks `n`) survives untouched — the worked example that carries it re-derives
perfectly.

---

# 3. `ttl/winep/README.md`

| LINE | CLAIM | VERDICT | EVIDENCE |
| --- | --- | --- | --- |
| 16 | "~**18.6k** rows … nationally" | **CONFIRMED** | sheet `PR24 WINEP National Data` = **18,598** data rows |
| 20–22 | filtered to `Water_Company = 'Wessex Water Service Ltd'` AND `EA_Function = 'Water Quality'` | CONFIRMED | `winep_to_db.py:224`; that filter alone yields **1,233** rows |
| 32 | "→ **11 actions**, **27 proposed limits** across **7 permits**" | **CONFIRMED, all three** | live graph: `reg:Action` = **11**, `reg:ProposedLimit` = **27**, `COUNT(DISTINCT ?targetPermit)` = **7** |
| 27–32 | catchment union rule; "a boundary works can land just outside the polygon (kept by the permit clause, **e.g. 401336, 401354**)" | **CONFIRMED** | point-in-polygon on the reprojected catchment: **401336 and 401354 sites both fall OUTSIDE** the polygon and are kept only by the permit clause. The permit clause is genuinely load-bearing ✔ |
| 31–32 | "conversely a site can sit inside the catchment for a permit we hold no regulation data on (kept by the site clause, **e.g. 042116**)" | **WRONG** | **`042116` IS one of the catchment's 61 regulation permits.** Its site is *also* inside the polygon, so `permit_in_catchment = True` **and** `site_in_catchment = True` — the permit clause keeps it regardless. It is not an example of the site clause doing anything. **Worse: no emitted action depends on the site clause at all.** All **11** emitted actions have `permit_in_catchment = True`; deleting the site clause would change the output by **zero rows**. (Rows kept *only* by the site clause — permits `401426`, `401422`, `401166`, `401167`, `102195`, `042430`, `400683`… — all get dropped later by the "must propose a limit" filter.) |
| 42–43 | "classifies each as **structured (196)**, **carried-over (67)**, or **uninterpreted (5)**" | **CONFIRMED — but PRE-CLIP, not this dataset** | Re-ran the shredder's own classifier with the catchment clip disabled: **138 actions, 268 limits = 196 structured + 67 carried_over + 5 uninterpreted** ✔ exactly. But the **emitted graph** holds **27** limits = **19 structured + 6 carried-over + 2 uninterpreted**. The README presents the 196/67/5 as if they described the dataset it is documenting |

**Human must decide (union rule):** either find a real site-clause example (there isn't one in the
emitted output) and reword, or admit the site clause is currently inert and keep it as
future-proofing. As written, the doc's central justification for the union rule is false.

---

# 4. `ttl/winep/TODO.md` — systematically written against the wrong population

Everything in this file is *numerically correct for the pre-clip (Wessex + Water Quality) set of
**138 actions / 268 limits***, and *wrong for the **11 actions / 27 limits** actually in the graph*.
A reader will assume the latter.

| LINE | CLAIM | VERDICT | EVIDENCE |
| --- | --- | --- | --- |
| 7–15 | "Of **268** proposed limits: **196** structured, **67** carried-over, **5** uninterpreted" | **CONFIRMED (pre-clip) / MISLEADING (as a description of the dataset)** | classifier without the clip: 268 = 196 + 67 + 5 ✔. **In the graph: 27 = 19 + 6 + 2** |
| 18–22 | "The 5 that remain uninterpreted: `TBC` ×4, `0.20kg/d` ×1" | **STALE for the graph** | Pre-clip: `Counter({'TBC': 4, '0.20kg/d': 1})` ✔. **In the graph only 2 remain — both `TBC`** (401242/08WW102105, 401336/08WW102108). **No `kg/d` limit is emitted at all**, so the "add a load unit + model load limits" fix is not needed for this dataset |
| 40–45 | "Generic chemical analyte … those limits use `wr:substance/chemical` … the biggest remaining enrichment (**~18 limits**)" | **WRONG for the graph; ~18 not reproducible anywhere** | The graph contains **ZERO** `wr:substance/chemical` limits — its 5 WINEP substances are `0111`, `0348`, `6051`, `6057`, `9686`, all real determinands. Pre-clip there are **29** chemical limits (not ~18). **This entire TODO item is inapplicable to the delivered dataset** |
| 71–75 | "**12** (permit, substance) pairs have >1 proposed limit, but **7** are the generic `wr:substance/chemical` placeholder … The genuine competing-driver cases are only **401050 (N, P, Fe)** and **401747 (P, Fe)**" | **Mixed: 12/7 WRONG for the graph; the "genuine cases" CONFIRMED** | **In the graph: 5** such pairs, **0** of them chemical — namely 401050/`0348`, 401050/`6051`, 401050/`9686`, 401747/`0348`, 401747/`6051`. That is *exactly* "401050 (N, P, Fe) and 401747 (P, Fe)" ✔. The 12 and the 7 are pre-clip figures (pre-clip: 12 pairs, 7 chemical ✔) |
| 60–69 | Worked example table for 401050 (08WW102104 P 0.25 / N 10, 2030-03-31; 08WW102201 P 2, 2030-05-13; 08WW102200 N 15, 2030-03-31) | **CONFIRMED** | `winep.duckdb`: 08WW102104 → `0348 = "0.25"`, `9686 = "N 10mg/l"`; 08WW102201 → `0348 = "2"`; 08WW102200 → `9686 = "N 15mg/l"`. Completion dates **2030-03-31 / 2030-05-13 / 2030-03-31** ✔. (Driver codes are not shredded, so `HD_IMP_NN`/`U_IMP1`/`U_IMP2` are taken on trust from source — consistent with the TODO's own "not currently shredded") |
| 46–48 | "`upper-tier` statistic. The second value in **`8 UT 30`**" | **STALE example** | `8 UT 30` does not occur in the catchment. The in-graph example is **`4.2 UT 16`** (042451 / `0111`). The `upper-tier` modifier does exist in `winep.duckdb` statistics ✔ |
| 92–97 | "Find the limits still needing attention with: `SELECT ?l ?stmt WHERE { ?l a reg:ProposedLimit ; reg:limitStatement ?stmt . FILTER NOT EXISTS { ?l reg:upperBound\|reg:lowerBound ?b } }`" | **WRONG — the query overstates the backlog 4×** | Run live it returns **8** rows, but **6 of them are `CarriedOverLimit`s** (`"No change from current"`) which are *deliberately* modelled with `reg:continuesCondition` instead of a bound — they need no attention. Only **2** (the `TBC`s) do. The query needs `FILTER NOT EXISTS { ?l reg:continuesCondition ?c }` |
| 24–36 | Party column hard-defaults to "Wessex Water"; `LEDE.wessex` hard-codes the company | CONFIRMED | `app/app.js` |
| 99–113 | "Even at 5 remaining, the escape hatch is a permanent part of the model" + the (clearly fictional) England-away-match-days example | CONFIRMED as illustrative | The `08WW102104/limit/0067` triple is **not** in the graph — it is an invented illustration. Fine, but a reader could mistake it for real data; consider labelling it |

**Human must decide:** this file needs a single opening sentence stating which population it
describes. If it is meant to describe the *shipped graph*, then almost every number in it must be
restated (268→27, 196→19, 67→6, 5→2, 12→5, 7→0, ~18→0) and two whole sections (chemical analyte,
load limits) become non-issues.

---

# 5. `ttl/sfi/README.md` — clean

| LINE | CLAIM | VERDICT | EVIDENCE |
| --- | --- | --- | --- |
| 16–20 | clipped to catchment via `ST_Within`; national source | CONFIRMED | `sfi_to_db.py` |
| 20–24 | "one row per drawn point" → collapsed to "**one row per option**", points → single `MULTIPOINT`, quantities summed | **CONFIRMED** | `ttl/sfi.ttl` geometries are `MULTIPOINT (…)` |
| 43–44 | "option `1805262/CHRW3` at **12,900 m** against **£10 per 100 m** → **£1,290**" | **CONFIRMED exactly** | live graph: `1805262/CHRW3` `mtl` = **12900**; concept `CHRW3` `paymentRate` = **10** GBP per **100** `unit:M`; `annualPayment` = **1290** GBP |
| 46 | "Result: ~**1,115** options across the catchment" | **CONFIRMED** | `COUNT(DISTINCT ?o) WHERE { ?o a core:Option }` = **1115** |
| 51–60 | payment text captured not interpreted; only per-ha and per-100 m rates costed | **CONFIRMED (consistent)** | **574** of 1115 options carry `defra-farming:annualPayment`; the other 541 have a `PaymentRate` but no `perQuantity` — exactly as described |
| 30–36 | concept scheme from `SFI Option details.xlsx` + PDF fallback | CONFIRMED | both source files exist |
| 69–70 | `sfi.duckdb` / `sfi_raw.ttl` gitignored | CONFIRMED | neither is tracked (nor currently present) |

---

# 6. `ttl/designations/README.md` — one clean half, one badly broken half

| LINE | CLAIM | VERDICT | EVIDENCE |
| --- | --- | --- | --- |
| 25–28 | "→ **71 SSSI, 7 SAC, 3 SPA** (**81** sites)" | **CONFIRMED, every number** | live graph `GROUP BY core:hasClassification`: SSSI **71**, SAC **7**, SPA **3**; `dn:ProtectedSite` total **81** |
| 24–25 | "buffered ~**3 km** so edge sites are kept whole" | CONFIRMED | `designations_to_ttl.py:36` `buffer(0.03)` ≈ 3.3 km at 50.7°N |
| 30–31 | RDF "~**2 m** simplification"; display GeoJSON "~**30 m**" | **CONFIRMED** | `RDF_SIMPLIFY = 0.00002` (≈2.2 m), `DISPLAY_SIMPLIFY = 0.0003` (≈33 m) |
| 34 | "`defra-nature:ProtectedSite` (in **`ontology-work/defra-nature.ttl`**)" | **WRONG — broken reference** | **`ontology-work/` does not exist**, and never has: `find` finds no `defra-nature*` file anywhere in the repo, and `git log --all -- ontology-work` is empty. The only `.ttl` files present are `raw_datasets/designation_types.ttl` and the `ttl/*.ttl` products |
| 58–61 | "**CRS.** WGS84 lon/lat with an explicit CRS84 URI on **every** `wktLiteral` — **one CRS across the whole graph** (**discharge points and SFI options are WGS84 too**), so `geof:distance(…, units:metre)` works directly on GraphDB **without reprojection**" | **WRONG — on every clause** | Live graph CRS census: **`reg:DischargePoint` 95 × EPSG:27700**; **SamplingPoint 161 × EPSG:27700**; **WINEP actionSite 11 × EPSG:27700**; `dn:ProtectedSite` 81 × CRS84; **`core:Option` (SFI) 1115 × NO CRS URI at all**. It is **not** one CRS; discharge points are **not** WGS84; SFI options do **not** carry an explicit CRS84 URI. Any `geof:distance` between a discharge point and a designation is a **cross-CRS comparison** and needs reprojection |
| 55 | designations are self-contained (codelist baked in) | CONFIRMED | `designation_types.ttl` exists and is inlined |

**This is the most consequential error in the audit.** The regulation README (L84–96) *deliberately*
publishes discharge and sampling points in **EPSG:27700** ("not a convenience reprojection"). The
designations docs were never updated, and still assert the opposite. Everything downstream of that
assertion — §1 and §2 of the designations TODO — is now broken (below).

---

# 7. `ttl/designations/TODO.md`

| LINE | CLAIM | VERDICT | EVIDENCE |
| --- | --- | --- | --- |
| 40–47 | "⚠️ **This query returns nothing on the bundled `/sparql`**… `geof:distance` computes **only between two POINTs** — given a POLYGON operand it returns *unbound*… `geof:buffer` is not implemented" | **CONFIRMED** | Ran the §1 query verbatim → **0 bindings** ✔. `geof:distance(POINT, POINT)` → `704.288…` ✔ works. `geof:distance(POINT, <site polygon>)` → **unbound** ✔ |
| 45 | "(The `CRS84` prefix is fine; that is **not** the cause.)" | **WRONG / STALE** | It is *now* a cause. See below |
| 49–58 | "**A version that runs on the bundled endpoint** (centroid approximation)… Swap only the distance `BIND`… `FILTER(?d <= 1000)`" | **WRONG — it returns ZERO rows** | Ran the centroid query verbatim against the live endpoint → **0 bindings**. And the failure is *worse* than "returns nothing": `geof:distance` is **not** unbound here, it returns **~5,408,774 m (≈5,400 km)** — it reads the discharge point's BNG easting `389950` as a **longitude in degrees**. So the query silently computes nonsense and `FILTER(?d <= 1000)` drops every row. It is not "a rough screen"; it is garbage. Cause: the discharge point is EPSG:27700, the site centroid is CRS84 |
| 60–65 | "permit **042451** … is **86 m** from the *boundary* of Morden Bog & Hyde Heath SSSI" | **WRONG** | Computed properly in EPSG:27700 from the store's own `POINT(389950 93350)`: **14 m**, not 86 m |
| 62–63 | "(and the co-located Dorset Heaths SAC / Dorset Heathlands SPA)" | **WRONG** | Those are at **287 m**, not co-located with Morden Bog's 14 m |
| 63–64 | "that heath's *centroid* is ~**2.1 km** away" | **CONFIRMED** | **2,174 m** |
| 64–65 | "the centroid query instead surfaces 042451 at **948 m** from **East Coppice SSSI**" | **WRONG (number) / CONFIRMED (structure)** | East Coppice SSSI centroid is **926 m** away (boundary **772 m**), not 948 m. But the *structural* claim is exactly right: ranking by centroid puts **East Coppice (926 m) ahead of Morden Bog (2,174 m)**, even though by boundary Morden Bog is **14 m** and East Coppice **772 m**. The illustration works; the numbers are stale |
| 70–78 | §2 "everything is stored WGS84/CRS84 (**one CRS across all graphs**) … the fallback is to **also emit a projected EPSG:27700 geometry on both the designations and the discharge points**" | **STALE** | The **discharge points are already EPSG:27700**. The mismatch is real but points the other way: it is the **designations** that are the odd one out. The recommended "fallback" is half-done already, and nobody noticed |
| 99–104 | §5 the `/observations` proxy blocks pure-static | CONFIRMED | `app/server.py` proxies live |

**Human must decide:** the designations CRS story needs a single decision — either reproject the
designations to EPSG:27700 to match everything else, or reproject the points to CRS84 for the
spatial layer. Until then **both** the §1 GraphDB query and the §2 "runs today" query are wrong,
and the 86 m / 948 m figures should be replaced with 14 m / 926 m.

---

# 8. `raw_datasets/access_database_csv_files/README.md`

| LINE | CLAIM | VERDICT | EVIDENCE |
| --- | --- | --- | --- |
| 1 | "mdb-export from mdbtools has been used to extract the relevant tables from [data.gov.uk consented-discharges…] into csv files" | **UNVERIFIABLE (plausible)** | Cannot check the provenance offline. The four CSVs are consistent with that origin (`consents_active` 72,176 × 33, `consents_all` 37 × 33 — same column layout, `effluents` 238,840 × 14, `determinands` 497,418 × 18) |

**Gap worth closing (not an error, an omission):** the README does not say that **`consents_all.csv`
is a hand-cut 37-row extract of *revoked* permits**, not a full "all" table — a reader will
reasonably assume `consents_all` ⊇ `consents_active`. It does not (37 rows vs 72,176). This
directly matters: the regulation README's "1085 grid refs" and its scoring table depend on which of
these two files you read (see §1.4 / §1.3). The file naming actively misleads.

---

# 9. `ontop/README.md`

| LINE | CLAIM | VERDICT | EVIDENCE |
| --- | --- | --- | --- |
| 52–68 | the `usage: ontop <command>` block and command list | **CONFIRMED verbatim** | `./ontop/ontop` prints exactly that block, same 9 commands |
| 19 | "For jdbc drivers … put them into the `jdbc` directory" | CONFIRMED | `ontop/jdbc/` exists |

This is the **upstream vendor README**, not project documentation. It is accurate but describes the
ontop CLI generally; it says nothing about this project's four `.properties` files
(`duckdb.properties`, `duckdb-regulation.properties`, `duckdb-breaches.properties`,
`duckdb-winep.properties` — all present ✔ and all correctly referenced by the dataset READMEs).

---

# 10. `app/TODO.md` — CONFIRMED, bug still live

| LINE | CLAIM | VERDICT | EVIDENCE |
| --- | --- | --- | --- |
| 5–10 | "Running a SPARQL `ASK` … fails with **HTTP 400** and the message `'pyoxigraph.QueryBoolean' object has no attribute 'variables'`" | **CONFIRMED — reproduced live, verbatim** | `POST ASK { ?s ?p ?o }` → **HTTP 400**, body = `'pyoxigraph.QueryBoolean' object has no attribute 'variables'` |
| 14–18 | "Cause. `results_to_json()` detects an `ASK` result with `isinstance(results, bool)`" | **CONFIRMED** | `app/server.py:209` — `if isinstance(results, bool):` / `:210` `return {"head": {}, "boolean": results}` |
| 11 | "`SELECT` and `CONSTRUCT`/`DESCRIBE` are unaffected" | CONFIRMED | all SELECTs in this audit ran fine |

Still real, still unfixed, diagnosis is exactly right.

---

# 11. Link / file-reference check

All **markdown links in all in-scope docs resolve**:
`../breaches/README.md` ×4 ✔, `../../app/points.html` ✔, `app/TODO.md → server.py` ✔, plus 3
external URLs (agrimetrics, gov.uk guidance, oxigraph#1560). **No heading anchors are used**, so
none can dangle.

Every script/data file named by the docs exists, **except**:

| reference | in | status |
| --- | --- | --- |
| `ontology-work/defra-nature.ttl` | `ttl/designations/README.md:34` | **BROKEN — does not exist, never has** |
| `enrich_sampling_points.py` | `ttl/regulation/README.md:180` | **OK** — correctly past-tense ("This replaced an earlier…"); the file is deleted, as intended. Only mention in the repo |
| `winep_overrides.csv` | `ttl/winep/TODO.md:88` | OK — explicitly a *proposed* future file |
| `defra-regulation.ttl` | `ttl/breaches/README.md:109` | OK — the published DEFRA ontology, not a repo file |
| `sfi.duckdb`, `sfi_raw.ttl` | `ttl/sfi/README.md` | OK — correctly described as gitignored regenerable intermediates |

---

# 12. What the human must decide — ranked

1. **Designations CRS (breaks two documented queries).** The graph is **not** one CRS: discharge /
   sampling / WINEP-action points are **EPSG:27700**; designations are **CRS84**; SFI options carry
   **no CRS URI**. Fix the claim in `designations/README.md:58-61`, and fix or delete the centroid
   query in `designations/TODO.md:49-58` — it currently returns 0 rows because `geof:distance`
   reads a BNG easting as a longitude and reports **5,400 km**. Replace 86 m → **14 m** and
   948 m → **926 m**.
2. **`permit_version_dates.csv` is stale.** 67 of 170 versions are undated (62 on *numeric*
   permits), not the "5" the README claims; 45 numeric pairs were never fetched. Re-run
   `fetch_version_dates.py`. Note this also affects which version breaches are judged against.
3. **WINEP TODO describes the wrong population.** 268/196/67/5, the "5 uninterpreted", the
   "~18 chemical limits" and the "12 pairs / 7 chemical" are all pre-clip. The graph holds
   27/19/6/2, **zero** chemical limits and **5** competing-driver pairs. State the population, or
   restate the numbers.
4. **The scoring table's provenance.** It reproduces exactly from `consents_active.csv` **alone**
   (69 / 33 / 53 / 53), but the store's published geometry uses `active + all` (which gives
   87 / 41 / 64 / 66). Pick one and say so. Under the union, the "finest geometry does no better
   than the outlet ref" sentence needs softening (66 > 64).
5. **Breaches non-detect sub-figures.** `70.7%` BOD → **63.9%**; `47.1%` ammonia → **35.9%**.
   (The 34% overall, and the worked example that carries the argument, are both correct.)
6. **WINEP union rule.** `042116` is *not* a site-clause example (it is a regulation permit), and
   **no emitted action depends on the site clause at all**. Reword, or drop the clause.
7. **"the extra 26 include flow, colour, turbidity and pH"** — colour, turbidity and pH are already
   in the 12. Only flow is new (plus metals, pesticides, storm telemetry).
8. **`ontology-work/defra-nature.ttl`** does not exist. Either add the ontology or drop the pointer.
9. **"26 permits whose ammonia limit is a percentile"** → **24**.
10. **`regulation_to_db.py`'s own header comments** (L240, L246–249, L527) still carry the
    pre-rewrite numbers (67 points / 32 coords; 38-56-54/64) and still describe the deleted
    sampling-point fallback. They now contradict the README.
11. **`consents_all.csv` is not "all"** — it is 37 hand-cut revoked-permit rows. Say so in
    `raw_datasets/access_database_csv_files/README.md`; the name misleads and the choice changes
    published numbers.
12. **Unverifiable-by-construction:** the breaches README's "64 breach rows for 39 real events /
    27 on the version in force". The code is deleted and its gitignored input has been regenerated.
    Keep as history or drop, but it can never be re-checked.
