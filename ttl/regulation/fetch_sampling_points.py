#!/usr/bin/env python3
"""Fetch sampling-point reference data from the EA Water Quality Archive into a cached CSV.

Why this exists
---------------
A sampling point is a thing in the world, not a by-product of the observations we happened to
download. It used to be the latter: every sampling point in the store was materialised from a row
of ``observations_with_permits_and_rules.csv``, so a point existed only if it had a numeric result
that matched a permit rule. That quietly lost real, permitted outlets — three watercress beds whose
every 2020-2026 sample reads "No flow/discharge at sampling point" (a true and useful fact) and one
sewage works whose only samples are a site inspection. It also meant the store could hold no AMBIENT
point at all: rivers, boreholes and investigation points have no permit to join to, so nothing in the
old pipeline could ever have carried them.

So the archive is now the source. This script resolves each sampling point we need straight from the
WQA as ``application/ld+json`` and caches the reference facts - label, geometry in the SOURCE CRS
(EPSG:27700, British National Grid, exactly as published), type and status - into
``sampling_points.csv``, which is committed and read by ``regulation_to_db.py``. Observational
*values* are still NOT stored: they stay federated, pulled live through the app's /observations proxy.

Which points? The union of:

  1. Every sampling point in the catchment observation download (the ambient layer - rivers,
     boreholes, bathing waters, investigation points - alongside the effluent ones).
  2. Every sampling point named as a permit's ``EFF_SAMPLE_POINT`` by a permit that samples at one of
     those points (the permit layer). Some of these are absent from (1) - a permitted outlet we hold
     no observations for is still a monitored outlet, and the register still says where it is sampled.

Re-run only when the catchment or the register extracts change (needs egress to
environment.data.gov.uk); the CSV is committed so the normal build is offline:

    python ttl/regulation/fetch_sampling_points.py
"""

from __future__ import annotations

import csv
import sys
from pathlib import Path

import pandas as pd
import requests

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUT = HERE / "sampling_points.csv"

OBSERVATIONS = ROOT / "raw_datasets" / "poole_harbour_rivers_water_quality_observations_2020_2026_combined.csv"
EFFLUENTS = ROOT / "raw_datasets" / "access_database_csv_files" / "effluents.csv"

WQA = "http://environment.data.gov.uk/water-quality"
HEADERS = {"Accept": "application/ld+json"}
TIMEOUT = 30


def notations() -> list[str]:
    """The sampling points the store needs: the catchment's own, plus those its permits name."""
    obs = pd.read_csv(OBSERVATIONS, low_memory=False)
    catchment = set(obs["samplingPoint.notation"].dropna().astype(str))

    # The register keys a sampling point as REGION + '-' + EFF_SAMPLE_POINT (see link_data.py).
    eff = pd.read_csv(EFFLUENTS, low_memory=False)
    eff = eff[(eff.EA_REGION == "SW") & eff.EFF_SAMPLE_POINT.notna()].copy()
    eff["sp"] = eff.EA_REGION.astype(str) + "-" + eff.EFF_SAMPLE_POINT.astype(str)

    # A permit is IN SCOPE if it samples at one of the catchment's points; we then want every
    # sampling point that permit names, including any the observation download never mentioned.
    scoped = set(eff[eff.sp.isin(catchment)].PERMIT_REF.astype(str))
    permit_points = set(eff[eff.PERMIT_REF.astype(str).isin(scoped)].sp)

    return sorted(catchment | permit_points)


def fetch(notation: str) -> dict | None:
    """Dereference a sampling point as JSON-LD. None if the archive does not know it."""
    r = requests.get(f"{WQA}/sampling-point/{notation}", headers=HEADERS, timeout=TIMEOUT)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    members = r.json().get("member", [])
    return members[0] if members else None


def row(notation: str, node: dict) -> dict:
    """Reference facts, in the encoding the archive published them in."""
    # The WQA nests type and status as blank-node skos:Concepts (no resolvable IRI of their own),
    # so we keep the notation + label and the store mints its own concept IRI from the notation.
    sp_type = node.get("samplingPointType") or {}
    status = node.get("samplingPointStatus") or {}
    return {
        "sp_notation": notation,
        "pref_label": node.get("prefLabel") or notation,
        # Source CRS, source numbers: 'POINT(384750 94670) <...EPSG/0/27700>'. Kept verbatim - the
        # whole point of app/points.html is that the published coordinate is what a consumer gets.
        "wkt": (node.get("geometry") or {}).get("asWKT", ""),
        "type_notation": sp_type.get("notation", ""),
        "type_label": sp_type.get("prefLabel", ""),
        "status_label": status.get("prefLabel", ""),
    }


def main() -> int:
    wanted = notations()
    print(f"{len(wanted)} sampling points to resolve", file=sys.stderr)

    rows, missing = [], []
    for i, n in enumerate(wanted, 1):
        node = fetch(n)
        if node is None:
            missing.append(n)
            continue
        rows.append(row(n, node))
        if i % 25 == 0:
            print(f"  {i}/{len(wanted)}", file=sys.stderr)

    with OUT.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    no_geom = [r["sp_notation"] for r in rows if not r["wkt"]]
    print(f"wrote {len(rows)} -> {OUT.relative_to(ROOT)}", file=sys.stderr)
    if no_geom:
        print(f"  {len(no_geom)} without geometry: {', '.join(no_geom)}", file=sys.stderr)
    if missing:
        print(f"  {len(missing)} unknown to the archive: {', '.join(missing)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
