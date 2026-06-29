import pandas as pd

###### Create a dataset between sampling points and permits from the effluents dataset
effluents = pd.read_csv("raw_datasets/access_database_csv_files/effluents.csv")
# Filter for SW region
effluents=effluents[effluents["EA_REGION"]=="SW"]
# Filter dataframe for where we have both the EA_REGION and the EFF_SAMPLE_POINT in order to construct the sampling point notation
effluents = effluents[
    (effluents["EA_REGION"].notna()) &
    (effluents["EFF_SAMPLE_POINT"].notna())]
effluents["samplingPoint.notation"]=effluents["EA_REGION"] + "-" + effluents["EFF_SAMPLE_POINT"]
# Select only relevant columns 
effluents_subset = effluents[[
    "samplingPoint.notation", 
    "PERMIT_REF",
    "VERSION",
    "OUTLET_NUMBER",
    "EFFLUENT_NUMBER"]]
effluents_subset=effluents_subset.drop_duplicates()
# Save to file
effluents.to_csv("output_data/sampling_point_to_permit_relationship.csv", index=False)
effluents_subset.to_csv("output_data/sampling_point_to_permit_relationship_mapping_columns_only.csv",index=False)

###### For our 2020-2026 Poole Harbour Rivers Water Quality observations dataset we create a dataset where we have the observation rows with their associated permits (one observation row can become multiple if one sampling point links to multiple (PERMIT_REF,VERSION,OUTLET_NUMBER,EFFLUENT_NUMBER) combinations
observations = pd.read_csv("raw_datasets/poole_harbour_rivers_water_quality_observations_2020_2026_combined.csv")

#Filter out observation results that are like "<5", we want just numeric values 
numeric_observations = observations.copy()
numeric_observations["result"] = pd.to_numeric(numeric_observations["result"], errors="coerce")
numeric_observations = numeric_observations.dropna(subset=["result"])

# Create dataframe of observations that we have permits for
observations_with_permits = numeric_observations.merge(effluents_subset, on="samplingPoint.notation",how="inner")
observations_with_permits.to_csv("output_data/observations_with_permits.csv", index=False)

###### Filter and shape determinands dataset (permits and their rules) in order to later merge with the observations dataset
determinands = pd.read_csv("raw_datasets/access_database_csv_files/determinands.csv")
#Filter for SW region
determinands = determinands[determinands["EA_REGION"]=="SW"]
#Filter for 'ABSOLUTE' method 
determinands = determinands[determinands["METHOD"]=="ABSOLUTE"]

#Convert into a long format
df=determinands.copy()
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
#Filter for just maximum and minimum rule types
long = long[long["RULE_TYPE"].isin(["MAXIMUM VALUE", "MINIMUM VALUE"])]
long=long.drop_duplicates()
long.to_csv("output_data/filtered_determinands_long.csv",index=False)

###### Create observational data which contains permits and their rules
long=long.rename(columns={
    "DETE_CODE":"determinand.notation",
    "UNITS":"unit"
})
observations_with_permits_and_rules = observations_with_permits.merge(long,
                                                                      on=["PERMIT_REF",
                                                                          "VERSION",
                                                                          "OUTLET_NUMBER",
                                                                          "EFFLUENT_NUMBER",
                                                                          "determinand.notation",
                                                                          "unit"])
#Filter out observations where the observation month doesn't fall within the month_from/month_to range
observations_with_permits_and_rules = observations_with_permits_and_rules[
    (observations_with_permits_and_rules["observation.month"] >= observations_with_permits_and_rules["MONTH_FROM"]) &
    (observations_with_permits_and_rules["observation.month"] <= observations_with_permits_and_rules["MONTH_TO"])
]

#Set observation to "FAIL" initially, then check the MAX/MIN to see whether it passes
observations_with_permits_and_rules["ROW_PASS_STATUS"] = False
observations_with_permits_and_rules.loc[
    (observations_with_permits_and_rules["RULE_TYPE"] == "MAXIMUM VALUE") & (observations_with_permits_and_rules["result"] <= observations_with_permits_and_rules["RULE_VALUE"]),
    "ROW_PASS_STATUS"
] = True
observations_with_permits_and_rules.loc[
    (observations_with_permits_and_rules["RULE_TYPE"] == "MINIMUM VALUE") & (observations_with_permits_and_rules["result"] >= observations_with_permits_and_rules["RULE_VALUE"]),
    "ROW_PASS_STATUS"
] = True

# Calculates for a given observation id, permit_number, permit_version and determinand grouping whether the observation passed (True) or failed (False)
observations_with_permits_and_rules["OBSERVATION_GROUPING_PASS_STATUS"] = (
    observations_with_permits_and_rules.groupby(
        ["id", "PERMIT_REF", "VERSION", "determinand.notation"]
    )["ROW_PASS_STATUS"]
    .transform("all") 
)
#filter for sampling point type?
#filter for only latest version per determinand?
#DWF data?

observations_with_permits_and_rules.to_csv("output_data/observations_with_permits_and_rules.csv",index=False)