"""Assess the in-scope permits against every bound they hold, and shred the resulting breaches into
breaches.duckdb for ontop to materialise as ../breaches.ttl.

A breach is a DERIVED judgement, not a register fact - which is why it lives in its own graph rather
than in regulation.ttl. Nothing here is asserted by the Environment Agency; it is our assessment,
computed from the archive's own compliance samples using the EA's published method.

THREE KINDS OF BREACH, because a permit holds three kinds of obligation
----------------------------------------------------------------------
  maximum / minimum   PER-SAMPLE. One result outside the bound is a failure on its own.
                      Breach period = a maximal run of consecutive failing samples (gaps-and-islands).

  95 percentile       PERIOD. Judged over a ROLLING 12-month window: each sample above the value is a
                      look-up-table exceedance, and the permit fails only when the count of them
                      exceeds the maximum the LUT allows for that number of samples. One sample above
                      the line is NOT a breach.

  mean value          PERIOD. Judged over a ROLLING 12-month window: the permit fails only when the
                      lower bound of the 90% confidence interval of the mean (mean - t x standard
                      error) is still above the limit - i.e. it is over the limit with confidence,
                      not just on the day's arithmetic.

For the two period statistics the window is re-evaluated at every compliance sample, and a breach
period is a maximal run of consecutive assessments that FAIL - so the permit is in breach from the
moment the rolling assessment first goes bad until it next comes good. That mirrors the per-sample
model, and an open period (no applicableTo) means it has not come good yet.

WHAT COUNTS AS A SAMPLE  (see README.md - this is where the assessment can still be wrong)
-----------------------------------------------------------------------------------------
  "<5"    -> 0.0    The EA records a "less than" result AS ZERO. The old pipeline DROPPED these, and
                    they are 34% of the compliance set (70% of BOD). Dropping them shrinks n, which
                    tightens the LUT band, which invents percentile failures.
  ">33"   -> 33.0   The EA uses the numeric value.
  no flow -> EXCLUDED. A sample taken when nothing was being discharged cannot evidence a breach.
  Only samples the archive itself calls compliance samples (complianceOnly=true) are used.
"""
from __future__ import annotations

import hashlib
import math
import sys
from pathlib import Path

import duckdb
import pandas as pd

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
REG_DB = ROOT / "ttl" / "regulation" / "regulation.duckdb"
OBS_CSV = HERE / "compliance_observations.csv"

# --- The EA's 95-percentile look-up table: samples in the 12-month period -> exceedances allowed. ---
LUT = [(4, 7, 1), (8, 16, 2), (17, 28, 3), (29, 40, 4), (41, 53, 5), (54, 67, 6), (68, 81, 7),
       (82, 95, 8), (96, 110, 9), (111, 125, 10), (126, 140, 11), (141, 155, 12), (156, 171, 13),
       (172, 187, 14), (188, 203, 15), (204, 219, 16), (220, 235, 17), (236, 251, 18),
       (252, 268, 19), (269, 284, 20), (285, 300, 21), (301, 317, 22), (318, 334, 23),
       (335, 350, 24), (351, 365, 25)]
LUT_MIN_N = LUT[0][0]                    # below this the table has no band: not assessable


def lut_allowance(n: int) -> int | None:
    for lo, hi, k in LUT:
        if lo <= n <= hi:
            return k
    return None                          # n < 4, or n > 365: outside the table


# --- One-sided 95% t (= the lower bound of a two-sided 90% CI), by degrees of freedom n-1. ---
T90 = {1: 6.314, 2: 2.920, 3: 2.353, 4: 2.132, 5: 2.015, 6: 1.943, 7: 1.895, 8: 1.860, 9: 1.833,
       10: 1.812, 11: 1.796, 12: 1.782, 13: 1.771, 14: 1.761, 15: 1.753, 16: 1.746, 17: 1.740,
       18: 1.734, 19: 1.729, 20: 1.725, 21: 1.721, 22: 1.717, 23: 1.714, 24: 1.711, 25: 1.708,
       26: 1.706, 27: 1.703, 28: 1.701, 29: 1.699, 30: 1.697, 40: 1.684, 60: 1.671, 120: 1.658}
MEAN_MIN_N = 2                           # need at least 2 samples for a standard deviation


def t_value(df: int) -> float:
    if df in T90:
        return T90[df]
    for k in sorted(T90):                # conservative: step up to the next tabulated df
        if df < k:
            return T90[k]
    return 1.645                         # large-sample normal limit


# --- Result interpretation. Returns (value, usable). ---
NO_DISCHARGE = ("no flow", "no discharge", "no material present")


def parse_result(raw) -> tuple[float | None, bool]:
    """The EA's rules, applied verbatim. See the module header."""
    if raw is None:
        return None, False
    s = str(raw).strip()
    if not s:
        return None, False
    low = s.lower()
    if any(low.startswith(p) for p in NO_DISCHARGE):
        return None, False               # nothing was discharged: the sample cannot evidence a breach
    if s.startswith("<"):
        try:
            float(s[1:])                 # validate, then record as ZERO per the guidance
            return 0.0, True
        except ValueError:
            return None, False
    if s.startswith(">"):
        try:
            return float(s[1:]), True    # the guidance uses the numeric value
        except ValueError:
            return None, False
    try:
        return float(s), True
    except ValueError:
        return None, False               # free text ("Trace present", ...): not a measurement


def bid(*parts) -> str:
    return hashlib.md5("|".join(str(p) for p in parts).encode()).hexdigest()


def runs(flags: list[bool]) -> list[tuple[int, int]]:
    """Maximal runs of True as (start_index, end_index) inclusive - gaps-and-islands."""
    out, start = [], None
    for i, f in enumerate(flags):
        if f and start is None:
            start = i
        elif not f and start is not None:
            out.append((start, i - 1))
            start = None
    if start is not None:
        out.append((start, len(flags) - 1))
    return out


# =====================================================================================
# Load: the register side (what is required) and the observation side (what happened)
# =====================================================================================
if not REG_DB.exists():
    sys.exit(f"ABORT: {REG_DB} missing - run ttl/regulation/regulation_to_db.py first.")
if not OBS_CSV.exists():
    sys.exit(f"ABORT: {OBS_CSV} missing - run ttl/breaches/fetch_compliance_observations.py first.")

reg = duckdb.connect(str(REG_DB), read_only=True)
bounds = reg.execute("""
    SELECT permit_ref, version, substance, statistic, bound_kind,
           CAST(value AS DOUBLE) AS limit_value, unit_slug
    FROM condition_bounds
""").df()
monitoring = reg.execute("""
    SELECT DISTINCT permit_ref, sp_notation FROM discharge_point_monitoring
    WHERE sp_notation IS NOT NULL AND sp_notation <> ''
""").df()
vdates = reg.execute("SELECT permit_ref, version, effective_date, revocation_date FROM permit_version_dates").df()
reg.close()

obs = pd.read_csv(OBS_CSV, dtype=str)
obs["substance"] = obs["determinand.notation"].str.zfill(4)
obs["t"] = pd.to_datetime(obs["phenomenonTime"], errors="coerce")
parsed = obs["result"].map(parse_result)
obs["result_value"] = [p[0] for p in parsed]
obs["usable"] = [p[1] for p in parsed]

excluded = (~obs["usable"]).sum()
obs = obs[obs["usable"] & obs["t"].notna()].copy()
obs = obs.rename(columns={"samplingPoint.notation": "sp_notation"})
obs = obs[["id", "sp_notation", "substance", "t", "result_value", "unit"]].drop_duplicates(subset=["id"])

# --- Which permit VERSION was in force when the sample was taken? --------------------------------
# Mirrors the app's limitAt(): use the dated window containing t; after the last dated window (an
# undated current version) fall back to the permit's latest version; a permit with NO dated version
# at all is judged against its latest version throughout. Before the first version there was no
# permit, so the sample is not judged. Without this a 2023 sample is tested against the limits of a
# version revoked in 2011 - which is how the old pipeline booked 64 breach rows for 39 real events.
vdates["vfrom"] = pd.to_datetime(vdates["effective_date"], errors="coerce")
vdates["vto"] = pd.to_datetime(vdates["revocation_date"], errors="coerce")
windows: dict[str, list[tuple[str, pd.Timestamp, pd.Timestamp]]] = {}
for r in vdates.itertuples():
    if pd.notna(r.vfrom):
        windows.setdefault(r.permit_ref, []).append((r.version, r.vfrom, r.vto))
latest = (bounds.assign(v=pd.to_numeric(bounds.version, errors="coerce"))
                .sort_values("v").groupby("permit_ref").version.last().to_dict())


def version_at(permit: str, t: pd.Timestamp) -> str | None:
    ws = windows.get(permit)
    if not ws:
        return latest.get(permit)                       # wholly undated permit: judge on its latest
    for ver, f, to in ws:
        if t >= f and (pd.isna(to) or t <= to):
            return ver
    last_end = max((w[2] for w in ws if pd.notna(w[2])), default=None)
    first_start = min(w[1] for w in ws)
    if last_end is not None and t > last_end:
        return latest.get(permit)                       # beyond the last dated window
    if t < first_start:
        return None                                     # before the permit existed
    return None                                         # in a gap between versions


# --- The assessable series: one row per (permit, version, substance, observation) ----------------
series = obs.merge(monitoring, on="sp_notation")
series["version"] = [version_at(p, t) for p, t in zip(series.permit_ref, series.t)]
undatable = series.version.isna().sum()
series = series.dropna(subset=["version"])
series = series.merge(bounds, on=["permit_ref", "version", "substance"])
series = series.sort_values("t")

print(f"compliance observations : {len(obs)} usable, {excluded} excluded "
      f"(no discharge / non-measurement)")
print(f"assessable series rows  : {len(series)}  ({undatable} samples fell outside every permit version)")

# =====================================================================================
# Assess
# =====================================================================================
WINDOW = pd.DateOffset(months=12)
breach_rows: list[dict] = []
evidence: list[dict] = []
stat_counts: dict[str, int] = {}

GROUP = ["permit_ref", "version", "substance", "statistic", "bound_kind", "limit_value", "unit_slug"]
for key, g in series.groupby(GROUP, sort=False):
    permit, version, substance, statistic, kind, limit, unit_slug = key
    g = g.drop_duplicates(subset=["id"]).sort_values("t").reset_index(drop=True)
    ts = g["t"].tolist()
    vals = g["result_value"].tolist()
    ids = g["id"].tolist()
    n_obs = len(g)
    if not n_obs:
        continue

    fails: list[bool] = []
    details: list[str] = []
    ev_for: list[list[str]] = []          # evidencing observation ids per assessment point

    if statistic in ("maximum", "minimum"):
        # PER-SAMPLE: judged on its own.
        for i in range(n_obs):
            bad = vals[i] > limit if statistic == "maximum" else vals[i] < limit
            fails.append(bad)
            details.append(f"{vals[i]:g} {'above' if statistic == 'maximum' else 'below'} "
                           f"the {limit:g} {statistic}")
            ev_for.append([ids[i]] if bad else [])

    elif statistic == "percentile-95":
        # PERIOD: rolling 12 months ending at each sample.
        for i in range(n_obs):
            lo = ts[i] - WINDOW
            idx = [j for j in range(i + 1) if ts[j] > lo]
            n = len(idx)
            allowed = lut_allowance(n)
            if allowed is None:
                fails.append(False)
                details.append(f"{n} samples in the 12 months to {ts[i]:%Y-%m-%d} - too few to assess")
                ev_for.append([])
                continue
            over = [j for j in idx if vals[j] > limit]
            bad = len(over) > allowed
            fails.append(bad)
            details.append(f"{len(over)} exceedances of the {limit:g} 95th-percentile limit in the "
                           f"12 months to {ts[i]:%Y-%m-%d}; {allowed} permitted for {n} samples")
            ev_for.append([ids[j] for j in over] if bad else [])

    elif statistic == "annual-average":
        # PERIOD: rolling 12-month mean, failed only if the 90% CI lower bound is still over.
        for i in range(n_obs):
            lo = ts[i] - WINDOW
            idx = [j for j in range(i + 1) if ts[j] > lo]
            n = len(idx)
            if n < MEAN_MIN_N:
                fails.append(False)
                details.append(f"{n} samples in the 12 months to {ts[i]:%Y-%m-%d} - too few to assess")
                ev_for.append([])
                continue
            w = [vals[j] for j in idx]
            mean = sum(w) / n
            sd = math.sqrt(sum((x - mean) ** 2 for x in w) / (n - 1))
            lci = mean - t_value(n - 1) * sd / math.sqrt(n)
            bad = lci > limit
            fails.append(bad)
            details.append(f"12-month mean {mean:.2f} to {ts[i]:%Y-%m-%d} (n={n}); lower bound of the "
                           f"90% confidence interval {lci:.2f} exceeds the {limit:g} annual-mean limit")
            # the whole window evidences a mean - every sample in it went into the number
            ev_for.append([ids[j] for j in idx] if bad else [])
    else:
        continue                          # median etc: no assessment defined yet

    cls = "ShortfallBreach" if statistic == "minimum" else "ExceedanceBreach"
    for a, b in runs(fails):
        breach_id = bid(permit, version, substance, statistic, ts[a].strftime("%Y-%m-%dT%H:%M:%S"))
        is_current = (b == n_obs - 1)      # nothing has passed since: the period is still open
        breach_rows.append(dict(
            breach_id=breach_id, permit_ref=permit, version=version, substance=substance,
            statistic=statistic, bound_kind=kind, breach_class=cls,
            limit_value=limit, unit_slug=unit_slug,
            applicable_from=ts[a].strftime("%Y-%m-%dT%H:%M:%S"),
            applicable_to=None if is_current else ts[b].strftime("%Y-%m-%dT%H:%M:%S"),
            is_current=is_current,
            detail=details[b],             # the assessment as it stood when the run ended
        ))
        stat_counts[statistic] = stat_counts.get(statistic, 0) + 1
        seen = set()
        for j in range(a, b + 1):
            for oid in ev_for[j]:
                if oid not in seen:
                    seen.add(oid)
                    evidence.append(dict(breach_id=breach_id, observation_id=oid))

breaches = pd.DataFrame(breach_rows)
breach_observations = pd.DataFrame(evidence).drop_duplicates() if evidence else \
    pd.DataFrame(columns=["breach_id", "observation_id"])

# --- Each evidencing observation's sampling point. This is the structural edge the app's breach query
#     joins on (<observation> sosa:hasFeatureOfInterest <sampling-point>), instead of an IRI-prefix
#     STRSTARTS filter the engine cannot key on. enrich_sampling_points.py used to dereference the
#     archive for it; we already KNOW it - the compliance fetch carried the sampling point on every
#     observation - so it is emitted straight from the data, no network round-trip. ---
observation_sampling_point = (
    obs[obs["id"].isin(set(breach_observations["observation_id"]))][["id", "sp_notation"]]
    .drop_duplicates()
    .rename(columns={"id": "observation_id"})
)

# =====================================================================================
# Write
# =====================================================================================
con = duckdb.connect(str(HERE / "breaches.duckdb"))
for name, df in [("breaches", breaches), ("breach_observations", breach_observations),
                 ("observation_sampling_point", observation_sampling_point)]:
    con.execute(f"CREATE OR REPLACE TABLE {name} AS SELECT * FROM df")

print(f"\n{'breaches':>22}: {len(breaches)}")
for stat, n in sorted(stat_counts.items(), key=lambda x: -x[1]):
    print(f"{stat:>22}: {n}")
print(f"{'breach_observations':>22}: {len(breach_observations)}")
if not breaches.empty:
    print(f"{'current (open)':>22}: {int(breaches.is_current.sum())}")
    print(f"{'permits affected':>22}: {breaches.permit_ref.nunique()}")
    nitro = breaches[breaches.substance.isin(["0111", "9686"])]
    print(f"{'nitrogen breaches':>22}: {len(nitro)}")
con.close()
