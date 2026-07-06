from pathlib import Path

import duckdb

# This script shreds the observations-with-permits-and-rules CSV into a small star of
# tables, one row per instance, so ontop can materialise Permit / Condition / ConditionBreach
# individuals against the DEFRA regulation + water ontologies.
#
# The whole database is a drop/replace rebuild from the CSV, so regulation.duckdb does not
# need to be committed - just re-run this script. Paths resolve relative to this file so it
# can be run from any working directory.

HERE = Path(__file__).resolve().parent          # ttl/regulation
ROOT = HERE.parents[1]                           # repository root
CSV = ROOT / "output_data" / "observations_with_permits_and_rules.csv"

con = duckdb.connect(str(HERE / "regulation.duckdb"))

# Raw load. PERMIT_REF / VERSION / OUTLET / EFFLUENT / determinand notation are forced to
# VARCHAR so leading zeros (e.g. permit '040015') survive and IRIs stay stable.
con.execute(f"""
CREATE OR REPLACE TABLE raw AS
SELECT * FROM read_csv(
    '{CSV}',
    header = true,
    types = {{
        'PERMIT_REF': 'VARCHAR',
        'VERSION': 'VARCHAR',
        'OUTLET_NUMBER': 'VARCHAR',
        'EFFLUENT_NUMBER': 'VARCHAR',
        'determinand.notation': 'VARCHAR',
        'ROW_ID': 'VARCHAR'
    }}
);
""")

# --- Permits (one per PERMIT_REF) -> defra-water:WaterDischargePermit ---
con.execute("""
CREATE OR REPLACE TABLE permits AS
SELECT DISTINCT PERMIT_REF AS permit_ref
FROM raw;
""")

# --- Permit versions (one per PERMIT_REF+VERSION) -> defra-reg:PermitDocument ---
con.execute("""
CREATE OR REPLACE TABLE permit_versions AS
SELECT DISTINCT PERMIT_REF AS permit_ref, VERSION AS version
FROM raw;
""")

# --- Discharge points (one per PERMIT_REF+OUTLET+EFFLUENT) -> defra-reg:DischargePoint ---
con.execute("""
CREATE OR REPLACE TABLE discharge_points AS
SELECT DISTINCT PERMIT_REF AS permit_ref, OUTLET_NUMBER AS outlet, EFFLUENT_NUMBER AS effluent
FROM raw;
""")

# --- Discharge point -> sampling point monitoring link (one sampling point per discharge point) ---
con.execute("""
CREATE OR REPLACE TABLE discharge_point_monitoring AS
SELECT DISTINCT
    PERMIT_REF AS permit_ref,
    OUTLET_NUMBER AS outlet,
    EFFLUENT_NUMBER AS effluent,
    "samplingPoint.notation" AS sp_notation
FROM raw
WHERE "samplingPoint.notation" IS NOT NULL AND "samplingPoint.notation" <> '';
""")

# --- Substances / parameters (the determinand concept scheme) -> skos:Concept + sosa:ObservableProperty ---
con.execute("""
CREATE OR REPLACE TABLE substances AS
SELECT DISTINCT lpad("determinand.notation", 4, '0') AS notation, "determinand.prefLabel" AS pref_label
FROM raw;
""")

# --- Units. Mint a local unit IRI per distinct unit, linking to a QUDT unit where confidently known. ---
con.execute("""
CREATE OR REPLACE TABLE unit_map AS
SELECT * FROM (VALUES
    ('MILLIGRAM PER LITRE', 'http://qudt.org/vocab/unit/MilliGM-PER-L'),
    ('MICROGRAM PER LITRE', 'http://qudt.org/vocab/unit/MicroGM-PER-L'),
    ('PERCENTAGE',          'http://qudt.org/vocab/unit/PERCENT')
) AS t(unit_label, qudt_iri);
""")
con.execute("""
CREATE OR REPLACE TABLE units AS
SELECT DISTINCT
    r.unit AS unit_label,
    lower(replace(replace(replace(r.unit, ' ', '-'), '/', '-'), '.', '')) AS unit_slug,
    m.qudt_iri AS qudt_iri
FROM raw r
LEFT JOIN unit_map m ON r.unit = m.unit_label
WHERE r.unit IS NOT NULL AND r.unit <> '';
""")

# --- Conditions: one per (permit, version, substance), pivoting the max/min rule rows into a
#     single limit with an optional upper and/or lower bound. Values -> DECIMAL so they render
#     in plain notation (no scientific). The unit is constant per condition (validated). ---
con.execute("""
CREATE OR REPLACE TABLE conditions AS
SELECT
    permit_ref,
    version,
    substance,
    max_value,
    min_value,
    lower(replace(replace(replace(unit_label, ' ', '-'), '/', '-'), '.', '')) AS unit_slug
FROM (
    SELECT
        PERMIT_REF AS permit_ref,
        VERSION AS version,
        lpad("determinand.notation", 4, '0') AS substance,
        MAX(CASE WHEN RULE_TYPE = 'MAXIMUM VALUE' THEN CAST(RULE_VALUE AS DECIMAL(18,4)) END) AS max_value,
        MAX(CASE WHEN RULE_TYPE = 'MINIMUM VALUE' THEN CAST(RULE_VALUE AS DECIMAL(18,4)) END) AS min_value,
        ANY_VALUE(unit) AS unit_label
    FROM raw
    GROUP BY PERMIT_REF, VERSION, "determinand.notation"
);
""")

# --- Condition breaches: one per (permit, version, substance, phenomenonTime) grouping whose
#     OBSERVATION_GROUPING_PASS_STATUS is FALSE. Identity is a hash (the breach will later
#     generalise to rolling percentile-over-period, so it can't be a single-timestamp path).
#     Direction of the failing rule picks the subclass. ---
con.execute("""
CREATE OR REPLACE TABLE breaches AS
SELECT
    md5(concat_ws('|', PERMIT_REF, VERSION, lpad("determinand.notation", 4, '0'), phenomenonTime)) AS breach_id,
    PERMIT_REF AS permit_ref,
    VERSION AS version,
    lpad("determinand.notation", 4, '0') AS substance,
    strftime(CAST(phenomenonTime AS TIMESTAMP), '%Y-%m-%dT%H:%M:%S') AS applicable_from,
    ANY_VALUE(replace(id, 'https://', 'http://')) AS observation_id,
    CASE
        WHEN BOOL_OR(ROW_PASS_STATUS = 'False' AND RULE_TYPE = 'MAXIMUM VALUE') THEN 'ExceedanceBreach'
        WHEN BOOL_OR(ROW_PASS_STATUS = 'False' AND RULE_TYPE = 'MINIMUM VALUE') THEN 'ShortfallBreach'
    END AS breach_class
FROM raw
WHERE OBSERVATION_GROUPING_PASS_STATUS = 'False'
GROUP BY PERMIT_REF, VERSION, "determinand.notation", phenomenonTime;
""")

# Summary + a couple of integrity checks for the operator
for tbl in ["permits", "permit_versions", "discharge_points", "discharge_point_monitoring",
            "substances", "units", "conditions", "breaches"]:
    n = con.execute(f"SELECT COUNT(*) FROM {tbl}").fetchone()[0]
    print(f"{tbl:>16}: {n}")

both = con.execute("""
    SELECT COUNT(*) FROM raw
    WHERE OBSERVATION_GROUPING_PASS_STATUS = 'False'
    GROUP BY PERMIT_REF, VERSION, "determinand.notation", phenomenonTime
    HAVING BOOL_OR(ROW_PASS_STATUS='False' AND RULE_TYPE='MAXIMUM VALUE')
       AND BOOL_OR(ROW_PASS_STATUS='False' AND RULE_TYPE='MINIMUM VALUE')
""").fetchall()
if both:
    print(f"NOTE: {len(both)} breach group(s) failed both bounds; classified as ExceedanceBreach.")
unmapped = con.execute("SELECT unit_label FROM units WHERE qudt_iri IS NULL").fetchall()
if unmapped:
    print("NOTE: units with no QUDT mapping (local IRI only):", [u[0] for u in unmapped])
