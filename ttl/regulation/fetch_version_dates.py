"""Fetch permit-version effective/revocation dates from the EA public register.

The regulation graph knows each permit version's LIMIT values but not when each version
was in force - that date is not in any CSV we have (consents_active.csv keeps only the
current version). The public register does expose it, one registration per version:

    https://environment.data.gov.uk/public-register/water-discharges/registration/SW-{permit:06d}-{version:03d}.json
        -> { items: [ { effectiveDate, revocationDate, ... } ] }

This script resolves every (numeric) permit version in the Poole Harbour dataset to its
[effectiveDate, revocationDate] window and caches the result in a committed CSV, so the
pipeline never depends on the register at build time and the ~120 calls happen once.

    python ttl/regulation/fetch_version_dates.py            # fills gaps only
    python ttl/regulation/fetch_version_dates.py --refresh  # re-fetch everything

Non-numeric / EPR permit refs (e.g. EPRYP3399VF) don't fit the SW-nnnnnn-nnn scheme and
are skipped - they simply won't get a dated step line.
"""

from __future__ import annotations

import csv
import json
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SRC_CSV = ROOT / "output_data" / "observations_with_permits_and_rules.csv"
OUT_CSV = HERE / "permit_version_dates.csv"
REG = "https://environment.data.gov.uk/public-register/water-discharges/registration"


def permit_versions() -> set[tuple[str, str]]:
    """Distinct (PERMIT_REF, VERSION) with a numeric permit ref, from the source CSV."""
    pairs: set[tuple[str, str]] = set()
    with open(SRC_CSV, newline="") as f:
        for row in csv.DictReader(f):
            p, v = row["PERMIT_REF"], row["VERSION"]
            if p and v and p.isdigit():
                pairs.add((p, v))
    return pairs


def fetch_one(pair: tuple[str, str]) -> dict | None:
    permit, version = pair
    url = f"{REG}/SW-{int(permit):06d}-{int(version):03d}.json"
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            items = json.loads(resp.read().decode("utf-8")).get("items", [])
    except urllib.error.HTTPError as e:
        if e.code == 404:  # version not on the register
            return {"permit_ref": permit, "version": version, "effective_date": "", "revocation_date": ""}
        print(f"  ! {permit}/{version}: HTTP {e.code}", file=sys.stderr)
        return None
    except Exception as e:  # noqa: BLE001 - transient network, retry next run
        print(f"  ! {permit}/{version}: {e}", file=sys.stderr)
        return None
    item = items[0] if items else {}
    return {
        "permit_ref": permit,
        "version": version,
        "effective_date": item.get("effectiveDate", "") or "",
        "revocation_date": item.get("revocationDate", "") or "",
    }


def load_existing() -> dict[tuple[str, str], dict]:
    if not OUT_CSV.exists():
        return {}
    with open(OUT_CSV, newline="") as f:
        return {(r["permit_ref"], r["version"]): r for r in csv.DictReader(f)}


def main() -> None:
    refresh = "--refresh" in sys.argv
    want = permit_versions()
    have = {} if refresh else load_existing()
    todo = sorted(want - set(have))
    print(f"{len(want)} numeric permit-versions; {len(have)} cached; fetching {len(todo)}")

    fetched: dict[tuple[str, str], dict] = {}
    if todo:
        with ThreadPoolExecutor(max_workers=8) as pool:
            for row in pool.map(fetch_one, todo):
                if row:
                    fetched[(row["permit_ref"], row["version"])] = row

    rows = {**have, **fetched}
    ordered = sorted(rows.values(), key=lambda r: (int(r["permit_ref"]), int(r["version"])))
    with open(OUT_CSV, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["permit_ref", "version", "effective_date", "revocation_date"])
        w.writeheader()
        w.writerows(ordered)

    dated = sum(1 for r in ordered if r["effective_date"])
    print(f"wrote {OUT_CSV.relative_to(ROOT)}: {len(ordered)} rows, {dated} with an effective date")


if __name__ == "__main__":
    main()
