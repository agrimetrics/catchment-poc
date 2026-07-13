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
# The permit register (a raw source) is the only place the discharge site's own National Grid
# Reference lives; the observations pipeline (CSV above) drops it. Read straight from here.
# consents_active covers in-force permits; consents_all is a hand-cut extract of the *revoked*
# permits that still carry observations here (absent from the active register), so between them
# every monitored discharge point gets its own NGR. Both files share the same column layout.
CONSENTS_CSVS = [
    ROOT / "raw_datasets" / "access_database_csv_files" / "consents_active.csv",
    ROOT / "raw_datasets" / "access_database_csv_files" / "consents_all.csv",
]

con = duckdb.connect(str(HERE / "regulation.duckdb"))


# --- National Grid Reference -> Easting/Northing (EPSG:27700). Decodes an OSGB alphanumeric grid
#     ref (e.g. 'SY7400087100') into metres from the British National Grid false origin. The two
#     letters pick a 100km square (the grid skips 'I'); the digits split in half into easting then
#     northing within that square, padded to 5 figures (metres). Registered as duckdb scalar UDFs. ---
def _ngr_to_en(ngr):
    if ngr is None:
        return None
    s = str(ngr).replace(" ", "").upper()
    if len(s) < 2 or not s[0].isalpha() or not s[1].isalpha():
        return None
    digits = s[2:]
    if not digits.isdigit() or len(digits) == 0 or len(digits) % 2 != 0:
        return None
    l1 = ord(s[0]) - ord("A")
    l2 = ord(s[1]) - ord("A")
    if l1 > 7:                                   # OSGB grid omits the letter 'I'
        l1 -= 1
    if l2 > 7:
        l2 -= 1
    e100 = ((l1 - 2) % 5) * 5 + (l2 % 5)
    n100 = (19 - (l1 // 5) * 5) - (l2 // 5)
    if not (0 <= e100 <= 6 and 0 <= n100 <= 12):  # outside the National Grid
        return None
    half = len(digits) // 2
    easting = e100 * 100000 + int((digits[:half] + "00000")[:5])
    northing = n100 * 100000 + int((digits[half:] + "00000")[:5])
    return [easting, northing]


def _ngr_easting(ngr):
    en = _ngr_to_en(ngr)
    return en[0] if en else None


def _ngr_northing(ngr):
    en = _ngr_to_en(ngr)
    return en[1] if en else None


con.create_function("ngr_easting", _ngr_easting, ["VARCHAR"], "INTEGER")
con.create_function("ngr_northing", _ngr_northing, ["VARCHAR"], "INTEGER")

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

# --- Sampling-point geometry (WGS84). The sampling point owns its own coordinates (lon/lat from
#     the water-quality observations), so we assert them on the sampling point itself rather than
#     transcribing them onto the discharge point. WKT is POINT(lon lat), CRS84/WGS84 (EPSG:4326). ---
con.execute("""
CREATE OR REPLACE TABLE sampling_point_geometry AS
SELECT
    "samplingPoint.notation" AS sp_notation,
    ANY_VALUE("samplingPoint.longitude") AS lon,
    ANY_VALUE("samplingPoint.latitude")  AS lat
FROM raw
WHERE "samplingPoint.longitude" IS NOT NULL AND "samplingPoint.latitude" IS NOT NULL
  AND "samplingPoint.notation" IS NOT NULL AND "samplingPoint.notation" <> ''
GROUP BY "samplingPoint.notation";
""")

# --- Discharge-point geometry. The discharge point's own #geography, as a ready-made WKT literal
#     string (mixed CRS, so built here rather than templated in the mapping). Source is the permit
#     register's National Grid Reference (DISCHARGE_NGR) - a distinct location from the sampling point
#     it is monitoredAt, so we surface it rather than hide it behind the sampling point's coordinates.
#     Decoded to Easting/Northing and tagged EPSG:27700. The active + revoked (all) register extracts
#     together cover every monitored discharge point, so all get a real NGR.
#
#     KNOWN LIMITATION - a coarse coordinate on a fine feature. The register carries a grid ref at
#     THREE levels: DISCHARGE_NGR (the discharge SITE), OUTLET_GRID_REF (the outlet) and
#     EFFLUENT_GRID_REF (the effluent). A discharge point here is keyed at the FINEST level
#     (permit+outlet+effluent), but is given the COARSEST coordinate. There is no per-permit NGR:
#     DISCHARGE_NGR belongs to the site, and a site can hold many permits (verified against the
#     national register - 1085 grid refs are shared by >1 permit, and in 1083 of those every permit
#     names the same discharge site; RAF Brize Norton has 13 permits on one ref). So joining it on
#     permit_ref alone quietly turns a SITE fact into a PERMIT fact, and every outlet of every permit
#     at a site inherits one identical point. In this catchment that puts 67 discharge points on 32
#     distinct coordinates - at Brockhill Watercress Farm, 7 outlets across 4 permits (043244, 043245,
#     401057, 401058) land on POINT(383690 92820).
#
#     This is deliberate, not an oversight: the site NGR is what the public register surfaces as "the"
#     discharge location, so the store reproduces what a consumer of that register actually gets - and
#     app/points.html uses it as the worked example of why a spatial join cannot be trusted to
#     reconstruct a link an identifier already states. Scored over the 64 discharge points matchable to
#     a register row, a nearest-sampling-point join gets 38/64 right from the site ref, 56/64 from the
#     outlet ref and 54/64 from the effluent ref (finer is not even monotonically better), against
#     64/64 for water:monitoredAt. To publish finer geometry instead, join OUTLET_GRID_REF or
#     EFFLUENT_GRID_REF on (PERMIT_NUMBER, OUTLET_NUMBER[, EFFLUENT_NUMBER]) rather than permit_ref.
#
#     ANY_VALUE collapses the register's duplicate version rows.
#     Fallback: the second WHEN keeps the sampling point's WGS84 coordinates for any discharge point
#     that still lacks an NGR (a new permit missing from both extracts), so it still maps rather than
#     vanishing. To publish ONLY real NGRs, delete that second WHEN branch. ---
consents_reads = " UNION ALL ".join(
    f"SELECT PERMIT_NUMBER, DISCHARGE_NGR FROM read_csv('{p}', header=true, "
    f"types={{'PERMIT_NUMBER': 'VARCHAR'}})"
    for p in CONSENTS_CSVS
)
con.execute(f"""
CREATE OR REPLACE TABLE discharge_point_geometry AS
WITH consents AS (
    SELECT PERMIT_NUMBER AS permit_ref, ANY_VALUE(DISCHARGE_NGR) AS ngr
    FROM ({consents_reads})
    WHERE DISCHARGE_NGR IS NOT NULL AND DISCHARGE_NGR <> ''
    GROUP BY PERMIT_NUMBER
),
ngr AS (
    SELECT dp.permit_ref, dp.outlet, dp.effluent,
           ngr_easting(c.ngr) AS easting, ngr_northing(c.ngr) AS northing
    FROM discharge_points dp
    JOIN consents c USING (permit_ref)
),
sp AS (
    SELECT m.permit_ref, m.outlet, m.effluent, g.lon, g.lat
    FROM discharge_point_monitoring m
    JOIN sampling_point_geometry g ON g.sp_notation = m.sp_notation
)
SELECT permit_ref, outlet, effluent, wkt FROM (
    SELECT
        dp.permit_ref, dp.outlet, dp.effluent,
        CASE
            WHEN ngr.easting IS NOT NULL
                THEN 'POINT(' || ngr.easting || ' ' || ngr.northing
                     || ') <http://www.opengis.net/def/crs/EPSG/0/27700>'
            WHEN sp.lon IS NOT NULL
                THEN 'POINT(' || sp.lon || ' ' || sp.lat || ')'
        END AS wkt
    FROM discharge_points dp
    LEFT JOIN ngr USING (permit_ref, outlet, effluent)
    LEFT JOIN sp  USING (permit_ref, outlet, effluent)
)
WHERE wkt IS NOT NULL;
""")

# --- Permit version effective/revocation dates, fetched from the public register by
#     fetch_version_dates.py (cached in the committed permit_version_dates.csv). These date each
#     PermitDocument so the app can draw a limit as a step line following the versions. ---
DATES_CSV = HERE / "permit_version_dates.csv"
if DATES_CSV.exists():
    con.execute(f"""
    CREATE OR REPLACE TABLE permit_version_dates AS
    SELECT permit_ref, version, effective_date, revocation_date
    FROM read_csv('{DATES_CSV}', header=true,
        types={{'permit_ref': 'VARCHAR', 'version': 'VARCHAR',
                'effective_date': 'VARCHAR', 'revocation_date': 'VARCHAR'}})
    WHERE effective_date IS NOT NULL AND effective_date <> '';
    """)
else:
    print("NOTE: permit_version_dates.csv missing - run fetch_version_dates.py for the step line.")
    con.execute("""
    CREATE OR REPLACE TABLE permit_version_dates
        (permit_ref VARCHAR, version VARCHAR, effective_date VARCHAR, revocation_date VARCHAR);
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

# --- Condition breaches as PERIODS, not single failing observations. ---
# Collapse the raw rows to one status per (permit, version, substance, phenomenonTime): did that
# observation pass, and if it failed, in which direction(s). GROUPING_PASS_STATUS is constant per
# grouping, so ANY_VALUE is exact.
con.execute("""
CREATE OR REPLACE TABLE obs_status AS
SELECT
    PERMIT_REF AS permit_ref,
    VERSION AS version,
    lpad("determinand.notation", 4, '0') AS substance,
    CAST(phenomenonTime AS TIMESTAMP) AS t,
    ANY_VALUE(OBSERVATION_GROUPING_PASS_STATUS) AS passed,
    BOOL_OR(NOT ROW_PASS_STATUS AND RULE_TYPE = 'MAXIMUM VALUE') AS max_failed,
    BOOL_OR(NOT ROW_PASS_STATUS AND RULE_TYPE = 'MINIMUM VALUE') AS min_failed,
    ANY_VALUE(replace(id, 'https://', 'http://')) AS observation_id
FROM raw
GROUP BY PERMIT_REF, VERSION, lpad("determinand.notation", 4, '0'), CAST(phenomenonTime AS TIMESTAMP);
""")

# A breach is a maximal run of consecutive FAILING observations within a series ordered by time,
# with no passing observation in between (classic gaps-and-islands: the run is identified by the
# difference between the all-rows row number and the same-status row number). applicableFrom/To =
# first/last failing observation in the run. A run is *current* iff it reaches the latest
# observation for that series - i.e. nothing has passed since it started - and is then modelled as
# an OPEN period (no applicableTo); otherwise it is closed. Identity is a hash of the run's start
# (the breach later generalises to rolling percentile-over-period, so it can't be a single-timestamp
# path). Direction of the failing rule(s) picks the subclass (both -> Exceedance).
con.execute("""
CREATE OR REPLACE TABLE breaches AS
WITH ranked AS (
    SELECT *,
        ROW_NUMBER() OVER (PARTITION BY permit_ref, version, substance ORDER BY t)
      - ROW_NUMBER() OVER (PARTITION BY permit_ref, version, substance, passed ORDER BY t) AS island
    FROM obs_status
),
periods AS (
    SELECT permit_ref, version, substance,
        MIN(t) AS start_t, MAX(t) AS end_t,
        BOOL_OR(max_failed) AS max_failed, BOOL_OR(min_failed) AS min_failed
    FROM ranked
    WHERE NOT passed
    GROUP BY permit_ref, version, substance, island
),
series_max AS (
    SELECT permit_ref, version, substance, MAX(t) AS last_t FROM obs_status GROUP BY 1, 2, 3
)
SELECT
    md5(concat_ws('|', p.permit_ref, p.version, p.substance, strftime(p.start_t, '%Y-%m-%dT%H:%M:%S'))) AS breach_id,
    p.permit_ref, p.version, p.substance,
    p.start_t, p.end_t,
    (p.end_t = sm.last_t) AS is_current,
    strftime(p.start_t, '%Y-%m-%dT%H:%M:%S') AS applicable_from,
    CASE WHEN p.end_t = sm.last_t THEN NULL
         ELSE strftime(p.end_t, '%Y-%m-%dT%H:%M:%S') END AS applicable_to,
    CASE WHEN p.max_failed THEN 'ExceedanceBreach'
         WHEN p.min_failed THEN 'ShortfallBreach' END AS breach_class
FROM periods p
JOIN series_max sm USING (permit_ref, version, substance);
""")

# Evidence: every failing observation that falls inside a breach period (the "evidenced set").
con.execute("""
CREATE OR REPLACE TABLE breach_observations AS
SELECT DISTINCT b.breach_id, o.observation_id
FROM obs_status o
JOIN breaches b
  ON o.permit_ref = b.permit_ref AND o.version = b.version AND o.substance = b.substance
 AND NOT o.passed AND o.t >= b.start_t AND o.t <= b.end_t;
""")

# Summary + a couple of integrity checks for the operator
for tbl in ["permits", "permit_versions", "permit_version_dates", "discharge_points",
            "discharge_point_monitoring", "sampling_point_geometry", "discharge_point_geometry",
            "substances", "units", "conditions", "breaches", "breach_observations"]:
    n = con.execute(f"SELECT COUNT(*) FROM {tbl}").fetchone()[0]
    print(f"{tbl:>20}: {n}")

n_current = con.execute("SELECT COUNT(*) FROM breaches WHERE is_current").fetchone()[0]
n_multi = con.execute("SELECT COUNT(*) FROM breaches WHERE end_t > start_t").fetchone()[0]
print(f"    breaches: {n_current} current (open), {n_multi} span multiple observations")
both = con.execute("""
    WITH ranked AS (
        SELECT permit_ref, version, substance, passed, max_failed, min_failed,
            ROW_NUMBER() OVER (PARTITION BY permit_ref, version, substance ORDER BY t)
          - ROW_NUMBER() OVER (PARTITION BY permit_ref, version, substance, passed ORDER BY t) AS island
        FROM obs_status
    )
    SELECT COUNT(*) FROM (
        SELECT 1 FROM ranked WHERE NOT passed
        GROUP BY permit_ref, version, substance, island
        HAVING BOOL_OR(max_failed) AND BOOL_OR(min_failed))
""").fetchone()[0]
if both:
    print(f"NOTE: {both} breach period(s) failed both bounds; classified as ExceedanceBreach.")
unmapped = con.execute("SELECT unit_label FROM units WHERE qudt_iri IS NULL").fetchall()
if unmapped:
    print("NOTE: units with no QUDT mapping (local IRI only):", [u[0] for u in unmapped])
