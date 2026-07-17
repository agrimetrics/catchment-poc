import geopandas as gpd
import pandas as pd
from shapely.geometry import Point
from pathlib import Path
import csv

# This script takes the large consents_all csv dump from the access database,
# and filters the rows to only the discharge points within the operational catchment of Poole Harbour

HERE = Path(__file__).resolve()
ROOT = HERE.parent

# --- National Grid Reference -> Easting/Northing (EPSG:27700). Decodes an OSGB alphanumeric grid
#     ref (e.g. 'SY7400087100') into metres from the British National Grid false origin. The two
#     letters pick a 100km square (the grid skips 'I'); the digits split in half into easting then
#     northing within that square, padded to 5 figures (metres). Registered as duckdb scalar UDFs. ---
def _ngr_to_en(ngr):
    if ngr is None:
        return None
    s = str(ngr).replace(" ", "").upper()
    if len(s) < 2 or not s[0].isalpha() or not s[1].isalpha():
        return None
    digits = s[2:]
    if not digits.isdigit() or len(digits) == 0 or len(digits) % 2 != 0:
        return None
    l1 = ord(s[0]) - ord("A")
    l2 = ord(s[1]) - ord("A")
    if l1 > 7:                                   # OSGB grid omits the letter 'I'
        l1 -= 1
    if l2 > 7:
        l2 -= 1
    e100 = ((l1 - 2) % 5) * 5 + (l2 % 5)
    n100 = (19 - (l1 // 5) * 5) - (l2 // 5)
    if not (0 <= e100 <= 6 and 0 <= n100 <= 12):  # outside the National Grid
        return None
    half = len(digits) // 2
    easting = e100 * 100000 + int((digits[:half] + "00000")[:5])
    northing = n100 * 100000 + int((digits[half:] + "00000")[:5])
    return [easting, northing]

# Read CSV (this reads the large consents_all table which is not part of this repo since its larger than 100mb)
df = pd.read_csv(ROOT / "consents_all.csv")

# Convert NGR to coordinates
coords = df["DISCHARGE_NGR"].apply(_ngr_to_en)

# Create geometry
df["geometry"] = [
    Point(xy[0], xy[1]) if xy is not None else None
    for xy in coords
]

# Convert to GeoDataFrame
gdf = gpd.GeoDataFrame(
    df,
    geometry="geometry",
    crs="EPSG:27700"
)

# Remove failed NGR conversions
gdf = gdf.dropna(subset=["geometry"])


# Read catchment boundary
oc = gpd.read_file(ROOT / "../poole_harbour_rivers_operational_catchment.geojson")

# Match CRS
oc = oc.to_crs(gdf.crs)

# Dissolve boundary into one polygon
oc_dissolved = oc.dissolve()

# Keep only discharge sites inside boundary
original_cols = gdf.columns

gdf_inside = gpd.sjoin(
    gdf,
    oc_dissolved,
    predicate="within",
    how="inner"
)

# Remove spatial join columns
gdf_inside = gdf_inside[original_cols]

# Save filtered points
gdf_inside.to_csv(ROOT / "consents_all_poole_harbour.csv", index=False, quoting=csv.QUOTE_ALL)