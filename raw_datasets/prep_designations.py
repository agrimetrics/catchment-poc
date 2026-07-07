"""Clip the three national conservation-designation layers (SSSI, SAC, SPA) down to the Poole
Harbour catchment and write small, browser-friendly GeoJSON the app serves statically.

For each layer we keep only sites intersecting the catchment (buffered ~3 km so edge sites show),
dissolve to one feature per site name, simplify the geometry (~30 m) and keep just the name. Output
goes to app/{sssi,sac,spa}.geojson. Re-run after changing the raw datasets:

    python raw_datasets/prep_designations.py
"""

from pathlib import Path

import geopandas as gpd

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "raw_datasets"
APP = ROOT / "app"

# Buffer the catchment so conservation sites straddling the boundary are kept whole.
catchment = gpd.read_file(RAW / "poole_harbour_rivers_operational_catchment.geojson").to_crs(4326)
clip = catchment.union_all().buffer(0.03)  # ~3 km in degrees at this latitude

LAYERS = [
    ("Sites_of_Special_Scientific_Interest_England.geojson", "name", "sssi.geojson"),
    ("Special_Areas_of_Conservation_England.geojson", "sac_name", "sac.geojson"),
    ("Special_Protection_Areas_England.geojson", "spa_name", "spa.geojson"),
]

for fname, namecol, out in LAYERS:
    g = gpd.read_file(RAW / fname).to_crs(4326)
    g = g[g.intersects(clip)].copy()
    g["name"] = g[namecol]
    g = g.dissolve(by="name", as_index=False)[["name", "geometry"]]  # one feature per named site
    g["geometry"] = g.geometry.simplify(0.0003)                       # ~30 m, keeps shapes legible
    (APP / out).unlink(missing_ok=True)
    g.to_file(APP / out, driver="GeoJSON")
    print(f"{out}: {len(g)} sites, {(APP / out).stat().st_size // 1024} KB")
