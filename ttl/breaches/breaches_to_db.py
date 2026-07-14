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

WHAT WE REFUSE TO JUDGE, AND WHY IT IS WRITTEN DOWN
--------------------------------------------------
A condition this pipeline cannot assess must not come out looking like a condition that passed. That
is the single mistake this whole project exists to warn about - an absence rendered as a value - and
the breach engine is where it does the most damage, because "no breach found" is what a regulator
reads as "compliant".

So every condition that is NOT assessed is emitted, with its reason, into `condition_assessment`:

  no-sampling-point      the register names no sampling point for this effluent. Nobody monitors it.
  sampling-point-unpublished  the register names one, but the Water Quality Archive publishes no
                         reference data for it, so there are no observations to fetch.
  no-observations        the point and the determinand are both known, and the archive holds no
                         compliance sample for the pair. Common for the storm-overflow telemetry and
                         flow conditions the register sets but the archive does not carry here.
  ambiguous-version-history  the register dates NONE of this permit's versions AND those versions
                         DISAGREE about this particular limit, so which value applied on the day cannot
                         be known. Narrower than it sounds - see below.
  too-few-samples        assessed, but every window fell below the minimum the method needs (n < 4 for
                         the 95th-percentile look-up table, n < 2 for a mean).

WHICH VERSION APPLIED?  -  and the trap that took THREE goes to get out of
--------------------------------------------------------------------------
A sample is judged against the permit version in force when it was taken. Where the register gives a
DATED window this pipeline uses it and nothing else. It does NOT fall back to the permit's latest
version, which is what it originally did, and which quietly judged 2000-2026 samples against limits that
may never have applied to them (110 of the old 270 breaches rested on that fallback and were
indistinguishable in the RDF from the 160 that did not).

The rule holds for gaps: if v1 and v3 are dated but v2 is not, a sample between v1's revocation and v3's
effective date sits in NO dated window and is not judged. We know what v2 required; we do not know when
v2 applied.

THE TRAP. Reading that rule as "no dates, no judgement" is wrong, and it was got wrong twice - both
times by asking about the VERSION when the only thing that matters is the LIMIT:

  1st attempt: refuse every undated permit.
      This refused EPRYP3399VF, which has exactly ONE version. There was never anything to choose
      between. 121 compliance samples for pH, solids and iron, all testable against limits in no doubt
      whatever, reported as unexaminable.

  2nd attempt: refuse undated permits with MORE THAN ONE version.
      Still asking about the version. This refused EPRBB3593EG - two undated versions whose pH limits
      are BOTH 6.0-9.0. The versions differ in name and in nothing else. Of the 70 conditions on the
      seven multi-version undated permits, 61 were exactly like this. It was hiding a real pH breach
      (5.0 against a minimum of 6.0, April 2016) behind an ambiguity that did not exist.

THE RULE, finally. What a sample is judged against is a BOUND. If every version of the permit states
the SAME bound for a condition, then the bound that applied is known with certainty, whichever version
was in force. So the test is applied PER CONDITION, against the values:

    dated window covers the sample              ->  judge against that version
    no dated window, versions AGREE on the bound ->  judge, and flag `undated_version`
    no dated window, versions DISAGREE           ->  do not judge; `ambiguous-version-history`

A permit can therefore have some conditions assessed and others not, which is exactly right: the
ambiguity is a property of the limit, not of the permit. In this catchment it collapses the "cannot
tell" set from 146 conditions to 26 - and only 9 of those are the genuine disagreement; the rest are
permits with no observations at all.

Every judgement made without a date carries `undated_version`, in the graph and in the app, because it
is a weaker claim than one made with a date and must read as one.

Refusing to judge what you CAN judge is not caution. It is an assertion the data does not support, just
pointed the other way - and it hides real breaches, which is the more dangerous direction to be wrong in.
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
# Bounds at the REGISTER's grain: per outlet, per effluent, and per season. A permit does not have one
# BOD limit; each of its effluents does, and permit 040067's changes with the month.
bounds = reg.execute("""
    SELECT permit_ref, version, outlet, effluent, substance, statistic, bound_kind, season,
           month_from, month_to, CAST(value AS DOUBLE) AS limit_value, unit_slug
    FROM condition_bounds
""").df()
# The monitoring edge, kept VERSIONED. A sample taken at SW-50440194 evidences permit 042116's
# effluent 1 - not "permit 042116", whose three effluents carry three different BOD limits. Joining on
# the permit alone (which is what this used to do) hands the assessment the wrong outlet's limit.
monitoring = reg.execute("""
    SELECT DISTINCT e.permit_ref, e.version, e.outlet, e.effluent, e.sp_notation
    FROM register_effluents e JOIN scoped_permits s USING (permit_ref)
    WHERE e.sp_notation IS NOT NULL
""").df()
conditions = reg.execute("""
    SELECT c.permit_ref, c.version, c.outlet, c.effluent, c.substance, s.pref_label AS substance_label
    FROM conditions c LEFT JOIN substances s ON s.notation = c.substance
""").df()
dp_monitoring = reg.execute(
    "SELECT DISTINCT permit_ref, outlet, effluent, sp_notation FROM discharge_point_monitoring").df()
unpublished = {r[0] for r in reg.execute(
    "SELECT sp_notation FROM unpublished_sampling_points").fetchall()}
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
# ONLY a dated window answers this. If t falls inside no dated window, the answer is "we do not know",
# and this pipeline makes no determination - it returns None and the sample is dropped from the
# assessment (and the reason is recorded in condition_assessment).
#
# The two fallbacks that used to live here are GONE, and both were the same mistake:
#
#   * a permit with no dated version at all was judged against its LATEST version, throughout
#     2000-2026. Fifteen of this catchment's permits are wholly undated. Their limits may never have
#     applied on the day the sample was taken; we were asserting that they did.
#   * a sample after the last dated window was judged against the latest version, on the assumption
#     that an undated current version must be the one in force. It might be. We do not know.
#
# The gap case matters even when the ends are dated: if v1 and v3 carry dates and v2 does not, a sample
# between v1's revocation and v3's effective date is in NO dated window. We hold v2's limits and cannot
# say when they applied, so we do not judge. Falling back to "the nearest version we do know" would be
# inventing a fact, and the count of breaches would silently include it.
vdates["vfrom"] = pd.to_datetime(vdates["effective_date"], errors="coerce")
vdates["vto"] = pd.to_datetime(vdates["revocation_date"], errors="coerce")
windows: dict[str, list[tuple[str, pd.Timestamp, pd.Timestamp]]] = {}
for r in vdates.itertuples():
    if pd.notna(r.vfrom):
        windows.setdefault(r.permit_ref, []).append((r.version, r.vfrom, r.vto))

# THE AMBIGUITY THAT MATTERS IS IN THE LIMIT, NOT IN THE VERSION NUMBER.
#
# The rule is "make no determination when the version history is AMBIGUOUS". Everything turns on what
# is actually ambiguous. A missing date leaves open *which version was in force* - but that only
# matters if the versions REQUIRE DIFFERENT THINGS. What we are judging a sample against is a BOUND,
# and if every version the permit has states the same bound, then the bound that applied is known with
# certainty whichever version it was.
#
# This got narrowed twice, and both times because the question was asked at the wrong level:
#
#   1. First the rule was "no dates, no judgement", refusing every undated permit. That refused
#      EPRYP3399VF - which has exactly ONE version, so there was never anything to choose between. 121
#      compliance samples for pH, solids and iron, all testable against limits in no doubt whatever,
#      reported as unexaminable.
#
#   2. Then it was "no dates AND more than one version, no judgement", which still asks about the
#      VERSION. That refused EPRBB3593EG - two undated versions whose pH limits are BOTH 6.0-9.0. The
#      versions differ in name and in nothing else. Of the 70 conditions on the 7 multi-version undated
#      permits, 61 were like this: every version agreeing on every bound, refused for an ambiguity that
#      does not exist. Only 9 conditions - on two permits - genuinely disagree.
#
# So the test is applied per CONDITION, against the BOUNDS themselves: if the candidate versions all
# state the same bounds, the condition is determinate and IS judged; if they disagree, that condition
# (and only that condition) is not. A permit can therefore have some conditions assessed and others
# not, which is exactly right - the ambiguity is a property of the limit, not of the permit.
#
# The judgement IS marked. Every breach resting on an undated version carries `undated_version`, and
# the app says so, because a determination made without a date is a weaker claim than one made with it.
#
# Refusing to judge what you CAN judge is not caution. It is an assertion the data does not support,
# just pointed the other way - and it hides real breaches, which is the more dangerous direction.
undated_permits = {p for p in set(conditions.permit_ref) if p not in windows}

# For an undated permit, is this condition's limit the SAME in every version it has? Keyed on the
# condition's identity WITHOUT the version; the value is the version to judge against (any of them,
# since they agree) or None when they do not.
_b = bounds[bounds.permit_ref.isin(undated_permits)]
CKEY = ["permit_ref", "outlet", "effluent", "substance"]
determinate: dict[tuple, str] = {}
ambiguous: set[tuple] = set()
for key, g in _b.groupby(CKEY, sort=False):
    # every version must carry the same SET of (statistic, season) bounds ...
    shapes = g.groupby("version").apply(
        lambda d: frozenset(zip(d.statistic, d.season)), include_groups=False)
    # ... and each of those bounds must have ONE distinct value across the versions
    values_agree = g.groupby(["statistic", "season"]).limit_value.nunique().max() <= 1
    if shapes.nunique() == 1 and values_agree:
        determinate[key] = sorted(g.version, key=lambda v: int(v) if v.isdigit() else v)[-1]
    else:
        ambiguous.add(key)


def version_at(permit: str, t: pd.Timestamp) -> tuple[str | None, bool]:
    """(version in force at t, whether that rests on an UNDATED version).

    None when a DATED window does not cover t and the permit has any dates at all - before its first
    version, or inside a gap between two of them. For a wholly undated permit the answer depends on the
    CONDITION, not on the date, so this returns the flag and the caller resolves it per condition.
    """
    for ver, f, to in windows.get(permit, ()):
        if t >= f and (pd.isna(to) or t <= to):
            return ver, False
    if permit in undated_permits:
        return "*", True          # undated: resolved per condition below, against `determinate`
    return None, False            # dated permit, but t is before v1 or in a gap


def in_season(month: int, m_from: str, m_to: str) -> bool:
    """Does `month` fall in the register's [MONTH_FROM, MONTH_TO] range? The range wraps the year:
    permit 040067's winter limit runs 11 -> 04."""
    a, b = int(m_from), int(m_to)
    return a <= month <= b if a <= b else (month >= a or month <= b)


# --- The assessable series: one row per (discharge point, substance, statistic, observation) -------
# The join is on (permit, VERSION, OUTLET, EFFLUENT) - the grain the register sets limits at.
series = obs.merge(monitoring, on="sp_notation")
_at = [version_at(p, t) for p, t in zip(series.permit_ref, series.t)]
series["v_at"] = [v for v, _ in _at]
series["undated"] = [u for _, u in _at]                   # the judgement rests on an undated version
n_undatable_obs = series[series.v_at.isna()].id.nunique()

# An undated permit carries "*" — resolve it per CONDITION. The condition is determinate when every
# version of the permit states the same bounds for it (see above), in which case we judge against any
# of them; otherwise the condition is dropped here and reported as `ambiguous-version-history`.
def resolve(r):
    if r.v_at != "*":
        return r.v_at
    return determinate.get((r.permit_ref, r.outlet, r.effluent, r.substance))


series["v_at"] = [resolve(r) for r in series.itertuples()]
series = series[series.v_at == series.version].copy()     # the version actually in force at t
series = series.merge(bounds, on=["permit_ref", "version", "outlet", "effluent", "substance"])

# Each sample is judged against the bound in force IN THE MONTH IT WAS TAKEN. Splitting a seasonal
# condition into two independent series would halve n in each, which tightens the 95th-percentile
# look-up band and manufactures failures - so the series stays whole and the LIMIT travels per sample.
series = series[[in_season(t.month, f, o)
                 for t, f, o in zip(series.t, series.month_from, series.month_to)]].copy()
series = series.sort_values("t")

print(f"compliance observations : {len(obs)} usable, {excluded} excluded "
      f"(no discharge / non-measurement)")
print(f"assessable series rows  : {len(series)}")
print(f"  outside every dated window: {n_undatable_obs} observation(s) on a DATED permit fell before "
      f"its first version or in a gap - NOT judged")
print(f"  undated permits           : {len(undated_permits)} - judged per CONDITION, against the bounds:")
print(f"      determinate (every version states the SAME limit): {len(determinate)} condition(s) - JUDGED, flagged")
print(f"      ambiguous   (versions DISAGREE on the limit)     : {len(ambiguous)} condition(s) - NOT judged")

# =====================================================================================
# Assess
# =====================================================================================
WINDOW = pd.DateOffset(months=12)
breach_rows: list[dict] = []
evidence: list[dict] = []
stat_counts: dict[str, int] = {}

# The season is NOT in the group key: a seasonal condition is one obligation whose value changes with
# the month, not two obligations. `limits[i]` is the bound in force when sample i was taken, and every
# comparison below uses it - so a 12-month percentile window spanning summer and winter counts each
# sample against the limit that actually applied to it.
GROUP = ["permit_ref", "version", "outlet", "effluent", "substance", "statistic", "bound_kind",
         "unit_slug"]
assessed_keys: set[tuple] = set()          # (permit, version, outlet, effluent, substance) we judged
too_few_keys: set[tuple] = set()           # ... and those where every window was too small to assess
for key, g in series.groupby(GROUP, sort=False):
    permit, version, outlet, effluent, substance, statistic, kind, unit_slug = key
    g = g.drop_duplicates(subset=["id"]).sort_values("t").reset_index(drop=True)
    ts = g["t"].tolist()
    vals = g["result_value"].tolist()
    limits = g["limit_value"].tolist()     # per sample: the bound in force in the month it was taken
    seasons = g["season"].tolist()         # '' year-round, else '-{from}{to}' - part of the bound IRI
    undated = bool(g["undated"].any())     # judged against a version the register does not date
    ids = g["id"].tolist()
    n_obs = len(g)
    if not n_obs:
        continue
    cond_key = (permit, version, outlet, effluent, substance)

    fails: list[bool] = []
    details: list[str] = []
    ev_for: list[list[str]] = []          # evidencing observation ids per assessment point
    assessable = False                     # did ANY assessment point have enough data to judge?

    if statistic in ("maximum", "minimum"):
        # PER-SAMPLE: judged on its own, against its own month's bound.
        assessable = True
        for i in range(n_obs):
            bad = vals[i] > limits[i] if statistic == "maximum" else vals[i] < limits[i]
            fails.append(bad)
            details.append(f"{vals[i]:g} {'above' if statistic == 'maximum' else 'below'} "
                           f"the {limits[i]:g} {statistic}")
            ev_for.append([ids[i]] if bad else [])

    elif statistic == "percentile-95":
        # PERIOD: rolling 12 months ending at each sample. Each sample in the window is tested against
        # the limit that applied on ITS date, which is what makes a seasonal percentile assessable.
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
            assessable = True
            over = [j for j in idx if vals[j] > limits[j]]
            bad = len(over) > allowed
            fails.append(bad)
            details.append(f"{len(over)} exceedances of the {limits[i]:g} 95th-percentile limit in the "
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
            assessable = True
            w = [vals[j] for j in idx]
            mean = sum(w) / n
            sd = math.sqrt(sum((x - mean) ** 2 for x in w) / (n - 1))
            lci = mean - t_value(n - 1) * sd / math.sqrt(n)
            bad = lci > limits[i]
            fails.append(bad)
            details.append(f"12-month mean {mean:.2f} to {ts[i]:%Y-%m-%d} (n={n}); lower bound of the "
                           f"90% confidence interval {lci:.2f} exceeds the {limits[i]:g} annual-mean limit")
            # the whole window evidences a mean - every sample in it went into the number
            ev_for.append([ids[j] for j in idx] if bad else [])
    else:
        continue                          # median etc: no assessment defined yet

    (assessed_keys if assessable else too_few_keys).add(cond_key)

    cls = "ShortfallBreach" if statistic == "minimum" else "ExceedanceBreach"
    for a, b in runs(fails):
        breach_id = bid(permit, version, outlet, effluent, substance, statistic,
                        ts[a].strftime("%Y-%m-%dT%H:%M:%S"))
        is_current = (b == n_obs - 1)      # nothing has passed since: the period is still open
        breach_rows.append(dict(
            breach_id=breach_id, permit_ref=permit, version=version,
            outlet=outlet, effluent=effluent, substance=substance,
            statistic=statistic, bound_kind=kind, breach_class=cls,
            limit_value=limits[b], unit_slug=unit_slug,   # the bound the run ended against
            season=seasons[b],
            applicable_from=ts[a].strftime("%Y-%m-%dT%H:%M:%S"),
            applicable_to=None if is_current else ts[b].strftime("%Y-%m-%dT%H:%M:%S"),
            is_current=is_current,
            undated_version=undated,       # the version this was judged against carries no dates
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

# =====================================================================================
# The ledger of what we did NOT judge, and why. See the module header.
# =====================================================================================
# Without this table, every condition above reads the same way as a condition that passed - and 63% of
# them were never examined at all. "No breach found" is what a regulator reads as "compliant", so an
# unexamined condition MUST NOT be silent. Each one is emitted with a machine-readable reason.
sp_by_dp = {(r.permit_ref, r.outlet, r.effluent): r.sp_notation for r in dp_monitoring.itertuples()}
obs_pairs = set(zip(obs.sp_notation, obs.substance))

rows = []
for c in conditions.itertuples():
    key = (c.permit_ref, c.version, c.outlet, c.effluent, c.substance)
    ckey = (c.permit_ref, c.outlet, c.effluent, c.substance)
    sp = sp_by_dp.get((c.permit_ref, c.outlet, c.effluent))
    if key in assessed_keys:
        reason = None
    # AMBIGUOUS PER CONDITION, not per permit: this permit has no dated version AND its versions
    # disagree about THIS limit, so which value applied on the day cannot be known. A sibling condition
    # on the same permit whose versions agree is judged normally.
    elif ckey in ambiguous:
        reason = "ambiguous-version-history"
    elif sp is None:
        reason = "no-sampling-point"
    elif sp in unpublished:
        reason = "sampling-point-unpublished"
    elif (sp, c.substance) not in obs_pairs:
        reason = "no-observations"
    elif key in too_few_keys:
        reason = "too-few-samples"
    # An undated permit is judged against ONE of its (agreeing) versions; the others are superseded
    # duplicates, not unexamined conditions. Do not report them as a gap - they are the same limit.
    elif c.permit_ref in undated_permits and determinate.get(ckey) not in (None, c.version):
        reason = None
    else:
        reason = "no-observations-in-a-dated-window"
    rows.append(dict(permit_ref=c.permit_ref, version=c.version, outlet=c.outlet,
                     effluent=c.effluent, substance=c.substance,
                     substance_label=c.substance_label, sp_notation=sp,
                     assessed=reason is None, reason=reason))
condition_assessment = pd.DataFrame(rows)

REASONS = {
    "ambiguous-version-history":
        "The register dates none of this permit's versions AND the versions DISAGREE about this "
        "particular limit, so which value applied on the day a sample was taken cannot be known. Note "
        "how narrow this is: it is a fact about the LIMIT, not the permit. Where every version states "
        "the SAME bound - which is the overwhelming majority, even on permits with several versions - "
        "there is nothing to choose between, the condition IS assessed, and the judgement is flagged "
        "as resting on an undated version. A permit can have some conditions assessed and others not.",
    "no-sampling-point":
        "The permit register names no sampling point for this effluent. Nothing monitors it, so nothing "
        "can evidence a breach of it.",
    "sampling-point-unpublished":
        "The register names a sampling point, but the Water Quality Archive publishes no data for it. "
        "The point exists; its observations are not open.",
    "no-observations":
        "The sampling point and the determinand are both known and the archive holds no compliance "
        "sample for the pair. Common for the flow, weir-setting and storm-overflow telemetry conditions "
        "the register sets but the archive does not carry here.",
    "no-observations-in-a-dated-window":
        "Compliance samples exist for this determinand at this point, but none of them falls inside a "
        "dated window of this permit version.",
    "too-few-samples":
        "Assessed, but every 12-month window held fewer samples than the method needs (n < 4 for the "
        "95th-percentile look-up table, n < 2 for a mean).",
}
assessment_reasons = pd.DataFrame(
    [dict(slug=k, definition=v) for k, v in REASONS.items()])

# --- Each evidencing observation's sampling point. This is the structural edge the app's breach query
#     joins on (<observation> sosa:hasFeatureOfInterest <sampling-point>), instead of an IRI-prefix
#     STRSTARTS filter the engine cannot key on. The regulation pipeline used to dereference the
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
                 ("observation_sampling_point", observation_sampling_point),
                 ("condition_assessment", condition_assessment),
                 ("assessment_reasons", assessment_reasons)]:
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

# The honest denominator. A breach count means nothing without it.
n_all = len(condition_assessment)
n_ok = int(condition_assessment.assessed.sum())
print(f"\n{'conditions held':>22}: {n_all}")
print(f"{'ASSESSED':>22}: {n_ok}  ({n_ok / n_all:.0%})")
print(f"{'NOT assessed':>22}: {n_all - n_ok}  ({1 - n_ok / n_all:.0%}) - these are NOT 'no breach':")
for reason, n in condition_assessment.reason.value_counts().items():
    print(f"{reason:>42}: {n}")
con.close()
