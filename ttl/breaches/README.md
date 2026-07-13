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
  result, and in the compliance set **34% of results are `<` non-detects** — 70.7% of BOD, 47.1% of
  ammonia. They are not lost at random: they are the *low* ones. Dropping them inflates every mean
  and, worse, shrinks the sample count `n`, which tightens the LUT band and **manufactures percentile
  failures that did not happen**. A worked example: on the old numbers Poole WRC failed its BOD
  95-percentile in 2023 (3 exceedances, 2 allowed for 15 samples). Counting the non-detects, the year
  has enough samples to allow 3 — and the breach disappears. It was an artefact.
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

## The version-in-force fix

Each sample is judged **only against the permit version in force when it was taken** (dated from the
public register; a permit with no dated versions is judged against its latest). The previous
breach code — the one embedded in `regulation.ttl` — did **not** do this: it tested every observation
against every version's limits, including versions revoked years before the sample existed. That
booked **64 breach rows for 39 real events**, with only 27 of the 64 sitting on the version actually
in force. This pipeline supersedes it.

## Which bound was breached?

`defra-reg:breachesCondition` points at the condition, but a condition can hold a 95th percentile
*and* a maximum, so on its own it cannot say which obligation failed. This graph therefore also emits

```turtle
wr:breach/{id} defra-reg:breachesBound
    wr:permit/401747/version/3/condition/0111#limit-percentile-95 .
```

pointing at the exact `qudt:QuantityValue` — the thing that carries the value, the unit and the
`iop:hasStatisticalModifier`.

> **Ontology gap — feedback for `defra-regulation.ttl`.** `breachesBound` is *not* in the published
> ontology, which offers only `breachesCondition`. A `breachesLimit` would not help: `hasLimit` is
> 1:1 with `Condition`, so it would be `breachesCondition` with an extra hop. The bound is the only
> level that discriminates. The cleaner long-term alternative is to make each *statistic* its own
> `Limit` (a Condition would then have several), moving `hasStatisticalModifier` from the bound onto
> the `Limit` — at which point `breachesLimit` becomes meaningful. That re-shapes both
> `regulation.ttl` and `winep.ttl`, so it is logged here rather than done.

Each breach also carries an `rdfs:comment` stating the assessment in words, e.g.

> *"6 exceedances of the 10 95th-percentile limit in the 12 months to 2002-06-26; 5 permitted for 48
> samples"*

## Result

**270 breaches** over 35 permits, from **40,600 compliance observations** (2000–2026):

| bound            | breaches |
| ---------------- | -------- |
| `maximum`        | 229      |
| `minimum`        | 36       |
| `percentile-95`  | 4        |
| `annual-average` | 1        |

One is still open. The count is higher than the old 64 chiefly because the compliance fetch reaches
back to **2000** rather than the bulk extract's 2020, not because more is being called a breach.

`breaches.duckdb` and `breaches_raw.ttl` are regenerable and gitignored;
`compliance_observations.csv` is committed (a fetched input, not a rebuild artefact), so the breach
build itself runs offline.
