import duckdb
import pdfplumber
import pandas as pd

#This script gets the polygon drawn sfi dataset and reduces it to only poole harbour, then it stores it in a duckdb table
#The script also reads the PDF for sfi and extracts the table out of the PDF and then stores than in a separate table in order for us to convert into a concept scheme

con = duckdb.connect("sfi.duckdb")

con.execute("INSTALL spatial")
con.execute("LOAD spatial")

# The sfi dataset was downloaded from a drawn polygon so we can cut the data down by clipping against the operational catchment boundary
con.execute("""
CREATE TABLE result AS
WITH dissolved AS (
    SELECT ST_Union_Agg(geom) AS geom
    FROM ST_Read('../raw_datasets/poole_harbour_rivers_operational_catchment.geojson')
)
SELECT x.*
FROM ST_Read('../raw_datasets/poole_harbour_rivers_sustainable_farming_initiatives.geojson') AS x
WHERE ST_Within(
    x.geom,
    (SELECT geom FROM dissolved)
);
""")


# Add a duckdb table for the concepts in the sfi concept scheme
all_rows = []

with pdfplumber.open("Sustainable Farming Incentive_Data_Notes_v1_0.pdf") as pdf:
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
CREATE TABLE concepts AS
SELECT * FROM df
""")
