# TODO — validation sweep, 2026-07-13

A full audit of the demonstrator: every assertion in every README, in `points.html`, and in the
app's own prose, checked against the data; the graph checked for referential integrity and for
faithfulness to the source CSVs; and the object model checked against
[canwaf/ontology-work](https://github.com/canwaf/ontology-work).

**Nothing here has been corrected.** Every item is a decision for you.

## How to read this

Each item states what is wrong, the evidence, where it lives, and **the decision** — the thing only
you can settle. Severity is about consequence, not effort:

- **HIGH** — the graph asserts something false, or a documented claim is untrue in a way that would
  embarrass us in front of the EA.
- **MEDIUM** — a real defect that is currently benign, or an honest omission that weakens the argument.
- **LOW** — cosmetic, or a latent trap that has not sprung.

**First, the good news**, so you know what *not* to re-check. The graph is a clean derivation:
0 dangling references across 28 structural properties, 0 orphans, 0 unresolved cross-graph joins
(WINEP→permit 11/11, breach→observation→sampling point 358/358). Scope, discharge points,
`monitoredAt`, geometry, conditions, bounds, sampling points and substances **all reconcile exactly**
against an independent re-derivation from the raw CSVs. And **every quantitative claim in the READMEs
and on Points apart is arithmetically correct** — including all four worked examples and the whole
scoring table. The problems below are about *what the numbers are labelled as*, *what the graph says
about the world*, and *which vocabulary it says it in*.

---

## A. The graph asserts something false

### A0. HIGH — **the breach assessment never caught up with the register-sourced outlets.** 15 sampling points are assessed against nothing.

When outlets were re-sourced from the permit register (fixing the old bug where an outlet existed only
if it had a numeric observation), the store's monitored sampling points grew. **The breach pipeline's
input never followed.**

- `ttl/breaches/compliance_observations.csv` (committed) covers **54** sampling points.
- The store now needs **69** — `fetch_compliance_observations.py`'s own header still says
  *"175 pairs over 54 sampling points"*; re-running its `pairs_in_scope()` today returns **228 over 69**.
- **15 sampling points have never been fetched**, so no observation of theirs is ever tested against a
  limit.

They include exactly the ones the earlier fix restored — `SW-50440146`, `SW-50570152`, `SW-50570160`
(the "No flow" watercress outlets) — and **`SW-50951082`, Blackheath's storm overflow**, which is a
sewage discharge point on a permit with live WINEP actions.

The failure is silent and it points the wrong way: an unassessed sampling point does not appear as
"unknown", it appears as **no breach**. So the headline "270 condition breaches" is an **undercount**,
and the app shows outlets as clean that have simply never been examined. This is the same class of
error as the geometry fallback — an absence of evidence rendered as evidence of absence.

> **DECISION.** Re-run `ttl/breaches/fetch_compliance_observations.py` (needs EA egress) and rebuild
> `breaches.ttl`, then re-check the 270 figure and the "1 current breach" claim, which appear in the
> app's lede, the README and `ttl/breaches/README.md`. Until that is done, **no breach count in this
> project should be quoted to anyone.** Note this also interacts with **A1**: permit `042116`'s
> effluent-1 limit is published 67% too loose, so even once fetched, its samples would be judged
> against the wrong number.

### A1. HIGH — the store publishes a **looser permit limit than the register sets** (permit 042116)

A `Condition` is keyed at `(permit, version, substance)`, but the register sets limits per
**effluent**. Where a permit's effluents carry *different* limits for the same substance,
`regulation_to_db.py` resolves the clash with `MAX()` — the **loosest** value.

Permit `042116` (Milborne St Andrew STW) has three effluents on outlet 1, sampled at three different
points, with genuinely different limits:

| Effluent | Sampled at | BOD 95%ile | Suspended solids 95%ile |
| --- | --- | --- | --- |
| 1 | `SW-50440194` | **15 mg/l** | **25 mg/l** |
| 2 | `SW-50440001` | 25 mg/l | 35 mg/l |

The graph publishes **BOD 25** and **SS 35** for the whole permit — for effluent 1 that is **67% and
40% looser than the law**. Verified against `determinands.csv` and by SPARQL against the live store.

Three things sharpen it:
- `reg:limitStatement` *does* preserve the truth verbatim (`"95 PERCENTILE 15 …; 95 PERCENTILE 25 …"`).
  So the graph contains the right answer — just not in the structured bound that **every query, the
  breach engine and the WINEP comparison actually read**.
- **No breach is currently suppressed.** Replaying the EA's 95th-percentile look-up table over the
  real series at both limits yields 0 breach periods either way. But it is *latent* suppression:
  `breaches_to_db.py` joins observations to permits on `(permit_ref, sp_notation)` and never
  re-narrows to the outlet, so any future BOD sample between 15 and 25 mg/l **would go unbooked**.
- `042116` is a WINEP `targetPermit` (action `08WW102106`), so the current-vs-proposed comparison
  shown in the app runs off the loosened number.

Affects 8 bounds / 8 conditions of 587, all on this one permit. The build already prints a `NOTE`
about it — it just prints it as a curiosity rather than an alarm.

> **DECISION.** Re-key `Condition` to `(permit, version, outlet, effluent, substance)` — the grain the
> register actually uses — or keep the coarse grain and publish the **tightest** (binding) value rather
> than the loosest? Re-keying is the correct model but it moves the Condition IRIs, and WINEP's
> `reg:continuesCondition` already points at the current ones. Until this is settled, **the store must
> not be described as a faithful reproduction of the permit register.**

### A2. MEDIUM — six register-stated `monitoredAt` links are silently dropped

The register names a sampling point for **all 102** outlets in scope. The graph asserts **96**. The
inner `JOIN sampling_points` in `regulation_to_db.py` discards any edge whose sampling point the Water
Quality Archive cannot resolve — these six 404 at the WQA:

```
043236/2/1 → SW-50440124     401354/1/3 → SW-50959903
040070/1/2 → SW-50410121     400607/1/2 → SW-6WXE0555
041639/2/1 → SW-50570248     040096/1/2 → SW-50520133
```

This is an omission, not a falsehood — but it lands badly. **Points apart** argues that the identifier
keeps working when the geometry is missing; here six identifier links were thrown away *because their
target didn't resolve* — the same class of reason the page condemns. It also means the scoring
denominators exclude them.

> **DECISION.** Assert `monitoredAt` to the unresolvable IRI anyway (an IRI is a name, not a promise
> that it dereferences — this is arguably the *more* linked-data-native answer, and it is what the
> register says), or keep dropping them and **say so on the page**? Either is defensible; silence is not.

### A3b. HIGH — the graph is **not in one CRS**, and a documented query silently returns garbage

`ttl/designations/README.md` states: *"one CRS across the whole graph (discharge points and SFI
options are WGS84 too)"*, and on that basis `ttl/designations/TODO.md` publishes a
`geof:distance` query as *"a version that runs on the bundled endpoint"*. Live census:

| Feature | Count | CRS |
| --- | --- | --- |
| Discharge / sampling / WINEP points | 267 | **EPSG:27700** |
| SFI options | 1,115 | **no CRS URI at all** |
| Designations (SSSI/SAC/SPA) | 81 | CRS84 |

So it is **three** encodings, not one. The consequence is worse than a doc error: the published query
**returns zero rows**, and not because `geof:distance` is unbound — it returns **≈5,400 km**, because it
reads the discharge point's BNG easting `389950` as a **longitude in degrees**. It computes nonsense,
the `FILTER(?d <= 1000)` drops everything, and nothing warns you. Anyone who runs the query we shipped
concludes there are no discharges near protected sites.

The worked numbers are also wrong: permit `042451` is **14 m** from Morden Bog & Hyde Heath SSSI (not
86 m), and **926 m** from East Coppice (not 948 m). The *qualitative* point that TODO makes — that
ranking by centroid puts East Coppice (926 m) ahead of Morden Bog (2,174 m) when by boundary Morden Bog
is 14 m — is **exactly right**, and is a good illustration. Only the numbers are stale.

> **DECISION.** Emit a projected EPSG:27700 geometry on the designations (the discharge points are
> *already* projected — the "fallback" the TODO proposes is half-done and nobody noticed), and give the
> SFI options a CRS URI. Until then, **withdraw the published `geof:distance` query** — shipping a query
> that silently answers "nothing found" is worse than shipping none.

### A3. MEDIUM — 110 of 270 breaches rest on an undated-version fallback

67 of 170 `PermitDocument`s carry no applicability period, and 22 permits have **no dated version at
all** (`permit_version_dates.csv` is incomplete). For those, `breaches_to_db.py` judges *every* sample
from 2000–2026 against the permit's **latest** version. That is **110 of 270 breaches** — and in the
RDF they are **indistinguishable** from the 160 backed by a real permit window.

Where dates *do* exist the logic is exact (0 breaches fall outside their version's window), so this is
missing input data, not broken logic.

**And the doc understates the gap by ~13×.** `ttl/regulation/README.md` says only *"3 EPR/non-numeric
permits (5 versions) are left undated"*. The parenthetical is right — but the implication that those
are the *only* undated versions is false: **67 of 170 versions are undated, across 29 permits, and 62
of them are on ordinary numeric permits** (`040725` has 7 undated versions, `040015` 6, `041353` 5).
The cache holds 120 rows; 45 numeric pairs were never fetched, because a later commit added versions
and `fetch_version_dates.py` "fills gaps only".

> **DECISION.** Re-run `fetch_version_dates.py` to close the gap (it is the cheap fix and it shrinks
> A3 to almost nothing), **and** decide whether to mark undated judgements in the graph (e.g. a
> `reg:assessmentCaveat`) so a consumer can tell a dated breach from an undated one. Right now they are
> indistinguishable in the RDF, and 41% is too many to leave unflagged.

---

## B. Conformance to the object model

Checked against the five ontologies in `canwaf/ontology-work`. **No `legacy/` term is used anywhere** —
that migration is clean.

### B1. HIGH — `defra-core:Option` does not exist. The ontology defines `defra-farming:Option`.

One wrong prefix in `ttl/sfi/sfi.obda` mints **1,115** `core:Option` type triples — and that single
typo is the **root cause of ~2,800 further domain/range violations** (`core:hasPart` range,
`core:partOf` domain, `farming:annualPayment` domain), because `farming:Option` is a
`core:DocumentPart` and `core:Option` is nothing at all. `farming:Option` is used **zero** times.

> **DECISION.** Confirm this is simply a typo and not a deliberate divergence, then it is a one-line fix
> that clears three quarters of all conformance violations in the project.

### B2. HIGH — the iAdopt namespace is wrong: we emit `http://`, the vocabulary is `https://`

`regulation.obda` and `winep.obda` declare `iop: http://w3id.org/iadopt/ont/`. I fetched and parsed the
real iAdopt ontology: every term is `https://w3id.org/iadopt/ont/…`. So our **815** triples using
`iop:hasStatisticalModifier` / `iop:StatisticalModifier` reference IRIs that **no vocabulary defines**.
(The property *name* is right — `hasStatisticalModifier` does exist in iAdopt. It is purely the scheme.)

Separately: the DEFRA ontology never mentions iAdopt at all, unlike QUDT which it names explicitly.

> **DECISION.** Correct the scheme to `https://` — and decide whether DEFRA should be adopting iAdopt
> here at all, since the object model doesn't sanction it. This is the vocabulary that carries *which
> statistic a limit is expressed in*, so it is load-bearing for the whole "a limit is not just a number"
> argument.

### B3. MEDIUM — three terms invented under the official DEFRA namespace

| Term | Triples | Minted in |
| --- | --- | --- |
| `reg:breachesBound` | 270 | `ttl/breaches/breaches.obda` |
| `water:samplingPointType` | 161 | `ttl/regulation/regulation.obda` |
| `water:samplingPointStatus` | 161 | `ttl/regulation/regulation.obda` |

None is defined in the ontology. `breachesBound` is *knowingly* invented (`ttl/breaches/README.md`
says so) — but it is still emitted under `environment.data.gov.uk/ontology/regulation/`, which claims
authority the project doesn't have. Aggravating for the two `water:` terms: their subjects are **real
EA IRIs** (`environment.data.gov.uk/water-quality/sampling-point/…`), so we are making up predicates
*about the EA's own resources*, and the UI depends on them (`points.js`, the measured-world colouring).

> **DECISION — and this is the one that unlocks the most.** `reg:breachesBound` exists because a
> `reg:Limit` can carry several bounds (one per statistic — 119 of them do), so naming the breached
> *condition* doesn't say *which* bound failed. Two ways out: **(a)** add `breachesBound` to
> `defra-regulation.ttl` upstream, or **(b)** make each statistic its own `Limit`, after which
> `breachesCondition` suffices and the invented term disappears. Your own
> `ttl/breaches/README.md` sketches both. Pick one. Same decision governs B4 below.
>
> For the two `water:` terms: propose them upstream, or move them to a project namespace and stop
> implying DEFRA blessed them.

### B4. MEDIUM — `xsd:date` vs `xsd:dateTime` on the same properties

`core:applicableFrom` / `applicableTo` carry **185 `xsd:date`** and **1,063 `xsd:dateTime`** values,
split by which pipeline emitted them (`regulation.obda` and `winep.obda` say `date`; `breaches.obda`
and `sfi.obda` say `dateTime`). The ontology's range is `xsd:date`. A cross-source date filter will
**silently return nothing** — no error, just an empty result.

> **DECISION.** Standardise on `xsd:date` per the ontology, or change the ontology? Either way this is
> the sort of thing that makes a demonstrator look untested in front of an audience.

### B5. LOW — WINEP completion dates bypass the ontology's own property

All 11 actions carry their completion date, but via an applicability period; `reg:completionDate` is
**defined in the ontology and used zero times**. (The app reads the applicability period, so nothing is
broken — but we are not modelling it the way the object model says to.)

### B6. Two defects **in the ontology itself** — feed these back upstream

- `defra-reg:documentsPermit rdfs:subPropertyOf defra-core:about` — **`defra-core:about` is never defined.**
- `defra-farming.ttl` declares its ontology IRI as `<http://environment.data.gov.uk/ontology/water>` —
  a copy-paste from the water file. Two `owl:Ontology` resources now collide on one IRI.

> **DECISION.** Raise these on `canwaf/ontology-work`. They are not our bugs, but they are our problem.

Other conformance notes: `core:hasClassification` points at 21 SKOS concepts that are never typed
(56 references to `…/Option/Concept/LIG1` alone); 646 `core:Applicability` with zero `core:appliesTo`;
450 `skos:Concept` with no `prefLabel`; `reg:Driver` defined and unused though the WINEP README talks
about competing regulatory drivers.

---

## C. The argument in *Points apart*

**The conclusions hold.** Every number re-derives, and the central claim survives the hardest test I
could put to it (see C4). What follows are gaps in *framing*, and one irony.

### C1. HIGH — the page lets **geometry decide what it counts** — which is the exact thing it condemns

Since outlets with no coordinate were correctly given no geometry, they have no leg — and the page
counts legs:

| The page says | The truth |
| --- | --- |
| Explorer: *"every `targetPermit` and every `monitoredAt` in the catchment, **102** of them"* | **107** asserted (96 + 11). 102 is merely the number it can *draw*. |
| Why screen: *"**91** outlets the register names a sampling point for"* | The register names one for **96**. |
| Regulated-world lede: *"the **95** outlets sit on just 37 coordinates"* | There are **102** outlets. 95 are mapped. |

The **scoring** denominator of 91 is right (you cannot score proximity without a coordinate). It is the
**labels** that overclaim. On the one page whose thesis is *"do not let the presence of geometry decide
what exists"*, the prose is doing precisely that.

> **DECISION.** Re-label to distinguish *asserted* from *drawable* throughout. This is the finding I
> would fix first — it is cheap, and a hostile reader who spots it will use it to discredit everything
> else on the page.

### C2. MEDIUM — the `monitoredAt 91/91 · 100%` tile is a tautology

`monitoredAt` **is** the ground truth the scoring compares against (`truth = c.monOf`). Scoring it
against itself necessarily yields 100%. It is the first thing a reviewer will reach for.

The **experiment underneath it is sound** — "if you throw the identifier away, how much can you get
back from the map?", answer **42 of 91** — and that is genuine and falsifiable. But the store cannot
demonstrate that `monitoredAt` is *correct*; only that it is *stated*. If the register's link were
wrong, nothing here would catch it.

> **DECISION.** Drop the green tile and reframe the comparison honestly ("the identifier is the
> regulator's statement; the question is whether a map can recover it"), or keep it and add the caveat
> in plain sight? I would drop it — the page is **stronger** without a claim it cannot support.

### C3. HIGH — we use the **worst of the three published geometries**, and the page never says so

The EA publishes a grid reference at three levels. Scored over the 69 outlets that carry all three:

| Geometry | Distinct coords | Nearest-neighbour correct |
| --- | --- | --- |
| `DISCHARGE_NGR` — site (**what this store uses**) | 37 | **33 / 69 (48%)** |
| `OUTLET_GRID_REF` — outlet | 60 | **53 / 69 (77%)** |
| `EFFLUENT_GRID_REF` — effluent | 66 | 53 / 69 (77%) |

`ttl/regulation/README.md` documents this fully and honestly, and the reason for using the site ref is
good (*it is what the public register surfaces as "the" discharge location*). **But Points apart — the
public-facing argument — never mentions it.** A reviewer who finds it will say we picked the geometry
that made proximity look worst. Answering that in a dataset README is not answering it.

> **DECISION.** Put the three-way table on the Why screen and let the argument stand on the strongest
> version of the opposition's case, or state plainly why the site ref is the honest one to test. Do not
> leave this only in a README.

### C4. MEDIUM — the page's **best argument is the one it doesn't make**

The page rebuts *"just restrict the layer to outfall points"* with a **circularity argument** — *you can
only filter that way if you already know the answer*. True, but it reads like a debating move. It has a
number available and doesn't use it. I ran the counterfactual:

| Candidate set given to proximity | Score |
| --- | --- |
| The whole 161-point layer (what the page uses) | 42 / 91 (46%) |
| **Oracle filter** — only the 70 genuine outfall points (requires knowing the answer) | **47 / 91 (52%)** |
| `water:monitoredAt` | 91 / 91 |

**Even cheating, proximity barely beats a coin toss.** And the radius trap *survives* the oracle filter
(Brockhill still has 4 candidates at 1,100 m). This is a far stronger rebuttal than the circularity
point, and it is empirical.

> **DECISION.** Add the counterfactual row. It costs one table and it closes the biggest hole in the
> argument.

### C5. LOW — two overreaches in the prose

- Blackheath: *"the single place in the catchment guaranteed to carry none of its effluent"* — **91**
  points carry none of it. The sentence means *the nearest*, but it doesn't say that.
- *"US = upstream"* is **asserted, not derived**. It is borrowed from the EA's own label. It is well
  corroborated (the other Sherford stations lie east; the river runs east to Poole Harbour) but the
  store holds no flow-direction or river-network data, so we cannot prove it.

> **DECISION.** Soften both, or add flow-direction data (WFD river network) and actually prove the
> upstream claim — it is the most rhetorically powerful sentence on the page and it currently rests on
> a naming convention.

---

## D. Documentation that is simply wrong

| # | Claim | Reality |
| --- | --- | --- |
| D1 | README: *"loads all **four** into a single pyoxigraph store"*, *"the 4 graphs"* | `server.py` loads **five** (`breaches.ttl` was added and the README never caught up). The **rebuild section omits breaches entirely** — following its steps never produces `breaches.ttl`. |
| D2 | README's `config.js` block shows `"/sparql"`, `"/observations"`, `"/tiles/…"` | The real `app/config.js` has **no leading slashes** — and the README's own pitfall note says a leading slash **breaks sub-path deploys**. Copy the README and you break `BASE_PATH`. |
| D3 | *"Points apart — the argument, in **five screens**"*, *"three worked examples"* | **Six** routes, **four** examples. The README's own table lists six rows. |
| D4 | *"**Three** utility pages hang off the app chrome (header, footer)"* | Points apart is in **neither** the header nor the footer — it is reachable only from an inline link inside a lede. |
| D5 | *"**Each screen** deep-links into the SPARQL editor"* | `#/unlocatable` and `#/explorer` have **no** SPARQL link. 4 of 6 do. |
| D6 | *"All of the docs below also render in-app"* | The docs sidebar **omits `ttl/breaches/README.md`** entirely. |
| D7 | The `app/` repo-layout listing | Stale — omits `points.{html,js,css}`, `config.js`, `vendor/`, each of which has its own README section. |

> **DECISION.** All are mechanical. D2 is the one that actively hurts someone (a broken deploy);
> D1 is the one that makes the project look unmaintained.

### Per-dataset docs — 12 wrong claims, 4 stale

Every **headline count** in these docs re-derives exactly (61/170/587/800/102/95/161/17/12, the
95-on-37-coords, Brockhill's 7-on-1, the whole breaches table, the Poole WRC worked example). These are
the ones that don't:

| # | Doc | Claim | Reality |
| --- | --- | --- | --- |
| D8 | `ttl/regulation/README.md` | *"the extra 26 include flow, **colour, turbidity and pH**"* | **Written by me, and wrong.** pH (`0061`), Colour (`0072`) and Turbidity (`6396`) are **already among the current 12 substances** — they cannot be "extra". Only **flow** is genuinely new; the real 26 are flow determinands, heavy metals, pesticides/solvents and storm telemetry. The count (38 − 12 = 26) is right. Same error repeated in the top-level README. |
| D9 | `ttl/regulation/README.md` | *"for **8 of the scored outlets** its nearest hit monitors no discharge"* | **Written by me, and imprecise.** 8 is right for all *mapped* outlets; within the **69-outlet scored set** it is **5** (three of the eight — `042451/1/1`, `/1/2`, `/2/1` — carry no outlet/effluent grid ref, so they aren't in the 69). Say "8 of the mapped outlets", or say 5. |
| D10 | `ttl/regulation/README.md` | *"permit refs are 6-digit"* | Three are not (`400114/CF/01`, `EPRBB3593EG`, `EPRYP3399VF`) — and the doc **contradicts itself** 118 lines later. |
| D11 | `link_data.py` comment | *"**26 permits** whose ammonia limit is a percentile"* | **24.** |
| D12 | `ttl/breaches/README.md` | *"70.7% of BOD, 47.1% of ammonia"* non-detects | **BOD 63.9%, ammonia 35.9%.** No population reproduces the doc's figures. The headline 34% overall **is** right and robust. |
| D13 | `ttl/winep/TODO.md` | Describes the **pre-clip** population (268/196/67, ~18 `chemical` limits, 12 competing pairs of which 7 chemical) | Those are Wessex-wide figures. **In the delivered graph:** 27 limits, **zero** `wr:substance/chemical`, **5** competing pairs — which are *exactly* the "genuine cases" the TODO names (401050 N/P/Fe, 401747 P/Fe). Its "limits needing attention" query returns 8, but **6 are carried-over limits** deliberately modelled with `continuesCondition` — it overstates the backlog **4×**. Most of this TODO is already done. |
| D14 | `ttl/winep/README.md` | `042116` cited as the example of a site kept by the catchment-**site** clause | `042116` **is** one of the 61 regulation permits — the *permit* clause keeps it. Worse: **no emitted action depends on the site clause at all** (all 11 have `permit_in_catchment = True`); deleting the clause changes the output by **zero rows**. |
| D15 | `ttl/designations/README.md` | *"`defra-nature:ProtectedSite` (in `ontology-work/defra-nature.ttl`)"* | **`ontology-work/` does not exist in this repo and never has.** Broken reference — the file lives in the external `canwaf/ontology-work` repo. |
| D16 | `regulation_to_db.py` header | Still carries **pre-rewrite numbers** (67 points / 32 coords; 38-56-54 of 64) and still describes the **deleted** geometry fallback. It also still says the extracts *"cover every monitored discharge point, so all get a real NGR"* — contradicting the NO-FALLBACK section **40 lines below it in the same file**, the script's own build output, and points.html | The single most misleading file in the repo. |
| D17 | `points.js:12-14` | *"every number is COMPUTED FROM THE STORE at render time (see the `fact()` helpers)"* | **There is no `fact()` helper.** And the example ledes **do** hard-code figures — "Seven outlets, belonging to four different permits", "a kilometre away". They are *true*, but they are typed into the prose, which is exactly what the comment claims they are not. Mine. |
| D18 | `app.js:5` / `:257`, `points.js:3-9` | "four views", "five screens" | **Three** views (regulated/measured/farming), **six** screens. |
| D19 | `app.js:272` | *"the **95** points that belong to no permit"* | **91.** |
| D20 | `points.js` kicker | "Example 3 of 3" on screens 1–3, "Example 4 of 4" on screen 4 | Inconsistent — it counts to a different total depending on which screen you're on. Mine. |

> **DECISION on D13 specifically:** most of the WINEP TODO is complete and the doc doesn't know it.
> Worth a pass to close it out rather than leaving a backlog that reads as 4× its real size.

### One audit finding that was itself WRONG — recorded so nobody re-opens it

The per-dataset audit claimed the scoring table only reproduces from `consents_active.csv` alone, and
that using `active + all` (what the store actually reads) would give a different population
(87 outlets, 41/64/66). **I re-derived it both ways: they are identical** — 69 outlets, 37/60/66
distinct coords, 33/53/53 correct. `consents_all.csv` contributes no grid references for any scoped
permit. **The table in `ttl/regulation/README.md` is correct and robust to the file choice.** No action.

---

## E. App and endpoint defects

### E1. HIGH — the SPARQL endpoint supports **only `SELECT`**

`ASK`, `CONSTRUCT` and `DESCRIBE` **all return HTTP 400**, from one root cause: `server.py` reads
`results.variables` unconditionally.

```
ASK { ?s ?p ?o }            -> 400  'pyoxigraph.QueryBoolean' object has no attribute 'variables'
CONSTRUCT { … } WHERE { … } -> 400  'pyoxigraph.QueryTriples' object has no attribute 'variables'
DESCRIBE <…>                -> 400  'pyoxigraph.QueryTriples' object has no attribute 'variables'
```

`app/TODO.md` documents only the ASK case **and explicitly claims "SELECT and CONSTRUCT/DESCRIBE are
unaffected" — which is false.** Meanwhile the README advertises a "SPARQL 1.1 endpoint" and an in-app
editor for "ad-hoc queries": **three of the four query forms fail.** Anyone who opens the editor and
types a `CONSTRUCT` gets a 400.

> **DECISION.** Fix the serialiser (it is ~10 lines: branch on result type, emit
> `{"boolean": …}` for ASK and Turtle/N-Triples for CONSTRUCT/DESCRIBE), and correct `app/TODO.md`,
> which is currently misleading about its own bug.

### E2. MEDIUM — three provenance queries no longer reproduce their tables

Every table carries a **◈ SPARQL** link, and the README's central credibility claim is that each one
*"reproduces, as ONE declarative query, the row set the table shows"*. All six were run via their own
`href`:

| Table | Query returns | Table shows | |
| --- | --- | --- | --- |
| Breaches | 270 | 270 | ✅ |
| Breaches (substance-filtered) | 5 | 5 | ✅ |
| Permits & limits | 58 | 58 | ✅ |
| Applications (SFI) | 262 | 262 | ✅ |
| **Sampling points** | **187** | **161** | ❌ 22 points are monitored by >1 outlet; the runtime query collapses the fan-out with `SAMPLE`/`GROUP BY`, the provenance query doesn't |
| **Current limits & future works** | **76** | **27** | ❌ |
| **WINEP Actions** | **11** | **1** (when a substance is selected) | ❌ `PQ.actions()` **ignores the substance filter entirely** |

The README admits these "CAN DRIFT" — but it describes the *opposite* failure (too **few** rows). All
three live drifts return **too many**, which is the direction that makes the app look like it is hiding
rows.

> **DECISION.** These queries are the demonstrator's whole "every table *is* one answerable question"
> claim — a reviewer will click one. Either add a build check that each `PQ` row count matches its
> table's, or stop making the claim. The `PQ.actions()` one is a straight bug, not drift.

### E3. LOW — `app/app.js` contains two literal **NUL bytes**

Used deliberately as a composite-key separator (`` `${permit}\0${sub}` ``). It works — but it makes the
file **binary to `grep` and `ripgrep`**, which silently skip it unless forced with `-a`. This actively
cost time during this very audit.

> **DECISION.** Swap for a printable separator (``, or just `|`). Trivial, and it stops the file
> disappearing from every future search.

### E4. LOW (latent) — a breach on an unlocatable outlet would vanish from the app

The app's breach query requires `?dp geo:hasGeometry`. Today all 270 breaches display, but **only by
luck**: the five geometry-less permits happen to have no breaches. If one ever did, it would disappear
from the UI with no error — the exact failure mode this project exists to warn about.

### E5. LOW (latent) — an IRI-encoding bug waiting for the right permit

`winep_to_db.py` hand-builds `continuesCondition` as an f-string rather than an ontop template, so a
slash-bearing permit ref (`400114/CF/01`) would produce an **unencoded** IRI and the join would fail
**silently**. All four current targets are numeric, so it is dormant — it fires the day WINEP touches an
EPR-style ref.

### E6. LOW — "every table is paginated and sortable" is overstated

Nested detail tables inside expanded rows use `tableEl()`, not `pagedTable()` — neither paginated nor
sortable. And `pagedTable` returns early for tables with fewer than two row-groups, skipping the sort
handlers as well as the pager.

---

## F. Verified clean — do not spend time re-checking

- **Referential integrity:** 0 dangling refs, 0 orphans, 0 broken cross-graph joins.
- **Faithfulness to source:** scope (61 permits), discharge points (102), `monitoredAt` (96), geometry
  (95, independently re-decoded from NGR), conditions (587), bounds (800, zero value mismatches),
  sampling points (161, zero drift), substances (12) — **all reconcile exactly**.
- **No fabricated geometry.** The "NO FALLBACK" policy holds: 7 outlets correctly carry none. The one
  remaining coincidence (`040111/1/1`) is **genuinely** in the sources — though note the
  `OUTLET_GRID_REF` in the same register row puts the outfall 30 m E / 90 m N away, so the code's own
  caveat ("rounding rather than truth") is right.
- **`%2F` encoding is consistent** across all 24 IRIs of the `400114/CF/01` family, in both graphs.
- **Every number** in the READMEs and on Points apart is arithmetically correct, including the full
  three-grid-ref scoring table and all four worked examples.
- **No `legacy/` ontology term is used anywhere.**

---

## Suggested order

1. **A0** — 15 sampling points are assessed against nothing and show as clean. **Quote no breach count
   until this is re-fetched.** It is also the cheapest of the three big ones: re-run one script.
2. **A1** — the store misstates a permit limit (67% too loose). A0 and A1 compound: once the missing
   observations arrive, they will be judged against the wrong number.
3. **A3b** — we ship a spatial query that silently answers "nothing found" by computing 5,400 km.
   Withdraw it or fix the CRS today.
4. **C1** — cheap, and it is the finding a hostile reader would use to discredit the rest of the page.
5. **B1 / B2** — two one-line namespace fixes that clear ~4,000 conformance violations between them.
6. **E1 / E2** — the editor is advertised as SPARQL 1.1 and answers 400 to three query forms in four;
   three of the six provenance links no longer reproduce their table.
7. **A3** — re-run `fetch_version_dates.py`; cheap, and it shrinks the 41%-undated problem to near
   nothing.
8. **D1–D20** — mechanical. D8, D9, D17 and D20 are **mine** and wrong; they should not survive the
   morning.
9. **C3 / C4** — make the argument on the strongest version of the opposition's case. It wins anyway.
10. **B3** — the `breachesBound` modelling question. Needs a real decision, not a patch.

### A pattern worth naming

Three of the most serious findings (**A0**, **A2**, and the deleted geometry fallback that started this)
are the *same mistake in different clothes: an absence rendered as a value.* An unfetched sampling point
displays as "no breach". A dropped `monitoredAt` edge displays as "no link". A missing coordinate used
to display as a plausible dot. Each time, the pipeline had no way to say **"I don't know"**, so it said
something false and said it quietly.

That is precisely the thesis *Points apart* argues — and the store keeps committing the error it was
built to expose. Worth a standing rule: **when a fact is absent, the graph must say so, and the app must
show it.**

---

## Provenance of this audit

Six independent passes, each re-deriving from source rather than re-reading the docs; every HIGH
finding then re-verified by hand before it was written down. Full working, with the queries and the
counter-derivations, is in [`validation/`](validation/):

| File | Scope |
| --- | --- |
| `01-ontology-conformance.md` | every class/property in the data vs `canwaf/ontology-work` |
| `02-readme-claims.md` | top-level `README.md`, claim by claim |
| `03-points-apart.md` | the argument, its arithmetic, and its methodology |
| `04-graph-vs-source.md` | referential integrity + faithfulness to the raw CSVs |
| `05-dataset-readmes.md` | every per-dataset README and TODO |

| `06-code-and-runtime.md` | code-comment assertions + the app driven in a real browser |

The runtime pass is worth reading on its own: **every behavioural claim checked out.** All six tables
paginate and sort correctly (identifiers sort as identifiers, numbers as numbers), expanded rows stay
with their summary after sorting and paging, clicking a WINEP marker turns the pager to its row, the
chart correctly shows no limit line for an unregulated point, all six Points-apart routes render, no
discharge-point marker is drawn on `#/unlocatable`, no leg is ever drawn between two discharge points,
and there are **zero console errors on any page**. The *code* does what it says. It is the *prose about
the code* — the long explanatory comments — that is the least reliable documentation in the project
(see D16).
