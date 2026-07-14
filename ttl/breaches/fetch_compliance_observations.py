#!/usr/bin/env python3
"""Fetch the COMPLIANCE observations needed to judge the in-scope permits, from the EA Water
Quality Archive, and cache them to compliance_observations.csv.

Why this exists, and why it does not reuse the bulk observations file
--------------------------------------------------------------------
`link_data.py` builds its observation set from the pre-downloaded Poole Harbour extract, and does
two things to it that make it unusable for a compliance assessment:

  1. It DROPS every non-numeric result. Across this catchment that is 46% of all results, and the
     losses are not random - they are the LOW ones. 70.7% of BOD results, 47.1% of ammonia and
     33.6% of suspended solids are "less than" non-detects ("<5"). The EA's rule is to record a
     "less than" result AS ZERO, not to discard it. Dropping them inflates every mean and, worse,
     shrinks the sample count `n` - which tightens the 95-percentile look-up table and manufactures
     percentile failures that do not exist.
  2. It does not distinguish compliance samples from ambient river monitoring. The archive mixes
     them; a permit is judged only on its own compliance samples.

So this script goes back to the source with `complianceOnly=true` (verified: it drops an ambient
river point from 149 observations to 0, and leaves a sewage-effluent point untouched) and keeps the
result VERBATIM, qualifier and all. breaches_to_db.py does the interpreting.

Scope: only the (sampling point, determinand) pairs that an in-scope permit actually has a condition
for, AT THE OUTLET THAT POINT MONITORS. Read from regulation.duckdb, so run that pipeline first.

KEEP THIS IN STEP WITH THE REGISTER. The scope is derived, so it MOVES when the register-sourced
tables move - and this cache is committed, so it does not move with it unless someone re-runs this.
That has bitten once already: when discharge points were re-sourced from the permit register (rather
than existing only if they had a numeric observation), the store's monitored sampling points grew from
54 to 69 and this cache stayed at 54. The 15 new points were assessed against nothing - and an
unassessed point does not read as "unknown", it reads as NO BREACH. Among them was Blackheath's storm
overflow, a sewage discharge point with live WINEP actions. If you change what is in scope in
ttl/regulation, RE-RUN THIS, or the breach count is silently an undercount.

    python ttl/breaches/fetch_compliance_observations.py            # incremental; keeps the cache
    python ttl/breaches/fetch_compliance_observations.py --refresh  # discard and re-fetch

Needs outbound egress to environment.data.gov.uk. The CSV it writes is committed, so the breach
build itself runs offline.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

import duckdb
import pandas as pd
import requests

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
REG_DB = ROOT / "ttl" / "regulation" / "regulation.duckdb"
OUT = HERE / "compliance_observations.csv"
# The record of what was ASKED, which the observation CSV cannot hold: a pair the archive has nothing
# for contributes no rows, so it is indistinguishable there from a pair nobody ever fetched. Those two
# states carry opposite meanings downstream - "the archive holds nothing" is a finding, "we never
# asked" is a stale cache - and breaches_to_db.py refuses to run without this file to tell them apart.
MANIFEST = HERE / "compliance_fetch_manifest.csv"

BASE = "https://environment.data.gov.uk/water-quality/sampling-point"
PAGE = 250                      # the archive rejects limit > 250
HEADERS = {"Accept": "application/x-jsonlines"}
KEEP = ["id", "samplingPoint.notation", "phenomenonTime", "samplingPurpose",
        "sampleMaterialType", "determinand.notation", "result", "unit"]


def pairs_in_scope() -> list[tuple[str, str]]:
    """(sampling point, determinand) for every condition an in-scope permit holds, at the point that
    monitors THE EFFLUENT THE CONDITION GOVERNS.

    The join is on (permit, outlet, effluent), not on permit alone. That matters now conditions are
    keyed at the register's own grain: permit 042116 limits BOD to 15 mg/l at effluent 1 and 25 mg/l
    at effluent 2, sampled at two different points. A permit-level join would ask the archive for
    every substance at every one of the permit's points, and hand the assessment a sample from the
    wrong outlet's monitoring point.

    Sampling points the archive does not publish are excluded - there is nothing to fetch. Those
    outlets are NOT ASSESSABLE, which breaches_to_db.py records explicitly rather than letting them
    pass for clean.
    """
    if not REG_DB.exists():
        sys.exit(f"ABORT: {REG_DB} missing - run ttl/regulation/regulation_to_db.py first.")
    con = duckdb.connect(str(REG_DB), read_only=True)
    rows = con.execute("""
        SELECT DISTINCT m.sp_notation, c.substance
        FROM conditions c
        JOIN discharge_point_monitoring m
          ON m.permit_ref = c.permit_ref AND m.outlet = c.outlet AND m.effluent = c.effluent
        WHERE m.sp_notation IS NOT NULL AND m.sp_notation <> ''
          AND m.sp_notation NOT IN (SELECT sp_notation FROM unpublished_sampling_points)
        ORDER BY 1, 2
    """).fetchall()
    con.close()
    return [(r[0], r[1]) for r in rows]


def fetch(sp: str, determinand: str) -> list[dict]:
    """Every COMPLIANCE observation for one (sampling point, determinand), following skip/limit
    pagination to exhaustion. complianceOnly=true is the whole point: it is the archive's own
    definition of a compliance sample, so we are not guessing at samplingPurpose strings."""
    out, skip = [], 0
    while True:
        url = (f"{BASE}/{sp}/observation"
               f"?skip={skip}&limit={PAGE}&determinand={determinand}&complianceOnly=true")
        r = requests.get(url, headers=HEADERS, timeout=60)
        r.raise_for_status()
        lines = [ln for ln in r.text.splitlines() if ln.strip()]
        if not lines:
            break
        import json
        for ln in lines:
            o = json.loads(ln)
            out.append({
                # The archive serves https:; the store's convention is http:. Normalise on the way
                # in so breach evidence IRIs match the sampling-point IRIs the regulation graph mints.
                "id": str(o.get("id", "")).replace("https://", "http://"),
                "samplingPoint.notation": (o.get("samplingPoint") or {}).get("notation"),
                "phenomenonTime": o.get("phenomenonTime"),
                "samplingPurpose": o.get("samplingPurpose"),
                "sampleMaterialType": o.get("sampleMaterialType"),
                "determinand.notation": (o.get("determinand") or {}).get("notation"),
                "result": o.get("result"),          # VERBATIM - "<5" stays "<5"
                "unit": o.get("unit"),
            })
        if len(lines) < PAGE:
            break
        skip += PAGE
    return out


def main() -> None:
    refresh = "--refresh" in sys.argv
    todo = pairs_in_scope()
    have: set[tuple[str, str]] = set()
    fetched: dict[tuple[str, str], int] = {}         # every pair ASKED -> how many came back
    rows: list[dict] = []

    if OUT.exists() and not refresh:
        prev = pd.read_csv(OUT, dtype=str)
        rows = prev.to_dict("records")
        if MANIFEST.exists():
            man = pd.read_csv(MANIFEST, dtype={"samplingPoint.notation": str,
                                               "determinand.notation": str,
                                               "n_observations": int})
            fetched = {(r[0], r[1]): r[2] for r in man.itertuples(index=False)}
        else:
            # Migration for a cache written before the manifest existed. A pair with rows was
            # demonstrably asked; a pair that returned zero left no trace and cannot be recovered from
            # the CSV, so it is simply absent here and gets re-fetched once. Self-healing, not silent.
            fetched = {p: n for p, n in
                       prev.groupby(["samplingPoint.notation", "determinand.notation"]).size().items()}
            print(f"no manifest: seeding it from {len(fetched)} pairs that have rows in the cache; "
                  "any pair the archive returned zero for will be re-fetched once")
        have = set(fetched)
        print(f"cache: {len(prev)} observations over {len(have)} pairs (use --refresh to discard)")

    missing = [p for p in todo if p not in have]
    print(f"{len(todo)} pairs in scope, {len(missing)} to fetch")

    for i, (sp, det) in enumerate(missing, 1):
        try:
            got = fetch(sp, det)
        except requests.RequestException as e:
            # NOT recorded in the manifest: we do not know what the archive holds for this pair, so it
            # must stay "never asked" and be retried, never pass for "the archive holds nothing".
            print(f"  [{i}/{len(missing)}] {sp} {det}: FAILED ({e}) - skipped, re-run to retry")
            continue
        rows.extend(got)
        fetched[(sp, det)] = len(got)                # including len(got) == 0: asked, archive was empty
        print(f"  [{i}/{len(missing)}] {sp} {det}: {len(got)}")
        time.sleep(0.1)                              # be kind to the archive

    df = pd.DataFrame(rows, columns=KEEP).drop_duplicates(subset=["id"])
    df.to_csv(OUT, index=False)

    man = pd.DataFrame(
        [{"samplingPoint.notation": sp, "determinand.notation": det, "n_observations": n}
         for (sp, det), n in sorted(fetched.items())])
    man.to_csv(MANIFEST, index=False)

    still_missing = [p for p in todo if p not in fetched]
    empty = sum(1 for n in fetched.values() if n == 0)
    print(f"\nmanifest -> {MANIFEST.relative_to(ROOT)}")
    print(f"  pairs asked        : {len(fetched)} of {len(todo)} in scope")
    print(f"  archive held none  : {empty}  (a finding - NOT a missing fetch)")
    if still_missing:
        print(f"  NEVER ASKED        : {len(still_missing)}  <- re-run to retry; "
              "breaches_to_db.py will ABORT until this is 0")

    # What the assessment is about to be handed - the non-detect share is the headline, because it
    # is exactly what the old pipeline was throwing away.
    num = pd.to_numeric(df["result"], errors="coerce")
    nd = df["result"].astype(str).str.startswith("<")
    noflow = df["result"].astype(str).str.startswith("No flow")
    print(f"\n{len(df)} compliance observations -> {OUT.relative_to(ROOT)}")
    print(f"  numeric            : {num.notna().sum()}")
    print(f"  '<' non-detects    : {nd.sum()}  (recorded as ZERO by the EA, not dropped)")
    print(f"  no flow/discharge  : {noflow.sum()}  (excluded from assessment)")
    print(f"  other non-numeric  : {len(df) - num.notna().sum() - nd.sum() - noflow.sum()}")


if __name__ == "__main__":
    main()
