# Graph Audit — faithfulness & referential integrity

**Target:** `ttl/regulation.ttl` + `ttl/breaches.ttl` + `ttl/winep.ttl` + `ttl/sfi.ttl` + `ttl/designations.ttl`
served in-memory by Oxigraph at `http://127.0.0.1:8000/sparql` (35,513 triples).
**Method:** every structural claim re-checked by SPARQL against the live store; every *source* claim
re-derived independently from the CSVs in pandas, including a from-scratch reimplementation of the
OSGB National Grid Reference decoder (validated against known OS references before use).
**Nothing was modified.**

## Verdict

The graph is, on the evidence, an unusually clean derivation. **Part A (referential integrity) is
effectively spotless**: zero dangling references, zero orphans, zero unresolved cross-graph joins.
**Part B (faithfulness) reconciles exactly** on scope, discharge points, `monitoredAt`, geometry,
conditions, bounds, sampling points and substances.

There is **one HIGH finding** — a documented-but-lossy aggregation that causes the graph to assert a
*false permit limit* for one permit — and **two MEDIUM findings** where the graph is silent or
approximate in ways a consumer cannot detect from the graph alone.

| Severity | Count | Summary |
|---|---|---|
| HIGH | 1 | `MAX()` collapse publishes a limit 67% looser than the register states (permit 042116) |
| MEDIUM | 2 | 6 register-stated `monitoredAt` edges silently dropped; 110/270 breaches judged against a possibly-not-in-force permit version |
| LOW | 5 | Untyped concept scheme; untyped/CRS-less SFI geometry; latent IRI-encoding bug in WINEP; 2 documented modelling gaps |

---

# PART A — Referential integrity

## A1. Dangling references — **CLEAN (0)**

Every IRI used as the object of a structural property has at least one triple describing it.

```sparql
SELECT ?prop (COUNT(DISTINCT ?obj) AS ?distinctObj) (COUNT(DISTINCT ?bad) AS ?dangling) WHERE {
  VALUES ?prop { reg:permitSite water:monitoredAt reg:targetPermit reg:actionSite reg:hasCondition
                 reg:breachesCondition reg:breachesBound reg:evidencedByObservation reg:regulatedProperty
                 reg:proposesLimit reg:continuesCondition reg:hasLimit reg:upperBound reg:lowerBound
                 core:hasPart core:hasClassification core:hasIdentifier core:hasApplicability
                 core:applicabilityPeriod skos:broader skos:inScheme skos:exactMatch qudt:unit
                 geo:hasGeometry sosa:hasFeatureOfInterest iop:hasStatisticalModifier geo:sfWithin
                 water:samplingPointType }
  ?s ?prop ?obj . FILTER(isIRI(?obj))
  OPTIONAL { BIND(?obj AS ?bad) FILTER NOT EXISTS { ?bad ?p2 ?o2 } }
} GROUP BY ?prop
```

All 28 properties returned `dangling = 0`. Sample of the traffic proving the properties are actually
exercised: `core:hasPart` 1115 uses, `core:hasClassification` 1196, `geo:hasGeometry` 1463,
`reg:hasCondition` 587, `reg:evidencedByObservation` 358, `skos:broader` 451.

(The `NOT EXISTS` was sanity-checked against a deliberately non-existent IRI, which correctly
returned 1 — so the zero is a real zero, not a broken query.)

## A2. Orphans — **CLEAN (0)**

No typed resource in any domain vocabulary is unreferenced. Checked all 27 types under the
`defra-*`, `qudt`, `geosparql` and `sosa` namespaces (`reg:DischargePoint` 102, `reg:Condition` 587,
`reg:ConditionBreach` 270, `qudt:QuantityValue` 1489, `core:Applicability` 646, …). Every one has
`orphans = 0` — i.e. something points at it with a non-`rdf:type` predicate.

## A3. DischargePoint cardinality — **CLEAN**

```sparql
SELECT ?nPermits ?nMon (COUNT(*) AS ?dischargePoints) WHERE {
  { SELECT ?dp (COUNT(DISTINCT ?perm) AS ?nPermits) (COUNT(DISTINCT ?sp) AS ?nMon) WHERE {
      ?dp a reg:DischargePoint .
      OPTIONAL { ?perm reg:permitSite ?dp } OPTIONAL { ?dp water:monitoredAt ?sp }
  } GROUP BY ?dp }
} GROUP BY ?nPermits ?nMon
```

| permits per DP | monitoredAt per DP | discharge points |
|---|---|---|
| 1 | 1 | 96 |
| 1 | 0 | 6 |

102 discharge points. **Every one belongs to exactly one permit. None has more than one
`monitoredAt`.** The 6 with none are **MEDIUM-1** below.

Worth flagging as a latent risk: the register *is* capable of stating two sampling points for one
`(permit, outlet, effluent)` — 35 such rows exist in `effluents.csv` (e.g. `010029/1/1`,
`400113/1/1`). None of them falls inside this catchment's scope, so the graph's 0..1 cardinality
holds today by luck of scope, not by construction.

## A4. Condition / Breach completeness — **CLEAN**

- **587 Conditions.** All 587 have a `reg:hasLimit`; **0** have a Limit with no bound; **0** have a
  Limit with no `reg:limitStatement`.
- **270 ConditionBreaches.** All have `reg:breachesCondition`, `reg:breachesBound`,
  `reg:evidencedByObservation`, and a full `core:hasApplicability → applicabilityPeriod →
  applicableFrom` chain. **0** missing any of them.
- **Evidence is attached to the right place — 0 wrong.**

```sparql
SELECT ?breach ?permit ?obsSP WHERE {
  ?breach a reg:ConditionBreach ; reg:breachesCondition ?cond ; reg:evidencedByObservation ?obs .
  ?permit reg:hasCondition ?cond .
  ?obs sosa:hasFeatureOfInterest ?obsSP .
  FILTER NOT EXISTS { ?permit reg:permitSite/water:monitoredAt ?obsSP }
}
```
→ **0 rows.** No breach is evidenced by an observation taken at a sampling point that does not
belong to the breached permit. This is structurally guaranteed by
`breaches_to_db.py:200` (`obs.merge(monitoring, on="sp_notation")`), and the graph confirms it.

## A5. Geometry — **CLEAN in the regulation graph**

All 348 `geo:asWKT` literals in the regulation/WINEP/designation graphs are correctly typed
`geo:wktLiteral`. Broken down:

| family | geometries | CRS |
|---|---|---|
| sampling points | 161 | `<…/EPSG/0/27700>` |
| discharge points | 95 | `<…/EPSG/0/27700>` |
| WINEP action sites | 11 | `<…/EPSG/0/27700>` |
| designations (nature) | 81 | `<…/OGC/1.3/CRS84>` (correct — source is lon/lat) |
| SFI | 1115 | **no CRS URI** — see LOW-2 |

**No WGS84 leftovers in the regulation graph.** Every one of the 256 regulation geometries matches
`^POINT\(\d{5,6} \d{5,6}\) <http://www\.opengis\.net/def/crs/EPSG/0/27700>$` exactly — zero exceptions.
(An initial `CONTAINS(…,"4326")` scan appeared to flag 7 geometries; those are false positives — the
string `4326` occurs inside SFI decimal coordinates such as `-2.634326`. There is **no** EPSG:4326
CRS URI anywhere in the store.)

No resource carries a geometry it should not: geometry appears only on sampling points, discharge
points, action sites, designations and SFI options.

## A6. IRI hygiene — **CLEAN**

- **Raw spaces: 0. Double slashes: 0.**
- **Percent-encoding is consistent.** All **24** IRIs in the `400114/CF/01` family — across
  `regulation.ttl` *and* `breaches.ttl` — use `400114%2FCF%2F01`. Permit, `#id`, all three
  outlet/effluent discharge points, their `#geography` nodes, both versions, and every condition,
  `#limit` and `#limit-{statistic}` node. No unencoded variant exists.
- **Scheme is uniformly `http:`** — including the 275 WQA observation IRIs and 161 sampling points.
  The archive serves `https:`; the normalisation is deliberate and documented at
  `ttl/breaches/fetch_compliance_observations.py:88-90` (`.replace("https://", "http://")`), which is
  exactly what makes breach evidence IRIs match the sampling-point IRIs regulation mints. **Not a
  defect** — but see LOW-3 for a latent encoding bug in the same area.

## A7. Cross-graph joins — **CLEAN (0 unresolved)**

The high-severity check. All of these returned **0 rows**:

```sparql
SELECT ?kind ?iri WHERE {
  { ?a reg:targetPermit ?iri . FILTER NOT EXISTS { ?iri a water:WaterDischargePermit } BIND("targetPermit" AS ?kind) }
  UNION { ?l reg:continuesCondition ?iri . FILTER NOT EXISTS { ?iri a reg:Condition } BIND("continuesCondition" AS ?kind) }
  UNION { ?b reg:breachesCondition ?iri . FILTER NOT EXISTS { ?iri a reg:Condition } BIND("breachesCondition" AS ?kind) }
  UNION { ?b reg:breachesBound ?iri . FILTER NOT EXISTS { ?iri a qudt:QuantityValue } BIND("breachesBound" AS ?kind) }
  UNION { ?b reg:evidencedByObservation ?o . ?o sosa:hasFeatureOfInterest ?iri .
          FILTER NOT EXISTS { ?iri a sosa:FeatureOfInterest } BIND("obs-FOI" AS ?kind) }
  UNION { ?b reg:evidencedByObservation ?iri . FILTER NOT EXISTS { ?iri sosa:hasFeatureOfInterest ?x } BIND("obs-noFOI" AS ?kind) }
}
```

- WINEP `reg:targetPermit` → **11/11** resolve to a real `WaterDischargePermit` (7 distinct permits).
- WINEP `reg:continuesCondition` → **6/6** resolve to a real `Condition` (4 distinct).
- Breach `reg:breachesCondition` → **270/270** resolve. `reg:breachesBound` → **270/270** resolve.
- Breach observation → `sosa:hasFeatureOfInterest` → **275/275** resolve to a real sampling point.

The `canon_permit()` zero-padding in `winep_to_db.py:48-53` is doing its job: WINEP's unpadded `42451`
correctly lands on `permit/042451`.

---

# PART B — Faithfulness to source

## B8. Permits & outlets — **EXACT MATCH**

The scope rule, re-derived independently:

```python
eff = pd.read_csv("raw_datasets/access_database_csv_files/effluents.csv", dtype=str)
e = eff[(eff.EA_REGION=="SW") & eff.EFF_SAMPLE_POINT.notna()]
e["sp"] = e.EA_REGION + "-" + e.EFF_SAMPLE_POINT
comb = pd.read_csv("raw_datasets/poole_harbour_rivers_water_quality_observations_2020_2026_combined.csv",
                   usecols=["samplingPoint.notation"])
catchment = set(comb["samplingPoint.notation"].dropna().astype(str))
scope = set(e[e.sp.isin(catchment)].PERMIT_REF)      # -> 61 permits
```

| | permits |
|---|---|
| re-derived from the **raw catchment download** | **61** |
| **in the graph** | **61** |
| difference | **none, in either direction** |

Discharge points: **102 expected, 102 in graph, 0 missing, 0 extra.** Every outlet of every in-scope
permit is present, including the never-sampled ones — the "ALL its outlets come in" rule holds.

*Note on a subtlety that is NOT a defect.* Reading the scope rule against the **filtered**
`output_data/observations_with_permits_and_rules.csv` gives only 60 permits; the code
(`regulation_to_db.py:169-178`) unions in `sampling_points.csv`, which recovers the 61st, **050922**.
That is correct, not a widening: 050922's sampling point `SW-50331270` *does* carry catchment
observations in the raw download — they are site inspections, which `link_data.py`'s numeric filter
drops. The graph's permit set is exactly the documented rule applied to the real catchment CSV.

## B9. `monitoredAt` — **96/96 correct, but 6 register facts are missing** → MEDIUM-1

Re-derived every `(permit, outlet, effluent) → sampling point` from `effluents.csv` with
`sp_notation = EA_REGION + '-' + EFF_SAMPLE_POINT`:

- **96 edges expected, 96 in graph. 0 missing, 0 extra, 0 wrong.** Perfect agreement.
- But **6 discharge points have no `monitoredAt` at all**, and the register *does* name a sampling
  point for every one of them. See MEDIUM-1.

## B10. Discharge-point geometry — **EXACT, and the 040111 coincidence claim is CONFIRMED**

I reimplemented the NGR decoder from an explicit 5×5 OS letter-grid table (a different formulation
from the pipeline's modular arithmetic), self-tested it against known references
(SY7400087100, NN1667071200 = Ben Nevis, TQ3080080100, SZ0289090000, ST5872072500 — all exact),
then decoded `DISCHARGE_NGR` straight from `consents_active.csv` + `consents_all.csv`:

| check | result |
|---|---|
| discharge points whose graph geometry **equals my independent decode** | **95 / 95** |
| **mismatches** | **0** |
| discharge points with no geometry **and** no register NGR (correctly omitted, not fabricated) | 7 |
| in-scope permits whose consents rows carry **>1 distinct** `DISCHARGE_NGR` (where `ANY_VALUE` would pick arbitrarily) | **0** |

The 7 legitimately-absent geometries are `040070/1/1`, `040070/1/2`, `040091/1/1`, `040091/1/2`,
`040096/1/1`, `040096/1/2`, `040137/1/1` — permits with no site NGR in either consents extract. The
"NO FALLBACK" policy (`regulation_to_db.py:254-273`) holds: **no discharge point is published at a
fabricated coordinate.**

### The coincidence claim — **VERIFIED GENUINE**

> *"NO discharge point's geometry equals the geometry of the sampling point it is monitored at,
> EXCEPT 040111/1/1."*

**Confirmed. Exactly one, and it is 040111/1/1.**

```
COINCIDENT: 040111 outlet 1 effluent 1 → SW-50900956
            POINT(397500 80700) <http://www.opengis.net/def/crs/EPSG/0/27700>
```

And it is genuinely a register/archive coincidence, not a pipeline artefact:

| source | value | decoded |
|---|---|---|
| `consents_active.csv` `DISCHARGE_NGR` (Harmans Cross STW) | `SY9750080700` | **(397500, 80700)** |
| `sampling_points.csv` (WQA) `SW-50900956` | — | **(397500, 80700)** |
| `consents_active.csv` `OUTLET_GRID_REF` | `SY9747080790` | (397470, 80790) |
| `consents_active.csv` `EFFLUENT_GRID_REF` | `SY9747080770` | (397470, 80770) |

The two independent registers agree to the metre — but only because the site NGR is a **100 m**
reference. The *finer* refs in the very same row put the outlet 30 m E / 90 m N away, i.e. the outfall
and the sampling point are **not** actually the same place; the coarse ref merely rounds onto it. The
code's own note (`regulation_to_db.py:552-567` — *"agreement may be rounding rather than truth… they
score a free hit for any proximity join"*) is exactly right.

## B11. Conditions & bounds — **EXACT COUNTS AND VALUES** (with one lossy aggregation → HIGH-1)

Re-derived from `output_data/observations_with_permits_and_rules.csv`:

| | expected | in graph | mismatch |
|---|---|---|---|
| Conditions `(permit, version, substance)` | 587 | **587** | 0 |
| Bounds `(condition, statistic)` | 800 | **800** | **0 value mismatches** |

Bounds by statistic: `percentile-95` 345, `maximum` 337, `minimum` 102, `annual-average` 16.
Bound direction is correct: `minimum` → `lowerBound` (all 102), everything else → `upperBound`.
All 4 `RULE_TYPE`s in the source are mapped; no `MEDIAN` rows exist, so nothing is silently dropped
by the `statistics` join. **0 conditions carry more than one unit**, so `ANY_VALUE(unit)` is safe.

**The `MAX()` collapse affects 8 bounds across 8 conditions (1.4% of 587) — all on permit 042116.**
See HIGH-1.

## B12. Sampling points — **PERFECT, ZERO DRIFT**

All **161** rows of `ttl/regulation/sampling_points.csv` are in the graph and nothing else is.
Field-by-field comparison of the merged sets:

| field | drift |
|---|---|
| `skos:prefLabel` vs `pref_label` | **0** |
| `geo:asWKT` vs `wkt` | **0** |
| `water:samplingPointStatus` vs `status_label` | **0** |
| `water:samplingPointType` vs `type_notation` | **0** |

No re-projection, no rounding, no relabelling. The WKT is carried through byte-identically.

## B13. Substances — **EXACT (12), alias correct**

The 12 substances in the concept scheme are **exactly** the 12 distinct determinands in the
observations join — no more, no fewer:

`0061` pH · `0072` Colour, Filtered · `0085` BOD : 5 Day ATU · `0111` Ammoniacal Nitrogen as N ·
`0135` Solids, Suspended at 105 C · `0348` Phosphorus, Total as P · `6051` Iron · `6057` Aluminium ·
`6396` Turbidity · `6455` Zinc · `9686` Nitrogen, Total as N · `9901` Oxygen, Dissolved, % Saturation

- **Zero-padding is correct.** The source carries unpadded `61, 72, 85, 111, 135, 348`; all six are
  padded to 4 digits, and the already-4-digit codes are untouched.
- **The nitrogen alias is present and correct.** `9686 skos:exactMatch 9194` **and** the inverse
  `9194 skos:exactMatch 9686` are both asserted. `9194` is a full `skos:Concept` carrying
  `skos:notation "9194"`, `skos:prefLabel "Nitrogen, Total as N"`, `skos:altLabel "Nitrogen Tot"`.
  Both labels are corroborated against `raw_datasets/determinand_codelist.json`, which does indeed
  give **both** 9686 and 9194 the identical prefLabel `"Nitrogen, Total as N"`.
- `9194` is deliberately **not** `skos:inScheme` (so the app's substance filter doesn't list nitrogen
  twice) — exactly as documented at `regulation_to_db.py:486-491`. This is why the scheme holds 12
  and the store holds 13 substance concepts. **Correct as designed.**
- The generic `chemical` placeholder from `winep_to_db.py:98` did **not** leak into the graph.

---

# FINDINGS

## HIGH-1 — `MAX()` collapse makes the graph assert a **false permit limit** (permit 042116)

**What the graph says.** For permit `042116`, versions 1–4:

| condition | graph asserts (`qudt:numericValue`) |
|---|---|
| BOD (`0085`) 95th percentile | **25 mg/l** |
| Suspended Solids (`0135`) 95th percentile | **35 mg/l** |

**What the register says.** The permit sets *different* limits on two different effluents, which
discharge to two *different* sampling points:

| discharge point | sampling point | BOD 95%ile | SS 95%ile |
|---|---|---|---|
| `042116/outlet/1/effluent/1` | `SW-50440194` | **15 mg/l** | **25 mg/l** |
| `042116/outlet/1/effluent/2` | `SW-50440001` | 25 mg/l | 35 mg/l |

The graph publishes **one** limit per `(permit, version, substance)` and resolves the conflict with
`MAX()` — the **loosest** value. For effluent 1 the graph therefore asserts a BOD limit **67% looser**
(25 vs 15) and an SS limit **40% looser** (35 vs 25) than the register actually imposes.

**Count affected:** **8 bounds / 8 conditions** (of 587 = 1.4%), all on permit 042116, versions 1–4,
substances 0085 and 0135. Confirmed exhaustively — no other permit in the catchment is affected.

**Cause:** `ttl/regulation/regulation_to_db.py:435-449`

```sql
CREATE OR REPLACE TABLE condition_bounds AS
SELECT r.PERMIT_REF, r.VERSION, lpad(r."determinand.notation",4,'0') AS substance,
       s.slug AS statistic, s.bound_kind,
       MAX(CAST(r.RULE_VALUE AS DECIMAL(18,4))) AS value,   -- <<< collapses differing per-outlet values
       ...
GROUP BY r.PERMIT_REF, r.VERSION, lpad(r."determinand.notation",4,'0'), s.slug, s.bound_kind;
```
The register sets limits at `(permit, version, OUTLET, EFFLUENT, substance)`; the Condition is keyed
at `(permit, version, substance)`. This is *known and documented* in the comment immediately above
(and counted at build time), so it is not a surprise — but the graph still **states a number that is
not true of the outlet it applies to**, and nothing in the RDF signals that.

**Verification query:**
```sparql
SELECT ?sub ?boundValue ?statement WHERE {
  <http://example.com/water-regulation/permit/042116> reg:hasCondition ?c .
  FILTER(CONTAINS(STR(?c),"/version/4/"))
  ?c reg:regulatedProperty ?sub ; reg:hasLimit ?l .
  ?l reg:limitStatement ?statement . OPTIONAL { ?l reg:upperBound/qudt:numericValue ?boundValue }
}
```
| substance | `upperBound` | `limitStatement` |
|---|---|---|
| `0085` | **25** | `95 PERCENTILE 15 MILLIGRAM PER LITRE; 95 PERCENTILE 25 MILLIGRAM PER LITRE` |
| `0135` | **35** | `95 PERCENTILE 25 MILLIGRAM PER LITRE; 95 PERCENTILE 35 MILLIGRAM PER LITRE` |

**Significant mitigation:** `reg:limitStatement` **preserves both values verbatim**. The truth is not
lost from the graph — it is only lost from the *structured* bound, which is the part every query and
the whole app actually reads. This is precisely the "alongside, not in place of" argument the code
makes for carrying limit statements, and here it pays off.

**Actual consequence today — breach counting: NIL.** I replayed the EA 95th-percentile LUT assessment
over the real compliance series at `SW-50440194` (n=240 BOD, n=217 SS) at both the true and the
published limit. **0 breach periods at either.** The effluent sits comfortably under even the tighter
limit, so no breach is currently suppressed. The graph currently has **0 breaches** for 042116.

**But the exposure is real and live:**
1. The false limit is *asserted*, and a consumer reading `qudt:numericValue` gets 25, not 15.
2. It is **latent breach suppression**: any future sample between 15 and 25 mg/l at `SW-50440194`
   would be a real breach that this graph would not book. `breaches_to_db.py:148-151,200` joins
   observations to permits on `(permit_ref, sp_notation)` **only** — it never re-narrows to the
   outlet — so it *will* judge `SW-50440194` against the collapsed permit-level bound.
3. **042116 is a WINEP `reg:targetPermit`** (action `08WW102106`). The whole point of the
   current-vs-proposed comparison is to show a tightening; it is being computed off the loosened
   number.

### ⚖️ WHAT THE HUMAN MUST DECIDE
Whether a `reg:Condition` should be re-keyed to `(permit, version, outlet, effluent, substance)` —
the grain the register actually uses. The code comment says re-keying is deferred because
"WINEP's `reg:continuesCondition` already points at these IRIs, so re-keying is a separate change."
That trade is defensible, but **the decision to record is: is it acceptable for the store to assert a
limit that is false for one of the outlets it governs?** The three options:
- **(a)** Re-key Conditions to the outlet grain (correct; breaks 6 `continuesCondition` IRIs and any
  external links to the 587 condition IRIs).
- **(b)** Keep the grain but publish `MIN()` (the *binding* limit) rather than `MAX()` — errs toward
  over-reporting breaches instead of under-reporting them, which is the safer direction for a
  regulatory demonstrator.
- **(c)** Keep as-is, but **mark the collapse in the RDF** so it is not silently false — e.g. omit the
  structured bound where the source values disagree and let `limitStatement` carry it alone, or add an
  explicit annotation on those 8 Limits.
Doing nothing is also a choice — but it should be a *recorded* one, because the graph currently gives
the reader no way to know those 8 numbers are lossy.

---

## MEDIUM-1 — 6 register-stated `monitoredAt` edges are silently dropped

The register names a sampling point for **all 102** discharge points. The graph publishes only **96**.
The 6 missing edges are not absent from the source — they are discarded by the pipeline:

| discharge point | register `EFF_SAMPLE_POINT` → sp_notation | in `sampling_points.csv`? |
|---|---|---|
| `040070/1/2` | `SW-50410121` | **no** |
| `040096/1/2` | `SW-50520133` | **no** |
| `041639/2/1` | `SW-50570248` | **no** |
| `043236/2/1` | `SW-50440124` | **no** |
| `400607/1/2` | `SW-6WXE0555` | **no** |
| `401354/1/3` | `SW-50959903` | **no** |

**Cause:** `ttl/regulation/regulation_to_db.py:216-222`

```sql
CREATE OR REPLACE TABLE discharge_point_monitoring AS
SELECT DISTINCT e.permit_ref, e.outlet, e.effluent, e.sp_notation
FROM register_effluents e
JOIN scoped_permits s USING (permit_ref)
JOIN sampling_points p ON p.sp_notation = e.sp_notation;   -- <<< inner join drops unresolvable points
```
These 6 sampling points could not be resolved in the Water Quality Archive, so
`fetch_sampling_points.py` never wrote them to `sampling_points.csv`, and the inner join silently
removes the edge. The stated intent (line 215) is *"Restricted to sampling points we could resolve in
the archive, so the edge never dangles"* — a deliberate trade of **completeness for tidiness**.

**Why it matters.** The graph's central thesis (`app/points.html`) is that *the identifier-borne edge
beats the spatial join*. For these 6 outlets the store has **no identifier-borne edge at all**, even
though the register supplies one. The graph is silent where the source speaks. It is an **omission,
not a falsehood** — hence MEDIUM, not HIGH — but a consumer cannot distinguish "this outlet is not
monitored" from "we couldn't look its monitoring point up", because both render as no triple.

### ⚖️ WHAT THE HUMAN MUST DECIDE
Whether to mint the sampling-point IRI from the register notation even when the archive has no record
of it — accepting 6 sampling-point IRIs that carry `skos:prefLabel`/geometry from nowhere (a
*resolvable-but-bare* node, which under RDF's open-world assumption is perfectly legitimate) — or to
keep the omission and accept that the store under-reports what the register states. If the omission is
kept, it should at least be **counted in the README's 64/64 scoring claim**, since those 6 outlets are
excluded from the comparison the page is making.

---

## MEDIUM-2 — 110 of 270 breaches (41%) are judged against a permit version that may not have been in force

**Permit-version dating is incomplete:**

| | count |
|---|---|
| `reg:PermitDocument` in graph | **170** |
| …carrying a `core:applicableFrom` | **103** |
| …carrying **no** `core:hasApplicability` at all | **67 (39%)** |
| permits with ≥1 version in the observations | 58 |
| permits with **no dated version whatsoever** | **22** |

**Consequence for breaches.** `ttl/breaches/breaches_to_db.py:183-196`:

```python
def version_at(permit: str, t: pd.Timestamp) -> str | None:
    ws = windows.get(permit)
    if not ws:
        return latest.get(permit)   # <<< wholly undated permit: judge EVERY sample on its LATEST version
```
For a permit with no dated version, **every observation from 2000 to 2026 is judged against the limits
of the permit's newest version** — limits that may not have existed when the sample was taken.

| | breaches |
|---|---|
| total in graph | 270 |
| on permits **with** dated versions | 160 |
| **on wholly-undated permits (latest-version fallback)** | **110 (41%)** |

Their `applicableFrom` dates span **2000-01-10 → 2026-03-16**. Worst-affected permits:
`051340` (32 breaches), `043241` (22), `040136` (15), `043276` (8), `043245` (7), `043246` (7),
`043259` (6), plus 8 others including `400114/CF/01` and `042116`.

**The good news — where dates exist, attribution is exact:**
- breaches whose `applicableFrom` **precedes** their version's `effective_date`: **0**
- breaches whose `applicableFrom` **follows** their version's `revocation_date`: **0**

So the version-window logic is *correct*; it is the **input data that is missing**, for 67 of 170
PermitDocuments. The fallback is documented (`breaches_to_db.py:167-172`) and is a reasonable default —
but 41% of the store's breach assertions rest on it, and nothing in the RDF marks them as
lower-confidence.

### ⚖️ WHAT THE HUMAN MUST DECIDE
Three things:
1. **Can `fetch_version_dates.py` be made to cover the missing 67?** If the public register simply has
   no dates for them, that is a source limitation and should be stated.
2. **Is "judge on the latest version" the right fallback,** or should an undated permit's older samples
   be left *unjudged* (as they are for a dated permit whose sample falls before its first version)?
   The current asymmetry means an undated permit is judged more aggressively than a dated one.
3. **Should the 110 fallback-derived breaches be marked in the graph** (e.g. a confidence annotation or
   a distinct subclass), so a consumer can tell an assertion backed by a real permit window from one
   backed by a guess? Right now they are indistinguishable.

---

## LOW-1 — `wr:sampling-point-type` concept scheme is not typed `skos:ConceptScheme`

17 concepts assert `skos:inScheme <http://example.com/water-regulation/sampling-point-type>`, but that
scheme has **no triples of its own** — it is the single untyped object of `skos:inScheme` in the store.
Its two sibling schemes are typed correctly (`wr:substance` and `wr:statistical-modifier` both are).

**Cause:** `ttl/regulation/regulation.obda:65-70`, mapping `SamplingPointTypeConcepts`, is missing the
line its siblings have:
```
wr:sampling-point-type rdf:type skos:ConceptScheme .   # <- absent
```
Compare `regulation.obda:84` (`wr:substance rdf:type skos:ConceptScheme .`) and `:102`
(`wr:statistical-modifier rdf:type skos:ConceptScheme .`).

Cosmetic — SKOS consumers that enumerate schemes by type will miss this one. **Decision:** trivial
one-line addition; confirm it is an oversight rather than intent.

## LOW-2 — SFI geometries are untyped and carry no CRS URI

All **1115** SFI geometry nodes carry `geo:asWKT` but **no `rdf:type geo:Geometry`** — they are the
entire population of the store's untyped `geo:hasGeometry` objects. They also carry **no CRS URI**, so
they fall back to GeoSPARQL's CRS84 default (which happens to be correct — they are lon/lat) whereas
the designations graph states `<…/OGC/1.3/CRS84>` explicitly. Regulation, WINEP and designations all
type their geometries correctly (161 + 95 + 11 + 81 = 348).

Valid but inconsistent. **Decision:** whether `ttl/sfi/sfi.obda` should type its geometry nodes and
state the CRS, for parity with the other three graphs.

## LOW-3 — Latent IRI-encoding bug in WINEP's `continuesCondition` (**not currently firing**)

`ttl/winep/winep_to_db.py:160` builds the condition IRI as a **raw Python f-string** and
`winep.obda:97` emits it as a bare `<{continues_iri}>`:

```python
continues_iri=f"{WR}permit/{permit_ref}/version/{ver}/condition/{sub}"
```
Every other permit IRI in the store is produced by an **ontop template** (`wr:permit/{permit_ref}`),
which percent-encodes `/` to `%2F`. A hand-built string does **not**. So for a permit ref containing a
slash — such as `400114/CF/01` — this would mint
`…/permit/400114/CF/01/version/…` while regulation mints `…/permit/400114%2FCF%2F01/version/…`, and the
`continuesCondition` join would **fail silently**.

**Currently harmless:** all 4 `continuesCondition` targets are numeric refs (`401050`, `401354` ×2,
`401747`), and all 6 triples resolve. The bug is dormant only because no WINEP "No change from current"
cell happens to sit on a slash-bearing permit.

**Decision:** whether to harden this now (URL-encode the ref, or route it through an ontop template
like every other IRI) or accept a landmine that fires the day WINEP touches an EPR-style permit ref.

## LOW-4 / LOW-5 — Two documented modelling gaps (verified as intended, no action implied)

- **7 WINEP nitrogen bounds carry a value but no `iop:hasStatisticalModifier`** (actions `08WW102103/4/5/7/8/9`, `08WW102200`; values 5–15 mg/l). The source cells read `N 10mg/l` and name no statistic. `winep_to_db.py:250-257` deliberately declines to invent one and carries the text in `reg:limitStatement` instead. **This is the honest behaviour** — flagged only so it is not mistaken for a parser failure.
- **2 WINEP limits carry no `reg:regulatedProperty`** (`08WW102105/limit/feal`, `08WW102108/limit/feal`) — both are `TBC` cells on the multi-substance Iron/Aluminium column, so no analyte can be attributed. Also deliberate.

---

# Appendix — what was checked and found clean

Recorded so the absence of a finding is not mistaken for an absence of a check.

| # | Check | Result |
|---|---|---|
| A1 | Dangling refs across 28 structural properties | **0** |
| A2 | Orphans across 27 domain types | **0** |
| A3 | DischargePoint → exactly 1 permit | **102/102** |
| A3 | DischargePoint → ≤1 `monitoredAt` | **0 with >1** |
| A4 | Conditions with no bound | **0 of 587** |
| A4 | Limits with no `limitStatement` | **0 of 587** |
| A4 | Breaches missing condition / bound / evidence / period | **0 of 270** |
| A4 | Breach evidence at the wrong sampling point | **0** |
| A5 | Malformed / mistyped WKT literals | **0** |
| A5 | WGS84 leftovers in the regulation graph | **0** |
| A6 | IRIs with a raw space or double slash | **0** |
| A6 | `%2F` encoding consistent for `400114/CF/01` | **24/24 IRIs** |
| A6 | http/https scheme consistency | **uniform `http:`** |
| A7 | WINEP `targetPermit` unresolved | **0 of 11** |
| A7 | WINEP `continuesCondition` unresolved | **0 of 6** |
| A7 | Breach `breachesCondition` / `breachesBound` unresolved | **0 of 270 / 0 of 270** |
| A7 | Breach observation → sampling point unresolved | **0 of 275** |
| B8 | Permit set vs independently re-derived scope | **61 = 61, exact** |
| B8 | Discharge point set | **102 = 102, exact** |
| B9 | `monitoredAt` edges present | **96 = 96, 0 wrong** |
| B10 | Discharge-point geometry vs independent NGR decode | **95/95 exact, 0 mismatches** |
| B10 | Fabricated geometries | **0** (7 correctly omitted) |
| B10 | Ambiguous `DISCHARGE_NGR` (multi-valued) | **0** |
| B10 | Discharge point coincident with its sampling point | **exactly 1 — 040111/1/1, verified genuine** |
| B11 | Condition count | **587 = 587** |
| B11 | Bound count and values | **800 = 800, 0 value mismatches** |
| B11 | Conditions with mixed units | **0** |
| B12 | Sampling points (label / wkt / status / type) | **161/161, zero drift** |
| B13 | Substances = determinands in the observations join | **12 = 12, exact** |
| B13 | 4-digit zero-padding | **correct** |
| B13 | 9686 ↔ 9194 `skos:exactMatch` (both directions) | **present and correct** |
