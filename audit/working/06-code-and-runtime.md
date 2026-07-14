# Audit — code-comment assertions vs. actual data & runtime behaviour

Repo: `/Users/waf/git/projects/demonstrator-poc` @ `9a30d17` (clean)
Live app: `http://127.0.0.1:8000/` · SPARQL: `/sparql` (35,513 triples)
Driven headless with Firefox 
Nothing was modified.

Store facts used throughout (from `ttl/regulation/regulation.duckdb` and `/sparql`):

| | |
|---|---|
| permits | 61 (58 carry conditions) |
| discharge points (outlets) | **102** — 95 with geometry, **7 with none** |
| distinct outlet coordinates | **37** (83 outlets share a coordinate) |
| discharge_point_monitoring | 96 edges, 70 distinct sampling points |
| sampling points | **161** — **91** monitor no discharge |
| conditions / condition_bounds | 587 / 800 |
| breaches | 270 (1 current, 35 permits) |

---

## PART A — code-comment assertions

### `ttl/regulation/regulation_to_db.py`

| SOURCE | CLAIM | VERDICT | EVIDENCE | HUMAN MUST DECIDE |
|---|---|---|---|---|
| L21–28 (header) | Permit **043231** showed 1 of its 2 outlets; **400114/CF/01** 1 of its 3; **050922** vanished entirely | **CONFIRMED** | `discharge_points`: 043231→2, `400114/CF/01`→3, 050922→1 outlet & 0 `permit_versions` | — |
| L24–26 | the missing outlets' "every 2020-2026 sample reads *No flow/discharge at sampling point*" | **CONFIRMED** | Bulk obs: SW-50440146 100 % no-flow (n=58); SW-50570152 100 % (n=58); SW-50570160 100 % (n=58) | — |
| L26 | 050922's "only samples being a site inspection" | **CONFIRMED** | SW-50331270 has exactly 2 rows, determinands 4883 *Site Inspection : Pass/Fail* ("Pass") and 7434 *National Grid Reference : Field report* | — |
| L30–35 | Sourcing conditions from `determinands.csv` would take the catchment "from 587 conditions over 12 substances to **919 over 38**"; the extra **26** include flow/colour/turbidity/pH | **CONFIRMED (exact)** | `determinands.csv` SW+ABSOLUTE, scoped permits, distinct (permit,version,DETE_CODE) = **919**; distinct DETE_CODE = **38**; store = 587/12; 38−12 = 26 | — |
| L165–168 (SCOPE) | "A permit is in scope if it is monitored at a sampling point the catchment holds observations for" | **CONFIRMED in effect / SQL misleading** | Stated rule applied to the 149-point observation download → **61 permits** = `scoped_permits` (61). But the SQL's first UNION term (`raw`) only holds **54** points and alone yields 60; the rule is actually satisfied by the `sampling_points` term. No second-order expansion (0 permits scoped only via register-only points). | Whether to rewrite the SQL to say what the comment says (scope silently depends on `sampling_points.csv` being in sync) |
| L190–194 | "A scoped permit with no observed condition (e.g. 050922) therefore has outlets but no versioned document" | **CONFIRMED** | 050922: 1 discharge point, 0 rows in `permit_versions` | — |
| **L228–229** | "The active + revoked (all) register extracts together cover **every monitored discharge point, so all get a real NGR**" | **WRONG** | 7 discharge points have **no** geometry (040137/1/1, 040070/1/1, 040070/1/2, 040091/1/1, 040091/1/2, 040096/1/1, 040096/1/2). **5 of them are monitored** (`discharge_point_monitoring`). The sentence directly contradicts the NO-FALLBACK section 40 lines below, the script's own `no_geom` print, and points.html ("7 of this catchment's 102 outlets have no coordinate at all") | Delete the sentence — it is the only place in the repo that says every outlet has an NGR |
| **L240–241** | "In this catchment that puts **67 discharge points on 32 distinct coordinates**" | **STALE / WRONG** | The script's *own* print computes **95 discharge points on 37 distinct coordinates; 83 share a coordinate**. `SELECT COUNT(*), COUNT(DISTINCT wkt) FROM discharge_point_geometry` → 95 / 37 | Re-derive the prose from the build output |
| L241 | "at Brockhill Watercress Farm, 7 outlets across 4 permits (043244, 043245, 401057, 401058) land on POINT(383690 92820)" | **CONFIRMED (exact)** | `SELECT … WHERE wkt LIKE 'POINT(383690 92820)%'` → exactly those 7 rows / 4 permits | — |
| L236–240 | "1085 grid refs are shared by >1 permit, and in **1083** of those every permit names the same discharge site; RAF Brize Norton has **13** permits on one ref" | **CONFIRMED (exact)** | `consents_active + consents_all`: 1085 shared `DISCHARGE_NGR`; 1083 with a single `DISCHARGE_SITE_NAME`; BRIZE NORTON → SP2896807152 with 13 permits (active alone gives 1076/1074 — the numbers only reproduce with **both** extracts, as the comment implies) | — |
| **L246–250** | "Scored over the **64** discharge points matchable to a register row, a nearest-sampling-point join gets **38/64** from the site ref, **56/64** from the outlet ref and **54/64** from the effluent ref *(finer is not even monotonically better)*, against **64/64** for `water:monitoredAt`" | **WRONG on every number, and the rhetorical point is now inverted** | Reproduced (nearest of all 161 sampling points, BNG Pythagoras, consents joined on permit+outlet+effluent): **87** matchable; site **41/87**, outlet **64/87**, effluent **66/87**, monitoredAt **87/87**. Finer *is* now monotonically better (41 < 64 < 66), so the parenthetical is false. The app's own live scoreboard on `#/why` (computed at render time) says **42/91 (46 %)** for the site ref — i.e. the running app already contradicts the comment | Recompute and restate; decide whether "matchable" means 87 (join on permit+outlet+effluent) or something else. **The comment and the app disagree in public.** |
| L254–273 (NO FALLBACK) | rationale 1 (fabricated fact), 2 (corrupts the scoring: fallback outlets sat 0 m away), 3 (map lie: 401025's outlets appeared linked to 040091's) | **CONFIRMED (logic sound, currently true)** | Geometry is built **only** from `consents.DISCHARGE_NGR` (no sampling-point join in the DDL). 040091 now has no geometry, so no leg can be drawn from it; only **1** genuine coincidence remains (040111/1/1 = SW-50900956), and the script reports it | — |
| L537–539 | old check "reported a clean bill of health while **6** outlets were being published at fabricated coordinates" | **UNVERIFIABLE / inconsistent with today** | Today the fallback would have fired for the **5** no-geometry outlets that *are* monitored (7 no-geom, 2 unmonitored). The historical 6 cannot be recovered from git | Restate as 5, or drop the number |
| **L522–527** (comment above the summary block) | "(2) How many outlets **fall back to their sampling point's coordinate** … those sit exactly ON their sampling point" | **STALE** | The fallback was deleted (L254–273 says so at length). No such count is computed; the code below counts `no_geom` instead. Two comments in one file describe opposite behaviours | Delete (2) |
| L342–362 (STATISTICS) | prefLabels "kept byte-identical to WINEP's or the concept would end up with two `skos:prefLabel`s" | **CONFIRMED** | `ttl/winep/winep_to_db.py:99` `STAT_LABEL` = {annual-average:"Annual average", percentile-95:"95th percentile", maximum:"Maximum (absolute)"} — identical. SPARQL: **no** statistical-modifier has >1 `skos:prefLabel` | — |
| L359–361 | "MEAN VALUE maps onto annual-average because the EA defines the mean compliance limit AS an annual 12-month mean" | **CONFIRMED (consistent)** | `condition_bounds` has 16 `annual-average` upper bounds; `breaches_to_db.py` assesses them on a rolling 12-month window | Editorial: the EA-guidance claim itself is a domain assertion (source URL is cited) |
| L361–362 | bound_kind: MAXIMUM/95 PERCENTILE/MEAN VALUE upper, only MINIMUM lower | **CONFIRMED** | `condition_bounds` by statistic: percentile-95 345 (upper), maximum 337 (upper), **minimum 102 (lower)**, annual-average 16 (upper) | — |
| L384–386 | `MEDIAN` in the vocabulary | **INERT** | `RULE_TYPE` in `raw` = only MAXIMUM VALUE / MINIMUM VALUE / 95 PERCENTILE / MEAN VALUE. The `median` concept is minted (SPARQL confirms) but **0 bounds** use it, and `breaches_to_db.py` silently `continue`s on it | Keep as forward-declaration, or drop |
| L399–406 | "Every rule type the source actually uses must be known to the vocabulary … Fail loudly" | **CONFIRMED** | The guard runs on `raw.RULE_TYPE`; all 4 present types are mapped, so it never fires | — |
| L420–434 (condition grain) | Register keys limits at (permit,version,outlet,effluent,substance) but a Condition is (permit,version,substance); `MAX()` collapses to the loosest; "count reported at the end" | **CONFIRMED** | `collapsed` = **8** bounds differ across outlet/effluent within one condition; `mixed_units` = 0 | Whether publishing the *loosest* limit is acceptable for 8 conditions |
| L423–425 | "permit 042451 carries the maximum in CODE_1 and the percentile in CODE_2; permit 401747 does the reverse" | **CONFIRMED (exact)** | `determinands.csv`: 042451/det 0111 → CODE_1 MAXIMUM 43, CODE_2 95 PERCENTILE 7. 401747/det 0111 → CODE_1 95 PERCENTILE 20, CODE_2 MAXIMUM 48 | — |
| L500–511 | old breach code "judged every observation against EVERY version … **64 breach rows for 39 real events**", and "ran on data with all the '<' non-detects dropped" | **CONFIRMED (exactly reproducible)** | Re-ran the old gaps-and-islands algorithm (git `566887a`) against the current `raw`: **64** breach periods across all versions; **39** when restricted to each permit's latest version. `link_data.py:27-30` still drops non-numeric results, and `raw` is built from that CSV | — |

### `ttl/regulation/fetch_sampling_points.py`

| SOURCE | CLAIM | VERDICT | EVIDENCE | HUMAN MUST DECIDE |
|---|---|---|---|---|
| docstring L21–27 | Fetches the union of (1) every catchment observation point and (2) every `EFF_SAMPLE_POINT` of a permit that samples at one of them | **CONFIRMED** | Reimplemented `notations()`: catchment 149 ∪ permit points 76 = **167 wanted**; `sampling_points.csv` = **161** rows (6 not resolvable by the archive: SW-50410121, SW-50440124, SW-50520133, SW-50570248, SW-50959903, SW-6WXE0555) | — |
| "**161 of 167**" *(the claim lives in `ttl/regulation/README.md:175`, **not** in the .py)* | 161 resolved of 167 wanted | **CONFIRMED** | as above (167 wanted, 161 written, 6 unknown to the archive) | The .py's own docstring never states the counts; only the README does |
| README L175: "adding **12** more, including **storm overflows** the download never mentioned" | 12 register-only points | **CONFIRMED** | 18 register-only notations exist; **12** resolve and are in the CSV — **11 of them STW storm overflows** + 1 watercress farm (Doddings Farm). The archive knows nothing about the other 6 | — |
| README L153: "Only **70** of the 161 sampling points monitor a discharge" | | **CONFIRMED** | `SELECT COUNT(DISTINCT sp_notation) FROM discharge_point_monitoring` = 70; 161 − 70 = 91 unpermitted | — |
| L18–19 | "Observational *values* are still NOT stored: they stay federated" | **CONFIRMED** | `sampling_points.csv` columns are label/wkt/type/status only; the chart is fetched live via `/observations` (verified at runtime: "live from the EA Water Quality Archive") | — |

### `ttl/regulation/regulation.obda`

| SOURCE | CLAIM | VERDICT | EVIDENCE |
|---|---|---|---|
| whole file | *(task asked to audit "mapping comments")* | **N/A — there are none** | The 145-line file contains **zero** comment lines. All mappings were checked against the DuckDB tables and resolve (e.g. `DischargePointGeometry` selects from `discharge_point_geometry`, so the 7 geometry-less outlets simply produce no `geo:hasGeometry` — consistent with the NO-FALLBACK design) |

### `ttl/breaches/breaches_to_db.py` and `fetch_compliance_observations.py`

| SOURCE | CLAIM | VERDICT | EVIDENCE | HUMAN MUST DECIDE |
|---|---|---|---|---|
| `breaches_to_db.py` L30–32 | `"<5"` non-detects "are **34 %** of the compliance set (**70 % of BOD**)" | **HALF WRONG** | Compliance set: 13,892 / 40,600 = **34.2 %** ✔. But BOD (det 0085) in the *compliance* set is **63.9 %** `<`, not 70 %. The 70 % figure is the **bulk-file** number (70.4 %) — the sentence attributes it to the wrong set | Fix "(70 % of BOD)" → 64 %, or say "70 % in the bulk file" |
| `breaches_to_db.py` L34 | "no flow → EXCLUDED" | **CONFIRMED but INERT** | `compliance_observations.csv` contains **zero** "No flow" rows (26,698 numeric + 13,892 `<` + 10 `>`). The exclusion path never fires; the script prints `excluded 0` | Keep as a guard; the header implies it is doing work |
| `breaches_to_db.py` L33 | `">33" → 33.0` | **CONFIRMED** | 10 such rows exist (`>33`, `>28`, `>122`, …); `parse_result` returns the numeric value | — |
| `breaches_to_db.py` L167–172 | version-at-sample-time logic; "without this a 2023 sample is tested against the limits of a version revoked in 2011 — which is how the old pipeline booked 64 breach rows for 39 real events" | **CONFIRMED** | See above — 64 / 39 reproduce exactly | — |
| `breaches_to_db.py` L52–57 (LUT), L69–72 (T90) | EA 95-percentile look-up table, one-sided 95 % t | **CONFIRMED internally consistent** | Bands are contiguous and monotone (4-7→1 … 351-365→25); `lut_allowance` returns `None` below n=4. Not independently checked against the published EA table | Someone should check the LUT against the EA guidance PDF |
| `breaches_to_db.py` L311–315 | evidence joined via `sosa:hasFeatureOfInterest` rather than an IRI-prefix `STRSTARTS` | **CONFIRMED** | `observation_sampling_point` table exists and the app's breach query joins `?obs sosa:hasFeatureOfInterest ?sp` — no `STRSTARTS` anywhere in `PQ.breaches` | — |
| `fetch_compliance_observations.py` L10–14 | link_data drops non-numeric results = "**46 %** of all results"; "**70.7 %** of BOD, **47.1 %** of ammonia and **33.6 %** of suspended solids are `<` non-detects" | **CONFIRMED (one 0.3 pp drift)** | Bulk file: non-numeric **46.5 %**; BOD `<` **70.4 %** (claim 70.7); ammonia **47.1 %** ✔ exact; susp. solids **33.6 %** ✔ exact | 70.7 vs 70.4 — trivial, but it is a *stated* figure |
| `fetch_compliance_observations.py` L19–21 | `complianceOnly=true` "drops an ambient river point from **149** observations to 0, and leaves a sewage-effluent point untouched" | **CONFIRMED in substance; the "149" is unattributable** | Live against the EA archive (det 0111): SW-50410164 250→**0**, SW-50430109 124→**0**, SW-50430144 185→**0**, SW-50440119 219→**0**, SW-50440158 52→**0**. Sewage FE: SW-50410119 250→250, SW-50410150 235→235, SW-50331270 23→23 (**untouched**). No point I tried has 149 | Name the point, or drop the number |
| **`fetch_compliance_observations.py` L23–24** | "Scope: … **175 pairs over 54 sampling points**" | **STALE — and the cache is now short** | `pairs_in_scope()` run against today's `regulation.duckdb` returns **228 pairs over 69 sampling points**. The committed `compliance_observations.csv` holds exactly **175 pairs over 54 sampling points** — i.e. the cache predates the register-sourced sampling-point/monitoring expansion. **53 pairs / 15 sampling points are missing from the breach assessment**, and an incremental re-run would fetch them | **Material.** Re-run the fetch and rebuild breaches, then decide whether the 270-breach headline changes |

### `app/app.js`

| SOURCE | CLAIM | VERDICT | EVIDENCE | HUMAN MUST DECIDE |
|---|---|---|---|---|
| L5 (header) | "switches between **four** 'views'" | **STALE** | There are **3**: `regulated`, `measured`, `farming` (`#views` buttons; `setView([...].includes(view) ? … : "regulated")` at L2477) | — |
| L257 (PQ header) | "to reuse results across the **four** views" | **STALE** | same as above | — |
| **L254–255** | "Each of these **reproduces, as ONE declarative query, the row set the table shows**" | **PARTLY WRONG — 3 of 6 do not** | Ran each card's own `◈ SPARQL` href (the exact shipped query) against `/sparql`: <br>• `breaches` (no filter) **270 = 270** ✔ · (sub=0111) **5 = 5** ✔<br>• `permits` **58 = 58** ✔<br>• `actions` (no filter) **11 = 11** ✔<br>• `applications` **262 = 262** ✔<br>• **`samplingPoints` 187 rows vs a 161-row table** ✘ (the `OPTIONAL{?dp water:monitoredAt ?sp . ?permit reg:permitSite ?dp}` fans out for points monitored by >1 permit; `SELECT DISTINCT ?sp` = 161)<br>• **`substanceStory(0111)` 76 rows vs a 27-row table** ✘ (fan-out over `?monitoredAt` **and** over multiple `upperBound`s; distinct (permit,sub,action) = **27** = the table)<br>• **`actions()` under a substance filter: 11 rows vs a 1-row table** ✘ (`PQ.actions()` takes no substance argument at all) | Add `DISTINCT`/`GROUP BY` to `samplingPoints` and `substanceStory`; give `actions` the substance filter — or widen the drift note, which today only admits the *opposite* error ("omits proposed-only rows") |
| **L272–273** | "make it a plain join and the **95** points that belong to no permit vanish" | **WRONG** | SPARQL: sampling points with `FILTER NOT EXISTS { ?dp water:monitoredAt ?sp }` = **91**. (95 is the count of *outlets with geometry* — the wrong number was carried across) | — |
| L37 | "17 distinct types in this catchment alone" | **CONFIRMED** | `sampling_point_types` = 17 | — |
| L1801–1816 | "whether a column is numeric is a property of the column…"; "one identifier anywhere makes the whole column text"; empty cells always sink | **CONFIRMED (see Part B.1)** | Permit column sorts 040015 … 402270 … EPRBB3593EG … EPRYP3399VF; "Limit breached" sorts 1, 3 … 75, 77, **4000** (numeric, not lexical) | The "empties sink" rule only holds where `data-sort=""` is set; cells rendering literal `none` / `unpriced` (`data-sort="-1"`) are *values*, not empties, and do not sink |
| L1386–1390 (LEDE) | "the ${n.outlets} outlets sit on just ${n.coords} distinct coordinates" | **HONEST BUT INCONSISTENT** | Renders "**95 outlets** … 37 distinct coordinates" — `n.outlets = drawnDps.length`, i.e. only the outlets that *have* geometry. points.html and the Explorer both say **102** outlets. Two pages of one app publish two different outlet counts | Say "95 of the 102 outlets we can draw" |

### `app/points.js`

| SOURCE | CLAIM | VERDICT | EVIDENCE | HUMAN MUST DECIDE |
|---|---|---|---|---|
| L3–9 (header) | "laid out as **five** screens" and lists `#/why #/blackheath #/brockhill #/doreys #/explorer` | **STALE** | There are **six** routes — the header omits `#/unlocatable`, which is defined at L316 and in `ROUTES` at L326, and renders fine | — |
| **L12–14** | "**Every number** on these pages is COMPUTED FROM THE STORE at render time (**see the `fact()` helpers**) rather than typed into the prose, so the page cannot drift away from the data behind it" | **WRONG twice** | (a) **There is no `fact()` helper** — `grep -n "fact("` matches only this comment. (b) Numbers *are* typed into the prose: L302-304 "**Seven** outlets, belonging to **four** different permits … one identical coordinate … at **four** different places"; L713 `<h3>⊕ Seven outlets, one coordinate</h3>`; L733-734 "these **seven** are **one dot** … give all **seven** the same answer"; L309 "just **a kilometre away**". They happen to be *true* today (7 outlets / 4 permits at POINT(383690 92820) — verified), but they are exactly the hard-coded prose the comment says does not exist. The *derived* statistics (scoreboard, radii table, gaps) **are** computed live | Either add the `fact()` helper the comment promises, or soften the claim to "every *statistic*" |
| L53–57 | "**Seven** outlets in this catchment have no published coordinate" | **CONFIRMED** | 102 − 95 = 7; `#/unlocatable` renders "7 of this catchment's 102 outlets" from the store | — |
| L627 vs L908 | kicker reads "Example {n} of **3**" on blackheath/brockhill/doreys but "Example **4 of 4**" on unlocatable | **INCONSISTENT (runtime)** | `EXAMPLES.length` = 3 and the unlocatable kicker is hard-coded "4 of 4". A reader clicking Next goes "Example 3 of 3" → "Example 4 of 4" | — |
| L1115, explorer | "61 permits own 102 discharge points, monitored across a layer of 161 sampling points — of which only 70 monitor a discharge" | **CONFIRMED (all four)** | 61 / 102 / 161 / 70 all match the store | — |
| L93–98 | proximity query ranks by **squared** distance because SPARQL has no SQRT and ranking is preserved | **CONFIRMED** | Sound: monotone transform; EPSG:27700 is metric so Pythagoras is ground distance | — |

### `link_data.py`

| SOURCE | CLAIM | VERDICT | EVIDENCE | HUMAN MUST DECIDE |
|---|---|---|---|---|
| L60–64 | "Keep every rule type … Filtering to MAXIMUM/MINIMUM published the backstop and dropped the real limit — **Total Nitrogen is limited only ever by MEAN VALUE**, so it never reached the graph at all" | **CONFIRMED** | `determinands.csv` (SW/ABSOLUTE, scoped): det **9686** appears with `MEAN VALUE` and **nothing else** (3 rows). Rule types now kept: MAXIMUM 858, 95 PERCENTILE 439, MINIMUM 252, MEAN 16 | — |
| L87–93 | 95 PERCENTILE / MEAN VALUE are period statistics → `ROW_PASS_STATUS = NA`; leaving them `False` "would have poisoned every group they touch (the `.all()`), inventing a breach for every ammonia observation at the **26** permits whose ammonia limit is a percentile" | **CONFIRMED except the number: it is 24, not 26** | `observations_with_permits_and_rules.csv`: `95 PERCENTILE` → **13,809 rows all NA**; `MEAN VALUE` → 1,470 all NA; `MAXIMUM` → 14,000 True / 72 False; `MINIMUM` → 6,316 True. **Zero** period-rule rows carry a non-NA status. Permits with an ammonia (0111) 95-percentile rule = **24** (store agrees: 24; 14 of them percentile-only) | Fix 26 → 24 |
| L109–117 | grouping status computed over per-sample rows only, broadcast back; groups with no per-sample rule stay NA | **CONFIRMED** | `OBSERVATION_GROUPING_PASS_STATUS`: True 25,257 · **NA 10,335** · False 75 | — |

---

## PART B — runtime behaviour (headless Firefox)

### B1. Pagination & sorting — **CONFIRMED**

Every top-level table: `PAGE_SIZE = 10`, `« ‹ 1 2 3 › »` pager with an "N–M of T" readout, **every** `<th>` carries `.sortable` and responds to a click.

| view | card | rows | pager | all cols sortable |
|---|---|---|---|---|
| regulated | Permits & limits | 58 | `«‹12345›» 1–10 of 58` | ✔ |
| regulated | Breaches | 270 | `«‹12345›» 1–10 of 270` | ✔ |
| regulated | WINEP Actions | 11 | `«‹12›» 1–10 of 11` | ✔ |
| measured | Sampling points | 161 | `«‹12345›» 1–10 of 161` | ✔ |
| farming | Applications | 262 | `«‹12345›» 1–10 of 262` | ✔ |
| farming | Options (after selecting an app) | 5 | `«‹1›» 1–5 of 5` | ✔ |

Order verified across **all pages**, both directions (not merely "it changed"):

* **Permit column sorts as identifiers** — asc: `040015, 040067, 040070, …, 402100, 402270, EPRBB3593EG, EPRYP3399VF`; desc exactly reversed. `040136 < 400505 < EPRBB3593EG` holds. (Column-level `NUMERIC` test at L1810 correctly demotes the whole column to text because of the leading zeros / `EPR…`.)
* **Numeric columns sort numerically** — "Limit breached" asc ends `… 75, 75, 77, **4,000**` (a lexical sort would put 4,000 first). "Discharge points" 1→5. "Options" 1→18. "Total cost" £…→£177,725.
* 8 header clicks across 6 cards; every resulting order re-verified against the underlying `data-sort` keys.

### B2. Expandable rows survive sorting — **CONFIRMED by content**

Sorted *Permits & limits* descending by Permit, turned to page 3, expanded every row: `data-row` == `data-exp` for all 10 pairs, and the detail content matches the store for the row it sits under:

* `051340 v1` → Ammoniacal N 0.25, BOD 2, Colour 10 … = `condition_bounds` for 051340 v1 ✔
* `050753 v1` → Oxygen Dissolved **lower** 60 (its only bound) ✔
* `043478 v1` → pH 9/6, Susp. solids 20, Zinc 75 ✔

### B3. Map → paged-out table row — **CONFIRMED**

WINEP action `08WW102201` is the only row on page 2. Dispatching a click on its map marker turned the pager from `1–10 of 11` to **`11–11 of 11`** and left the row selected (`.sel`) and visible. (`wrap.revealRow` at L1906.)

### B4. Chart limit line / legend — **CONFIRMED both ways**

* **Unpermitted** SW-50440158 (permit `none`): `0` dashed lines; legend = *"◯ observation (52) · measured, not regulated — no permit limit here"*. No hit/miss.
* **Permitted** SW-50410119 (permit 402100, ammonia 95 %ile 6 mg/l): **4** dashed lines (stepped by version); legend = *"✕ miss (0) · △ over 95th percentile (1) · ◯ hit (311) · – – enforced limit (by version)"*.

### B5. Points apart — **CONFIRMED (with two prose defects)**

* All **6** routes render (`#/why 3.6 k chars`, `#/blackheath`, `#/brockhill`, `#/doreys`, `#/unlocatable 5.0 k`, `#/explorer 6.2 k`); no `.pts-error` anywhere.
* **Next chain**: `why → blackheath → brockhill → doreys → unlocatable → explorer`. **Prev chain**: exactly the reverse. ✔
* **`#/unlocatable` picker re-renders**: switching 040091 → 040070 changed the map (11 → 7 SVG paths) *and* the panels (different outlet/monitoredAt table). ✔
* **No discharge-point marker is drawn**: no path carries the DP colour `#3aa0ff`; only sampling points (`#46b978`), the 5/50/500 m circles (`#e5484d`) and designation polygons. The legend carries a *"Discharge point — no location published"* entry with nothing on the map. ✔
* Defects: the points.js header omits `#/unlocatable` (5 screens claimed, 6 exist); the kicker reads "Example 3 of **3**" then "Example 4 of **4**".

### B6. Explorer — **CONFIRMED**

Tabs: `Permits 61 · Discharge points 102 · Sampling points 161 · WINEP actions 11` (all match the store).

* Selecting permit **042451** lit the chain: *"7 asserted links, spanning 188 m–1.35 km"* with per-leg distance tooltips (188 m, 188 m, 201 m, 188 m, 201 m, 1.01 km, 1.35 km).
* Selecting sampling point **SW-50450110** (WAREHAM STW): *"1 outlet monitored here"*, one 113 m leg.
* **No line between two discharge points** — structurally impossible: legs are built only as `kind:"mon"` (discharge point → sampling point, L246-253) and `kind:"winep"` (anchor discharge point → WINEP action site, L254-259). No DP→DP leg is constructible, and the old failure mode (401025's outlets appearing linked to 040091's) is gone because 040091 now has no geometry at all.

### B7. Console — **CLEAN**

Captured via `devtools.console.stdout.content` across `/`, all three `?view=` keys, five bogus keys, `points.html#/why`, `points.html#/explorer`, `docs.html`, `sparql.html`. The only line is Firefox's own `Translations: "Failed to run language detection"` actor abort — not the app. **Zero** app errors, zero uncaught exceptions.

### B8. Deep links — **CONFIRMED**

| URL | active view | error? |
|---|---|---|
| `?view=regulated` / `?view=measured` / `?view=farming` | regulated / measured / farming | none |
| `?view=breaches`, `?view=substance`, `?view=wessex`, `?view=permits`, `?view=ambient`, `?view=bogus` | **regulated** (silent fallback) | none — page loads fully, status "Loaded 270 breaches …" |

`setView(["regulated","measured","farming"].includes(view) ? view : "regulated")` (app.js:2477). **No doc links to an old key**: the only `?view=` references in the repo are `README.md:164` (`?view=regulated`) and `README.md:171` (`?view=measured`), both current. Back-compat is genuinely dropped and it degrades silently, as intended.

---

## Summary of everything NOT confirmed

**Wrong**
1. `regulation_to_db.py:228` — "all get a real NGR": 7 outlets have none (5 of them monitored).
2. `regulation_to_db.py:240` — "67 discharge points on 32 distinct coordinates": it is **95 on 37**, per the script's own print.
3. `regulation_to_db.py:246-250` — the whole proximity scoreboard (38/64, 56/64, 54/64, 64/64) is wrong: **41/87, 64/87, 66/87, 87/87**; and "finer is not even monotonically better" is now false. **The app's own `#/why` page already prints 42/91 (46 %), contradicting the comment.**
4. `app.js:272` — "the 95 points that belong to no permit": **91**.
5. `app.js:254` — "reproduces, as ONE declarative query, the row set the table shows": true for breaches/permits/actions/applications; **false for samplingPoints (187 vs 161), substanceStory (76 vs 27) and actions-under-a-substance-filter (11 vs 1)**. The admitted drift note describes the opposite error.
6. `points.js:12-14` — "every number is computed from the store … see the `fact()` helpers": **there is no `fact()` helper**, and the example ledes hard-code "Seven outlets … four different permits … a kilometre away".
7. `link_data.py:93` — "the 26 permits whose ammonia limit is a percentile": **24**.
8. `breaches_to_db.py:31` — "(70 % of BOD)": 70 % is the *bulk-file* share; in the compliance set BOD is **64 %**.

**Stale**
9. `fetch_compliance_observations.py:24` — "175 pairs over 54 sampling points": the scope query now returns **228 pairs over 69 sampling points**. The committed cache still holds the old 175/54, so **the breach assessment is running on an incomplete compliance set**. *(Highest-impact finding — it is not just prose.)*
10. `regulation_to_db.py:522-527` — comment (2) still describes the deleted sampling-point fallback.
11. `regulation_to_db.py:539` — "6 outlets … at fabricated coordinates": today it would be 5.
12. `app.js:5` and `app.js:257` — "four views": there are three.
13. `points.js:3-9` — "five screens": there are six (`#/unlocatable` missing).
14. `fetch_compliance_observations.py:11` — 70.7 % of BOD vs measured 70.4 %.

**Unverifiable**
15. `fetch_compliance_observations.py:19-21` — the "**149** observations → 0" river point: the behaviour reproduces live (five river points all drop to 0; three sewage points untouched), but no point in the catchment has 149 ammonia observations.
16. `breaches_to_db.py:52-57` — the EA 95-percentile LUT is internally consistent but was not checked against the published guidance.

**Inconsistent (not strictly wrong)**
17. `app.js` LEDE says "**95** outlets"; `points.html` and the Explorer say "**102** discharge points". Both are honest (drawn vs. existing) but the app publishes two outlet counts.
18. `points.js` kicker: "Example 3 of 3" → "Example 4 of 4".
19. `regulation.obda` has **no** comments at all to audit.
