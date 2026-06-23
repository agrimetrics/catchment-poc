import pandas as pd

obs_df = pd.read_csv("raw_datasets/poole_harbour_rivers_observations_2020-2026.csv")
sampling_point_to_permit_filtered_df = pd.read_csv("output_data/location_linking/sampling_point_to_permit_filtered.csv")
determinands = pd.read_csv("output_data/filter_determinands/filtered_determinands_long.csv")

# For each observation in our observational data tack on the corresponding permit+version
obs_df = obs_df.merge(
    sampling_point_to_permit_filtered_df[
        ["samplingPoint.notation", "PERMIT_NUMBER", "PERMIT_VERSION"]
    ],
    on="samplingPoint.notation",
    how="left")
# Add month as a column in order to filter out rows where the MONTH range for the permit does not apply to the observation phenomenonTime
obs_df["phenomenonTime"] = pd.to_datetime(obs_df["phenomenonTime"])
obs_df["OBSERVATION_MONTH"] = obs_df["phenomenonTime"].dt.month

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
    (eval_df["OBSERVATION_MONTH"] >= eval_df["MONTH_FROM"]) &
    (eval_df["OBSERVATION_MONTH"] <= eval_df["MONTH_TO"])
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
filtered_eval_df["row_pass_status"] = False
filtered_eval_df.loc[
    (filtered_eval_df["RULE_TYPE"] == "MAXIMUM VALUE") & (filtered_eval_df["result"] <= filtered_eval_df["RULE_VALUE"]),
    "row_pass_status"
] = True
filtered_eval_df.loc[
    (filtered_eval_df["RULE_TYPE"] == "MINIMUM VALUE") & (filtered_eval_df["result"] >= filtered_eval_df["RULE_VALUE"]),
    "row_pass_status"
] = True

# Add a observation_pass_status column which calculates for a given observation id, permit_number, permit_version and determinand whether the observation passed (True) or failed (False)
filtered_eval_df["observation_pass_status"] = (
    filtered_eval_df.groupby(
        ["id", "PERMIT_NUMBER", "PERMIT_VERSION", "determinand.notation"]
    )["row_pass_status"]
    .transform("all")
)

filtered_eval_df.to_csv("output_data/shape_observational_data/observation_evaluation.csv",index=False)

