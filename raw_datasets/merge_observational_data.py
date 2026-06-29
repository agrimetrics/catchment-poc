import pandas as pd
from pathlib import Path
import geopandas as gpd

#This script must be run within the raw_datasets directory, it takes all of the csv files within the specified folder and concatenates them.
#This script also adds some extra columns for convenience

folder = Path("poole_harbour_rivers_water_quality_observations_2020_2026")
# read all csv files in folder
files = list(folder.glob("*.csv"))
df_list = [pd.read_csv(f) for f in files]
obs = pd.concat(df_list, ignore_index=True)

# Load observations and convert lat/long into eastings/northings
gdf = gpd.GeoDataFrame(obs,geometry=gpd.points_from_xy(obs["samplingPoint.longitude"],obs["samplingPoint.latitude"]),crs="EPSG:4326")
gdf = gdf.to_crs("EPSG:27700")
gdf["samplingPoint.easting"] = gdf.geometry.x
gdf["samplingPoint.northing"] = gdf.geometry.y

# Add month as a column in order to filter out rows where the MONTH range for the permit does not apply to the observation phenomenonTime
gdf["phenomenonTime"] = pd.to_datetime(gdf["phenomenonTime"])
gdf["observation.month"] = gdf["phenomenonTime"].dt.month

cols_to_keep = [
    "id",
    "samplingPoint.notation",
    "samplingPoint.prefLabel",
    "samplingPoint.latitude",
    "samplingPoint.longitude",
    "samplingPoint.easting",
    "samplingPoint.northing",
    "samplingPoint.region",
    "samplingPoint.area",
    "samplingPoint.subArea",
    "samplingPoint.samplingPointStatus",
    "samplingPoint.samplingPointType",
    "phenomenonTime",
    "observation.month",
    "samplingPurpose",
    "sampleMaterialType",
    "determinand.notation",
    "determinand.prefLabel",
    "result",
    "unit"
]

gdf = gdf[cols_to_keep]
gdf.to_csv("poole_harbour_rivers_water_quality_observations_2020_2026_combined.csv", index=False)
