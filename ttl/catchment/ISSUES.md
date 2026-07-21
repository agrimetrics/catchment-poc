# Issues in the CDE source data and model

Defects found in the source RDF during the investigation recorded in [PLAN.md](PLAN.md). **Most of
these are not visible on the Catchment Data Explorer website** — the application filters or papers over
them, so the public site can look correct while the underlying graph is wrong. That is precisely why
they are written down here: anything querying the source directly inherits them.

Counts are national unless stated. Verified 2026-07-20 against the source.

Severity is about *what breaks if you don't know*, not about how hard it is to fix.

---

## 1. Stannon Lake is in two operational catchments — HIGH

`cp:so/WaterBody/GB30846165` ("Stannon Lake") asserts `wfd:inOperationalCatchment` for **both**:

- `cp:so/OperationalCatchment/3065` — **Camel**, Cornwall (correct: Stannon Lake is on Bodmin Moor)
- `cp:so/OperationalCatchment/3367` — **Poole Harbour Rivers**, Dorset (~200 km away)

It is the **only waterbody of 14,864 nationally** that sits in more than one operational catchment:

```sparql
SELECT (COUNT(DISTINCT ?wb) AS ?n) WHERE {
  ?wb wfd:inOperationalCatchment ?a, ?b . FILTER(STR(?a) < STR(?b))
}   # -> 1
```

Both catchments are in the South West river basin district, so an RBD-level sanity check does not catch
it. It carries 27 referencing records and a single version.

**Why it matters more than a stray row.** Poole Harbour's 19 real waterbodies are all *rivers* and all
currently *not designated artificial or heavily modified*. Stannon Lake is a **Lake** and is **heavily
modified** — the only member of both minorities. So the one spurious record is exactly the one that
silently falsifies both "this catchment is all rivers" and "nothing here is designated". A naive
catchment query does not merely gain a row; it inverts two headline statements.

**Not visible on the front end** — the published `classifications.csv` returns 19 waterbodies, so the CDE
application excludes it by some means. The website is right and the graph is wrong.

**Mitigation** (mandatory for every catchment-scoped query in this folder):

```sparql
FILTER(?wb != <http://environment.data.gov.uk/catchment-planning/so/WaterBody/GB30846165>)
```

**Action:** report upstream. Ask which membership is wrong and how the application filters it, because
that filter is the real scoping rule and we are currently guessing at it.

---

## 2. The published CSV is not a faithful export — HIGH

`rnags.csv` for catchment 3367 contains **93** cycle-3 RNAGs. The source graph contains **95**. Missing
from the published file:

| ID | Water body | Item | Activity | Sector |
| --- | --- | --- | --- | --- |
| `578245` | Frome Dorset (Lower) u/s Louds Mill | Hydrological Regime | Groundwater abstraction | Water Industry |
| `578282` | South Winterbourne | Hydrological Regime | Natural conditions - other | No sector responsible |

Both are complete, well-formed cycle-3 records: 2019, `apportionment = Major`, full certainty triples,
`pressureTier3 = "Abstraction and flow"`. `578245` even carries
`nationalSWMIheader = "Changes to the natural flow and levels of water"`, so it *looks* like a
cross-table contributor; it does not change the published table only because its classification status is
`Supports Good`, which the below-good filter excludes.

Neither is malformed, so this is not an obvious export-validity filter. The rule that drops them is
unknown.

**Why it matters:** anything built on the CSV silently under-reports, and the under-reporting is not
uniform or announced. This is the strongest single argument for ingesting from the source graph.

**Action:** ask Defra what the CSV export filters on.

---

## 3. The cross-table's column axis is an unmodelled string literal — HIGH (modelling)

The Challenges cross-table has a concept on one axis and bare text on the other:

- **Rows** — `rff:category` → a concept in `businessCategorySectorScheme` (e.g. `bcs_1`), with
  `rdfs:label`, `skos:prefLabel` and `skos:notation`. Dereferenceable.
- **Columns** — `rff:nationalSWMIheader` → a **plain literal**, e.g. `"Pollution from rural areas"`. No
  URI, no scheme, no notation, nothing to resolve, no other-language label.

So half the published table cannot be linked, translated, or joined on identity — only on string
equality. It also means the blank case is indistinguishable from a missing concept: **57 of the 95
cycle-3 RNAGs have no `nationalSWMIheader` at all** and therefore cannot appear in the table, including
every "measures delivered to address reason, awaiting recovery" record.

`rff:swmiScheme` exists (14 concepts) but holds a *different* vocabulary — `Diffuse source`,
`Point source`, `Natural`, `Flow` — matching the CSV's `Swmi` column, not the table headings.

**There is no rollup relating the two.** `rff:PressureHierarchy` and `rff:SectorHierarchy` are declared
in the model with `skos:broader`/`skos:narrower` and hold **zero instances** (see §6), so the national
headings cannot be derived from the SWMI concepts. The literal is the only source.

**Consequence for any UI:** a cross-table built from this data must carry an explicit *unattributed*
row/column, or it asserts that 60% of the catchment's challenges do not exist.

---

## 4. Concept scheme membership is modelled two incompatible ways — HIGH (traps queries)

Scheme discovery gives a different answer depending on the predicate:

| Query | Schemes found |
| --- | --- |
| `?c skos:inScheme ?scheme` | 19 |
| `?c skos:topConceptOf ?scheme` | 29 |

The entire `water-framework-directive` family appears **only** in the second: `aOrHMConceptScheme`,
`areaGeologyConceptScheme`, `catchmentSizeConceptScheme`, `alkalinityConceptScheme`,
`altitudeConceptScheme`, `exposureConceptScheme`, `groundWaterClassificationScheme`,
`lakeDepthConceptScheme`, `salineClassificationConceptScheme`, `tidalRangeClassificationConceptScheme`,
`statusOrPotentialConceptScheme`.

Compounding it, **the concepts are not all typed `skos:Concept`**. The four hydromorphological
designations are typed `wfd:HydromorphologicalDesignation`, so a discovery query filtering
`?c a skos:Concept` misses them too.

**This caused a real, published error.** The plan previously asserted that natural / artificial /
heavily modified was absent from the source graph. It is fully modelled, with **9,933** links nationally
(5,397 not designated / 3,146 heavily modified / 862 artificial / 528 not applicable). Both traps fired
at once, and a similarly-named dead property (§7) made the false negative look confirmed.

**Mitigation:** always query the union.

```sparql
{ ?c skos:inScheme ?scheme } UNION { ?c skos:topConceptOf ?scheme }
```

---

## 5. Two classification-value schemes exist, one misspelled — MEDIUM

| Scheme URI | Concepts |
| --- | --- |
| `cp:def/classification/classificationValueScheme` | 20 |
| `cp:def/classification/classifcationValueScheme` | 13 |

The second is missing the `i` — "classif**c**ationValueScheme". Both are populated. Code selecting
classification values by scheme URI will silently under-select if it picks the wrong one, and the
misspelling is not obvious on sight in a URI.

**Action:** determine which the data actually references before Phase 2; do not assume the correctly
spelled one wins.

---

## 6. 39 of ~99 modelled classes hold no data — MEDIUM

The CDE UML model is a **specification, not a description**. Empty classes include the entire action and
measure delivery side:

`Action`, `ActionAim`, `ActionCost`, `ActionDeliverability`, `ActionDesignation`, `ActionEffect`,
`ActionEffectConfidence`, `ActionMeasureStatus`, `ActionResource`, `WaterBodyLevelMeasure`,
`WideAreaMeasure`, `ProblemStatus`, `InvestigationStatus`, every `*Investigation` subtype except
`ConfirmfailureInvestigation`, all four `*Dataset` classes, `PredictedOutcome`,
`ClassificationConfidence`, `ClassificationValueProbability`, and all of
`BenefitCategory` / `BenefitSummary` / `MeasureActionSummary`.

Also empty: **`PressureHierarchy` and `SectorHierarchy`** — which is what kills the rollup hypothesis in
§3.

**Consequence:** the diagram cannot be used to plan phases. Count instances first.

---

## 7. `wfd:heavilyModified` is a dead property that looks alive — MEDIUM

`cp:def/water-framework-directive/heavilyModified` exists, carries an `skos:prefLabel` of
`"heavily modified"`, and has **zero uses as data**. It appears only in two `owl:onProperty` restrictions.

The real designation is `wfd:hydromorphologicalDesignation` → a concept in `aOrHMConceptScheme`.

This is an attractive nuisance: it has the right name and the right label, so finding it and getting
zero reads as a confirmed negative. It is the direct cause of the retracted conclusion in §4.

**Standing rule:** a plausible near-miss returning zero is not evidence of absence. Check whether the
*value space* exists elsewhere before concluding the fact is unmodelled.

---

## 8. Waterbodies carry no label; version labels vary in case — MEDIUM

`cp:so/WaterBody/{id}` has `skos:notation`, `inspireNotation` and `waterbodyNotation` — but **no
`rdfs:label`**. The human name lives on the version (`dct:hasVersion` → `…/1`, `…/2`), and the same
waterbody's versions disagree on case:

```
GB108044009710   "CERNE"    and  "Cerne"
GB108044009610   "WRAXALL Brook"  and  "Wraxall Brook"
GB108044009630   "BERE STREAM"    and  "Bere Stream"
```

Joining or grouping on the label therefore **fans out** and produces duplicate rows that look like
genuine multiplicity. During this investigation a single waterbody listing returned 4 rows each
(versions × case variants) before the cause was spotted.

This is the same fan-out-on-`OPTIONAL` failure recorded in [`app/TODO.md`](../../app/TODO.md), arriving
in a new costume: matching row counts prove two queries agree, not that either is right.

**Mitigation:** key on `skos:notation`; take the label from `ver:currentVersion` only, and never join on it.

---

## 9. Duplicate characteristic labels with different values — LOW

Of 11 national characteristic types, two pairs share a label:

| ID | Label | Devils Brook value |
| --- | --- | --- |
| `characteristic_147` | Catchment area | 3364.34 |
| `characteristic_197` | Catchment area | 33.643 |
| `characteristic_150` | Surface area | — |
| `characteristic_151` | Surface area | — |

The two "Catchment area" values differ by ~100×, so they are near-certainly different units (km² vs
hectares, or similar) — but **no unit is recorded on either**, and the label does not disambiguate.
Selecting "Catchment area" by label yields two contradictory numbers with nothing to choose between them.

**Action:** do not surface catchment area until the units are confirmed upstream.

---

## 10. A reasoner materialises blank-node types on every entity — LOW (operational)

Every entity carries dozens of inferred `rdf:type` triples pointing at blank-node OWL restriction
classes (`node1536`, `node1537`, …). A plain `?s a ?c` returns mostly noise: the national class census
returned ~50 blank-node rows per real class, and a property dump of one waterbody returned 50 rows of
pure `rdf:type` before any real predicate appeared.

Entities are also **dual-typed** under both `cp:def/water-framework-directive/` and
`location.data.gov.uk/inspire/am/…` (INSPIRE alignment), so unfiltered type counts double.

**Mitigation:**

```sparql
FILTER(isIRI(?c) && !STRSTARTS(STR(?c), "node"))
```

and pick one namespace for types, consistently.

---

## 11. Labels are language-tagged; plain-string filters match nothing — LOW (operational)

`rdfs:label` values are language-tagged, so this returns **zero rows** with no error:

```sparql
FILTER(?status IN ("Bad","Poor","Moderate"))          # WRONG — never matches "Bad"@en
BIND(STR(?statusL) AS ?status) FILTER(?status IN (…))  # correct
```

Listed as an issue rather than a gotcha because of the failure mode: an empty result is
indistinguishable from "this catchment has no failing water bodies". During this work it silently
produced an all-zero cross-table that looked like a legitimate finding.

---

## 12. RNAGs link by `wfd:waterBody`, not `rff:waterBody` — LOW (operational)

`rff:waterBody` does not exist. Reason-for-failure records link to their waterbody with
`wfd:waterBody`, from the water-framework-directive namespace, despite every other RNAG predicate living
in `rff:`. Using the namespace-consistent guess returns zero rows, silently.

## 13. 372 classifications carry two `classificationValue`s — MEDIUM

A `wbc:Classification` is one assessment of one item, in one year, for one water body, and reads as
though it has one verdict. 372 of the 5,852 here have **two**, both from
`classificationValueScheme`, and always the same pair:

    ... wbc:classificationValue cls:supports-good, cls:not-high .

Every affected record is a **Hydromorphological Supporting Elements** (216) or **Morphology** (156)
assessment — two axes of one judgement ("does it support good?" and "is it high?") collapsed onto one
property rather than modelled as two.

There is no cardinality constraint to catch this and nothing in the record marks it as expected, so a
query joining `classificationValue` returns 6,224 rows for 5,852 classifications. That is a **12%
over-count that looks exactly like data**: the extra rows are well-formed, carry real statuses, and
distribute unevenly across items, so a per-item chart silently over-weights hydromorphology.

**Mitigation.** Any query joining `classificationValue` must either restrict to items known to be
single-valued or aggregate explicitly. `Q.wbClassifications` in `app/app.js` does the former, and says
so at the point of the filter.

---

## Cross-cutting

Issues 1, 2, 3, 11, 12 and 13 share one shape, and it is the shape this repository already knows:

> **An absence is rendered as a value.** A spurious catchment membership becomes a Lake in a river
> catchment. An export filter becomes two challenges that never happened. A missing SWMI header becomes
> a challenge with no cause. A language tag becomes a catchment with no failures. A wrong predicate
> becomes a catchment with no challenges at all. Two axes sharing one property become 372 assessments
> that were never made.

None of these announce themselves. Each returns a well-formed, plausible answer. The mitigations above
are cheap; the habit of checking a zero before believing it is the expensive part.
