import pandas as pd
import geopandas as gpd
import bng
from scipy.spatial import cKDTree

# Add easting/northing to observational data
obs_df = pd.read_csv("raw_datasets/poole_harbour_rivers_observations_2026.csv")
obs_df=obs_df[["samplingPoint.notation", "samplingPoint.prefLabel", "samplingPoint.longitude", "samplingPoint.latitude"]]
observations_df = gpd.GeoDataFrame(
    obs_df,
    geometry=gpd.points_from_xy(obs_df["samplingPoint.longitude"], obs_df["samplingPoint.latitude"]),
    crs="EPSG:4326"
)
observations_df = observations_df.to_crs("EPSG:27700")
observations_df["samplingPoint.easting"] = observations_df.geometry.x
observations_df["samplingPoint.northing"] = observations_df.geometry.y
observations_df=observations_df[["samplingPoint.notation", "samplingPoint.prefLabel", "samplingPoint.easting", "samplingPoint.northing"]]
observations_df = observations_df.drop_duplicates(subset=["samplingPoint.notation"], keep="first")
print(observations_df.head())

# Add easting/northing to discharge location data
dis_df = pd.read_csv("raw_datasets/consents_active.csv")
dis_df["DISCHARGE_EASTING"] = dis_df["DISCHARGE_NGR"].apply(lambda x: bng.to_osgb36(x)[0])
dis_df["DISCHARGE_NORTHING"] = dis_df["DISCHARGE_NGR"].apply(lambda x: bng.to_osgb36(x)[1])
dis_df = dis_df[["DISCHARGE_SITE_NAME","DISCHARGE_EASTING", "DISCHARGE_NORTHING", "PERMIT_NUMBER", "PERMIT_VERSION"]]
print(dis_df.head())

# Build tree
dp_coords = dis_df[['DISCHARGE_EASTING', 'DISCHARGE_NORTHING']].to_numpy()
tree = cKDTree(dp_coords)

radius = 100


obs_coords = observations_df[
    ["samplingPoint.easting", "samplingPoint.northing"]
].to_numpy()

# matches is a list of lists, each inner list corresponds to a sampling point easting/northing pair, the list associated are the row numbers in the dis_df
matches = tree.query_ball_point(obs_coords, r=radius)

permit_details = []

# For each sampling point, create a dataframe which contains its closely located discharge points
for idx_list in matches:

    # Create a subset dataframe of dis_df based on the matching
    permits_df = (
        dis_df.iloc[idx_list]
        .drop_duplicates(subset=["PERMIT_NUMBER", "PERMIT_VERSION"])
        .reset_index(drop=True)
    )

    row = {
        "permit_count": len(permits_df)
    }

    for i, (_, permit) in enumerate(permits_df.iterrows(), start=1):
        row[f"PERMIT{i}_ID"] = permit["PERMIT_NUMBER"]
        row[f"PERMIT{i}_SITE_NAME"] = permit["DISCHARGE_SITE_NAME"]
        row[f"PERMIT{i}_VERSION"] = permit["PERMIT_VERSION"]
        row[f"PERMIT{i}_EASTING"] = permit["DISCHARGE_EASTING"]
        row[f"PERMIT{i}_NORTHING"] = permit["DISCHARGE_NORTHING"]

    permit_details.append(row)

permit_df = pd.DataFrame(permit_details)

observations_df = pd.concat(
    [observations_df.reset_index(drop=True), permit_df],
    axis=1
)

observations_df=observations_df.sort_values("permit_count", ascending=False)

observations_df.to_csv("output_data/test.csv")



