# Audit — findings, and what was done about them

A full validation sweep of the demonstrator, run 2026-07-13, and its resolution, completed 2026-07-14.

Every assertion in every README, in `points.html`, and in the app's own prose was checked against the
data; the graph was checked for referential integrity and for faithfulness to the source CSVs; and the
object model was checked against [`canwaf/ontology-work`](https://github.com/canwaf/ontology-work).

| File | What it is |
| --- | --- |
| [`findings.md`](findings.md) | **The audit as delivered.** Every finding, its evidence, and the decision it required. Unedited — it is the record of what was wrong, not of what was fixed. |
| [`working/`](working/) | The six independent passes behind it, with the queries and counter-derivations. Read these to check the audit rather than trust it. |
| this file | What was actually done, finding by finding. |

**All findings are resolved.** One (C3) was resolved by a decision to go further than the audit
proposed. Nothing was closed as "won't fix".

---

## The shape of it

The audit found **no arithmetic errors**. Every headline count in the READMEs re-derived exactly, and
the graph was a clean derivation from its sources — zero dangling references, zero orphans, zero broken
cross-graph joins.

What it found instead was worse, and it took a while to see why. Three of the most serious findings —
an unfetched sampling point displaying as "no breach", a dropped `monitoredAt` edge displaying as "no
link", a missing coordinate displaying as a plausible dot — are **the same mistake in three costumes:**

> **An absence rendered as a value.**
>
> Each time, the pipeline had no way to say *"I don't know"*, so it said something false, and said it
> quietly.

That is precisely the thesis *Points apart* argues. The store kept committing the error it was built to
expose. Fixing it properly meant giving the graph a vocabulary for ignorance — which is why the biggest
single change in this whole exercise is not a corrected number but a new fact the store can state:
**`wr:assessed false`, with a reason.**

And then a fourth costume showed up, wearing the mistake **inside out** — see [The over-correction](#the-over-correction).

---

## What changed, in numbers

| | Before the audit | Now |
| --- | --- | --- |
| Discharge points | 102 | **122** |
| Permit conditions | 587 | **1,277** |
| Determinands regulated | 12 | **38** (12 chartable) |
| `defra-reg:Limit` individuals | — (bounds hung off one Limit) | **1,565** (one per statistic, per season) |
| Breaches | 270 | **281** — 1 current, 117 flagged as judged on an undated version |
| **Conditions we could NOT assess** | *invisible* | **641 (50%), each with a machine-readable reason** |
| Triples | 48,454 | **56,422** |

The breach count barely moved. That is not because little changed — it is because two large errors were
pulling in opposite directions, and the audit only caught one of them. See below.

---

## A — the graph asserted something false

### A0 · Conditions existed only if somebody had sampled them ✅

**Found:** the breach pipeline's input had never caught up with the register-sourced outlets. 15
sampling points were assessed against nothing and displayed as *no breach*.

**What we did instead.** The audit's proposed fix — re-run the fetch — **does not work**, and finding
out why was the most valuable thing in the whole exercise. Re-running it found *nothing to fetch*,
because **conditions themselves were observation-sourced**: a permit limit existed only if somebody had
sampled that substance there and the result happened to be numeric. **Twenty-seven outlets carried no
condition at all** while the register plainly limits them — Blackheath's storm overflow at BOD 200 mg/l,
the watercress outlets at pH 6–9. There was nothing to assess them *against*.

A limit is a **register fact**. It is true whether or not anyone sampled. Conditions now come from
`determinands.csv`: **587 → 1,277 conditions over 38 determinands**. The app's substance filter still
offers the 12 the archive holds a time series for, because those are the only ones it can chart — and
the two facts are now kept apart as two SKOS schemes (`wr:substance`, `wr:substance/monitored`) so the
app's dropdown can never again decide what the law says.

### A1 · The store published a looser limit than the register sets ✅

**Found:** a `Condition` was keyed at `(permit, version, substance)` but the register sets limits per
**effluent**, and `MAX()` resolved the clash to the **loosest** value. Permit `042116`'s effluent 1 read
BOD 25 mg/l where the register says 15.

**Fixed, and it was far bigger than the audit found — 7 permits, not one:**

| Permit | Substance | Register says | Store published |
| --- | --- | --- | --- |
| `040091` | BOD (95%ile) | **30** mg/l | 200 mg/l |
| `042451` | BOD (max) | **56** mg/l | 200 mg/l |
| `042116` | BOD (95%ile) | **15** mg/l | 25 mg/l |
| `040067` | BOD (95%ile) | **15** mg/l May–Oct | 20 mg/l all year |

The last row is a category the audit missed entirely: **`040067` is a seasonal permit.** Its limits
tighten in summer, when the river is low and dilutes less. `MAX()` was publishing the *winter* number
all year round.

Conditions are now keyed at `(permit, version, outlet, effluent, substance)`; bounds add statistic and
season. A build-time `ABORT` proves no aggregate has to choose — at the register's own grain there is
exactly one value, always.

### A2 · Six register-stated `monitoredAt` links were silently dropped ✅

**Decision (yours):** the points exist; the archive simply doesn't publish them. Assert the edge anyway
— an IRI is a name, not a promise that it dereferences.

Done. And it turned up **a third instance of the same bug, one level up**: `register_effluents` carried
`WHERE EFF_SAMPLE_POINT IS NOT NULL`, which looks like a harmless guard on the column the notation is
built from. But that table also defines *which outlets exist* — so it silently deleted **29 outlets for
having no sampling point**. Twelve of them on `042451`: the Blackheath permit whose unlocatable outlets
are the subject of *Points apart*'s fourth worked example.

**Outlets: 102 → 122.**

### A3 · Version dating ✅ — and see [The over-correction](#the-over-correction)

`fetch_version_dates.py` re-run: **103 → 144 dated versions**. The "judge against the latest version"
fallback is gone.

### A3b · The store shipped a spatial query that silently answered "nothing found" ✅

**Found:** the designations `geof:distance` query computed ~5,400 km and returned zero rows.

**The diagnosis in the brief was wrong, and the truth is worse.** Oxigraph *does* implement
`geof:distance`. The query was broken by **our** bug: the CRS URI sat **after** the geometry.

GeoSPARQL 1.1 (OGC 22-047r1), **Requirement 14**, is unambiguous — and its ABNF settles it beyond
argument:

```abnf
wktLiteral        ::= opt-iri-and-whitespace geometry-data
opt-iri-and-space  =  "<" IRI ">" LWSP / ""
```

The IRI is *concatenated before* the geometry. There is no production in which it may follow. So
`POINT(389950 93850) <…/EPSG/0/27700>` matches the **empty-IRI** production, the trailing text is not
read, and **Requirement 15** then *obliges* the engine to assume CRS84 — at which point it reads a
British National Grid easting as a **longitude**.

Engines weren't being sloppy. **They were doing what the spec requires**, and the spec required them to
answer *"no discharges lie near any protected site."* Not an error — an **answer**, and a reassuring one.

| WKT form | `geof:distance` for two points 100 m apart |
| --- | --- |
| `POINT(…) <EPSG/0/27700>` — what we shipped | **3,377,867 m** |
| `<EPSG/0/27700> POINT(…)` — conformant | **unbound** |
| `<CRS84> POINT(…)` | correct |

Fixing the order alone turns a confident lie into a silent blank, so every point now **also** carries a
derived CRS84 geometry (`geo:hasDefaultGeometry`) beside the verbatim EPSG:27700 source. The query
returns **8 rows**; `042451 → East Coppice SSSI at 926 m` matches the audit's hand-derivation exactly.

Both `parseWkt` implementations were also scraping the CRS URI's own digits as a phantom coordinate
pair. Fixed.

---

## B — conformance to the object model

All resolved. The **ontology was updated upstream** (`canwaf/ontology-work`) in response.

| | Finding | Resolution |
| --- | --- | --- |
| **B1** | `defra-core:Option` doesn't exist | One wrong prefix in `sfi.obda`. `farming:Option`. **Fixing that single prefix cleared all ~2,800 domain/range violations** — the audit's diagnosis was exactly right. |
| **B2** | iAdopt namespace is `http://`, vocabulary is `https://` | Corrected. |
| **B3** | `reg:breachesBound` invented under DEFRA's namespace | **The ontology adopted this README's own proposed fix.** `reg:LimitBreach` and `reg:breachesLimit` (range `reg:Limit`) are now defined upstream; each statistic and season became its own `Limit` with a single bound; the invented term is **gone**. The feedback loop closed. |
| | `water:samplingPointType` / `samplingPointStatus` | Moved to the project namespace. We were minting predicates *about the EA's own resources* under DEFRA's authority. |
| **B4** | `xsd:date` vs `xsd:dateTime` split across pipelines | Standardised on `xsd:dateTime` (581 + 531, zero `xsd:date`). |
| **B5** | `reg:completionDate` defined, unused | Deleted upstream. |
| **B6** | Two defects *in the ontology* | Fixed upstream: `documentsPermit` now `⊑ foaf:primaryTopic`; the `defra-farming` ontology IRI no longer collides with `defra-water`. |

**Verified:** every one of the 20 classes and 31 predicates the store emits from a DEFRA namespace now
resolves to the ontology. Zero undefined terms.

---

## C — the argument in *Points apart*

### C1 · The page let geometry decide what it counts ✅

On the one page whose thesis is *"do not let the presence of geometry decide what exists"*, the prose
was counting only what it could **draw**. Now the three counts are held apart everywhere:

> **122 outlets exist.** A map can show **115**. **102** have a sampling point. **91** have both — and
> only those 91 can be *scored*, because you cannot test a proximity join on an outlet with no position
> to measure from or no stated answer to check against.

The explorer states how many links it **asserts** (107) alongside how many it can **draw** (91).

### C2 · The `monitoredAt 91/91 · 100%` tile was a tautology ✅

Removed. `monitoredAt` **is** the ground truth being scored against; scoring it against itself returns
100% by construction and proves nothing. The screen now asks the honest question — *"if you threw the
identifier away, how much could you recover from the map?"* — and adds the caveat the page owes the
reader: it can show that `monitoredAt` is **stated**, not that it is **correct**.

### C3 · We used the worst of three published geometries, and never said so ✅ — *went further*

The audit said: put the three-way table on the Why screen. We did better than that — the store now
**publishes all three grid references**, each tagged `wr:gridReferenceLevel`, so the page **computes** the
comparison at render time like every other number on it. It cannot drift.

The new section is headed **"But you used the worst coordinate"**:

| Grid reference | Locates | Distinct coords | Nearest point correct |
| --- | --- | --- | --- |
| `DISCHARGE_NGR` | the **site** — *the store's default* | 37 | **41 / 87 (47%)** |
| `OUTLET_GRID_REF` | the **outlet** | 74 | 64 / 87 (74%) |
| `EFFLUENT_GRID_REF` | the **effluent** | 80 | 66 / 87 (76%) |
| `water:monitoredAt` | nothing — **it is not a place** | — | **87 / 87 (100%)** |

**The argument is stronger for conceding the point.** The best coordinate the register holds still files
**one outlet in four** under the wrong watercourse. And two things only become visible once all three are
on screen: the effluent reference resolves *more* distinct coordinates than the outlet reference and buys
almost nothing for it — **precision is not accuracy** — and the 47%-vs-76% gap is not a fact about the
world at all. It is decided by **which column of a spreadsheet** somebody hung the geometry on, two levels
above the feature being joined.

### C4 · The page's best argument was the one it didn't make ✅

The circularity rebuttal to *"just restrict the layer to outfall points"* reads like a debating move. It
had a number available and didn't use it. Now it does: hand proximity an **oracle** — a layer containing
only the 70 points that genuinely monitor a discharge, which you could build *only if you already had the
answer* — and it still recovers just **47 / 91 (52%)**. **Even cheating, it barely beats a coin toss.**

### C5 · Two overreaches ✅

*"the single place guaranteed to carry none of its effluent"* → **the nearest** such place (91 others also
carry none). And *"US = upstream"* now openly rests on the EA's naming convention, with the caveat stated:
the store holds no flow direction and no river network, so it cannot **prove** which way the water runs.

---

## D — documentation

All 20 items fixed. The ones that mattered:

- **D1** — the README said the server loads four graphs (it loads five), and **its rebuild section never
  built `breaches.ttl` at all**. Follow its steps and you got four graphs.
- **D2** — the `config.js` example showed leading slashes, which its own pitfall note (ten lines later)
  says **breaks sub-path deploys**. Copying the README broke the deploy it was meant to explain.
- **D13** — the WINEP TODO quoted **Wessex-wide** figures for a graph that ships **27** limits, and its own
  "limits needing attention" query returned 8 of which **6 are correctly-modelled carried-over limits**.
  It was advertising its backlog at **4× the real size** (it is 2, both `TBC`). Most of that file was
  already done and didn't know it.
- **D14** — the WINEP README cited `042116` as kept by the catchment-*site* clause. It is one of the 61
  regulation permits, so the *permit* clause keeps it. Worse: **no emitted action depends on the site
  clause at all** — deleting it changes the output by zero rows.
- **D16** — `regulation_to_db.py`'s header still described the *deleted* geometry fallback and contradicted
  the "NO FALLBACK" section 40 lines below it in the same file.
- **D8, D9, D17, D20** were **errors I introduced myself** in earlier work. They did not survive the morning.

---

## E — app and endpoint

| | Finding | Resolution |
| --- | --- | --- |
| **E1** | The "SPARQL 1.1" endpoint 400'd on `ASK`, `CONSTRUCT` **and** `DESCRIBE` — three of four query forms | Fixed; all four return 200. `app/TODO.md` had itself claimed *"`SELECT` and `CONSTRUCT`/`DESCRIBE` are unaffected"*, which is why a broken endpoint sat as a one-line curiosity. |
| **E2** | Three provenance queries no longer reproduced their tables | **Fixed and now verified in a browser** — every ◈ SPARQL link reproduces its table's row count exactly, across every substance and view. This is the demonstrator's central credibility claim and it had never actually held. |
| **E3** | Two literal NUL bytes made `app.js` binary to `grep` | Removed. (They were the "space" in a key function — which is *also* why one of my own edits silently failed to match during the fix.) |
| **E4** | A breach at an unlocatable outlet would vanish from the app | **Fixed rather than warned about.** Geometry is `OPTIONAL` in the breach query. It had worked only by luck. |
| **E5** | A slash-bearing permit ref would silently fail to join | **Fixed rather than warned about.** `continuesCondition` is now percent-encoded exactly as ontop's templates are. |
| **E6** | "Every table is paginated and sortable" was overstated | Fixed; nested detail tables now are too — they had to be, since a permit's limits are now per-outlet and `042451` has 14. |

---

## The over-correction

The audit's central pattern — *an absence rendered as a value* — has an inverse, and it caught us
**three times** while fixing A3. It is worth recording, because it is the more insidious of the two.

The A3 rule is *"make no determination when the version history is ambiguous."* Implementing it meant
deciding what **ambiguous** means, and the question got asked at the wrong level twice:

| Attempt | Refused | Asked | What it cost |
| --- | --- | --- | --- |
| 1 | every undated permit | *"is it dated?"* | `EPRYP3399VF` — **one** version. 121 compliance samples for pH, solids and iron, all testable against limits in no doubt whatever, reported as unexaminable. |
| 2 | undated permits with **>1** version | *"how many versions?"* | `EPRBB3593EG` — **two** versions whose pH limits are **both 6.0–9.0**. They differ in name and in nothing else. This hid a real pH breach: **5.0 against a minimum of 6.0, April 2016.** |
| 3 ✅ | *(correct)* | **"do the versions disagree about *this limit*?"** | — |

What a sample is judged against is a **bound**. If every candidate version states the same bound, the
bound that applied is known with certainty — whichever version was in force. The ambiguity is a property
of the **limit**, not of the **permit**, so the test is applied per condition. A permit can now have some
conditions assessed and others not, which is exactly right.

That collapsed the "cannot tell" set from **146 conditions to 26** — of which only **9** are the genuine
disagreement.

> **Refusing to judge what you *can* judge is not caution.** It is an assertion the data does not support,
> pointed the other way — and it **hides real breaches**, which is the more dangerous direction to be wrong
> in. Over-caution is just the failure mode you get praised for.

Both users' catches (`040111`, `EPRBB3593EG`) were of this kind. Neither was a data problem.

---

## The standing rule

**When a fact is absent, the graph must say so, and the app must show it.**

This is now enforceable rather than aspirational:

- Conditions carry **`wr:assessed`** and, when false, **`wr:notAssessedBecause`** — a SKOS concept with a
  definition. 641 of 1,277 conditions are marked not-assessed, and no longer read as "no breach".
- Breaches judged without a dated version carry **`wr:judgedOnUndatedVersion`** (117 of 281). A weaker
  claim reads as a weaker claim.
- Outlets with no coordinate carry **no geometry** — never a guessed one.
- Sampling points the archive doesn't publish carry **their IRI and nothing else**, with an
  `rdfs:comment` saying so. The `monitoredAt` edge is asserted anyway.
- The map has a **third marker state**: not blue (assessed, clean), not red or amber (breached), but
  **grey — not assessed.**

| Why a condition could not be assessed | Conditions |
| --- | --- |
| `no-observations` | 456 |
| `no-sampling-point` | 111 |
| `ambiguous-version-history` | 26 |
| `sampling-point-unpublished` | 19 |
| `no-observations-in-a-dated-window` | 18 |
| `too-few-samples` | 11 |

---

## Two traps that outlived the audit

**1. Fan-out on `OPTIONAL`.** Twice during the fix, giving a subject a *second* value for something an
`OPTIONAL` reads **silently doubled every affected row** — once when discharge points gained a CRS84
geometry, once when breaches gained a second `rdfs:comment`. Both times **every row-count check still
passed**, because the table and its provenance query fanned out *together*.

> Matching counts prove the two **agree**. They do not prove either is **right**.

`app.js` now asserts distinctness on the subject IRI at load and logs a `FAN-OUT` error. Every geometry
is tagged with `wr:crs` **and** `wr:gridReferenceLevel` so a query names the one it means.

**2. `pyproj` is not thread-safe, and DuckDB parallelises scalar UDFs.** Registering the reprojection as
a UDF **segfaulted** the build. It had appeared to work for weeks — because the only table using it was
115 rows, one vector, one thread. The reprojection is now done once, vectorised, in pandas.

---

## Verified clean — do not spend time re-checking

- **Conformance:** every DEFRA term the store emits resolves to the ontology. Zero undefined.
- **Referential integrity:** zero dangling `breachesCondition`, `breachesLimit`, `continuesCondition`,
  `appliesTo`. Every `Limit` has exactly one bound and one statement. Every geometry carries its CRS and
  its register level.
- **Provenance:** every ◈ SPARQL link reproduces its table's row count, across every substance and view.
- **Runtime:** all nine screens render with **zero console errors**; all six tables paginate and sort;
  identifiers sort as identifiers.
- **No fabricated geometry.** The NO-FALLBACK policy holds: 7 outlets correctly carry none.
