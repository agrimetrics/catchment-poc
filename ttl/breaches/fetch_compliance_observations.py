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
for - 175 pairs over 54 sampling points. Read from regulation.duckdb, so run that pipeline first.

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

BASE = "https://environment.data.gov.uk/water-quality/sampling-point"
PAGE = 250                      # the archive rejects limit > 250
HEADERS = {"Accept": "application/x-jsonlines"}
KEEP = ["id", "samplingPoint.notation", "phenomenonTime", "samplingPurpose",
        "sampleMaterialType", "determinand.notation", "result", "unit"]


def pairs_in_scope() -> list[tuple[str, str]]:
    """(sampling point, determinand) for every condition an in-scope permit holds at a point it is
    actually monitored at. A permit with no monitored sampling point cannot be judged at all."""
    if not REG_DB.exists():
        sys.exit(f"ABORT: {REG_DB} missing - run ttl/regulation/regulation_to_db.py first.")
    con = duckdb.connect(str(REG_DB), read_only=True)
    rows = con.execute("""
        SELECT DISTINCT m.sp_notation, c.substance
        FROM conditions c
        JOIN discharge_point_monitoring m ON m.permit_ref = c.permit_ref
        WHERE m.sp_notation IS NOT NULL AND m.sp_notation <> ''
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
                # in so breach evidence IRIs match the observations enrich_sampling_points captured.
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
    rows: list[dict] = []

    if OUT.exists() and not refresh:
        prev = pd.read_csv(OUT, dtype=str)
        rows = prev.to_dict("records")
        have = set(zip(prev["samplingPoint.notation"], prev["determinand.notation"]))
        print(f"cache: {len(prev)} observations over {len(have)} pairs (use --refresh to discard)")

    missing = [p for p in todo if p not in have]
    print(f"{len(todo)} pairs in scope, {len(missing)} to fetch")

    for i, (sp, det) in enumerate(missing, 1):
        try:
            got = fetch(sp, det)
        except requests.RequestException as e:
            print(f"  [{i}/{len(missing)}] {sp} {det}: FAILED ({e}) - skipped, re-run to retry")
            continue
        rows.extend(got)
        print(f"  [{i}/{len(missing)}] {sp} {det}: {len(got)}")
        time.sleep(0.1)                              # be kind to the archive

    df = pd.DataFrame(rows, columns=KEEP).drop_duplicates(subset=["id"])
    df.to_csv(OUT, index=False)

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
