import pandas as pd

obs_df = pd.read_csv("raw_datasets/poole_harbour_rivers_observations_2020-2026.csv")
sampling_point_to_permit_filtered_df = pd.read_csv("output_data/location_linking/sampling_point_to_permit_filtered.csv")
determinands = pd.read_csv("output_data/filter_determinands/filtered_determinands_long.csv")

# For each observation in our observational data tack on the corresponding permit+version along with the discharge easting/northing
obs_df = obs_df.merge(
    sampling_point_to_permit_filtered_df[
        ["samplingPoint.notation", "PERMIT_NUMBER", "PERMIT_VERSION", "DISCHARGE_EASTING", "DISCHARGE_NORTHING"]
    ],
    on="samplingPoint.notation",
    how="left")

#Rename determinands_long columns to match the observations dataframe before doing the inner join
determinands = determinands.rename(columns={
    "PERMIT_REF": "PERMIT_NUMBER",
    "VERSION": "PERMIT_VERSION",
    "DETE_CODE": "determinand.notation"
})

# Join the observations and determinands dataset based on the permit+version and determinand code
eval_df = obs_df.merge(
    determinands,
    on=["PERMIT_NUMBER", "PERMIT_VERSION", "determinand.notation"],
    how="inner"
).reset_index(drop=True)

# Filter out cases where the observation month does not fall within the permit month range
eval_df = eval_df[
    (eval_df["observation.month"] >= eval_df["MONTH_FROM"]) &
    (eval_df["observation.month"] <= eval_df["MONTH_TO"])
]

# For a first attempt just focus on ABSOLUTE methods and MIN/MAX rule types
filtered_eval_df = eval_df.loc[
    (eval_df["METHOD"] == "ABSOLUTE") &
    (eval_df["RULE_TYPE"].isin(["MAXIMUM VALUE", "MINIMUM VALUE"]))
]

filtered_eval_df = filtered_eval_df.copy()
filtered_eval_df["result"] = pd.to_numeric(filtered_eval_df["result"], errors="coerce")
filtered_eval_df = filtered_eval_df.dropna(subset=["result"])

#Set observation to "FAIL" initially, then check the MAX/MIN to see whether it passes
filtered_eval_df["ROW_PASS_STATUS"] = False
filtered_eval_df.loc[
    (filtered_eval_df["RULE_TYPE"] == "MAXIMUM VALUE") & (filtered_eval_df["result"] <= filtered_eval_df["RULE_VALUE"]),
    "ROW_PASS_STATUS"
] = True
filtered_eval_df.loc[
    (filtered_eval_df["RULE_TYPE"] == "MINIMUM VALUE") & (filtered_eval_df["result"] >= filtered_eval_df["RULE_VALUE"]),
    "ROW_PASS_STATUS"
] = True

# Calculates for a given observation id, permit_number, permit_version and determinand grouping whether the observation passed (True) or failed (False)
filtered_eval_df["OBSERVATION_GROUPING_PASS_STATUS"] = (
    filtered_eval_df.groupby(
        ["id", "PERMIT_NUMBER", "PERMIT_VERSION", "determinand.notation"]
    )["ROW_PASS_STATUS"]
    .transform("all")
)

columns = [
    "id",
    "samplingPoint.notation",
    "samplingPoint.prefLabel",
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
    "unit",
    "PERMIT_NUMBER",
    "PERMIT_VERSION",
    "DISCHARGE_EASTING",
    "DISCHARGE_NORTHING",
    "EA_REGION",
    "REGION",
    "OUTLET_NUMBER",
    "EFFLUENT_NUMBER",
    "MONTH_FROM",
    "MONTH_TO",
    "ROW_ID",
    "N",
    "DETE",
    "METHOD",
    "UNITS",
    "RULE_TYPE",
    "RULE_VALUE",
    "ROW_PASS_STATUS",
    "OBSERVATION_GROUPING_PASS_STATUS",
]

filtered_eval_df[columns].to_csv("output_data/shape_observational_data/observation_evaluation.csv",index=False)

