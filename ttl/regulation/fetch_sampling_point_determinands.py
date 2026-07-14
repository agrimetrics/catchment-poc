#!/usr/bin/env python3
"""Sweep the EA Water Quality Archive for WHICH DETERMINANDS each sampling point actually has a
series for, and cache it to sampling_point_determinands.csv.

Why this exists
---------------
The measured (ambient) view lets you pick a determinand. Until now it drew all 161 sampling points
whatever you picked, and you found out which ones had a series for it by clicking them one at a time
and reading "No observations for this substance at this sampling point". This file is the edge that
lets the view filter: (sampling point) -> (determinand it is actually sampled for).

Why NOT from the catchment extract
----------------------------------
The obvious source is raw_datasets/poole_harbour_rivers_..._combined.csv, which already pairs
samplingPoint.notation with determinand.notation and costs nothing to read. It is WRONG for this job,
and wrong in the direction that does damage. That extract covers 149 sampling points; the store holds
161. Ten of the twelve it omits have live observations in the archive right now (4 to 12 each,
verified). Filtering the map off the extract would therefore delete ten points that ARE sampled, and
delete them silently - the map would simply show fewer dots, and nobody would know to ask why.

That is the same failure the breaches pipeline shipped twice: an absence in a cached extract read as
an absence in the world. So this goes to the archive itself - the same source the chart plots from,
so what the map filters on and what the chart draws can never disagree.

How
---
There is no determinands-at-a-point endpoint (checked: /determinand and /measurement both 404), so
each point is swept with an UNFILTERED observation walk and the determinands are read off what comes
back. One walk per point rather than one request per (point, determinand) pair: 161 walks instead of
161 x 12 existence probes, and it also picks up determinands outside the current dropdown, so the
table stays right if the monitored scheme grows.

    python ttl/regulation/fetch_sampling_point_determinands.py            # incremental
    python ttl/regulation/fetch_sampling_point_determinands.py --refresh  # discard and re-sweep

Writes TWO files, and needs both for the same reason the breach fetcher does:

  sampling_point_determinands.csv   the edges          (sp_notation, determinand, n_observations)
  sampling_point_sweep.csv          what was ASKED     (sp_notation, n_observations, n_determinands)

A point the archive holds NOTHING for contributes no edge rows, which makes it indistinguishable in
the edges file from a point nobody ever swept. Those two mean opposite things - "nothing is measured
here" is a finding, "we never looked" is a stale cache - so the sweep file records every point asked,
including the empty ones, and regulation_to_db.py ABORTS if a sampling point in the register is
missing from it. Without that gate a register that grows without a re-sweep silently hides its new
points from the map, which is exactly the bug this file exists to avoid causing.

Needs outbound egress to environment.data.gov.uk. Both CSVs are committed, so the normal build is
offline. Re-run when the sampling-point set changes.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import duckdb
import pandas as pd
import requests

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
REG_DB = HERE / "regulation.duckdb"
SP_CSV = HERE / "sampling_points.csv"
EDGES = HERE / "sampling_point_determinands.csv"
SWEEP = HERE / "sampling_point_sweep.csv"

BASE = "https://environment.data.gov.uk/water-quality/sampling-point"
PAGE = 250                      # the archive rejects limit > 250
HEADERS = {"Accept": "application/x-jsonlines"}


def sampling_points() -> list[str]:
    """Every sampling point the store holds. Read from sampling_points.csv rather than the duckdb, so
    this can run before regulation_to_db.py (which is the build step that will demand its output)."""
    if not SP_CSV.exists():
        sys.exit(f"ABORT: {SP_CSV} missing - run ttl/regulation/fetch_sampling_points.py first.")
    df = pd.read_csv(SP_CSV, dtype=str)
    return sorted({s for s in df["sp_notation"] if isinstance(s, str) and s})


def sweep(sp: str) -> dict[str, int]:
    """Every determinand observed at one sampling point -> how many observations, following skip/limit
    pagination to exhaustion. Unfiltered: complianceOnly is NOT set, because this view is the ambient
    world - a river's nitrate series is not a compliance sample and must not be excluded like one."""
    counts: dict[str, int] = {}
    skip = 0
    while True:
        url = f"{BASE}/{sp}/observation?skip={skip}&limit={PAGE}"
        r = requests.get(url, headers=HEADERS, timeout=60)
        r.raise_for_status()
        lines = [ln for ln in r.text.splitlines() if ln.strip()]
        for ln in lines:
            det = (json.loads(ln).get("determinand") or {}).get("notation")
            if det:
                det = str(det).zfill(4)     # the store keys determinands 4-wide; the archive does not
                counts[det] = counts.get(det, 0) + 1
        if len(lines) < PAGE:
            break
        skip += PAGE
    return counts


def write_out(swept: dict[str, dict[str, int]]) -> pd.DataFrame:
    """Both files, always together. The sweep record is what lets a reader tell a point with no edges
    apart from a point nobody asked about, so an edges file without its sweep record is worse than
    useless - it is the ambiguity this script exists to remove."""
    edges = pd.DataFrame(
        [{"sp_notation": sp, "determinand": det, "n_observations": n}
         for sp, counts in sorted(swept.items()) for det, n in sorted(counts.items())],
        columns=["sp_notation", "determinand", "n_observations"])
    edges.to_csv(EDGES, index=False)
    pd.DataFrame(
        [{"sp_notation": sp, "n_observations": sum(counts.values()), "n_determinands": len(counts)}
         for sp, counts in sorted(swept.items())],
        columns=["sp_notation", "n_observations", "n_determinands"]).to_csv(SWEEP, index=False)
    return edges


def main() -> None:
    refresh = "--refresh" in sys.argv
    todo = sampling_points()
    swept: dict[str, dict[str, int]] = {}

    if SWEEP.exists() and EDGES.exists() and not refresh:
        prev_sweep = pd.read_csv(SWEEP, dtype={"sp_notation": str})
        prev_edges = pd.read_csv(EDGES, dtype={"sp_notation": str, "determinand": str})
        for sp in prev_sweep["sp_notation"]:
            swept[sp] = {}
        for r in prev_edges.itertuples(index=False):
            swept.setdefault(r.sp_notation, {})[r.determinand] = int(r.n_observations)
        print(f"cache: {len(swept)} points already swept (use --refresh to discard)")

    missing = [sp for sp in todo if sp not in swept]
    print(f"{len(todo)} sampling points in the store, {len(missing)} to sweep")

    for i, sp in enumerate(missing, 1):
        try:
            counts = sweep(sp)
        except requests.RequestException as e:
            # NOT recorded: we do not know what the archive holds for this point, so it must stay
            # "never swept" and be retried - never pass for "nothing is measured here".
            print(f"  [{i}/{len(missing)}] {sp}: FAILED ({e}) - skipped, re-run to retry")
            continue
        swept[sp] = counts                  # including {}: swept, archive held nothing
        n = sum(counts.values())
        print(f"  [{i}/{len(missing)}] {sp}: {n} observations over {len(counts)} determinands")
        # Checkpoint. A full sweep walks every observation the archive holds for 161 points and takes
        # long enough that something WILL interrupt it - and the pair of files is the resume state, so
        # writing only at the end means an interrupted sweep starts from nothing every time. Both files
        # are written together, because the sweep record is what makes the edges file readable.
        if i % 10 == 0:
            write_out(swept)
        time.sleep(0.1)                     # be kind to the archive

    edges = write_out(swept)

    never = [sp for sp in todo if sp not in swept]
    empty = sum(1 for c in swept.values() if not c)
    print(f"\n{len(edges)} (point, determinand) edges -> {EDGES.relative_to(ROOT)}")
    print(f"sweep record -> {SWEEP.relative_to(ROOT)}")
    print(f"  points swept       : {len(swept)} of {len(todo)} in the store")
    print(f"  archive held none  : {empty}  (a finding - NOT a missing sweep)")
    if never:
        print(f"  NEVER SWEPT        : {len(never)}  <- re-run to retry; "
              "regulation_to_db.py will ABORT until this is 0")


if __name__ == "__main__":
    main()
