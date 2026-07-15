import pandas as pd
from pathlib import Path

output_dir = Path("output_data")
output_dir.mkdir(exist_ok=True)

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
effluents.to_csv(output_dir / "sampling_point_to_permit_relationship.csv", index=False)
effluents_subset.to_csv(output_dir / "sampling_point_to_permit_relationship_mapping_columns_only.csv",index=False)

###### For our 2020-2026 Poole Harbour Rivers Water Quality observations dataset we create a dataset where we have the observation rows with their associated permits (one observation row can become multiple if one sampling point links to multiple (PERMIT_REF,VERSION,OUTLET_NUMBER,EFFLUENT_NUMBER) combinations
observations = pd.read_csv("raw_datasets/poole_harbour_rivers_water_quality_observations_2020_2026_combined.csv")

#Filter out observation results that are like "<5", we want just numeric values 
numeric_observations = observations.copy()
numeric_observations["result"] = pd.to_numeric(numeric_observations["result"], errors="coerce")
numeric_observations = numeric_observations.dropna(subset=["result"])

# Create dataframe of observations that we have permits for
observations_with_permits = numeric_observations.merge(effluents_subset, on="samplingPoint.notation",how="inner")
observations_with_permits.to_csv(output_dir / "observations_with_permits.csv", index=False)

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
# Keep every rule type the register carries, not just the per-sample ones. A permit's
# BINDING limit at a sewage works is usually the 95th percentile; the MAXIMUM is an
# upper-tier backstop 2-4x looser. Filtering to MAXIMUM/MINIMUM published the backstop and
# dropped the real limit - and dropped whole determinands (Total Nitrogen is limited only
# ever by MEAN VALUE, so it never reached the graph at all).
long = long[long["RULE_TYPE"].notna() & (long["RULE_TYPE"] != "")]
long=long.drop_duplicates()
long.to_csv(output_dir / "filtered_determinands_long.csv",index=False)

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

# Only MAXIMUM/MINIMUM can be judged from a single sample: they are the per-sample rules.
# 95 PERCENTILE and MEAN VALUE are PERIOD statistics - a lone result above a 95th-percentile
# limit is an exceedance, not a breach; the EA judges it against a 12-month sample set (see
# ttl/regulation/README.md). So those rows get pass status NA - "not assessable from this
# sample" - and are excluded from the grouping below. Leaving them at the old default of
# False would have poisoned every group they touch (the .all() below), inventing a breach for
# every ammonia observation at the 24 permits whose ammonia limit is a percentile.
PER_SAMPLE_RULES = ["MAXIMUM VALUE", "MINIMUM VALUE"]
owpr = observations_with_permits_and_rules
per_sample = owpr["RULE_TYPE"].isin(PER_SAMPLE_RULES)

owpr["ROW_PASS_STATUS"] = pd.NA
owpr.loc[per_sample, "ROW_PASS_STATUS"] = False
owpr.loc[
    (owpr["RULE_TYPE"] == "MAXIMUM VALUE") & (owpr["result"] <= owpr["RULE_VALUE"]),
    "ROW_PASS_STATUS"
] = True
owpr.loc[
    (owpr["RULE_TYPE"] == "MINIMUM VALUE") & (owpr["result"] >= owpr["RULE_VALUE"]),
    "ROW_PASS_STATUS"
] = True

# For a given observation id, permit, version and determinand: did it pass EVERY per-sample
# rule that applies to it? Computed over the per-sample rows only, then broadcast back over
# the whole group. A group with no per-sample rule at all (e.g. a percentile-only ammonia
# limit, or a mean-only Total Nitrogen limit) has nothing to assess and stays NA.
GROUPING = ["id", "PERMIT_REF", "VERSION", "determinand.notation"]
grouping_status = owpr[per_sample].groupby(GROUPING)["ROW_PASS_STATUS"].all()
owpr["OBSERVATION_GROUPING_PASS_STATUS"] = (
    owpr.set_index(GROUPING).index.map(grouping_status)
)
observations_with_permits_and_rules = owpr
#filter for sampling point type?
#filter for only latest version per determinand?
#DWF data?

observations_with_permits_and_rules.to_csv(output_dir / "observations_with_permits_and_rules.csv",index=False)