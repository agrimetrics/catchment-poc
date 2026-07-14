import re
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
#
# THE CRS IS NAMED. The source is GeoJSON with no `crs` member, and RFC 7946 is unambiguous about what
# that means: GeoJSON is ALWAYS WGS84 longitude/latitude (CRS84). So we do know the CRS - it is not
# missing, it is specified by the format - and the graph should say so rather than leave a reader to
# infer it. GeoSPARQL happens to default an un-prefixed wktLiteral to CRS84 too, so these coordinates
# were being read correctly by luck; but "correct by two coincident defaults" is not the same as
# "stated", and this store is in the business of stating things. The URI goes FIRST, per the spec.
CRS84 = "http://www.opengis.net/def/crs/OGC/1.3/CRS84"
con.execute(f"""
CREATE OR REPLACE TABLE option_geometry AS
SELECT app_id,
       option_code,
       CAST(SUM(area)  AS DECIMAL(18,4))      AS total_area,
       CAST(SUM(mtl)   AS BIGINT)             AS total_mtl,
       CAST(SUM(units) AS BIGINT)             AS total_units,
       '<{CRS84}> ' || ST_AsText(ST_Collect(array_agg(geom))) AS geom_wkt
FROM result
GROUP BY app_id, option_code;
""")


# --- SFI concept scheme -------------------------------------------------------
# Two sources are unioned into one `concepts` table:
#   1. The "SFI Option details.xlsx" workbook is the richer, canonical source for the expanded
#      (C-prefixed) SFI offer: code, description, the payment rate + pay unit, duration, and the
#      long human-authored guidance (aim / purpose / where / what / when / evidence / advice) which
#      we roll up verbatim into a single formatted rdfs:comment rather than modelling as related
#      concept schemes.
#   2. The data-notes PDF still supplies definition + broader grouping for the older SFI 2023 /
#      pilot codes that appear in the catchment but are absent from the workbook.
# The workbook wins on any code present in both.

# Windows-1252 punctuation mangled into UTF-8 in the source workbook (e.g. "action€™s" -> "action's").
_MOJIBAKE = {
    "€™": "’", "€˜": "‘", "€œ": "“", "€\x9d": "”",
    "€“": "–", "€”": "—", "€¦": "…", "Â": "",
}


def clean_text(v) -> str | None:
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    s = str(v)
    for bad, good in _MOJIBAKE.items():
        s = s.replace(bad, good)
    s = s.replace("€", "")          # any stray lone euro left over from the mangling
    return s.strip() or None


def roll_up_comment(row) -> str | None:
    """Format the long guidance columns into one Markdown-ish rdfs:comment. No interpretation —
    the text is captured verbatim (only whitespace-normalised) under section headings."""
    sections = [
        ("Aim", "Aim"), ("Purpose", "Purpose"), ("Where", "where"), ("What", "what"),
        ("When", "when"), ("Evidence", "evidence"), ("Advice", "advice"),
    ]
    parts = []
    for heading, col in sections:
        text = clean_text(row.get(col))
        if text and text.lower() != "nan":
            parts.append(f"## {heading}\n{text}")
    return "\n\n".join(parts) if parts else None


xl = pd.read_excel(RAW / "SFI Option details.xlsx", sheet_name="SFI Option Data")
xl_rows = []
for _, r in xl.iterrows():
    notation = clean_text(r["Code"])
    if not notation:
        continue
    pay_unit_text = clean_text(r["Pay Unit"])
    # The payment rate is quoted per a base unit. We only compute a monetary cost for the two
    # units we can reliably tie to a measured option quantity: per hectare (area) and per 100
    # metres (length). Everything else keeps the verbatim rate but no computed per-unit divisor.
    per_amount, per_unit_slug = None, None
    if pay_unit_text and "100 metres" in pay_unit_text.lower():
        per_amount, per_unit_slug = 100, "M"
    elif pay_unit_text and pay_unit_text.lower().startswith("per hectare"):
        per_amount, per_unit_slug = 1, "HA"
    xl_rows.append({
        "notation": notation,
        "definition": clean_text(r["Description"]),
        "comment": roll_up_comment(r),
        "duration": clean_text(r["duration"]),
        "pay_amount": float(r["PAYMENT_RATE"]) if pd.notna(r["PAYMENT_RATE"]) else None,
        "pay_unit_text": pay_unit_text,
        "more_pay_info": clean_text(r["More_pay_info"]),
        "per_amount": per_amount,
        "per_unit_slug": per_unit_slug,
        "broader": re.sub(r"^C", "", re.match(r"([A-Za-z]+)", notation).group(1)),
    })
xlsx_df = pd.DataFrame(xl_rows)

# Older codes (SFI 2023 / pilot) not in the workbook: fall back to the data-notes PDF for a
# definition + broader grouping only.
all_rows = []
with pdfplumber.open(str(HERE / "Sustainable Farming Incentive_Data_Notes_v1_0.pdf")) as pdf:
    for i in range(len(pdf.pages) - 1):
        table = pdf.pages[i].extract_table()
        if table:
            all_rows.extend(table)
pdf_df = pd.DataFrame(all_rows).iloc[1:].rename(columns={0: "notation", 1: "description"})
pdf_df["description"] = pdf_df["description"].str.replace(r"\s+", " ", regex=True).str.strip()
pdf_df["broader"] = (
    pdf_df["notation"].astype(str).str.extract(r"([A-Za-z]+)")[0].str.replace(r"^C", "", regex=True)
)

con.register("xlsx_df", xlsx_df)
con.register("pdf_df", pdf_df)
con.execute("""
CREATE OR REPLACE TABLE concepts AS
SELECT notation, definition, comment, duration, pay_amount, pay_unit_text,
       more_pay_info, per_amount, per_unit_slug, broader
FROM xlsx_df
UNION ALL
SELECT notation, description AS definition, NULL, NULL, NULL, NULL,
       NULL, NULL, NULL, broader
FROM pdf_df
WHERE notation NOT IN (SELECT notation FROM xlsx_df)
""")

# Human-readable prefLabel for each broader group (the action-code letter-group). The group codes
# are a controlled vocabulary; these are curated short names so the farming view can label option
# groups meaningfully (e.g. HRW -> Hedgerows, SAM -> Soil management) instead of showing bare codes.
# Any broader code not listed falls back to the code itself.
GROUP_LABELS = {
    "AB": "Flower-rich & arable plots", "AGF": "Agroforestry", "AHL": "Arable land",
    "AHW": "Arable habitats", "BFS": "Buffer strips", "GRH": "Grassland habitats",
    "GS": "Grassland", "HEF": "Historic & heritage features", "HRW": "Hedgerows",
    "IGL": "Improved grassland", "IPM": "Integrated pest management", "LIG": "Low-input grassland",
    "MOR": "Moorland", "NUM": "Nutrient management", "OFA": "Organic — arable",
    "OFC": "Organic — conversion", "OFM": "Organic — management", "PAC": "Public access",
    "PRF": "Precision farming", "SAM": "Soil management", "SCR": "Scrub & successional areas",
    "SOH": "Soil health", "SP": "Species management", "SPM": "Species recovery",
    "SW": "Water quality", "UPL": "Upland", "WBD": "Waterbodies", "WD": "Woodland",
    "WT": "Wetland & water",
}
broader_codes = [r[0] for r in con.execute(
    "SELECT DISTINCT broader FROM concepts WHERE broader IS NOT NULL").fetchall()]
group_labels_df = pd.DataFrame(
    [{"broader": b, "label": GROUP_LABELS.get(b, b)} for b in broader_codes])
con.register("group_labels_df", group_labels_df)
con.execute("CREATE OR REPLACE TABLE group_labels AS SELECT * FROM group_labels_df")

# --- Per-option cost ----------------------------------------------------------
# Followup activity: value each option by multiplying its measured extent by the concept's payment
# rate. cost = extent * pay_amount / per_amount, taking the option's summed length (metres) for a
# per-100-metres rate and summed area (hectares) for a per-hectare rate. This is the base annual
# rate only — it does NOT apply the More_pay_info nuances (e.g. "for both sides", extra per-agreement
# top-ups). See the SFI README data warning.
#
# Options coded with a superseded SFI 2023 action (e.g. HRW3, SAM1) are NOT priced: the workbook only
# carries the expanded-offer (C-prefixed) rates, and we deliberately do not borrow those rates for the
# older codes. Such options simply produce no cost row here and are surfaced as "unpriced" in the UI.
con.execute("""
CREATE OR REPLACE TABLE option_cost AS
SELECT g.app_id,
       g.option_code,
       CAST(
         CASE c.per_unit_slug
           WHEN 'M'  THEN g.total_mtl  * c.pay_amount / c.per_amount
           WHEN 'HA' THEN g.total_area * c.pay_amount / c.per_amount
         END AS DECIMAL(18,2)) AS cost
FROM option_geometry g
JOIN concepts c ON c.notation = g.option_code
WHERE c.per_unit_slug IS NOT NULL AND c.pay_amount IS NOT NULL;
""")


# --- Farmscoper pollutant impact ---------------------------------------------
# "Scheme details.xlsx" / Farmscoper sheet holds one row per FARMSCOPER *treatment* (a mitigation
# measure modelled by ADAS), giving the modelled annual change in pollutant loss per hectare for
# three pollutants. Each treatment row also carries a concatenated "Scheme Actions" list naming the
# scheme actions that enact it, tagged with their scheme, e.g.
#
#     "OFDB-0087,OFDB-0088,OFDB-0095,OFDB-0492,AB3 (CS),AHW3 (SFI)"
#
# We take only the "(SFI)" tokens and hang the treatment's per-hectare figures on the matching SFI
# concept. Values are NEGATIVE = a reduction in pollutant loss (the point of the intervention).
#
# The pollutant columns are bound to the substances the water-quality side of the store already
# monitors, so an SFI option's modelled impact and a sampling point's observations refer to the SAME
# skos:Concept and can be joined:
#     Kg Nitrate Ha-1 Yr-1 -> substance 9686  "Nitrogen, Total as N"
#     Kg P Ha-1 Yr-1       -> substance 0348  "Phosphorus, Total as P"
#
# The sheet's third column, `Kg Z Ha-1 Yr-1`, is DELIBERATELY NOT SHREDDED. Read literally it is
# zinc, but its magnitudes are physically impossible for zinc (rates to -1,651 kg/ha/yr against a
# soil zinc stock of ~150-250 kg/ha) and it tracks the phosphorus column at a near-constant ~870:1 —
# the sediment-to-particulate-P ratio, not anything to do with zinc. We do not know what it measures,
# so the store does not claim to. See TODO.md; rebind it only once the source is confirmed.
SUBSTANCE_BASE = "http://example.com/water-regulation/substance/"
IMPACT_COLUMNS = [
    ("Kg Nitrate Ha-1 Yr-1", "9686", "Nitrogen, Total as N"),
    ("Kg P Ha-1 Yr-1", "0348", "Phosphorus, Total as P"),
]

fs = pd.read_excel(RAW / "Scheme details.xlsx", sheet_name="Farmscoper")
impact_rows = []
for _, r in fs.iterrows():
    treatment = clean_text(r["Name"])
    # Only the SFI-tagged tokens of the concatenated action list; other tokens are OFDB or CS actions.
    codes = [
        m.group(1)
        for m in (re.match(r"^(.+?)\s*\(SFI\)$", t.strip())
                  for t in str(r["Scheme Actions"] or "").split(","))
        if m
    ]
    for column, substance_code, substance_label in IMPACT_COLUMNS:
        value = r[column]
        if pd.isna(value):
            continue
        for notation in codes:
            impact_rows.append({
                "notation": notation,
                "substance_code": substance_code,
                "substance_uri": SUBSTANCE_BASE + substance_code,
                "substance_label": substance_label,
                "kg_per_ha_yr": round(float(value), 4),
                "treatment": treatment,
            })
impact_df = pd.DataFrame(impact_rows)

# One SFI action can only carry one figure per pollutant. The source happens to name each SFI code in
# exactly one treatment row, so there is nothing to reconcile — but if that ever changes we want to be
# told rather than silently pick a row.
clashes = impact_df.groupby(["notation", "substance_code"]).size()
clashes = clashes[clashes > 1]
if not clashes.empty:
    raise ValueError(
        "An SFI code is named by more than one Farmscoper treatment for the same pollutant, so its "
        f"impact is ambiguous and no rule exists to combine them:\n{clashes}")

con.register("impact_df", impact_df)
con.execute("""
CREATE OR REPLACE TABLE concept_impact AS
SELECT notation, substance_code, substance_uri, substance_label,
       CAST(kg_per_ha_yr AS DECIMAL(18,4)) AS kg_per_ha_yr, treatment
FROM impact_df
WHERE notation IN (SELECT notation FROM concepts);
""")

# --- Per-option and per-application applied impact -----------------------------
# The concept rate is per hectare per year; an in-catchment option's modelled impact is therefore its
# summed AREA x the rate, giving kg/yr. Options measured in metres or units (e.g. hedgerow actions)
# have no hectarage to multiply, so they get no applied impact — the rate stays on the concept only.
con.execute("""
CREATE OR REPLACE TABLE option_impact AS
SELECT g.app_id,
       g.option_code,
       i.substance_code,
       i.substance_uri,
       i.substance_label,
       CAST(g.total_area * i.kg_per_ha_yr AS DECIMAL(18,4)) AS kg_per_yr
FROM option_geometry g
JOIN concept_impact i ON i.notation = g.option_code
WHERE g.total_area IS NOT NULL AND g.total_area > 0;
""")

# An application is a whole farm agreement made of many options; its impact is the sum of its options'.
con.execute("""
CREATE OR REPLACE TABLE application_impact AS
SELECT app_id,
       substance_code,
       ANY_VALUE(substance_uri)   AS substance_uri,
       ANY_VALUE(substance_label) AS substance_label,
       CAST(SUM(kg_per_yr) AS DECIMAL(18,4)) AS kg_per_yr
FROM option_impact
GROUP BY app_id, substance_code;
""")
