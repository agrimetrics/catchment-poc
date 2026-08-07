"""Sweep the catchment's sampling points for unusual-weather waiver observations.

The Water Quality Archive records a waiver as its own observation (determinand 4838, 'Unusual Weather
Waiver (WRA)', with a coded Granted / Not Granted result) rather than as an attribute of the results it
excuses. Determinand 4448 ('Exceptional Circumstances OSM') is its sibling. Neither reaches the bulk
download or the complianceOnly=true fetch, so they have to be swept per sampling point.

334 requests, so this is committed output rather than an inline notebook cell:

    python notebooks/sweep_waivers.py        # -> notebooks/data/weather_waivers.csv

Note the archive caps `limit` at 250 and returns 422 (not a clamp) above it.
"""
import json
import time
import urllib.request
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
POINTS = ROOT / "ttl" / "regulation" / "sampling_points.csv"
OUT = ROOT / "notebooks" / "data" / "weather_waivers.csv"
WQA = "https://environment.data.gov.uk/water-quality/sampling-point"
DETERMINANDS = {"4838": "Unusual Weather Waiver (WRA)",
                "4448": "Exceptional Circumstances OSM (not S87 or unusual weather)"}
LIMIT = 250                                  # the archive's maximum; 422 above it


def observations(point: str, determinand: str) -> list[dict]:
    url = f"{WQA}/{point}/observation?determinand={determinand}&limit={LIMIT}"
    req = urllib.request.Request(url, headers={"Accept": "application/ld+json"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=45) as r:
                return json.load(r).get("member", [])
        except Exception:
            if attempt == 2:
                raise
            time.sleep(1 + attempt)
    return []


def main() -> None:
    points = pd.read_csv(POINTS, dtype=str).sp_notation.tolist()
    rows, errors = [], []
    for point in points:
        for determinand, label in DETERMINANDS.items():
            try:
                found = observations(point, determinand)
            except Exception as exc:
                errors.append((point, determinand, str(exc)[:60]))
                continue
            for o in found:
                rows.append({"sampling_point": point,
                             "determinand": determinand,
                             "label": label,
                             "date": o["phenomenonTime"][:10],
                             "sample": o["hasSample"]["id"].rsplit("/", 1)[-1],
                             "result": o.get("hasSimpleResult")})
            time.sleep(0.1)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(rows, columns=["sampling_point", "determinand", "label", "date", "sample",
                                "result"]).to_csv(OUT, index=False)
    print(f"points swept: {len(points)}   observations found: {len(rows)}   failed requests: {len(errors)}")
    if errors:
        print("failures:", errors[:5])


if __name__ == "__main__":
    main()
