# Breaches dataset — scope

Condition breaches for the in-scope permits, assessed against **every bound** they hold. Built by
`fetch_compliance_observations.py` (caches the EA's compliance samples) → `breaches_to_db.py`
(applies the EA's published assessment methods) → ontop (`breaches.obda`) → `../breaches.ttl`.

```
python ttl/regulation/regulation_to_db.py                  # must run first — supplies the bounds
python ttl/breaches/fetch_compliance_observations.py       # (occasional) refresh the cached samples
python ttl/breaches/breaches_to_db.py
./ontop/ontop materialize --mapping ttl/breaches/breaches.obda \
    --properties ontop/duckdb-breaches.properties \
    --output ttl/breaches/breaches_raw.ttl --format turtle \
  && rdfpipe -i turtle -o turtle ttl/breaches/breaches_raw.ttl > ttl/breaches.ttl
```

## Why this is a separate graph

A permit, a condition and a limit are **asserted** facts: the Environment Agency published them, and
`regulation.ttl` reproduces them. A breach is a **derived judgement** — nobody published it, we
computed it. Keeping the two in one file invites a reader to treat our arithmetic with the same
authority as the register, so they are separated by construction.

**A breach is not a violation.** It is an assessment that a bound was not met over some period. What
follows from that is a matter for the regulator.

## Three kinds of obligation, three kinds of breach

A condition now carries one bound per statistic, and they are not judged the same way.

| bound                 | how it is judged                                                                                                                                                                                             | a breach period is                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `maximum` / `minimum` | **per sample.** One result outside the bound fails on its own.                                                                                                                                               | a maximal run of consecutive failing samples               |
| `percentile-95`       | **period.** Over a rolling 12 months: each sample above the value is a look-up-table (LUT) exceedance; the permit fails only when the count exceeds the maximum the LUT allows *for that number of samples*. | a maximal run of consecutive rolling assessments that fail |
| `annual-average`      | **period.** Over a rolling 12 months: the permit fails only when the lower bound of the 90% confidence interval of the mean (`mean − t × SE`) is *still* above the limit.                                    | a maximal run of consecutive rolling assessments that fail |

One sample above a 95th-percentile line is an **exceedance, not a breach** — it is evidence, not a
verdict. The window is re-evaluated at every compliance sample, so the permit is in breach from the
moment the rolling assessment first goes bad until it next comes good. An **open** period (no
`applicableTo`) means it has not come good yet.

## What counts as a sample

This is where a compliance assessment is most easily wrong, so it is spelled out.

- **Only compliance samples.** Fetched with `complianceOnly=true`, which is the *archive's own*
  definition rather than our guess at `samplingPurpose` strings. Verified: it takes an ambient river
  point from 149 observations to 0 and leaves a sewage-effluent point untouched. The resulting set
  contains only `COMPLIANCE AUDIT (PERMIT)`, `COMPLIANCE FORMAL (PERMIT)`, `WATER QUALITY OPERATOR
  SELF MONITORING COMPLIANCE DATA` and `WATER QUALITY UWWTD MONITORING DATA`.
- **`"<5"` is recorded as ZERO, not dropped.** The EA's rule. `link_data.py` drops every non-numeric
  result, and in the compliance set **34.2% of results are `<` non-detects** — **63.9% of BOD**, **38.1%
  of suspended solids**, **35.9% of ammonia**. They are not lost at random: they are the *low* ones.
  Dropping them inflates every mean and, worse, shrinks the sample count `n`, which tightens the LUT
  band and **manufactures percentile failures that did not happen**. A worked example: on the old
  numbers Poole WRC failed its BOD 95-percentile in 2023 (3 exceedances, 2 allowed for 15 samples).
  Counting the non-detects, the year has enough samples to allow 3 — and the breach disappears. It was
  an artefact.
- **`">33"` is read as 33.** The EA uses the numeric value.
- **Free text is not a measurement** (`Trace present`, `Not found`, …) and is excluded.

## Known gaps in the assessment

Two of the EA's exclusions are **not yet implemented**. Both would only ever *remove* breaches, so
the current output is the conservative direction — but neither is done, and a breach here may
therefore rest on a sample the EA would not have counted.

- **No discharge.** The guidance excludes samples taken when nothing was being discharged. The archive
  does record this — as a *result value*, e.g. `No flow/discharge at sampling point` — and
  `parse_result()` in `breaches_to_db.py` already drops those (`NO_DISCHARGE`). In the current
  compliance set **zero** such results appear, so the check is a no-op today; it is retained because a
  refreshed fetch may bring some in. **What is missing** is the case where flow is nil but the result
  is still a number: that needs the discharge's flow record, which is not in the water-quality archive
  at all, so it cannot be done from this source.
- **Unusual weather.** The guidance excludes samples affected by unusual weather (storm conditions,
  which dilute or overwhelm a works). **Nothing in the water-quality archive flags this**, so it is not
  implemented and cannot be from this source alone. Doing it properly needs rainfall or
  storm-overflow-spill data joined on (sampling point, date) — the EDM / storm overflow dataset is the
  obvious candidate. Until then, a breach recorded on a storm day may be one the EA would discount.

Also not yet handled:

- **`median`** bounds have no assessment defined and are skipped. (None occur in this catchment.)
- **`COMPARATIVE`** (differential inlet-vs-discharge) limits are out of scope upstream, in
  `link_data.py`.
- **Fixed assessment periods.** A permit may name its own 12-month period; we use a rolling one.

## Which version applied? — and the trap inside the rule

Each sample is judged **only against the permit version in force when it was taken**, dated from the
public register. The old code — the one embedded in `regulation.ttl` — tested every observation against
every version's limits, including versions revoked years before the sample existed, booking **64 breach
rows for 39 real events**.

The first fix over-corrected. It fell back to the permit's **latest** version whenever the register gave
no dates, which quietly judged 2000–2026 samples against limits that may never have applied to them —
**110 of the old 270 breaches** rested on that fallback, and in the RDF they were indistinguishable
from the 160 that did not. That fallback is gone.

The second fix over-corrected the other way, and this is the interesting one. Reading the rule as *"no
dates, no judgement"* refuses to assess **any** undated permit — but the ambiguity a missing date
creates is *which of the permit's limit-sets applied on the day*. A permit with a **single version** has
only one limit-set. There is nothing to choose between. The missing date leaves open only the period the
permit ran between — and a sample the Water Quality Archive itself labels a **compliance sample**, taken
at the point the register names as that permit's compliance point, is the EA's own statement that the
permit was in force when it was taken.

So the rule as it now stands:

| Version history | Judged? |
| --- | --- |
| a **dated** window contains the sample | **yes** |
| the sample falls in a **gap** between dated versions, or before the first | **no** — `no-observations-in-a-dated-window` |
| **one** version, undated | **yes**, and flagged `wr:judgedOnUndatedVersion` |
| **several** versions, none dated | **no** — `ambiguous-version-history` |

Getting the third row wrong cost real assessments: permit `EPRYP3399VF` holds **121 compliance samples**
for pH, suspended solids and iron, every one of them testable against limits that are in no doubt
whatever, and all six of its conditions were being reported as unexaminable. **Refusing to judge what
you can judge is not caution** — it is an assertion the data does not support, just pointed the other way.

**111 of the 275 breaches** rest on an undated single version. They say so, in the graph and in the app.

## Which limit was breached?

`defra-reg:breachesCondition` points at the condition, but a condition holds several limits — a 95th
percentile *and* a maximum, and at permit `040067` a summer value *and* a winter one — so on its own it
cannot say which obligation failed. Each breach therefore also carries:

```turtle
wr:breach/{id}  a                        defra-reg:LimitBreach, defra-reg:ExceedanceBreach ;
                defra-reg:breachesCondition  wr:permit/042116/version/4/outlet/1/effluent/1/condition/0085 ;
                defra-reg:breachesLimit      wr:permit/042116/version/4/outlet/1/effluent/1/condition/0085#limit-percentile-95 ;
                rdfs:comment            "3 exceedances of the 15 95th-percentile limit in the 12 months to …" .
```

> **This section used to describe an invented predicate.** The store minted `defra-reg:breachesBound`
> under DEFRA's own namespace, because one `Limit` carried every bound and naming the Limit therefore
> did not discriminate. This README argued the fix was to *"make each statistic its own `Limit`, at
> which point `breachesLimit` becomes meaningful"* — and that is exactly what happened. `defra-regulation.ttl`
> now defines **`reg:LimitBreach`** and **`reg:breachesLimit`** (range `reg:Limit`), a Condition holds one
> Limit per statistic per season, each with a single bound, and the invented term is **gone**. The
> feedback loop closed.

## Result

**275 breaches** over 31 permits, from **40,600 compliance observations** (2000–2026):

| statistic        | breaches |
| ---------------- | -------- |
| `maximum`        | 237      |
| `minimum`        | 35       |
| `percentile-95`  | 2        |
| `annual-average` | 1        |

One is still open. **111 rest on an undated (single-version) permit** and are flagged as such.

## What we did NOT judge — and why that is in the graph

A breach count means nothing without its denominator. The store holds **1,277 conditions**; **588 (46%)
were actually assessed**. The other **689 were not** — and an unassessed condition is *not* a condition
that passed. "No breach found" is what a regulator reads as "compliant", so every one of them is emitted
with a machine-readable reason (`wr:assessed false`, `wr:notAssessedBecause`):

| reason | conditions | what it means |
| --- | --- | --- |
| `no-observations` | 394 | the point and determinand are known; the archive holds no compliance sample for the pair. Mostly the flow, weir-setting and storm-overflow telemetry the register sets but the archive does not carry. |
| `ambiguous-version-history` | 146 | several versions, none dated (see above) |
| `no-sampling-point` | 111 | the register names no sampling point for this outlet — nobody monitors it |
| `no-observations-in-a-dated-window` | 18 | samples exist, but none falls inside a dated version |
| `too-few-samples` | 11 | assessed, but every 12-month window was below the method's minimum |
| `sampling-point-unpublished` | 9 | the register names a point the archive publishes no data for |

The app draws this as a **third marker state** — not blue (assessed, clean), not red or amber
(breached), but **grey: not assessed**. That distinction is the whole reason this project exists.

The count is higher than the old 64 chiefly because the compliance fetch reaches
back to **2000** rather than the bulk extract's 2020, not because more is being called a breach.

`breaches.duckdb` and `breaches_raw.ttl` are regenerable and gitignored;
`compliance_observations.csv` is committed (a fetched input, not a rebuild artefact), so the breach
build itself runs offline.
