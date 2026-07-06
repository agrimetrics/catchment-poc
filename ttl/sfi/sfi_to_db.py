from pathlib import Path

import duckdb
import pdfplumber
import pandas as pd

#This script gets the polygon drawn sfi dataset and reduces it to only poole harbour, then it stores it in a duckdb table
#The script also reads the PDF for sfi and extracts the table out of the PDF and then stores than in a separate table in order for us to convert into a concept scheme
#The whole database is a drop/replace rebuild from the raw datasets, so sfi.duckdb does not need to be committed - just re-run this script.

# Resolve paths relative to this script so it can be run from any working directory
HERE = Path(__file__).resolve().parent          # ttl/sfi
ROOT = HERE.parents[1]                           # repository root
RAW = ROOT / "raw_datasets"

con = duckdb.connect(str(HERE / "sfi.duckdb"))

con.execute("INSTALL spatial")
con.execute("LOAD spatial")

# The sfi dataset was downloaded from a drawn polygon so we can cut the data down by clipping against the operational catchment boundary
con.execute(f"""
CREATE OR REPLACE TABLE result AS
WITH dissolved AS (
    SELECT ST_Union_Agg(geom) AS geom
    FROM ST_Read('{RAW / "poole_harbour_rivers_operational_catchment.geojson"}')
)
SELECT x.*
FROM ST_Read('{RAW / "poole_harbour_rivers_sustainable_farming_initiatives.geojson"}') AS x
WHERE ST_Within(
    x.geom,
    (SELECT geom FROM dissolved)
);
""")

# The raw dataset holds one row per drawn point, so a single option (app_id + option_code) spans many rows.
# Aggregate to one row per option: sum the measured quantities (area/length/units) and collect the points
# into a single MULTIPOINT geometry. The quantities are cast to concrete decimal/integer types so ontop
# renders them in plain notation (no scientific notation) and the geometry is pre-serialised to WKT text so
# ontop can read this table without needing the spatial extension loaded on its JDBC connection.
con.execute("""
CREATE OR REPLACE TABLE option_geometry AS
SELECT app_id,
       option_code,
       CAST(SUM(area)  AS DECIMAL(18,4))      AS total_area,
       CAST(SUM(mtl)   AS BIGINT)             AS total_mtl,
       CAST(SUM(units) AS BIGINT)             AS total_units,
       ST_AsText(ST_Collect(array_agg(geom))) AS geom_wkt
FROM result
GROUP BY app_id, option_code;
""")


# Add a duckdb table for the concepts in the sfi concept scheme
all_rows = []

with pdfplumber.open(str(HERE / "Sustainable Farming Incentive_Data_Notes_v1_0.pdf")) as pdf:
    for i in range(len(pdf.pages) - 1):
        page = pdf.pages[i]
        table = page.extract_table()
        if table:
            all_rows.extend(table)

df = pd.DataFrame(all_rows)
df = df.iloc[1:]
df = df.rename(columns={0: "notation", 1: "description"})
df["description"] = (
    df["description"]
      .str.replace(r"\s+", " ", regex=True)
      .str.strip()
)
df["broader"] = (
    df["notation"]
    .astype(str)
    .str.extract(r"([A-Za-z]+)")[0]
    .str.replace(r"^C", "", regex=True)
)

con.execute("""
CREATE OR REPLACE TABLE concepts AS
SELECT * FROM df
""")
