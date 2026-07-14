# README fact-check — `/Users/waf/git/projects/demonstrator-poc/README.md`

Audited line by line against the live SPARQL endpoint (`http://127.0.0.1:8000/sparql`, 35,513 triples,
default graph), the source CSVs, and `app/*.js`, `app/server.py`, `Dockerfile`.
No files were modified.

## Headline

**Every quantitative claim in the README is correct.** All the numbers flagged as "most likely stale"
— 42/91, 91/91, 7 unlocatable outlets, 161/91, 61/58, Blackheath 0/5, Brockhill 1/7, Doreys 1.01 km,
and the 5 m/50 m/500 m figures — reproduce exactly. The page computes them at render time and the prose
agrees with the computation.

**The failures are all structural/prose, and they cluster on one thing: the `breaches` dataset was added
and the README was never updated for it.** Plus a set of counting/prose errors about the app's own chrome
and screens.

### Note on the brief
Six items in my brief are **not in the current README** and could not be audited as README claims:
`"102 discharge points"`, `"95 with a published location"`, `"70 monitor a discharge"`,
`"587 conditions"`, `"12 substances"`, `"919 conditions over 38 substances"`.
Those figures live in `app/points.js` (computed) — not in `README.md`. For the record I computed them
anyway and **all are correct**: 102 outlets, 95 located, 70 monitoring points, 587 `reg:Condition`,
12 `sosa:ObservableProperty`. The `919 / 38` projection has no corresponding README text to verify.

---

## Findings table

| # | CLAIM (quoted, README line) | VERDICT | EVIDENCE | WHAT THE HUMAN MUST DECIDE |
|---|---|---|---|---|
| 1 | L24 "`app/server.py` loads all **four** into a single pyoxigraph store"; L36 "`# loads the 4 graphs`"; L357 "`ttl/` the **four** committed graphs"; L22-24 architecture names only regulation/winep/sfi/designations | **WRONG** | `app/server.py:46` → `GRAPHS = ["regulation.ttl", "breaches.ttl", "winep.ttl", "sfi.ttl", "designations.ttl"]` — **five**. `git ls-files ttl/*.ttl` → breaches, designations, regulation, sfi, winep (5 committed). | Update every "four" → "five" and add `ttl/breaches.ttl` to the architecture sentence. |
| 2 | L253-296 "Rebuilding the RDF pipelines … the commands below are the reproducible rebuild in **dependency order**" — 4 numbered steps (regulation, WINEP, SFI, designations) | **WRONG / incomplete** | There is no breaches step. `ttl/breaches/README.md` documents the real one: `regulation_to_db.py` (first, supplies the bounds) → `ttl/breaches/fetch_compliance_observations.py` → `ttl/breaches/breaches_to_db.py` → `ontop materialize --mapping ttl/breaches/breaches.obda --properties ontop/duckdb-breaches.properties` → `ttl/breaches.ttl`. `ontop/duckdb-breaches.properties` exists. Following the README as written does **not** rebuild `breaches.ttl`. | Add the breaches step (it sits between regulation and WINEP in dependency order). |
| 3 | L358 repo layout: "`regulation/ winep/ sfi/ designations/ {pipeline, README.md}`" | **WRONG / incomplete** | `ttl/breaches/` exists with `README.md`, `breaches.obda`, `breaches_to_db.py`, `fetch_compliance_observations.py`. Not listed. | Add `breaches/` to the layout block. |
| 4 | L192-193 "**Points apart** … as **five screens**"; L201 "### Points apart — the argument, in **five screens**"; L203 "It is **five screens**, stepped through in order" | **WRONG** | `app/points.js:320-328` → `ROUTES` has **six**: `why`, `blackheath`, `brockhill`, `doreys`, `unlocatable`, `explorer`. The README's **own table (L208-213) lists six rows**, including "**4 · No location** `#/unlocatable`". | Change "five screens" → "six screens" in all three places. |
| 5 | L193 "then **three worked examples** — one per way a spatial join fails" | **WRONG / stale** | The README's own table calls the fourth one "**4 · No location**" and L212 describes it as a worked example. `points.js:314-315` acknowledges "Example 4 is a different shape from the other three". So there are four example screens, three of which are "ways a spatial join fails" and a fourth which is "it cannot be run at all". | Reword: "four worked examples — three ways a spatial join fails, and one where it cannot be run at all". |
| 6 | L190 "**Three utility pages hang off the app chrome** (top-right of the header, and the footer): **Points apart**, SPARQL, Docs" | **WRONG** | `app/index.html:19-22` header-links = **Docs + SPARQL only**. `app/index.html:76-79` footer = **SPARQL only**. **`points.html` appears nowhere in `index.html`.** Its only link in the app is an inline one inside a lede paragraph: `app/app.js:1397` → `` `(<a href="points.html" …>why that matters</a>)` ``. No dynamic injection into header/footer exists (grepped `header-links`/`foot-link`). | Either (a) add a **Points apart** link to the header/footer chrome, or (b) rewrite L190 to say two pages are in the chrome and Points apart is reached from the map lede. Note Docs is header-only, not footer. |
| 7 | L60-65 the `window.APP_CONFIG` block shows `sparqlEndpoint: "/sparql"`, `observationsEndpoint: "/observations"`, `tilesUrl: "/tiles/{z}/{x}/{y}.png"` — **all with leading slashes** | **WRONG** (and self-contradictory) | Actual `app/config.js:24-29`: `sparqlEndpoint: "sparql"`, `observationsEndpoint: "observations"`, `tilesUrl: "tiles/{z}/{x}/{y}.png"` — **no leading slashes**. The README **contradicts itself** at L130-132: "keep endpoints relative (`\"sparql\"`, not `\"/sparql\"`) — a leading slash pins the request to the origin root and **breaks the sub-path**." So the README's own example is the anti-pattern its own pitfall note warns against. | Fix the code block to match `app/config.js` (drop the leading slashes). This one actively misleads: copying the README block breaks `BASE_PATH` sub-path deploys. |
| 8 | L68 "A **relative** path (`/sparql`) stays same-origin" | **WRONG (terminology)** | `/sparql` is root-relative (origin-absolute), not relative. `app/config.js:10-13` explicitly draws the distinction the README blurs. Same-origin part is true; "relative" is not. | Reword to "a same-origin path"; reserve "relative" for the no-leading-slash form. |
| 9 | L217 "**Each screen** deep-links into the SPARQL editor with the query that reproduces it" | **WRONG** | Scanned every `render*` in `app/points.js` for `sparql.html#q=`: `renderWhy` **YES** (L493), `renderExample` **YES** (L653, L668 — covers blackheath/brockhill/doreys), `renderUnlocatable` **NO**, `renderExplorer` **NO**. So 4 of 6 screens have a deep-link; `#/unlocatable` and `#/explorer` have none. | Either add deep-links to those two screens, or soften to "Most screens deep-link…". |
| 10 | L180 "**Every table** is paginated at 10 rows (`« ‹ 1 2 3 › »`) and sortable by clicking any column header" | **WRONG (overstated)** | Page size and pager glyphs are right: `app/app.js:1794` `const PAGE_SIZE = 10`, L1860-1871 renders `« ‹ … › »`; L1887-1895 adds `sortable` + click handler to every `<th>`. **But**: (a) the nested detail tables inside an expanded permit row (`curTbl` / `histTbl`, `app.js:1977-1988`) are built with `tableEl(…)`, **not** `pagedTable(…)` → neither paginated nor sortable; (b) `pagedTable` returns early at L1837 (`if (groups.length < 2) return wrap;`), so a 0/1-row table gets no pager **and no sort handlers**. | Decide whether "table" means "table **card**" (in which case it's true — see #11) and say so, or drop "Every". |
| 11 | L230 "**Every table card** carries a small **◈ SPARQL** link in its header" | **CONFIRMED** | `app/app.js:1759-1771` `card(title, count, bodyEl, query)` renders `◈ SPARQL` when `query` is passed. All 7 card call-sites pass a `PQ.*` query: L1933/1946 `PQ.breaches`, L1953/1965 `PQ.permits`, L2007/2044 `PQ.substanceStory`, L2068 `PQ.actions`, L2169-2173 `PQ.samplingPoints`, L2369 `PQ.applications`, L2381/2400 `PQ.sfiOptions`. | — |
| 12 | L367 "**All of the docs below** also render in-app in the Docs viewer (`/docs.html`)" + L371 "`ttl/<dataset>/README.md` — the authoritative per-dataset detail" | **WRONG** | `app/docs.js` lists 10 docs: `/README.md`, `/LICENSE.md`, `/ontop/README.md`, `/raw_datasets/access_database_csv_files/README.md`, `/ttl/{designations,regulation,sfi,winep}/README.md`, `/ttl/{designations,winep}/TODO.md`. **`/ttl/breaches/README.md` is missing.** So a `ttl/<dataset>/README.md` does *not* render in-app. | Add `ttl/breaches/README.md` to `docs.js`. (`app/TODO.md` is also absent, but the README doesn't claim it.) |
| 13 | L354-356 repo layout `app/`: "server.py …, index.html, app.js, style.css, catchment.geojson, {sssi,sac,spa}.geojson, docs.{html,js,css}, sparql.{html,css}" | **STALE / incomplete** | Missing from the listing: `points.{html,js,css}`, `config.js`, `vendor/`, `TODO.md` — all of which exist and three of which get their own README sections (Points apart L192, config.js L57, vendor/ L98). | Add them to the layout block. |
| 14 | L139-141 "nothing under `.obs_cache/` / `.tile_cache/` is written into the repo" | **CONFIRMED (stale names)** | Substantive claim holds: `server.py:56-58` defaults `CACHE_DIR` to `tempfile.gettempdir()/catchment-poc-cache`, outside the repo. But the actual subdirs are `observations` and `tiles` (`server.py:63,75`); `.obs_cache/`/`.tile_cache/` survive only as a `.gitignore` safety net (`.gitignore:43-44`). | Cosmetic: the named dirs no longer exist. Optional fix. |
| 15 | L79-82 "**The EA Water Quality Archive has no CORS** (verified: … preflight `OPTIONS` that 404s)" | **UNVERIFIABLE HERE** | Requires a live outbound request to `environment.data.gov.uk`; not performed. Consistent with the same assertion in `app/config.js:14-17`. | Nothing — flagged only because it is asserted as "verified" and I could not re-verify offline. |

---

## Confirmed claims (computed, not assumed)

### The Points-apart numbers — all exact
Replicated `app/points.js`'s own algorithm (`Q_PERMITS` + `Q_SP`, `parseWkt`, `dist`, `nearestSp`,
`buildCombos`, `buildStacks`) in Python against the live endpoint:

```
permits (combos)                    : 61
outlets that exist (nDp)            : 102
outlets WITH a coordinate (nMapped) : 95
outlets with NO coordinate (nNoGeom): 7
sampling points in layer (allSp)    : 161
... that monitor a discharge        : 70
... ambient (monitor nothing)       : 91
SCORE  proximity   42 / 91  (46%)
SCORE  monitoredAt 91 / 91
```

| README claim (line) | Verdict | Computed |
| --- | --- | --- |
| L208 "proximity **42 / 91**, `water:monitoredAt` **91 / 91**" | CONFIRMED | 42/91 and 91/91 exactly |
| L208, L212 "**7 outlets have no coordinate at all**" | CONFIRMED | 7 (across 4 permits: 040070×2, 040091×2, 040096×2, 040137×1) |
| L166 "the catchment's **161 sampling points**" | CONFIRMED | 161 `sosa:FeatureOfInterest` with geometry |
| L167 "**91 of them belong to no permit at all**" | CONFIRMED | 91 ambient (161 − 70 monitoring) |
| L212 "Pick one of the **four permits**" | CONFIRMED | exactly 4 permits hold the 7 no-geom outlets |
| L212 "only **1** sits within 5 m of its sampling point" | CONFIRMED | 1 / 91 |
| L212 "**21%** within 50 m" | CONFIRMED | 19/91 = 20.9% → 21% |
| L212 "**4 lie beyond 500 m**" | CONFIRMED | 4 |
| L212 "the circle is **79 hectares**" | CONFIRMED | π·500² = 78.54 ha → 79 |

**Blackheath (L209)** — permit `042451`, all 5 outlets:
- nearest point in the whole layer for every outlet = `SW-50951085`, label **"SHERFORD AT SNAILS BRIDGE US BLACKHEATH"**, type `FRESHWATER - RIVERS`, `monitors_a_discharge = False` → **"a river station"** CONFIRMED; **"sited upstream"** CONFIRMED via the EA station name (`US` = upstream). Distance **18.9 m** → "**19 m**" CONFIRMED.
- the works' own sampling points: `SW-50951082` @ **187.9 m**, `SW-50951080` @ **201.2 m** → "**188–201 m**" CONFIRMED.
- Proximity score **0 / 5** CONFIRMED.

**Brockhill (L210)** — collision bucket `BNG:383690.0 92820.0`:
- **7 outlets** across **4 permits** (`043244`, `043245`, `401057`, `401058`) at one identical grid ref — CONFIRMED (largest stack in the catchment).
- proximity gives all seven the same answer, `SW-50430126` @ 120.8 m; exactly **one** stack member (`401058/outlet/2/effluent/1`) happens to name it → **1 / 7** CONFIRMED, and "right by luck" is fair. The identifier names 4 distinct sampling points.
- (Note: the *scoreline* at the top of that same screen shows `0 / 2` — that is permit `043245` alone. The README's 1/7 correctly refers to the stack board, not the scoreline. No error, but the two numbers coexist on one screen.)

**Doreys (L211)** — permit `EPRBB3593EG`: nearest = `SW-50590008` @ **1014.5 m** → `fmtM` → "**1.01 km**" CONFIRMED, and proximity gets it **right** (1/1) CONFIRMED. Radius trap:

```
r=  250 m : Doreys 0   Brockhill 3
r=  500 m : Doreys 0   Brockhill 5
r= 1000 m : Doreys 0   Brockhill 7
r= 1100 m : Doreys 1   Brockhill 7   <- "widen it until Doreys is found" => 7 candidates
r= 1500 m : Doreys 1   Brockhill 8
```
"Tighten … and Doreys silently matches nothing" CONFIRMED (0 candidates below ~1015 m).
"widen it until Doreys is found and Brockhill's single dot is within reach of **7 candidates**" CONFIRMED (`points.js:782` computes `withinRadius(otherG, 1100).length` = 7).

### Regulation counts
| Claim | Verdict | Query / result |
| --- | --- | --- |
| L316 "**61 permits** have outlets but only **58** have limits" | CONFIRMED | `SELECT (COUNT(DISTINCT ?p)) WHERE { ?p a water:WaterDischargePermit ; reg:permitSite ?dp }` → **61**; `… { ?p reg:hasCondition ?c }` → **58** |
| L160-163 breaches are periods; current = open; past = start+end; lone failure from == to | CONFIRMED | 270 `reg:ConditionBreach`; via `core:hasApplicability/core:applicabilityPeriod`: **1** open (no `core:applicableTo`) = current; **222** with `from == to` (lone failures); **47** closed spans |
| L309 "Absolute rules only (`METHOD = ABSOLUTE`)" | CONFIRMED | `link_data.py:41` `determinands = determinands[determinands["METHOD"]=="ABSOLUTE"]` |
| L309-310 "seasonality collapsed to one limit per (permit, version, substance)" | CONFIRMED | `ttl/regulation/README.md:43` "**Seasonality collapsed.**" |

### Geometry note (L220-226) — all correct
| Claim | Verdict | Evidence |
| --- | --- | --- |
| "SFI options carry WGS84 lon/lat" | CONFIRMED | 1115 `core:Option`, e.g. `MULTIPOINT (-2.640029 50.788221, …)` |
| "discharge points, sampling points and WINEP action sites all carry EPSG:27700" | CONFIRMED | all three carry `<…/EPSG/0/27700>`: DP 95, SP 161, WINEP action sites 11 |
| "asserted on the discharge point we own (a `#geography` fragment)" | CONFIRMED | e.g. `…/permit/EPRYP3399VF/outlet/1/effluent/1#geography` |
| "The sampling point carries **its own** `#geometry`" | CONFIRMED | e.g. `…/sampling-point/SW-50951082#geometry` |

(Aside, not a README bug: `app/app.js:5,7-8` header comment says "four views" and claims discharge points carry WGS84. Both are stale **code comments**; the README is the one that's right.)

### App behaviour
| Claim | Verdict | Evidence |
| --- | --- | --- |
| L180 paginated at 10 rows, pager `« ‹ 1 2 3 › »` | CONFIRMED | `app.js:1794` `PAGE_SIZE = 10`; `app.js:1860-1871` renders `«`/`‹`/numbers/`›`/`»` + "n–m of N" |
| L183-186 "A column is numeric only if **every** value in it is a bare, unpadded number"; `040136` is an identifier; shares a column with `400114/CF/01` and `EPRBB3593EG` | CONFIRMED | `app.js:1810` `const NUMERIC = /^-?(0\|[1-9]\d*)(\.\d+)?$/` (rejects leading zeros); `app.js:1813` `const numeric = raw.every(…)` — column-level, not per-cell. All three permit refs exist in the store (`040136`, `400114/CF/01` percent-encoded, `EPRBB3593EG`) |
| L187-188 "Rows sort and page in **groups**: an expandable summary row carries its hidden detail row with it" | CONFIRMED | `app.js:1831-1834` builds `groups`, `expand-row` appended to the preceding group; `app.js:1851` `view.slice(…).flat()` |
| L164, L171 view keys `?view=regulated` / `?view=measured` | CONFIRMED | `app.js:2468-2477` `["regulated","measured","farming"].includes(view)`, default `regulated` |
| L168-170 "a point that is measured but not regulated … its chart shows readings and **no pass mark**" | CONFIRMED | `app.js:597` "an ambient sampling point has no permit, so no limit line"; `app.js:820-821` "Saying 'hit (52)' there would invent a pass mark nobody set" |
| L176-178 designations toggled individually **or by category**; legend collapses while chart open | CONFIRMED | `app.js:1457` `setCategory(key,on)` + per-site `setSite`; `app.js:1512-1513` `collapseLegend`/`expandLegend`, called on chart open at L607, L888 |
| L215-216 "Every number on those screens is computed from the store at render time" | CONFIRMED | all scoreboard figures derive from `combos`/`allSp`; none are literals in `points.js` |
| L236-243 runtime uses `Q` + JS joins; `PQ` is a separate hand-maintained set that can drift; substance-story query left-joins from current limits so it omits proposed-only rows | CONFIRMED | `app.js:104` `const Q = {`; `app.js:269` `const PQ = {`; `PQ.substanceStory` anchors on `?permit reg:hasCondition ?cond` with the WINEP action in an `OPTIONAL` → a proposal with no current condition is indeed dropped |

### Serving / deployment
| Claim | Verdict | Evidence (`app/server.py`, `Dockerfile`) |
| --- | --- | --- |
| L48 `/sparql` — GET `?query=` or POST, returns `application/sparql-results+json` | CONFIRMED | `do_GET` L269-276, `do_POST` L305-323, content-type L241 |
| L49 `/observations?samplingPoint=&determinand=` proxy, follows `Link` pagination | CONFIRMED | L277-295; `_NEXT_RE = re.compile(r'<([^>]+)>;\s*rel="next"')` L65, walked at L123-124 |
| L50 `/*.md` raw Markdown from repo root, `.md` under the repo only | CONFIRMED | `_serve_markdown` L325-342: rejects unless `ROOT in target.parents` and `suffix == ".md"` |
| L99 basemap tiles proxied same-origin via `/tiles/{z}/{x}/{y}.png` | CONFIRMED | `_TILE_RE` L64, `_serve_tile` L344-375 |
| L100 "The page loads **no external CDN** — only this origin" | CONFIRMED | zero `http(s)://` refs in `index.html`, `docs.html`, `sparql.html`, `points.html` |
| L98 vendored: Leaflet, markercluster, proj4, marked, SPARQL editor | CONFIRMED | `app/vendor/{leaflet,marked,proj4,sparql-editor}`; markercluster ships inside `leaflet/` |
| L107-112 env vars `HOST`/`PORT`/`BASE_PATH`/`EA_BASE`/`TILE_BASE`/`CACHE_DIR` + defaults | CONFIRMED | L38-39, L44, L51, L62, L56-58. `CACHE_DIR` default = `tempfile.gettempdir()/catchment-poc-cache`; disabled by `""`/`none`/`off` (code also accepts `"0"`). Image sets `HOST=0.0.0.0` (`Dockerfile:31`) |
| L124-128 strips `BASE_PATH`, 301-redirects bare prefix, `/` still works | CONFIRMED | `_effective_path` L246-262: 301 at L255-259, pass-through at L262; `Dockerfile:38` healthcheck hits `/` |
| L134-137 in-memory Oxigraph rebuilt from committed `.ttl` on boot; stdlib `http.server` | CONFIRMED | `build_store()` L181-188; `ThreadingHTTPServer` L414 |
| L93-94 `docker build -t catchment-poc .` / `docker run … -p 8000:8000` | CONFIRMED (not executed) | `Dockerfile:34` `EXPOSE 8000`, `:40` `CMD ["python", "app/server.py"]` |
| L255 "All intermediates (`*.duckdb`, `*_raw.ttl`) are gitignored … the final `ttl/*.ttl` are committed" | CONFIRMED | `git check-ignore` → all 6 intermediates ignored, none tracked; `git ls-files ttl/*.ttl` → 5 committed |
| L326-329 pyoxigraph GeoSPARQL is point-only: `geof:distance` unbound for polygons, no `geof:buffer` | CONFIRMED | `geof:distance(?poly, "POINT(-2.0 50.7)", uom:metre)` over `nature:ProtectedSite` → `?d` **unbound** in every row. `geof:buffer` → *"The custom function …/buffer is not supported"* |

### Links, paths, anchors
All internal links resolve. Checked and present: `app/config.js`, `app/points.html`, `app/sparql.html`,
`app/docs.html`, `app/vendor/`, `app/app.js`, `ttl/{regulation,winep,sfi,designations}/README.md`,
`ttl/winep/TODO.md`, `ttl/designations/TODO.md`, `link_data.py`, `ttl/regulation/{fetch_version_dates,regulation_to_db}.py`,
`ttl/winep/winep_to_db.py`, `ttl/sfi/sfi_to_db.py`, `ttl/designations/designations_to_ttl.py`,
all `.obda` files, `ontop/ontop`, `ontop/duckdb{,-regulation,-winep}.properties`,
and every file named in **Data sources** (incl. `consents_active.csv`, `determinands.csv`, `effluents.csv`,
`PR24 WINEP National Dataset.xlsx`, `SFI Option details.xlsx`).

- Anchor `ttl/sfi/README.md#data-warnings` → **`## Data warnings`** at `ttl/sfi/README.md:48` — CONFIRMED.
- Anchor `#documentation-map` → **`## Documentation map`** at README:365 — CONFIRMED.
- L336 Operational Catchment **3367** — CONFIRMED (`3367` present in the catchment GeoJSON).
- L297-299 sibling **`ontology-work`** repo with `defra-{core-ontology,regulation,water,farming,nature}.ttl` — CONFIRMED, all 5 exist at `../ontology-work/`.

### Scope/warnings summary (L306-331)
| Claim | Verdict | Evidence |
| --- | --- | --- |
| "5 cells remain verbatim" | CONFIRMED | `ttl/winep/TODO.md:14` "**5 uninterpreted** — kept verbatim as `reg:limitStatement`" |
| "one generic `chemical` analyte is unresolved" | CONFIRMED | `ttl/winep/TODO.md:41-43` |
| "a permit+substance can carry competing proposals from different regulatory drivers" | CONFIRMED | `ttl/winep/TODO.md:71` "12 (permit, substance) pairs have >1 proposed limit" |
| "**SFI 2023 options are unpriced** (only the Expanded Offer has published rates)" | CONFIRMED | `ttl/sfi/README.md:34,62` |
| "one SFI option group (**PAC**) shows its code where the option isn't in the concept scheme" | CONFIRMED | `ttl/sfi/sfi_to_db.py:165` `"PAC": "Public access"` (curated group label); option `CPAC1` present in `ttl/sfi/sfi.csv` (99 rows); `grep -c PAC ttl/sfi/sfi_concept_scheme.csv` → **0** (absent from the scheme, so the code is shown) |
| "SSSI/SAC/SPA are `defra-nature:ProtectedSite` … **WGS84/CRS84** … **~2 m** `geo:asWKT` geometry" | CONFIRMED | 81 `nature:ProtectedSite`, `<…/CRS84> MULTIPOLYGON(…)`; `ttl/designations/designations_to_ttl.py:46` `RDF_SIMPLIFY = 0.00002` (≈2.2 m) and its L44 comment "~2 m"; `ttl/designations/README.md:29` "**~2 m simplification**" |
