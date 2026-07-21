# Catchment Data Explorer — ingest plan

Status: **investigation complete, nothing ingested.** Source access obtained 2026-07-20 and every
finding below re-validated against it (§6). The build is specified in [TODO.md](TODO.md); orientation is
in [README.md](README.md); source-data defects are in [ISSUES.md](ISSUES.md).

Scope: Poole Harbour Rivers (`OperationalCatchment/3367`).

> **§§1–4 were written from the CSVs, before source access.** They are kept because the reasoning
> and the cross-table rule remain sound, but two of their conclusions were later overturned by §5 and
> §6 — the hydromorphological designation is fully modelled (not absent), and it is not constant here
> (three rivers changed between versions). Where §2 and §5/§6 disagree, **§5/§6 win.**

---

## 1. There is no public RDF. Do not go looking again.

The site is an Epimorphics-style linked-data app and *looks* like it should content-negotiate. It does
not. Probed and recorded so nobody repeats it:

| Probe                                                                                                    | Result              |
| -------------------------------------------------------------------------------------------------------- | ------------------- |
| `…/OperationalCatchment/3367.ttl`                                                                        | 200 **`text/html`** |
| `…/OperationalCatchment/3367.rdf`                                                                        | 200 **`text/html`** |
| `…/OperationalCatchment/3367.json`                                                                       | 200 **`text/html`** |
| `Accept: text/turtle` (and `application/rdf+xml`, `ld+json`, `n-triples`)                                | 200 **`text/html`** |
| `…/catchment-planning/so/WaterBody/{id}` — the canonical URI the GeoJSON itself advertises               | **404**             |
| `…/catchment-planning/data/classification/waterbody/…` — the URI in the CSV's `Classification ID` column | **404**             |
| `https://environment.data.gov.uk/sparql`                                                                 | **404**             |

The extension-bearing URLs return HTML with HTTP **200**, not 404 or 406 — a content-negotiation probe
that trusts the status code will report success and hand back a web page. Check `content-type`.

**The published machine-readable surface is CSV, GeoJSON and shapefile.** Hence: get source access.
The CSVs are richer than the rendered HTML tables and are a viable shim, but they are a shim.

### Data actually available

| What                       | URL                                           | Size                                          |
| -------------------------- | --------------------------------------------- | --------------------------------------------- |
| Classifications            | `…/3367/classifications.csv`                  | 5,852 rows                                    |
| Site classifications       | `…/3367/site-classifications.csv`             | ~1.4 MB                                       |
| Challenges (RNAGs)         | `…/3367/rnags.csv`                            | 93 rows                                       |
| Objectives                 | `…/3367/objectives.csv`                       | —                                             |
| Protected areas            | `…/3367/protected-areas.csv`                  | —                                             |
| Catchment outline          | `…/3367.geojson`                              | —                                             |
| **Per-waterbody geometry** | `…/catchment-planning/WaterBody/{id}.geojson` | polygon + `id`/`name`/`uri`/`water-body-type` |

The per-waterbody GeoJSON is what any map-highlighting feature needs. The app currently holds only a
single catchment outline (`app/catchment.geojson`, one feature, **empty properties**) — there is no
waterbody layer yet, and no waterbody entity in the graph.

---

## 2. What this catchment's data actually contains

Three facts that constrain what the demonstrator can honestly show.

**The two classifications named in the original request are constants here.** All 5,852 classification
rows carry:

- `Water Body Type` = `River` (1 distinct value)
- `Hydromorphological designation` = `not designated artificial or heavily modified` (1 distinct value)

The natural / artificial / heavily-modified scheme is trivially buildable — and in Poole Harbour it
sorts 19 waterbodies into one bucket. **Decision taken: build the schemes in full and let the UI show
the degenerate case**, because these are national EA vocabularies and the point is portability to
catchments where they discriminate. But nothing here should be *driven* by them.

**Nitrate does not appear.** Zero matches for `nitr*` in either CSV. The Challenges → nutrients link is
**phosphorus only**: `Phosphate` appears 33× at RNAG `Pressure Tier 3`, 17× as `Classification Element`,
218× in classifications. The app already runs a paired nitrogen-and-phosphorus story (`app/app.js`
~L1150) — this asymmetry must be stated, not rendered as an empty nitrogen panel.

**What does discriminate** is the classification hierarchy: `Classification Item` (74 values) ×
`Status` (11) × `Year` (2009–2022) × `Cycle` (1–3) × `Classification Level` (5 levels: Overall Waterbody
→ Ecological/chemical/quantitative status → Component → Element → Sub Element).

---

## 3. The cross-table counting rule (reverse-engineered, exact)

The Challenges cross-table at `…/3367/rnags` is **not** a row count of `rnags.csv`. It is:

> count of **distinct `(Water Body ID, Classification Status, Pressure Tier 3)`** triples,
> filtered to `Classification Status ∈ {Bad, Poor, Moderate, Fail, Does Not Support Good}`,
> grouped by `Category` (business sector, rows) × `National Swmi Header` (SWMI, columns).

Verified: reproduces all 8 populated cells **and** the total of 29, exactly. The obvious alternatives do
not — row counts give 17 where the site says 12; distinct-waterbody counts give 9.

```
Agriculture and rural land management x Physical modifications                 2 = 2
Agriculture and rural land management x Pollution from rural areas            12 = 12
Industry                              x Pollution from towns, cities…          2 = 2
Recreation                            x Pollution from towns, cities…          3 = 3
Sector under investigation            x Physical modifications                 1 = 1
Urban and transport                   x Pollution from towns, cities…          1 = 1
Water Industry                        x Changes to the natural flow…           1 = 1
Water Industry                        x Pollution from waste water             7 = 7
                                                                    TOTAL     29 = 29
```

### The 60% the cross-table cannot show

**56 of 93 RNAGs (60%) have a blank `Category`, a blank `National Swmi Header`, or both**, and therefore
cannot appear in any cell. That includes all 38 rows whose reason is
`measures delivered to address reason, awaiting recovery`.

A click-to-highlight built naively on this table would silently imply those 56 RNAGs do not exist. This
is precisely the failure mode `app/TODO.md` is organised around — *an absence rendered as a value*. Any
cross-table UI must carry an explicit unattributed row/column.

### Column naming trap

`rnags.csv` has a column literally named `Swmi` — it does **not** hold SWMIs. It holds pressure types
(`Diffuse source`, `Point source`, `Natural`, `Flow`…). The actual SWMIs, matching the site's column
headings, are in **`National Swmi Header`**.

---

## 4. Phases

**Phase 0 — SKOS vocabularies.** Source-independent; the schemes are national EA vocabulary, so
only the URIs change when real ones arrive. Extractable from the two CSVs: Hydromorphological
designation, Water Body Type, Classification Item, Classification Level, Status, Business Sector, SWMI,
Activity, Pressure Tier 1/2/3, Certainty, Reason Type.

**Phase 1 — waterbody entities.** 19 waterbodies; currently absent from the graph entirely. The join key
everything else hangs off and the thing the UI highlights. Geometry from the per-waterbody GeoJSON.

**Phase 2 — classifications and RNAGs.** Model each RNAG as a reified reason-node — it has a stable `ID`
and its own URL (`/catchment-planning/ReasonsForNotAchievingGood/{id}`) — rather than flattening it onto
the waterbody. Reification is what preserves the three independent certainty triples (`Category
Certainty`, `Swmi Certainty`, `Activity Certainty`); flattening loses the confirmed-vs-probable
distinction the site's own table depends on.

**Phase 3 — cross-table UI.** Cells carry their contributing waterbody set so a click highlights the map
layer. Unattributed RNAGs shown explicitly.

---

## 5. Questions put to the source — ANSWERED (2026-07-20)

Access obtained to the internal source SPARQL endpoint (not publicly reachable). Client:
[`sparql_client.py`](sparql_client.py), with the endpoint and basic-auth credentials taken from the
environment (`CDE_SPARQL_ENDPOINT`, `CDE_SPARQL_USER`, `CDE_SPARQL_PASSWORD`, `CDE_REPOSITORY`) — nothing
about the deployment is recorded here.

The source exposes more than one repository/dataset; some look like deployment slots — **confirm which
is authoritative before pinning an ingest to one.**

| #   | Question                                     | Answer                                                                                                                   |
| --- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | Do the `so/` URIs resolve internally?        | **Yes.** `cp:so/WaterBody/{id}` and `cp:so/OperationalCatchment/3367` are the real subject URIs. Use them; mint nothing. |
| 2   | Is the cross-table aggregation materialised? | **No.** Must be computed. Our §3 rule stands — but see the `nationalSWMIheader` trap below.                              |
| 3   | Are the vocabularies already SKOS schemes?   | **Yes — 19 of them.** Do not mint any.                                                                                   |
| 4   | Are unattributed RNAGs explicit or absent?   | **Absent.** `nationalSWMIheader` is simply missing on those rows.                                                        |

### Scale and shape

National dataset, ~2M `qb:Observation`s. Classifications and RNAGs are **RDF Data Cube**, not ad-hoc
triples — dimensions are already modelled, which removes most of Phase 2's design work.

| Class                            | Count     |
| -------------------------------- | --------- |
| `wbc:ClassificationObservation`  | 2,042,495 |
| `wbc:Classification`             | 1,876,135 |
| `monitoring-site:Classification` | 482,920   |
| `rff:Problem`                    | 61,353    |
| `rff:ReasonForFailure`           | 37,509    |
| `wfd:WaterBody`                  | 14,864    |

**A reasoner is materialising inferred types.** Every entity carries dozens of `rdf:type` triples to
blank-node OWL restriction classes (`node1536`…). Any `?s a ?c` query must filter
`isIRI(?c) && !STRSTARTS(STR(?c),"node")` or the results are unusable. Waterbodies are also dual-typed
under both `cp:def/water-framework-directive/` and `location.data.gov.uk/inspire/am/…` (INSPIRE
alignment) — pick one namespace and stay in it, or every count doubles.

**Waterbodies are versioned:** `dct:hasVersion` → `so/WaterBody/{id}/1`, `/2`, with
`version:currentVersion` pointing at the latest. Classifications may attach to versions rather than to
the base URI. **Resolve this before Phase 2** — getting it wrong silently mixes WFD cycles.

### The 19 published concept schemes

`measureTierScheme` (249), `wbClassificationItemScheme` (201), `measureScheme` (193), `pressureScheme`
(158), `activityScheme` (100), `businessCategorySectorScheme` (61), `rfaoScheme` (26),
`classificationValueScheme` (20), `swmiScheme` (14), `actionStatusScheme` (12), `protectedAreaScheme`
(11), `apportionmentScheme` (7), `deteriorationTypeScheme` (7), `classificationCertaintyScheme` (6),
`certaintyScheme` (5), `deteriorationCertaintyScheme` (5), `investigationOutcomeScheme` (4),
`measureStatusScheme` (3), `reasonForFailureTypeScheme` (2).

Phase 0 collapses to *reuse these URIs*. It is no longer a build task.

### RNAG structure (`cp:data/reason-for-failure/{id}`)

A `qb:Observation` carrying: `waterBody`, `classificationItem`, `classificationYear`, `cycle`,
`activity` + `activityCertainty`, `businessSector`, `category` + `categoryCertainty`, `swmi` +
`swmiCertainty`, `pressureTier3`, `problem`, `reasonForFailureType`, `classification`,
`nationalSWMIheader`. Maps cleanly onto `rnags.csv`. Reification (Phase 2) is already done upstream.

### Two traps in the cross-table axes

**The row axis is a concept; the column axis is a bare string.** `category` resolves to a
`businessCategorySectorScheme` concept (`bcs_1`). `nationalSWMIheader` is a **plain literal** —
`"Pollution from rural areas"` — with no URI, no scheme, no label in any other language, and nothing to
dereference. The cross-table's columns are therefore un-modelled text.

**`swmiScheme` is not the cross-table's column axis.** It holds `Diffuse source`, `Point source`,
`Natural`, `Flow`, `Suspect data`, `measures delivered…` — i.e. exactly the CSV's `Swmi` column. The
site's column headings live only in the `nationalSWMIheader` literal. §3's correction stands, but the
naming is the reverse of what it looked like from CSV alone: `swmiScheme` *is* the real SWMI vocabulary;
the site's "significant water management issue" headings are a separate, unmodelled national rollup.

### Natural / artificial / heavily modified — ALREADY MODELLED. Do not build it.

**This section previously claimed the designation was absent from the source graph. That was wrong.** It
is fully modelled, and the error is worth recording because it was caused by two query traps that will
catch anyone else the same way (see below).

`cp:def/water-framework-directive/aOrHMConceptScheme` exists with four top concepts, each carrying an
`rdfs:label` and a full `rdfs:comment` definition:

| Concept | Label | National count |
| --- | --- | --- |
| `ahm_notDesignated` | not designated artificial or heavily modified | 5,397 |
| `ahm_heavilyModified` | heavily modified | 3,146 |
| `ahm_artificial` | artificial | 862 |
| `ahm_notApplicable` | not applicable | 528 |

Linked by `wfd:hydromorphologicalDesignation`, populated **9,933 times nationally**. So §2's claim that
this scheme is degenerate holds *only for Poole Harbour* — nationally it discriminates strongly, which
is the argument for the "build general, show degenerate" decision.

**It attaches to the versioned waterbody** (subjects typed both `wfd:WaterBody` and `version:Version`),
not to the base URI. This resolves the open versioning question for at least this property: a waterbody's
designation is a per-version fact, so it must be read through `version:currentVersion` or explicitly per
cycle. Reading it off the base URI returns nothing.

### Two query traps that produced the wrong answer above

**1. `skos:inScheme` is not the only membership predicate — and for the WFD vocabularies it is not used
at all.** Scheme discovery via `?c skos:inScheme ?scheme` finds 19 schemes. Via
`?c skos:topConceptOf ?scheme` it finds **29**, and the entire `water-framework-directive` family —
`aOrHMConceptScheme`, `areaGeologyConceptScheme`, `catchmentSizeConceptScheme`,
`alkalinityConceptScheme`, `altitudeConceptScheme`, `exposureConceptScheme`,
`groundWaterClassificationScheme`, `lakeDepthConceptScheme`, `salineClassificationConceptScheme`,
`tidalRangeClassificationConceptScheme`, `statusOrPotentialConceptScheme` — appears **only** in the
second list. Always query the union of both.

**2. Concepts are not always typed `skos:Concept`.** The four designations are typed
`wfd:HydromorphologicalDesignation`. A discovery query filtering on `?c a skos:Concept` misses them
entirely.

Chasing the similarly-named `wfd:heavilyModified` compounded both: that *is* a dead OWL property with
zero data uses, appearing only in two `owl:onProperty` restrictions. Its existence made "no data" look
confirmed. **A near-miss name that returns zero is not evidence of absence.**

### A misspelled scheme exists alongside the correct one

`cp:def/classification/classifcationValueScheme` (note: missing `i`, "classifcation") holds 13 concepts
and coexists with `classificationValueScheme` (20 concepts). Any code selecting classification values by
scheme URI must know which one the data actually references, or it will silently under-select. Verify
before Phase 2.

### The diagram is a specification, not a description

The supplied CDE UML model describes ~99 classes. **39 of them hold zero instances**, including the
entire action/measure delivery side: `Action`, `ActionAim`, `ActionCost`, `ActionDeliverability`,
`ActionEffect`, `ActionResource`, `ActionMeasureStatus`, `WaterBodyLevelMeasure`, `WideAreaMeasure`,
every `*Investigation` subtype except `ConfirmfailureInvestigation`, all four `*Dataset` classes, and all
of `BenefitCategory`/`BenefitSummary`/`MeasureActionSummary`. `PressureHierarchy` and `SectorHierarchy`
are also empty — so the SWMI rollup hypothesis in §3 is dead, and `nationalSWMIheader` really is an
un-modelled bare literal.

**Do not plan a phase around a box in that diagram without first counting its instances.**

---

## 6. Validation of every CSV-derived claim (2026-07-20)

All §2/§3 findings were re-derived from the source graph. Harness:
[`validate_csv_claims.py`](validate_csv_claims.py). Result: **the CSV is accurate but incomplete, and
one §2 claim was substantively wrong.**

| Claim | CSV | Source | Verdict |
| --- | --- | --- | --- |
| Waterbodies in OC 3367 | 19 | 20 (19 excl. a spurious record) | CSV right, graph has a defect |
| All type `River` | yes | 19 River + 1 Lake (the spurious one) | CSV right |
| Classification records | 5,852 | **5,852** | exact |
| Distinct classification items | 74 | **74** | exact |
| Classification years | 10 (2009–2022) | **10, identical set** | exact |
| Cycles | 3 | **3** | exact |
| Nitrate/nitrogen present | none | **none** | confirmed |
| RNAG records (cycle 3) | 93 | **95** | CSV drops 2 |
| RNAGs with no SWMI header | 56 | **57** | follows from the above |
| Cross-table, all 8 cells + total | 29 | **29, exact match** | rule confirmed |
| Hydromorph designation constant | yes | **no — 3 rivers changed** | **CSV misleading** |

### The cross-table rule is confirmed against the source

§3's rule — distinct `(waterbody, status, pressureTier3)`, filtered to below-good — reproduces all eight
cells and the total of 29 when computed directly from RDF. It was reverse-engineered from HTML; it is now
verified against the authoritative data.

### CSV claim that was wrong: the designation is NOT constant

§2 said the natural/artificial/heavily-modified scheme is degenerate here. **It is not.** The designation
attaches to the *versioned* waterbody, and three rivers changed between versions:

| Waterbody | v1 | v2 / v3 |
| --- | --- | --- |
| `GB108044009700` Sydling Water | **heavily modified** | not designated |
| `GB108044009780` Frome Dorset (Upper) | **heavily modified** | not designated |
| `GB108044010080` Piddle (Lower) | **heavily modified** | not designated |

The CSV reports only the current version, so the change is invisible in it. The scheme *is* degenerate
in the latest cycle and *not* degenerate over time. That is a far better demonstrator story than the
constant it appeared to be — three stretches of river were reclassified from "heavily modified" to
"substantially natural in character", and the graph can show when.

**This makes the versioning question load-bearing, not a detail.** Any query reading designation off the
base waterbody URI returns nothing; reading it without pinning a version silently triples rows.

### Defects found along the way

Two of the discrepancies above are defects in the source, not in our reading of it: **Stannon Lake** sits
in two operational catchments (unique nationally), and the **published CSV drops two well-formed RNAGs**.
Both are written up with evidence and mitigations in [ISSUES.md](ISSUES.md) — §1 and §2 — along with
ten other model and data problems found during this work. **Read ISSUES.md before writing any query
against the source.** It is not background reading; five of the twelve entries describe silent
wrong-answer modes.

### Query idioms this repository must use

Learned the hard way; each produced a wrong answer first. Full context in ISSUES.md §§4, 8, 10–12.

```sparql
# 1. Labels are language-tagged. IN() against plain strings matches NOTHING.
#    Silently returns zero rows -- looks like "no data", is actually a type mismatch.
?sv rdfs:label ?statusL . BIND(STR(?statusL) AS ?status)
FILTER(?status IN ("Bad","Poor","Moderate","Fail","Does Not Support Good"))

# 2. RNAGs link by wfd:waterBody -- NOT rff:waterBody (which does not exist).
?x wfd:waterBody ?wb ; a rff:ReasonForFailure .

# 3. Classification vs ClassificationObservation vs ObjectiveOutcome share predicates.
#    Unfiltered, classification counts inflate 5,852 -> 6,631 and pull in objective
#    years 2027/2040/2063 as though they were observations.
?c a wbc:Classification .

# 4. Waterbodies carry NO rdfs:label. The name is on the version, in mixed case
#    ("CERNE" and "Cerne" both exist) -- joining on it fans out.
?wb dct:hasVersion ?v . ?v rdfs:label ?name .

# 5. Exclude the dual-catchment defect.
FILTER(?wb != <http://environment.data.gov.uk/catchment-planning/so/WaterBody/GB30846165>)
```
