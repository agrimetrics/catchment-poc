import pandas as pd
import geopandas as gpd
import bng
from scipy.spatial import cKDTree
from rapidfuzz import fuzz

## Create sampling point data from observational data
# Load observations and convert lat/long into eastings/northings
obs = pd.read_csv("raw_datasets/poole_harbour_rivers_observations_2026.csv")
gdf = gpd.GeoDataFrame(obs,geometry=gpd.points_from_xy(obs["samplingPoint.longitude"],obs["samplingPoint.latitude"]),crs="EPSG:4326")
gdf = gdf.to_crs("EPSG:27700")
gdf["samplingPoint.easting"] = gdf.geometry.x
gdf["samplingPoint.northing"] = gdf.geometry.y
# Create a dataset of just sampling points and their eastings/northings
sampling_points = gdf[["samplingPoint.notation","samplingPoint.prefLabel","samplingPoint.easting", "samplingPoint.northing"]].drop_duplicates(subset="samplingPoint.notation",keep="first")

## Create discharge point data
discharge_points = pd.read_csv("raw_datasets/consents_active.csv")
# Convert NGR to eatings/northings and remove columns that aren't needed
discharge_points["DISCHARGE_EASTING"] = discharge_points["DISCHARGE_NGR"].apply(lambda x: bng.to_osgb36(x)[0])
discharge_points["DISCHARGE_NORTHING"] = discharge_points["DISCHARGE_NGR"].apply(lambda x: bng.to_osgb36(x)[1])
discharge_points = discharge_points[["DISCHARGE_SITE_NAME","DISCHARGE_EASTING", "DISCHARGE_NORTHING", "PERMIT_NUMBER", "PERMIT_VERSION"]]

# Build tree
dp_coords = discharge_points[['DISCHARGE_EASTING', 'DISCHARGE_NORTHING']].to_numpy()
tree = cKDTree(dp_coords)
# set a radius in metres
radius = 100


sampling_point_coords = sampling_points[["samplingPoint.easting", "samplingPoint.northing"]].to_numpy()

# matches is a list of lists
# the index of the list corresponds to the row index of the samplingPoint in the sampling_point dataframe
# the list contains row indices from the discharge_points dataframe that link to the specific sampling_point
matches = tree.query_ball_point(sampling_point_coords, r=radius)

rows = []

# For each sampling point, get the subset of discharge_points dataframe and pick the permit from these rows
for sampling_point_index, corresponding_list in enumerate(matches):

    sp = sampling_points.iloc[sampling_point_index]
    sp_name = str(sp["samplingPoint.prefLabel"]).upper()

    # no candidates
    if len(corresponding_list) == 0:
        rows.append({
            "samplingPoint.notation": sp["samplingPoint.notation"],
            "samplingPoint.prefLabel": sp["samplingPoint.prefLabel"],
            "PERMIT_NUMBER": None,
            "PERMIT_VERSION": None,
            "DISCHARGE_SITE_NAME": None,
            "CONFIDENCE": 0
        })
        continue

    # spatial candidates
    candidate_permits = discharge_points.iloc[corresponding_list].copy()

    # fuzzy match score
    candidate_permits["CONFIDENCE"] = candidate_permits["DISCHARGE_SITE_NAME"].apply(
        lambda x: fuzz.token_set_ratio(sp_name, str(x).upper())
    )

    # best match
    best = candidate_permits.loc[candidate_permits["CONFIDENCE"].idxmax()]

    rows.append({
        "samplingPoint.notation": sp["samplingPoint.notation"],
        "samplingPoint.prefLabel": sp["samplingPoint.prefLabel"],
        "PERMIT_NUMBER": best["PERMIT_NUMBER"],
        "PERMIT_VERSION": best["PERMIT_VERSION"],
        "DISCHARGE_SITE_NAME": best["DISCHARGE_SITE_NAME"],
        "CONFIDENCE": best["CONFIDENCE"]
    })

# FINAL DATAFRAME
mapping_dataset = pd.DataFrame(rows)
mapping_dataset = mapping_dataset.sort_values("CONFIDENCE", ascending=False)

mapping_dataset.to_csv("output_data/test1.csv")


