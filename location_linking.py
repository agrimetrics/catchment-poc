import pandas as pd
import geopandas as gpd
import bng
from scipy.spatial import cKDTree
from pyproj import Transformer
from rapidfuzz import fuzz

## Create sampling point data from observational data
obs = pd.read_csv("raw_datasets/poole_harbour_rivers_observations_2020-2026.csv")
# Remove columns related to observations and remove duplicates by samplingPoint notation
sampling_points = obs[["samplingPoint.notation","samplingPoint.prefLabel","samplingPoint.latitude","samplingPoint.longitude","samplingPoint.easting", "samplingPoint.northing","samplingPoint.region","samplingPoint.area","samplingPoint.subArea","samplingPoint.samplingPointStatus","samplingPoint.samplingPointType"]].drop_duplicates(subset="samplingPoint.notation",keep="first")

## Clean discharge point data
# Convert NGR to eastings/northings and remove columns that aren't needed
discharge_points = pd.read_csv("raw_datasets/consents_active.csv")
discharge_points["DISCHARGE_EASTING"] = discharge_points["DISCHARGE_NGR"].apply(lambda x: bng.to_osgb36(x)[0])
discharge_points["DISCHARGE_NORTHING"] = discharge_points["DISCHARGE_NGR"].apply(lambda x: bng.to_osgb36(x)[1])
transformer = Transformer.from_crs("EPSG:27700", "EPSG:4326", always_xy=True)
discharge_points["DISCHARGE_LONGITUDE"], discharge_points["DISCHARGE_LATITUDE"] = (
    transformer.transform(
        discharge_points["DISCHARGE_EASTING"].to_numpy(),
        discharge_points["DISCHARGE_NORTHING"].to_numpy()
    )
)
discharge_points = discharge_points[["DISCHARGE_SITE_NAME","DISCHARGE_NGR","DISCHARGE_LATITUDE","DISCHARGE_LONGITUDE","DISCHARGE_EASTING", "DISCHARGE_NORTHING", "PERMIT_NUMBER", "PERMIT_VERSION"]].drop_duplicates()

# Build tree from discharge points
dp_coords = discharge_points[['DISCHARGE_EASTING', 'DISCHARGE_NORTHING']]
tree = cKDTree(dp_coords)
# set a radius in metres
radius = 100

# matches is a list of lists
# the index of each list corresponds to the row index of a samplingPoint in the sampling_point dataframe
# the list contains row indices from the discharge_points dataframe that link to that specific sampling_point
matches = tree.query_ball_point(sampling_points[["samplingPoint.easting", "samplingPoint.northing"]], r=radius)

rows = []
# For each sampling point get its candidate matches in the discharge_points dataframe and pick the best permit from these rows
for sampling_point_index, corresponding_list in enumerate(matches):

    sp = sampling_points.iloc[sampling_point_index]
    sp_name = str(sp["samplingPoint.prefLabel"]).upper()

    row={}
    # no candidates
    if len(corresponding_list) == 0:
        row["samplingPoint.notation"] = sp["samplingPoint.notation"]
        row["samplingPoint.prefLabel"] = sp["samplingPoint.prefLabel"]
        row["samplingPoint.latitude"] = sp["samplingPoint.latitude"]
        row["samplingPoint.longitude"] = sp["samplingPoint.longitude"]
        row["samplingPoint.easting"] = sp["samplingPoint.easting"]
        row["samplingPoint.northing"] = sp["samplingPoint.northing"]
        row["samplingPoint.region"] = sp["samplingPoint.region"]
        row["samplingPoint.area"] = sp["samplingPoint.area"]
        row["samplingPoint.subArea"] = sp["samplingPoint.subArea"]
        row["samplingPoint.samplingPointStatus"] = sp["samplingPoint.samplingPointStatus"]
        row["samplingPoint.samplingPointType"] = sp["samplingPoint.samplingPointType"]
        row["DISCHARGE_SITE_NAME_1"] = None
        row["MATCH_CONFIDENCE_1"] = 0
        row["PERMIT_NUMBER_1"] = None
        row["PERMIT_VERSION_1"] = None
        row["DISCHARGE_NGR_1"] = None
        row["DISCHARGE_LATITUDE"] = None
        row["DISCHARGE_LONGITUDE"] = None
        row["DISCHARGE_EASTING_1"] = None
        row["DISCHARGE_NORTHING_1"] = None
        rows.append(row)
        continue

    closest_discharge_points = discharge_points.iloc[corresponding_list].copy()
    closest_discharge_points["MATCH_CONFIDENCE"] = (
    closest_discharge_points["DISCHARGE_SITE_NAME"]
    .apply(lambda x: fuzz.token_set_ratio(sp_name, str(x).upper()))
)

    # A basic sorting by match confidence then by permit version (to handle cases where you might have multiple versions of the same permit)
    closest_discharge_points = (
        closest_discharge_points.copy()
        .sort_values(
            ["MATCH_CONFIDENCE", "PERMIT_VERSION"],
            ascending=[False, False]
        )
        .reset_index(drop=True)
    )

    for i, match_row in closest_discharge_points.iterrows():
        rank = i + 1
        row["samplingPoint.notation"] = sp["samplingPoint.notation"]
        row["samplingPoint.prefLabel"] = sp["samplingPoint.prefLabel"]
        row["samplingPoint.latitude"] = sp["samplingPoint.latitude"]
        row["samplingPoint.longitude"] = sp["samplingPoint.longitude"]
        row["samplingPoint.easting"] = sp["samplingPoint.easting"]
        row["samplingPoint.northing"] = sp["samplingPoint.northing"]
        row["samplingPoint.region"] = sp["samplingPoint.region"]
        row["samplingPoint.area"] = sp["samplingPoint.area"]
        row["samplingPoint.subArea"] = sp["samplingPoint.subArea"]
        row["samplingPoint.samplingPointStatus"] = sp["samplingPoint.samplingPointStatus"]
        row["samplingPoint.samplingPointType"] = sp["samplingPoint.samplingPointType"]
        row[f"DISCHARGE_SITE_NAME_{rank}"] = match_row["DISCHARGE_SITE_NAME"]
        row[f"MATCH_CONFIDENCE_{rank}"] = match_row["MATCH_CONFIDENCE"]
        row[f"PERMIT_NUMBER_{rank}"] = match_row["PERMIT_NUMBER"]
        row[f"PERMIT_VERSION_{rank}"] = match_row["PERMIT_VERSION"]
        row[f"DISCHARGE_NGR_{rank}"] = match_row["DISCHARGE_NGR"]
        row[f"DISCHARGE_LATITUDE_{rank}"] = match_row["DISCHARGE_LATITUDE"]
        row[f"DISCHARGE_LONGITUDE_{rank}"] = match_row["DISCHARGE_LONGITUDE"]
        row[f"DISCHARGE_EASTING_{rank}"] = match_row["DISCHARGE_EASTING"]
        row[f"DISCHARGE_NORTHING_{rank}"] = match_row["DISCHARGE_NORTHING"]

    rows.append(row)

# Create final dataframe which maps a sampling point to a permit+version
mapping_dataset_all = pd.DataFrame(rows)
mapping_dataset_all = mapping_dataset_all.sort_values("MATCH_CONFIDENCE_1", ascending=False)
mapping_dataset_all.to_csv("output_data/location_linking/sampling_point_to_permit_all.csv",index=False)

# Filter out rows where the MATCH_CONFIDENCE is under 50%
mapping_dataset_filtered = mapping_dataset_all[[
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
    "MATCH_CONFIDENCE_1",
    "DISCHARGE_SITE_NAME_1",
    "DISCHARGE_NGR_1",
    "DISCHARGE_LATITUDE_1",
    "DISCHARGE_LONGITUDE_1",
    "DISCHARGE_EASTING_1",
    "DISCHARGE_NORTHING_1",
    "PERMIT_NUMBER_1",
    "PERMIT_VERSION_1"]].rename(columns={
    "MATCH_CONFIDENCE_1": "MATCH_CONFIDENCE",
    "DISCHARGE_SITE_NAME_1": "DISCHARGE_SITE_NAME",
    "PERMIT_NUMBER_1": "PERMIT_NUMBER",
    "PERMIT_VERSION_1": "PERMIT_VERSION",
    "DISCHARGE_NGR_1": "DISCHARGE_NGR",
    "DISCHARGE_LATITUDE_1": "DISCHARGE_LATITUDE",
    "DISCHARGE_LONGITUDE_1": "DISCHARGE_LONGITUDE",
    "DISCHARGE_EASTING_1":"DISCHARGE_EASTING",
    "DISCHARGE_NORTHING_1":"DISCHARGE_NORTHING"
})
mapping_dataset_filtered = mapping_dataset_filtered[mapping_dataset_filtered["MATCH_CONFIDENCE"] >= 50]


mapping_dataset_filtered.to_csv("output_data/location_linking/sampling_point_to_permit_filtered.csv",index=False)


