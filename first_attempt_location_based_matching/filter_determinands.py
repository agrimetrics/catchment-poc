import pandas as pd

# Read in large determinands file
determinands = pd.read_csv("raw_datasets/determinands.csv")

# Filter determinands for only the permit+versions that are relevant to our sampling points
sampling_points_to_discharge_points = pd.read_csv("output_data/location_linking/sampling_point_to_permit_filtered.csv")

unique_permits_and_versions = (sampling_points_to_discharge_points[["PERMIT_NUMBER", "PERMIT_VERSION"]]
                                .drop_duplicates()
                                .rename(columns={"PERMIT_NUMBER": "PERMIT_REF", "PERMIT_VERSION": "VERSION"}))

determinands_filtered_by_permit = determinands.merge(
    unique_permits_and_versions,
    on=['PERMIT_REF', 'VERSION'],
    how='inner'
)

# Filter determinands for only the determinands that appear in our observational data
obs_df = pd.read_csv("raw_datasets/poole_harbour_rivers_observations_2020-2026.csv")
unique_observation_determinands = (obs_df[["determinand.notation"]]
                                .drop_duplicates()
                                .rename(columns={"determinand.notation": "DETE_CODE"}))

determinands_filtered_by_permit_and_determinand = determinands_filtered_by_permit.merge(
    unique_observation_determinands,
    on=['DETE_CODE'],
    how='inner'
)
determinands_filtered_by_permit_and_determinand.to_csv("output_data/filter_determinands/filtered_determinands.csv",index=False)

# Unpivot determinands table to create a long form dataset
df = determinands_filtered_by_permit_and_determinand.copy()
df = df.reset_index(names="ROW_ID")
long = (
    pd.wide_to_long(
        df,
        stubnames=["CODE", "VAL"],
        i="ROW_ID",
        j="N",
        sep="_"
    )
        .rename(columns={
        "CODE": "RULE_TYPE",
        "VAL": "RULE_VALUE"
    })
    .reset_index()
)
long.to_csv("output_data/filter_determinands/filtered_determinands_long.csv",index=False)


#### ANALYSIS (not relevant to output_data)
###### Identify permits that have more than 1 row for a given permit ref, version and determinand code
duplicates = (
    determinands.groupby(["PERMIT_REF", "VERSION", "DETE_CODE"])
    .size()
    .reset_index(name="row_count")
)
duplicates = duplicates[duplicates["row_count"] > 1]
duplicates.to_csv("analysis/duplicate_rows_by_permit_version_and_deteCode.csv",index=False)

###### Identify rows where given all other relevant columns are the same the month_from/month_to differ for a given permit
group_cols = [
    "PERMIT_REF",
    "VERSION",
    "OUTLET_NUMBER",
    "EFFLUENT_NUMBER",
    "DETE_CODE",
    "RULE_TYPE"
]

# identify groups with multiple distinct values
mask = (
    long.groupby(group_cols)["RULE_VALUE"]
      .transform("nunique")
      .gt(1)
)

conflicts = long[mask].sort_values(group_cols)
conflicts.to_csv("analysis/month_analysis.csv",index=False)
