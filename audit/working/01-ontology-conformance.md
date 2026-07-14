# Object-model conformance audit — `demonstrator-poc` vs the DEFRA ontology

**Date:** 2026-07-13
**Graph audited:** live SPARQL endpoint `http://127.0.0.1:8000/sparql` (union of `ttl/regulation.ttl`,
`ttl/breaches.ttl`, `ttl/winep.ttl`, `ttl/sfi.ttl`, `ttl/designations.ttl`) — **35,513 triples**.
**Ontology audited:** `defra-core-ontology.ttl`, `defra-regulation.ttl`, `defra-water.ttl`,
`defra-farming.ttl`, `defra-nature.ttl` (**29 classes, 40 properties**) + `legacy/`.
**Method:** every class and property was extracted *from the data* by SPARQL
(`SELECT ?type … { ?s a ?type }`, `SELECT ?p … { ?s ?p ?o }`), then set-differenced against the
`rdfs:Class`/`owl:Class`/`rdf:Property`/`owl:ObjectProperty`/`owl:DatatypeProperty` subjects of the
ontology, then domain/range-checked with subclass-closure over the ontology's `rdfs:subClassOf` graph.
No file in the project was modified.

---

## Summary

| # | Severity | Finding |
|---|---|---|
| H1 | **HIGH** | `reg:breachesBound` is not defined in the ontology — 270 triples |
| H2 | **HIGH** | `water:samplingPointType` is not defined in the ontology — 161 triples |
| H3 | **HIGH** | `water:samplingPointStatus` is not defined in the ontology — 161 triples |
| H4 | **HIGH** | `core:Option` does not exist; the ontology defines `farming:Option` — 1,115 type triples, and it is the root cause of 2,804 downstream domain/range violations |
| H5 | **HIGH** | `iop:` is bound to `http://w3id.org/iadopt/ont/` but the real iAdopt namespace is `https://…` — 821 triples reference IRIs that no published vocabulary defines; and the DEFRA ontology never mentions iAdopt at all |
| M1 | MEDIUM | `core:applicableFrom`/`applicableTo` declare `rdfs:range xsd:date`; 1,063 of 1,248 values are `xsd:dateTime` |
| M2 | MEDIUM | `core:hasClassification` (range `skos:Concept`) points at 21 IRIs that are never typed `skos:Concept` — 88 dangling triples |
| M3 | MEDIUM | `iop:hasStatisticalModifier` is asserted on `qudt:QuantityValue`; iAdopt's domain is `iop:Variable` |
| M4 | MEDIUM | `water:samplingPointStatus` carries a bare `xsd:string`; `samplingPointType` carries a SKOS concept — same shape of fact, two different modellings, neither sanctioned |
| M5 | MEDIUM | 119 `reg:Limit` resources carry **two** `reg:upperBound`s ("The maximum permitted quantity value for a limit" — singular) |
| M6 | MEDIUM | 646 `core:Applicability` instances, **zero** use `core:appliesTo` |
| M7 | MEDIUM | All 11 `reg:Action` lack `reg:completionDate` — the ontology's own comment says an Action "has a completion date after which its proposed limits are expected to take effect" |
| L1 | LOW | 5,274 triples use undefined `http://example.com/*` predicates (`ex:area`, `ex:mtl`, `ex:units`, …), some load-bearing |
| L2 | LOW | `reg:Driver` / `reg:driver` / `reg:action` defined and unused, though the project README says proposals come "from different regulatory drivers" |
| L3 | LOW | 450 `skos:Concept` have no `skos:prefLabel` |
| L4 | LOW | 3 of 6 minted `qudt:Unit` have no `owl:sameAs` to a real QUDT unit; 61 `core:Identifier` have no `core:identifierScheme`; 61 permits have no `reg:permitHolder` |
| O1 | LOW *(ontology-side defect, not the project's)* | `reg:documentsPermit rdfs:subPropertyOf defra-core:about` — `defra-core:about` is not defined |
| O2 | LOW *(ontology-side defect)* | `defra-farming.ttl` declares its ontology IRI as `<http://environment.data.gov.uk/ontology/water>` |

**Clean:** No `legacy/` term is used anywhere (see §D). No `reg:Condition` without a limit, no
`reg:Limit` without a bound, no `reg:ConditionBreach` without an evidencing observation, no resource
with two `rdfs:label` or two `skos:prefLabel` (see §E).

---

## A. Invented terms in a DEFRA namespace (HIGH)

Method — the complete set-difference:

```sparql
# every defra term used in the data
SELECT ?type (COUNT(*) AS ?n) WHERE { ?s a ?type } GROUP BY ?type
SELECT ?p    (COUNT(*) AS ?n) WHERE { ?s ?p ?o }  GROUP BY ?p
```
…minus every subject of `rdf:type owl:Class|owl:ObjectProperty|owl:DatatypeProperty|rdf:Property` in
the five ontology files. Result — exactly four DEFRA-namespaced terms are used but never defined
(and `grep -rn` over `ontology/*.ttl` **and** `ontology/legacy/` returns zero hits for each):

### H1 — `defra-reg:breachesBound` — **HIGH** — 270 triples

* **Evidence (data):** `SELECT (COUNT(*) AS ?n) WHERE { ?s <http://environment.data.gov.uk/ontology/regulation/breachesBound> ?o }` → **270**.
  Objects are all `qudt:QuantityValue`.
* **Evidence (ontology):** `grep -rn breachesBound ontology/` → **no match**. `defra-regulation.ttl`
  defines only `defra-reg:breachesCondition` (domain `ConditionBreach`, range `Condition`).
* **Minted at:** `/Users/waf/git/projects/demonstrator-poc/ttl/breaches/breaches.obda:16`
  ```
  wr:breach/{breach_id} defra-reg:breachesBound wr:permit/{permit_ref}/version/{version}/condition/{substance}#limit-{statistic} .
  ```
* **Note:** the project already knows —
  `/Users/waf/git/projects/demonstrator-poc/ttl/breaches/README.md:109` carries an explicit
  *"Ontology gap — feedback for `defra-regulation.ttl`. `breachesBound` is **not** in the published
  ontology"*. It is nonetheless being emitted into the graph under the DEFRA namespace, where a
  consumer cannot tell it apart from a real term.
* **DECIDE:** does `defra-regulation.ttl` adopt `breachesBound`, or is a bound-level breach re-modelled
  (one `Limit` per statistic, per the README's own alternative) so that `breachesCondition` suffices?

### H2 — `defra-water:samplingPointType` — **HIGH** — 161 triples

* **Evidence (data):** `SELECT (COUNT(*) AS ?n) WHERE { ?s <…/ontology/water/samplingPointType> ?o }` → **161**.
  Subjects are typed `sosa:FeatureOfInterest, geo:Feature`; objects are `wr:sampling-point-type/*` SKOS concepts.
* **Evidence (ontology):** `grep -rn samplingPointType ontology/` → **no match**. `defra-water.ttl`
  defines only `WaterBody`, `Catchment`, `WaterDischargePermit`, `monitoredAt`.
* **Minted at:** `/Users/waf/git/projects/demonstrator-poc/ttl/regulation/regulation.obda:63`
* **Consumed at:** `/Users/waf/git/projects/demonstrator-poc/app/points.js:74`
  (`OPTIONAL { ?sp water:samplingPointType/skos:prefLabel ?type }`) — the demonstrator UI depends on
  an undefined term.
* **Aggravating:** the subjects are **real Environment Agency IRIs**
  (`http://environment.data.gov.uk/water-quality/sampling-point/SW-50440001`), so the graph makes
  unsanctioned DEFRA-namespaced assertions *about real EA resources* — not about `example.com` stand-ins.
* **DECIDE:** add `samplingPointType` to `defra-water.ttl`, or re-express it as
  `core:hasClassification` (which is already defined, `rdfs:range skos:Concept`, and whose comment is
  *"a resource can have multiple classifications"* — an exact fit)?

### H3 — `defra-water:samplingPointStatus` — **HIGH** — 161 triples

* **Evidence (data):** 161 triples; every object is a plain `xsd:string`, 161/161 `"OPEN"`-style literals.
* **Evidence (ontology):** `grep -rn samplingPointStatus ontology/` → **no match**.
* **Minted at:** `/Users/waf/git/projects/demonstrator-poc/ttl/regulation/regulation.obda:56`
* **DECIDE:** define it, or model status as a `core:hasClassification` to a status codelist concept
  (see M4)?

### H4 — `defra-core:Option` — **HIGH** — 1,115 type triples — *the ontology defines `defra-farming:Option`*

This is the most consequential finding because it is a **one-token error with a large blast radius**.

* **Evidence (ontology):** `defra-farming.ttl:26`
  ```turtle
  defra-farming:Option a owl:Class ;
      rdfs:subClassOf defra-core:DocumentPart ;
      rdfs:label "Option" .
  ```
  `defra-core-ontology.ttl` defines **no** `Option`. `defra-farming:Option` is used **zero** times in
  the data.
* **Evidence (data):** `SELECT (COUNT(*) AS ?n) WHERE { ?s a <…/ontology/core/Option> }` → **1,115**.
* **Minted at:** `/Users/waf/git/projects/demonstrator-poc/ttl/sfi/sfi.obda:39`
  ```
  target      :Option/{app_id}/{option_code} rdf:type defra-core:Option.
  ```
* **Blast radius** — because `core:Option` is not a `core:DocumentPart` (it is nothing at all), it
  breaks three *defined* properties at once:

  | property | ontology says | data asserts | violations |
  |---|---|---|---|
  | `core:hasPart` | range `core:DocumentPart` | object is `core:Option` | **1,115** |
  | `core:partOf` | domain `core:DocumentPart` | subject is `core:Option` | **1,115** |
  | `farming:annualPayment` | domain `farming:Option` | subject is `core:Option` | **574** |

  Example: `<http://example.com/sfi/Application/1693770> core:hasPart <http://example.com/sfi/Option/1693770/SAM1>`
  where the object's only type is `core:Option`.
  Changing `defra-core:Option` → `defra-farming:Option` at `sfi.obda:39` clears all 2,804 violations,
  because `farming:Option ⊑ core:DocumentPart`.
* **DECIDE:** confirm `sfi.obda:39` should read `defra-farming:Option` — i.e. that this is a typo and
  not a deliberate assertion that a scheme option is a *core* concept distinct from the farming one.

### H5 — `iop:` is bound to a namespace that does not exist — **HIGH** — 821 triples

* **Evidence (project):** `ttl/regulation/regulation.obda:7` and `ttl/winep/winep.obda:8` both declare
  ```
  iop:            http://w3id.org/iadopt/ont/
  ```
* **Evidence (upstream):** fetching `https://w3id.org/iadopt/ont` (redirects to
  `https://i-adopt.github.io/ontology/ontology.ttl`) and parsing it gives:
  ```
  https://w3id.org/iadopt/ont/StatisticalModifier      a owl:Class
  https://w3id.org/iadopt/ont/hasStatisticalModifier   a owl:ObjectProperty ;
      rdfs:domain https://w3id.org/iadopt/ont/Variable ;
      rdfs:range  https://w3id.org/iadopt/ont/StatisticalModifier
  ```
  The published terms are **`https:`**. The project emits **`http:`**. In RDF these are distinct IRIs:
  `http://w3id.org/iadopt/ont/hasStatisticalModifier` is defined by nobody.
* **Evidence (data):** `iop:hasStatisticalModifier` (http scheme) → **815** triples;
  `a iop:StatisticalModifier` → **6**.
* **Evidence (DEFRA ontology):** `grep -rn "iadopt\|iop:" ontology/` → **no match**. The DEFRA
  ontology does not reference iAdopt at all, so even with the scheme corrected the term is an
  unsanctioned third-party extension — unlike `qudt:`, which `defra-farming.ttl` and
  `defra-regulation.ttl` explicitly name.
* **Minted at:** `regulation.obda:97,135,143`; `winep.obda:62,84`.
* **DECIDE:** (a) fix the scheme to `https://`, and (b) decide whether the DEFRA ontology should
  formally import/permit iAdopt, or whether the statistical modifier belongs in a DEFRA term.

### Terms that ARE sanctioned (checked, no finding)

Every other DEFRA term used in the data resolves to a definition. Specifically, all of the terms the
brief asked me to scrutinise **are defined** in the published ontology:
`water:monitoredAt` (`defra-water.ttl:45`, domain `reg:DischargePoint`, range `sosa:FeatureOfInterest`),
`water:WaterDischargePermit` (`defra-water.ttl:39`, ⊑ `reg:Permit`),
`reg:permitSite`, `reg:targetPermit`, `reg:actionSite`, `reg:proposesLimit`, `reg:breachesCondition`,
`reg:evidencedByObservation`, `reg:regulatedProperty` (domain is the union `Condition ⊔ Limit`),
`reg:hasLimit`, `reg:upperBound`, `reg:lowerBound`, `reg:limitStatement`, `reg:continuesCondition`,
`reg:CarriedOverLimit`, `reg:DischargePoint`, `reg:Action`, `reg:PermitDocument`, `reg:Condition`,
`core:hasApplicability`, `core:applicabilityPeriod`, `core:applicableFrom`, `core:applicableTo`,
`core:hasIdentifier`, `core:identifierValue`, `core:hasPart`, `core:hasClassification`.
`qudt:numericValue`, `qudt:unit`, `qudt:QuantityValue`, `qudt:Quantity`, `qudt:Unit` are real QUDT
terms and are explicitly sanctioned by `defra-farming.ttl` (`rdfs:range qudt:QuantityValue`, and the
`PaymentRate` comment: *"the monetary amount is carried by `qudt:numericValue` with `qudt:unit` a currency"*).

The minted concept scheme **`wr:sampling-point-type/{notation}`**
(`http://example.com/water-regulation/sampling-point-type`, `regulation.obda:63,67-70`, 17 concepts)
is *itself* fine — a locally-minted SKOS codelist in an `example.com` namespace is honest and is what
the ontology expects reference data to look like (`defra-nature.ttl` explicitly says codelists are
"reference data, not part of this ontology"). The problem is not the scheme, it is the **undefined
predicate `samplingPointType` that points at it** (H2).

---

## B. Domain and range mismatches (MEDIUM)

RDFS domain/range are inference rules, not constraints — so none of these make the graph
*inconsistent*. They make it *say things the modeller probably did not mean*. Each is phrased as a
question.

### M1 — `core:applicableFrom` / `core:applicableTo`: the data asserts `xsd:dateTime`, the ontology says `xsd:date`

* **Ontology:** `defra-core-ontology.ttl` — `defra-core:applicableFrom … rdfs:range xsd:date .` (same for `applicableTo`).
* **Data:**
  ```sparql
  SELECT ?dt (COUNT(*) AS ?n) WHERE { ?s core:applicableFrom ?v BIND(DATATYPE(?v) AS ?dt) } GROUP BY ?dt
  ```
  → `xsd:date` **114**, `xsd:dateTime` **532**. `applicableTo` is the same: 531 of 602 are `dateTime`.
* **Example:** `<http://example.com/water-regulation/breach/001cda2d9415c62016738ea01610b24c#period> core:applicableFrom "2022-06-10T13:57:00"^^xsd:dateTime`
* **Origin:** `ttl/breaches/breaches.obda:21` and `:25` (`^^xsd:dateTime`), `ttl/sfi/sfi.obda:27-28`
  (`^^xsd:dateTime`). By contrast `ttl/regulation/regulation.obda:37,41` and `ttl/winep/winep.obda:34`
  correctly emit `^^xsd:date`. So the pipeline is **internally inconsistent**: the same property
  carries two datatypes depending on which mapping wrote it, which will silently break any
  `FILTER(?from >= "2022-01-01"^^xsd:date)` comparison across sources.
* **DECIDE:** widen the ontology's range to `xsd:dateTime` (breaches genuinely have a time of day), or
  truncate the breach/SFI values to `xsd:date`? Either way, the four mappings must agree.

### M2 — `core:hasClassification` range `skos:Concept`: 88 objects are typed as nothing

* **Ontology:** `defra-core:hasClassification … rdfs:range skos:Concept .`
* **Data:**
  ```sparql
  SELECT (COUNT(*) AS ?n) WHERE { ?s core:hasClassification ?o FILTER NOT EXISTS { ?o a ?any } }   # 88
  SELECT (COUNT(DISTINCT ?o) AS ?n) WHERE { … }                                                    # 21
  ```
* **Example:** `<http://example.com/sfi/Option/2276433/CWT15> core:hasClassification <http://example.com/sfi/Option/Concept/CWT15>` — and `…/Concept/CWT15` has no `rdf:type`, no `prefLabel`, no
  `inScheme`; it appears nowhere else in the graph. The worst is `…/Concept/LIG1`, referenced 56 times
  and never minted.
* **Origin:** `ttl/sfi/sfi.obda:42` emits the `hasClassification` edge from the *result* table
  (every option code that appears in an application), while `sfi.obda:58-66` mints the concepts from
  the *option-details* table. 21 option codes exist in applications but not in the details workbook,
  so the edge dangles.
* **Reading:** RDFS would *infer* these 21 IRIs are `skos:Concept`s — which is exactly the silent
  failure. A consumer joining on `?c a skos:Concept` loses 88 classifications.
* **DECIDE:** are the 21 missing option codes a data gap in `SFI Option details.xlsx` that must be
  filled, or should `sfi.obda` mint a stub concept for any code it classifies against?

### M3 — `iop:hasStatisticalModifier` asserted on a `qudt:QuantityValue`

* **Upstream ontology:** `iop:hasStatisticalModifier rdfs:domain iop:Variable`.
* **Data:** `SELECT ?t (COUNT(*) AS ?n) WHERE { ?s iop:hasStatisticalModifier ?m . ?s a ?t }` →
  `qudt:QuantityValue` **815** (100%).
* **Origin:** `regulation.obda:135,143`, `winep.obda:84` — the modifier hangs off the *bound*
  (`…#limit-{statistic}` / `…#bound-{n}`), not off a variable.
* **Reading:** under RDFS this asserts that every limit bound in the graph *is an `iop:Variable`* —
  which is not what a `qudt:QuantityValue` is. (Moot while the namespace is wrong, per H5.)
* **DECIDE:** is the statistical modifier a property of the *bound*, or (as `ttl/breaches/README.md:112`
  itself suggests) of a per-statistic `Limit`? The answer determines whether iAdopt is even the right
  vocabulary here.

### M4 — `samplingPointType` and `samplingPointStatus` model the same kind of fact two different ways

* **Data:** `samplingPointType` → SKOS concept IRI (`wr:sampling-point-type/SA`);
  `samplingPointStatus` → bare `xsd:string` (`"OPEN"`, 161/161).
* **Origin:** `regulation.obda:56` vs `:63`.
* Both are classifications of a sampling point against a small controlled vocabulary; the ontology
  already has exactly one way to say that (`core:hasClassification` → `skos:Concept`).
* **DECIDE:** unify both onto `core:hasClassification` (with a `sampling-point-status` codelist
  alongside the existing `sampling-point-type` one), or keep two bespoke `defra-water` predicates and
  get them added to `defra-water.ttl`?

---

## C. Ontology terms the project should plausibly be using, and is not

Twenty defined DEFRA terms are unused. Most are simply out of scope. These are the ones where the
project **hand-mints or omits something the ontology already covers**:

| Ontology term (defined, unused) | What the project does instead | Severity |
|---|---|---|
| `farming:Option` (`defra-farming.ttl:26`, ⊑ `core:DocumentPart`) | mints `core:Option` (H4) | **HIGH** |
| `core:hasClassification` | mints `water:samplingPointType` / `water:samplingPointStatus` (H2, H3, M4) | **HIGH** |
| `reg:Driver`, `reg:driver`, `reg:action` (`defra-regulation.ttl`) | `grep -rn -i driver ttl/winep/winep.obda` → **no hits**. Zero triples. Yet `README.md:317` says *"a permit+substance can carry competing proposals from **different regulatory drivers** (the app lists all)"* — so the driver is real information the graph is not carrying in the term built for it. | LOW |
| `reg:completionDate` (domain `Action`, range `xsd:date`) | `SELECT (COUNT(*) AS ?n) WHERE { ?a a reg:Action FILTER NOT EXISTS { ?a reg:completionDate ?d } }` → **11 of 11**. The `winep.obda:29` `ActionApplicability` mapping is gated on `completion_date IS NOT NULL` and yields nothing, so all 11 Actions also have **no `core:hasApplicability`** — even though the ontology comment for `reg:Action` says it *"has a completion date after which its proposed limits are expected to take effect"*. | MEDIUM (M7) |
| `core:appliesTo` (domain `Applicability`) | **646** `core:Applicability` nodes, **0** `appliesTo`. Every applicability is reachable only by the inbound `hasApplicability` edge (0 orphans, so nothing is lost — but the ontology's own way of naming an applicability's subject is unused). | MEDIUM (M6) |
| `reg:permitHolder`, `core:Party`, `core:Organisation` | 61 `WaterDischargePermit`, **0** `permitHolder`. No party is represented at all. | LOW |
| `core:identifierScheme`, `core:identifierIssuedBy` | 61 `core:Identifier`, each with only a `core:identifierValue`; no scheme, no issuer. | LOW |
| real QUDT unit IRIs | The project mints 6 `wr:unit/*` as `qudt:Unit` and `owl:sameAs` **only 3** of them to QUDT (`MilliGM-PER-L`, `MicroGM-PER-L`, `PERCENT`). `ph-units`, `nephelometric-turbidity-units` and `colour` have no `sameAs`, so 194+ triples carry a unit nothing else in the world understands. (`regulation.obda:88-93`.) It already uses `unit:HA`, `unit:M`, `currency:GBP` directly elsewhere, so the pattern is understood. | LOW |

### M5 — cardinality: 119 Limits with two upper bounds

* **Ontology:** `defra-reg:upperBound … rdfs:comment "The maximum permitted quantity value for a limit."` — singular; not `owl:FunctionalProperty`, so not a violation, but the intent reads as one.
* **Data:**
  ```sparql
  SELECT (COUNT(*) AS ?n) WHERE { SELECT ?l (COUNT(?b) AS ?c) WHERE { ?l reg:upperBound ?b } GROUP BY ?l HAVING(COUNT(?b)>1) }
  ```
  → **119**. Example: `<http://example.com/water-regulation/permit/041324/version/3/condition/0085#limit>` has 2.
  (720 `upperBound` + 102 `lowerBound` over 620 limit resources.)
* **Why:** tiers/statistics (95th-percentile *and* maximum) are modelled as sibling bounds on one
  Limit, each distinguished only by `iop:hasStatisticalModifier` — which is precisely why `breachesBound`
  (H1) had to be invented.
* **DECIDE:** keep multi-bound Limits (and get `breachesBound` into the ontology), or make each
  statistic its own `Limit` (a `Condition` then has several) — the alternative the project's own
  `ttl/breaches/README.md:111-116` already sketches. This is the single design decision that resolves
  H1, M3 and M5 together.

---

## D. Legacy ontology terms — **none used** ✅

`ontology/legacy/` defines terms in five namespaces:
`…/ontology/catchment/`, `…/ontology/location/`, `…/ontology/permit/`, `…/ontology/party/`,
`…/ontology/improvement-action/`.

The full `SELECT DISTINCT ?p` and `SELECT DISTINCT ?type` over the graph (61 predicates, 30 classes)
contains **zero** IRIs in any of those five namespaces. Every DEFRA term in the graph is in
`core/`, `regulation/`, `water/`, `farming/` or `nature/`. **No finding.**

---

## E. Shape and cardinality checks

Run against the live endpoint. The four the brief specifically asked about all come back **clean**:

| Check | SPARQL | Result |
|---|---|---|
| `Condition` with no `hasLimit` | `?c a reg:Condition FILTER NOT EXISTS { ?c reg:hasLimit ?l }` | **0** ✅ |
| `Limit` with no bound and no `limitStatement` | `?l a reg:Limit FILTER NOT EXISTS { ?l reg:upperBound\|reg:lowerBound ?b } FILTER NOT EXISTS { ?l reg:limitStatement ?s }` | **0** ✅ |
| `Limit` with no bound at all | as above, first filter only | **0** ✅ |
| `ConditionBreach` with no `evidencedByObservation` | `?b a reg:ConditionBreach FILTER NOT EXISTS { ?b reg:evidencedByObservation ?o }` | **0** ✅ |
| `ConditionBreach` with no `breachesBound` | | **0** ✅ |
| resource with >1 `rdfs:label` | `GROUP BY ?s HAVING(COUNT(?l)>1)` | **0** ✅ |
| resource with >1 `skos:prefLabel` | `GROUP BY ?s HAVING(COUNT(?l)>1)` | **0** ✅ |
| resource with both `rdfs:label` **and** `skos:prefLabel` | | **0** ✅ |
| orphan `core:Applicability` (nothing points to it) | `?a a core:Applicability FILTER NOT EXISTS { ?x core:hasApplicability ?a }` | **0** ✅ |
| `reg:hasCondition` subject untyped | | **0** ✅ |

And the ones that come back dirty:

* **M5** — 119 Limits with 2 `upperBound` (above).
* **M6** — 646 `Applicability`, 0 `appliesTo` (above).
* **M7** — 11/11 `Action` with no `completionDate` and no `hasApplicability` (above).
* **L3 — 450 `skos:Concept` have no `skos:prefLabel`.**
  `SELECT (COUNT(*) AS ?n) WHERE { ?c a skos:Concept FILTER NOT EXISTS { ?c skos:prefLabel ?l } }` → **450** of 552.
  These are the SFI option concepts: `sfi.obda:60-66` gives each concept `skos:notation`,
  `skos:definition`, `rdfs:comment`, `skos:inScheme` and `skos:broader` — but `sfi.obda:76` only ever
  emits `skos:prefLabel` for the *broader* letter-group parent. So `…/Option/Concept/SAM1` has a
  200-word definition and no name. SKOS does not *require* a prefLabel, so this is LOW, but any UI
  or picker over the scheme has nothing to display.
  **DECIDE:** is the option code (`skos:notation`) intended to be the display label, or is a
  `prefLabel` missing from the source workbook mapping?

---

## F. Undefined non-DEFRA predicates (LOW — L1)

Nine `http://example.com/*` predicates carry **5,274 triples** and are defined nowhere:

| predicate | triples | minted at |
|---|---|---|
| `ex:uom_desc` | 1,115 | `ttl/sfi/sfi.obda:46` |
| `ex:opt_year` | 1,115 | `ttl/sfi/sfi.obda:47` |
| `ex:schememodule` | 1,115 | `ttl/sfi/sfi.obda:48` |
| `ex:area` | 871 | `ttl/sfi/sfi.obda` (OptionAreaAndGeometry) |
| `ex:refYear`, `ex:scheme`, `ex:applicationType` | 262 each | `ttl/sfi/sfi.obda:33-35` |
| `ex:mtl` | 251 | `ttl/sfi/sfi.obda` |
| `ex:units` | 21 | `ttl/sfi/sfi.obda` |

These are **honest** — they sit in `example.com`, not in a DEFRA namespace, so no consumer will
mistake them for published terms. That is why this is LOW and not HIGH. But `ex:area` in particular
is load-bearing (it is the measured extent that `farming:annualPayment` is computed from), so it is
undefined data that a real consumer must reverse-engineer.

**DECIDE:** which of these nine belong in `defra-farming.ttl` (`area`/`mtl`/`units` look like real
domain properties — a measured extent), and which are pass-through source columns that should be
dropped from the published graph?

---

## G. Defects in the ontology itself (feed back upstream)

Found while auditing; not the project's fault, but they will bite the project.

* **O1 — `defra-core:about` does not exist.** `defra-regulation.ttl` declares
  `defra-reg:documentsPermit rdfs:subPropertyOf defra-core:about .` — but `defra-core-ontology.ttl`
  defines no `about`. `grep -rn "defra-core:about\|core/about" ontology/` finds only that one
  reference, never a definition. The ontology contains a dangling superproperty.
* **O2 — `defra-farming.ttl` has the wrong ontology IRI.** Its header reads
  `<http://environment.data.gov.uk/ontology/water> a owl:Ontology ; dcterms:title "DEFRA Farming Ontology"@en ;`
  — copy-pasted from `defra-water.ttl`. Two `owl:Ontology` resources now share one IRI with
  conflicting titles, creation dates and descriptions; any tool that loads both and asks "what
  version is `…/ontology/water`?" gets a merged, contradictory answer.

**DECIDE:** raise O1 and O2 against the `ontology-work` repo.

---

## Appendix — full term inventory

**Classes used in the data (30):** `qudt:QuantityValue` (1489), **`core:Option` (1115, UNDEFINED)**,
`core:Applicability` (646), `core:ApplicabilityPeriod` (646), `reg:Condition` (587), `reg:Limit` (587),
`skos:Concept` (552), `geo:Geometry` (348), `sosa:Observation` (275), `reg:ConditionBreach` (270),
`farming:Application` (262), `reg:ExceedanceBreach` (234), `reg:PermitDocument` (170), `geo:Feature` (161),
`sosa:FeatureOfInterest` (161), `reg:DischargePoint` (102), `farming:PaymentRate` (102),
`nature:ProtectedSite` (81), `water:WaterDischargePermit` (61), `core:Identifier` (61),
`reg:ShortfallBreach` (36), `reg:ProposedLimit` (27), `sosa:ObservableProperty` (12), `core:Site` (11),
`reg:Action` (11), `reg:CarriedOverLimit` (6), `qudt:Unit` (6),
**`iop:StatisticalModifier` (6, http-scheme IRI — UNDEFINED)**, `water:WaterBody` (4),
`skos:ConceptScheme` (4).

**DEFRA properties used in the data (32):** all defined except
**`reg:breachesBound` (270)**, **`water:samplingPointStatus` (161)**, **`water:samplingPointType` (161)**.

**DEFRA terms defined but never used (20):** `core:Document`, `core:DocumentPart`,
`core:IdentifierScheme`, `core:Organisation`, `core:Party`, `core:appliesTo`, `core:documentText`,
`core:documentType`, `core:identifierIssuedBy`, `core:identifierIssuedDate`, `core:identifierScheme`,
**`farming:Option`**, `reg:Driver`, `reg:Permit`, `reg:action`, `reg:actionOwner`,
`reg:completionDate`, `reg:driver`, `reg:permitHolder`, `water:Catchment`.
(`reg:Permit` unused as a direct type is correct — `water:WaterDischargePermit ⊑ reg:Permit`.)
