import pandas as pd
from pathlib import Path

folder = Path("raw_datasets/poole_harbour_2020-2026")

# read all csv files in folder
files = list(folder.glob("*.csv"))

df_list = [pd.read_csv(f) for f in files]

combined = pd.concat(df_list, ignore_index=True)

combined.to_csv("poole_harbour_rivers_observations_2020-2026.csv", index=False)