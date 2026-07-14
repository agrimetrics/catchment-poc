import json
from pathlib import Path

import duckdb
import pandas as pd
from pyproj import Transformer

# This script shreds the source registers into a small star of tables, one row per instance, so
# ontop can materialise Permit / DischargePoint / SamplingPoint / Condition / Limit individuals
# against the DEFRA regulation + water ontologies.
#
# WHAT DEFINES A THING, AND WHAT MERELY DESCRIBES IT
# --------------------------------------------------
# The whole design rests on one rule:
#
#     WHAT EXISTS comes from the REGISTERS.  WHAT HAPPENED comes from the OBSERVATIONS.
#
# A permit, its outlets, the sampling point each outlet is monitored at, and THE LIMITS EACH OUTLET
# IS SUBJECT TO are facts of the permit register (effluents.csv, consents_*.csv, determinands.csv)
# and of the Water Quality Archive. Every one of them is true whether or not anybody sampled there
# this decade. Only the measurements - and the breach judgements derived from them - come from the
# observations, and those live in ttl/breaches/ precisely so nobody confuses our arithmetic with the
# EA's assertions.
#
# THE RULE WAS BROKEN THREE TIMES, IN THE SAME WAY, AND EACH TIME IT DELETED SOMETHING REAL:
#
#   1. EVERY table used to come from the observations CSV, so a thing existed only if it had a
#      numeric result matching a permit rule. Permit 043231 showed 1 of its 2 outlets and
#      400114/CF/01 showed 1 of its 3, because the missing outlets' every 2020-2026 sample reads
#      "No flow/discharge at sampling point" - a true and useful fact, dropped by the numeric filter
#      in link_data.py. Permit 050922 vanished entirely, its only samples being a site inspection.
#
#   2. `register_effluents` carried `WHERE EFF_SAMPLE_POINT IS NOT NULL`, which looks like a harmless
#      guard on the column the sampling-point notation is built from. But that table also defines
#      WHICH OUTLETS EXIST, so the filter silently deleted every outlet the register names no sampling
#      point for. TWENTY-NINE of them, on scoped permits - twelve on 042451 alone, the Blackheath
#      permit whose unlocatable outlets are the subject of app/points.html's fourth worked example.
#
#   3. CONDITIONS were observation-sourced, so a permit limit existed only if somebody had sampled
#      that substance there. Twenty-seven outlets carried NO CONDITION AT ALL while the register
#      plainly limits them - Blackheath's storm overflow to BOD 200 mg/l, the watercress outlets to
#      pH 6-9. The breach engine had nothing to judge them against, and an outlet judged against
#      nothing does not read as "unknown". It reads as NO BREACH.
#
# The same mistake wears a different coat each time: an ABSENCE (of a sample, of a monitoring link, of
# a coordinate) is allowed to decide EXISTENCE. That is the exact error app/points.html exists to warn
# about, committed three times over inside the store that makes the argument. All three are now fixed,
# and the ABORTs and NOTEs below exist so a fourth cannot pass quietly.
#
# The whole database is a drop/replace rebuild from the CSVs, so regulation.duckdb does not
# need to be committed - just re-run this script. Paths resolve relative to this file so it
# can be run from any working directory.

HERE = Path(__file__).resolve().parent          # ttl/regulation
ROOT = HERE.parents[1]                           # repository root
CSV = ROOT / "output_data" / "observations_with_permits_and_rules.csv"
# The permit register. effluents.csv is the outlet-level register: one row per
# (permit, version, outlet, effluent), naming the sampling point that effluent is monitored at
# (EFF_SAMPLE_POINT). It is the source of truth for WHICH OUTLETS EXIST and WHERE EACH IS SAMPLED.
EFFLUENTS_CSV = ROOT / "raw_datasets" / "access_database_csv_files" / "effluents.csv"
# The consents register is the only place the discharge site's own National Grid Reference lives.
# consents_active covers in-force permits; consents_all is a hand-cut extract of the *revoked*
# permits that still carry observations here (absent from the active register). Both files share
# the same column layout.
CONSENTS_CSVS = [
    ROOT / "raw_datasets" / "access_database_csv_files" / "consents_active.csv",
    ROOT / "raw_datasets" / "access_database_csv_files" / "consents_all.csv",
]
# Sampling-point reference data resolved from the EA Water Quality Archive by
# fetch_sampling_points.py: label, geometry in the SOURCE CRS (EPSG:27700), type and status. Covers
# both layers the app shows - the effluent points a permit is monitored at, AND the ambient points
# (rivers, boreholes, bathing waters) that belong to no permit at all and so could never have been
# reached through the permit join.
SAMPLING_POINTS_CSV = HERE / "sampling_points.csv"
# Which determinands each point is actually sampled for, swept from the archive. The measured view
# filters its map on this, so a point missing from the SWEEP file is a point that would silently
# vanish from the map - see the abort below.
SP_DETERMINANDS_CSV = HERE / "sampling_point_determinands.csv"
SP_SWEEP_CSV = HERE / "sampling_point_sweep.csv"

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


# null_handling="special": a grid reference the decoder cannot make sense of returns NULL, and NULL is
# the right answer - the register carries refs like 'TA9999999999' that fall outside the National Grid
# entirely. Under DuckDB's DEFAULT null handling a UDF may not RETURN null, so an undecodable ref
# aborts the build rather than simply having no coordinate. That is precisely backwards for this store:
# "I cannot place this" must be expressible.
con.create_function("ngr_easting", _ngr_easting, ["VARCHAR"], "INTEGER", null_handling="special")
con.create_function("ngr_northing", _ngr_northing, ["VARCHAR"], "INTEGER", null_handling="special")


# --- TWO GEOMETRIES PER FEATURE, and this is a deliberate piece of modelling, not belt-and-braces.
#
#     The EA publishes these points in EPSG:27700 (British National Grid, metres). That is the SOURCE,
#     and the store reproduces it exactly - no reprojection, no rounding, the EA's own numbers.
#
#     But almost no SPARQL engine can COMPUTE with it. GeoSPARQL's geof: functions are defined over
#     CRS84 (WGS84 lon/lat) and engines are not required to reproject; oxigraph, which serves this
#     store, simply returns UNBOUND for a geometry in any other CRS. So a graph that publishes only
#     BNG is a graph whose spatial functions silently do nothing - and "silently" is the problem. The
#     query this project shipped in ttl/designations/TODO.md did exactly that, only worse: because the
#     CRS URI was in the wrong place it was ignored altogether, the engine assumed CRS84, read the
#     easting 389950 as a longitude, computed ~5,400 km, filtered every row out, and answered
#     "no discharges lie near any protected site." A reassuring falsehood, delivered with no warning.
#
#     So the feature carries BOTH, which GeoSPARQL explicitly allows (a geo:Feature may have several
#     geo:hasGeometry, one of them geo:hasDefaultGeometry):
#
#         #geography        EPSG:27700 - the SOURCE, verbatim, for fidelity and for provenance
#         #geography-crs84  CRS84      - DERIVED here, so geof: functions actually work
#
#     CRS84 is the default geometry because it is the one a consumer can compute with, and because
#     GeoSPARQL's own default CRS is CRS84. The BNG one is never derived from it - the direction of
#     travel is always source -> derived, never the reverse.
#     THE REPROJECTION IS NOT A DUCKDB UDF, and that is deliberate. pyproj's Transformer holds C-level
#     state and is NOT thread-safe; DuckDB parallelises scalar UDFs across threads, so registering it as
#     one SEGFAULTS the process as soon as a scan is large enough to fan out across workers. (It appears
#     to work on a small table - a single vector on a single thread - which is the worst way for a bug
#     like this to behave.) So the WKT is built in a table with plain easting/northing columns and the
#     reprojection is done once, here, vectorised over pandas, where pyproj is on one thread and happy.
_T = Transformer.from_crs("EPSG:27700", "EPSG:4326", always_xy=True)

CRS84 = "http://www.opengis.net/def/crs/OGC/1.3/CRS84"
BNG = "http://www.opengis.net/def/crs/EPSG/0/27700"


def add_wkt(df, e="easting", n="northing"):
    """easting/northing columns -> conformant `wkt` (EPSG:27700) and `wkt_crs84` columns.

    The CRS IRI goes FIRST, which is what GeoSPARQL requires (OGC 22-047r1, Requirement 14: a
    wktLiteral is "an optional IRI identifying the coordinate reference system and a required Well
    Known Text description", formed "by concatenating a valid absolute IRI ... enclosed in angled
    brackets ... followed by whitespace as a separator, and a WKT string"). A TRAILING IRI matches the
    grammar's empty-IRI production, so every conformant parser ignores it and Requirement 15 then
    obliges it to assume CRS84 - which is how this store once read a British National Grid easting as a
    longitude and reported that no discharge lies near any protected site.
    """
    df = df.dropna(subset=[e, n]).copy()
    lon, lat = _T.transform(df[e].astype(float).values, df[n].astype(float).values)
    df["wkt"] = (f"<{BNG}> POINT(" + df[e].astype("Int64").astype(str) + " "
                 + df[n].astype("Int64").astype(str) + ")")
    df["wkt_crs84"] = [f"<{CRS84}> POINT({x:.7f} {y:.7f})" for x, y in zip(lon, lat)]
    return df

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

# --- Sampling points, from the Water Quality Archive (fetch_sampling_points.py). Every sampling
#     point the catchment holds observations for, PLUS every one the register names as a permit's
#     effluent sample point. Geometry stays in its published CRS (EPSG:27700) - the numbers are the
#     EA's own and are never reprojected here.
#
#     THE CRS URI IS MOVED TO THE FRONT, and that is a correctness fix, not tidying. GeoSPARQL says a
#     wktLiteral is "an optional URI identifying the coordinate reference system FOLLOWED BY" the WKT.
#     The archive publishes it the other way round:
#
#         POINT(384750 94670) <http://www.opengis.net/def/crs/EPSG/0/27700>     <- what the EA emits
#         <http://www.opengis.net/def/crs/EPSG/0/27700> POINT(384750 94670)     <- what GeoSPARQL says
#
#     A trailing URI is not part of the literal any parser reads, so every GeoSPARQL engine silently
#     ignores it and falls back to the default CRS - which is CRS84, degrees of longitude and latitude.
#     It then reads the easting 384750 as a longitude. That is why the geof:distance query this project
#     shipped returns ~5,400 km for two points a few hundred metres apart, filters them all out, and
#     answers "there are no discharges near any protected site". It is the most dangerous kind of bug
#     in the whole store: not an error, an ANSWER, and a reassuring one.
#
#     The committed CSV keeps the archive's string verbatim (it is a cache of their data, and we do not
#     rewrite what we did not author). The graph publishes it correctly. ---
con.execute(f"""
CREATE OR REPLACE TABLE sampling_points_src AS
SELECT sp_notation, pref_label, type_notation, type_label, status_label,
       CAST(regexp_extract(wkt, 'POINT\\s*\\(\\s*(-?[0-9.]+)', 1) AS DOUBLE) AS easting,
       CAST(regexp_extract(wkt, 'POINT\\s*\\([^ ]+\\s+(-?[0-9.]+)', 1) AS DOUBLE) AS northing
FROM read_csv('{SAMPLING_POINTS_CSV}', header=true, types={{'sp_notation': 'VARCHAR',
    'pref_label': 'VARCHAR', 'wkt': 'VARCHAR', 'type_notation': 'VARCHAR',
    'type_label': 'VARCHAR', 'status_label': 'VARCHAR'}})
WHERE wkt IS NOT NULL AND wkt <> '' AND wkt LIKE '%27700%';
""")
sp_df = add_wkt(con.execute("SELECT * FROM sampling_points_src").df())
con.execute("""
CREATE OR REPLACE TABLE sampling_points AS
SELECT sp_notation, pref_label, type_notation, type_label, status_label, wkt, wkt_crs84
FROM sp_df;
""")

# --- Which determinands each point is actually sampled for, so the measured view can filter its map
#     by the chosen one instead of drawing all 161 and making you click to find out.
#
#     THE SWEEP FILE IS THE GATE, and it is not the same file as the edges. A point the archive holds
#     nothing for contributes no edge rows, so in the edges file it is indistinguishable from a point
#     nobody ever swept - and those mean opposite things. "Nothing is measured here" is a finding;
#     "we never looked" is a stale cache. Filtering a map on the second is how you delete a real,
#     sampled point from the picture and never hear about it. So: every point in the register must
#     appear in the sweep record, or the build stops. (This is the same trap the breach pipeline fell
#     into twice, where an absence in a cached extract was read as an absence in the world.) ---
if not SP_SWEEP_CSV.exists() or not SP_DETERMINANDS_CSV.exists():
    raise SystemExit(
        f"ABORT: {SP_SWEEP_CSV.name} / {SP_DETERMINANDS_CSV.name} missing. The measured view filters "
        f"its sampling points on these; without them it cannot tell 'not sampled for this determinand' "
        f"from 'never asked'.\n  Run: python ttl/regulation/fetch_sampling_point_determinands.py")

con.execute(f"""
CREATE OR REPLACE TABLE sampling_point_sweep AS
SELECT sp_notation, n_observations, n_determinands
FROM read_csv('{SP_SWEEP_CSV}', header=true, types={{'sp_notation': 'VARCHAR',
    'n_observations': 'BIGINT', 'n_determinands': 'BIGINT'}});
""")
con.execute(f"""
CREATE OR REPLACE TABLE sampling_point_determinands AS
SELECT sp_notation, lpad(determinand, 4, '0') AS determinand, n_observations
FROM read_csv('{SP_DETERMINANDS_CSV}', header=true, types={{'sp_notation': 'VARCHAR',
    'determinand': 'VARCHAR', 'n_observations': 'BIGINT'}});
""")

never_swept = [r[0] for r in con.execute("""
    SELECT sp_notation FROM sampling_points
    WHERE sp_notation NOT IN (SELECT sp_notation FROM sampling_point_sweep)
    ORDER BY 1
""").fetchall()]
if never_swept:
    shown = "\n".join(f"    {sp}" for sp in never_swept[:10])
    more = f"\n    ... and {len(never_swept) - 10} more" if len(never_swept) > 10 else ""
    raise SystemExit(
        f"ABORT: the determinand sweep does not cover the register.\n\n"
        f"  {len(never_swept)} sampling point(s) were NEVER SWEPT:\n{shown}{more}\n\n"
        f"  These are not 'nothing is measured here' - nobody asked the archive. The measured view "
        f"would hide them for every determinand, so a sampled point would drop off the map in "
        f"silence.\n  Re-run: python ttl/regulation/fetch_sampling_point_determinands.py")

# --- Sampling-point type vocabulary (rivers / boreholes / watercress farming / storm overflow ...).
#     The archive nests the type as a blank-node skos:Concept with no resolvable IRI of its own, so
#     the store mints one from the notation, exactly as it does for substances. This is what the
#     app's Ambient view colours by. ---
con.execute("""
CREATE OR REPLACE TABLE sampling_point_types AS
SELECT DISTINCT type_notation AS notation, type_label AS pref_label
FROM sampling_points
WHERE type_notation IS NOT NULL AND type_notation <> '';
""")

# --- The permit register, at outlet grain. One row per (permit, version, outlet, effluent), naming
#     the sampling point that effluent is monitored at - OR NOT. sp_notation is NULLABLE, and that is
#     the whole point of this table's shape.
#
#     This used to carry `AND EFF_SAMPLE_POINT IS NOT NULL`, which looks like a harmless guard on the
#     column the sp_notation is built from. It was not harmless: this table also defines WHICH OUTLETS
#     EXIST, so the filter quietly deleted every outlet the register does not name a sampling point
#     for. Twenty-nine of them, on scoped permits - twelve on 042451 alone, the Blackheath permit whose
#     unlocatable outlets are the subject of app/points.html's fourth worked example. The store said a
#     permit had 2 outlets where the register says 14.
#
#     It is the same error as the geometry fallback and the dropped monitoredAt edges, one level up:
#     an outlet with no sampling point is not a non-existent outlet, it is an outlet nobody monitors.
#     Letting the presence of a MONITORING LINK decide what EXISTS is exactly the mistake this store
#     was built to expose. The link is now asserted where the register states it and absent where it
#     does not, and the outlet exists either way. ---
con.execute(f"""
CREATE OR REPLACE TABLE register_effluents AS
SELECT DISTINCT
    CAST(PERMIT_REF AS VARCHAR) AS permit_ref,
    CAST(VERSION AS VARCHAR) AS version,
    CAST(OUTLET_NUMBER AS VARCHAR) AS outlet,
    CAST(EFFLUENT_NUMBER AS VARCHAR) AS effluent,
    CASE WHEN EFF_SAMPLE_POINT IS NOT NULL AND EFF_SAMPLE_POINT <> ''
         THEN EA_REGION || '-' || EFF_SAMPLE_POINT END AS sp_notation
FROM read_csv('{EFFLUENTS_CSV}', header=true, types={{'PERMIT_REF': 'VARCHAR',
    'VERSION': 'VARCHAR', 'OUTLET_NUMBER': 'VARCHAR', 'EFFLUENT_NUMBER': 'VARCHAR'}})
WHERE EA_REGION = 'SW';
""")

# --- SCOPE. The register is national (59k permits); this demonstrator is one catchment. A permit is
#     in scope if it is monitored at a sampling point the catchment holds observations for. That is a
#     property of the REGISTER, not of what happened to be sampled - so once a permit is in, ALL of
#     its outlets come with it, including the ones that have never produced a numeric result AND the
#     ones the register names no sampling point for at all. ---
con.execute("""
CREATE OR REPLACE TABLE scoped_permits AS
SELECT DISTINCT e.permit_ref
FROM register_effluents e
WHERE e.sp_notation IN (
    SELECT DISTINCT "samplingPoint.notation" FROM raw
    UNION
    SELECT sp_notation FROM sampling_points
);
""")

# --- The permit register's LIMITS, unpivoted. determinands.csv is the register's own statement of what
#     each effluent is limited to: one row per (permit, version, outlet, effluent, determinand, month
#     range), carrying up to THREE rules in CODE_n / VAL_n column pairs (e.g. "MINIMUM VALUE 6" and
#     "MAXIMUM VALUE 9" for pH, in one row).
#
#     THIS IS WHERE CONDITIONS NOW COME FROM, and it closes the last big hole in the register/observation
#     split at the top of this file. Conditions used to be built from the OBSERVATIONS - so a permit
#     limit existed only if somebody had sampled that substance at that permit and the result happened
#     to be numeric. Twenty-seven of the catchment's outlets therefore carried NO condition at all,
#     while the register plainly limits them: Blackheath's storm overflow is capped at BOD 200 mg/l and
#     suspended solids 200 mg/l; the watercress outlets at pH 6-9 and solids 20 mg/l. The breach engine
#     had nothing to judge them against, and an outlet judged against nothing does not read as
#     "unknown" - it reads as NO BREACH.
#
#     A limit is a REGISTER fact. It is true whether or not anyone sampled. It comes from the register.
#
#     SEASONS. MONTH_FROM/MONTH_TO are part of the key, not decoration. Permit 040067 is limited to BOD
#     15 mg/l from May to October and 20 mg/l from November to April - tighter in summer, when the river
#     is low and dilutes less. Collapsing the two publishes the winter figure all year and understates
#     the summer obligation by a third. Most rules run 01-12 (the whole year); the ones that do not are
#     real seasonal limits and are kept apart.
#
#     METHOD='ABSOLUTE' keeps the numeric limits and drops COMPARATIVE rules (limits expressed relative
#     to another determinand), which this store has no model for. ---
DETERMINANDS_CSV = ROOT / "raw_datasets" / "access_database_csv_files" / "determinands.csv"
con.execute(f"""
CREATE OR REPLACE TABLE register_rules AS
WITH src AS (
    SELECT CAST(PERMIT_REF AS VARCHAR) AS permit_ref,
           CAST(VERSION AS VARCHAR) AS version,
           CAST(OUTLET_NUMBER AS VARCHAR) AS outlet,
           CAST(EFFLUENT_NUMBER AS VARCHAR) AS effluent,
           lpad(CAST(DETE_CODE AS VARCHAR), 4, '0') AS substance,
           DETE AS substance_label,
           lpad(CAST(MONTH_FROM AS VARCHAR), 2, '0') AS month_from,
           lpad(CAST(MONTH_TO AS VARCHAR), 2, '0') AS month_to,
           UNITS AS unit,
           CODE_1, VAL_1, CODE_2, VAL_2, CODE_3, VAL_3
    FROM read_csv('{DETERMINANDS_CSV}', header=true, types={{'PERMIT_REF': 'VARCHAR',
        'VERSION': 'VARCHAR', 'OUTLET_NUMBER': 'VARCHAR', 'EFFLUENT_NUMBER': 'VARCHAR',
        'DETE_CODE': 'VARCHAR', 'MONTH_FROM': 'VARCHAR', 'MONTH_TO': 'VARCHAR'}})
    WHERE EA_REGION = 'SW' AND METHOD = 'ABSOLUTE'
      AND PERMIT_REF IN (SELECT permit_ref FROM scoped_permits)
)
SELECT DISTINCT permit_ref, version, outlet, effluent, substance, substance_label,
       month_from, month_to, unit, rule_type, CAST(rule_value AS DECIMAL(18,4)) AS rule_value
FROM (
    SELECT * EXCLUDE (CODE_1, VAL_1, CODE_2, VAL_2, CODE_3, VAL_3),
           CODE_1 AS rule_type, VAL_1 AS rule_value FROM src
    UNION ALL
    SELECT * EXCLUDE (CODE_1, VAL_1, CODE_2, VAL_2, CODE_3, VAL_3),
           CODE_2, VAL_2 FROM src
    UNION ALL
    SELECT * EXCLUDE (CODE_1, VAL_1, CODE_2, VAL_2, CODE_3, VAL_3),
           CODE_3, VAL_3 FROM src
)
WHERE rule_type IS NOT NULL AND rule_type <> '' AND rule_value IS NOT NULL;
""")

# --- Permits (one per PERMIT_REF) -> defra-water:WaterDischargePermit.
#     Union with the observations: a permit we hold breaches for stays in the store even if the
#     register extracts have since dropped it (a revoked permit still has a history). ---
con.execute("""
CREATE OR REPLACE TABLE permits AS
SELECT permit_ref FROM scoped_permits
UNION
SELECT DISTINCT PERMIT_REF AS permit_ref FROM raw;
""")

# --- Permit versions (one per PERMIT_REF+VERSION) -> defra-reg:PermitDocument.
#     Still observation-sourced: a PermitDocument's reason to exist here is the Conditions it
#     carries, and those come from the observations join. A scoped permit with no observed
#     condition (e.g. 050922) therefore has outlets but no versioned document - which is exactly
#     what we know about it. ---
con.execute("""
CREATE OR REPLACE TABLE permit_versions AS
SELECT DISTINCT PERMIT_REF AS permit_ref, VERSION AS version
FROM raw;
""")

# --- Discharge points (one per PERMIT_REF+OUTLET+EFFLUENT) -> defra-reg:DischargePoint.
#     From the REGISTER, so every outlet of an in-scope permit exists, sampled or not. Version is
#     collapsed: an outlet is one thing in the world across the permit's versions. ---
con.execute("""
CREATE OR REPLACE TABLE discharge_points AS
SELECT DISTINCT e.permit_ref, e.outlet, e.effluent
FROM register_effluents e
JOIN scoped_permits s USING (permit_ref)
UNION
SELECT DISTINCT PERMIT_REF, OUTLET_NUMBER, EFFLUENT_NUMBER FROM raw
UNION
SELECT DISTINCT permit_ref, outlet, effluent FROM register_rules;
""")

# --- Discharge point -> sampling point (defra-water:monitoredAt). The register states this link; it is
#     the identifier-borne edge that app/points.html sets against a spatial join. EVERY link the
#     register states is asserted - all 102, not just the 96 whose sampling point the Water Quality
#     Archive publishes reference data for.
#
#     This used to carry an inner JOIN to sampling_points, which silently discarded any edge whose
#     sampling point 404s at the archive. Six did. They are not errors: the points EXIST - the register
#     names them, the EA samples them - the archive just does not publish them openly. Dropping the edge
#     turned "we hold no reference data for this point" into "this outlet is monitored nowhere", which
#     is the same absence-rendered-as-a-value mistake as the geometry fallback that used to sit below.
#
#     Asserting the edge to an IRI we cannot dereference is the linked-data-native answer, and the one
#     app/points.html argues for: an IRI is a NAME, not a promise that it resolves. The identifier join
#     keeps working across a boundary the map cannot cross. What we must not do is let the reference
#     data decide what exists - so the unresolvable points are typed (see unpublished_sampling_points
#     below) and simply carry no label, no geometry and no type. ---
con.execute("""
CREATE OR REPLACE TABLE discharge_point_monitoring AS
SELECT DISTINCT e.permit_ref, e.outlet, e.effluent, e.sp_notation
FROM register_effluents e
JOIN scoped_permits s USING (permit_ref)
WHERE e.sp_notation IS NOT NULL;
""")

# --- Sampling points the REGISTER names but the ARCHIVE does not publish. They are typed, so the
#     monitoredAt edge above lands on something rather than dangling, and they are marked with the
#     reason - the store says "I know this point exists and I do not know where it is", which is a
#     different and far more useful statement than saying nothing. They carry no geometry, so no map
#     draws them and no proximity join scores them. ---
con.execute("""
CREATE OR REPLACE TABLE unpublished_sampling_points AS
SELECT DISTINCT m.sp_notation
FROM discharge_point_monitoring m
WHERE m.sp_notation NOT IN (SELECT sp_notation FROM sampling_points);
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
#
#     NO FALLBACK. An outlet whose permit carries no site NGR gets NO GEOMETRY, and is simply not
#     drawn on any map. This used to fall back to the coordinates of the sampling point the outlet is
#     monitored at, so that it "still mapped rather than vanishing" — and that was a bad trade, for
#     three reasons:
#
#       1. It is a fabricated fact. It places the outfall exactly ON the watercourse location it is
#          sampled at, asserting the very conflation this store exists to disprove: the outfall and
#          the sampling point are DIFFERENT PLACES. Publishing a coordinate we do not have, in the
#          one graph whose argument is "do not trust coordinates", is self-defeating.
#       2. It corrupts the scoring. Those outlets sat 0 m from their own sampling point, so a
#          nearest-point join scored them correct for free — flattering proximity with points it did
#          not earn, in exactly the comparison app/points.html exists to make.
#       3. It made the map lie. The outlet's marker landed on top of the sampling point's marker, so a
#          leg drawn from ANOTHER permit's outlet to that shared sampling point appeared to be a link
#          between two discharge points. (In this catchment: 401025's outlets appeared linked to
#          040091's.)
#
#     An outlet with no coordinate is the truth — the register does not say where it is — and it costs
#     nothing that matters, because water:monitoredAt still names its sampling point. That is the whole
#     thesis: the identifier join does not need the geometry to be right, or to exist at all. ---
consents_reads = " UNION ALL ".join(
    f"SELECT PERMIT_NUMBER, PERMIT_VERSION, OUTLET_NUMBER, EFFLUENT_NUMBER, "
    f"DISCHARGE_NGR, OUTLET_GRID_REF, EFFLUENT_GRID_REF "
    f"FROM read_csv('{p}', header=true, types={{'PERMIT_NUMBER': 'VARCHAR', "
    f"'OUTLET_NUMBER': 'VARCHAR', 'EFFLUENT_NUMBER': 'VARCHAR'}})"
    for p in CONSENTS_CSVS
)
site_df = con.execute("""
WITH consents AS (
    SELECT PERMIT_NUMBER AS permit_ref, ANY_VALUE(DISCHARGE_NGR) AS ngr
    FROM (""" + consents_reads + """)
    WHERE DISCHARGE_NGR IS NOT NULL AND DISCHARGE_NGR <> ''
    GROUP BY PERMIT_NUMBER
)
SELECT dp.permit_ref, dp.outlet, dp.effluent,
       ngr_easting(c.ngr) AS easting, ngr_northing(c.ngr) AS northing
FROM discharge_points dp
JOIN consents c USING (permit_ref)
WHERE ngr_easting(c.ngr) IS NOT NULL;
""").df()
site_df = add_wkt(site_df)
con.execute("CREATE OR REPLACE TABLE discharge_point_geometry AS "
            "SELECT permit_ref, outlet, effluent, wkt, wkt_crs84 FROM site_df")

# --- THE OTHER TWO GRID REFERENCES, PUBLISHED. ---------------------------------------------------
#
#     The store's headline geometry is the SITE reference above, and app/points.html's whole case rests
#     on how badly a proximity join does with it. The obvious objection - and it is a fair one - is that
#     we picked the coarsest of the three coordinates the register carries and then complained that
#     proximity could not use it.
#
#     So the store publishes all three, keyed at the grain each one actually belongs to:
#
#         DISCHARGE_NGR      the SITE      keyed on permit          -> #geography          (the default)
#         OUTLET_GRID_REF    the OUTLET    keyed on permit+outlet   -> #geography-outlet
#         EFFLUENT_GRID_REF  the EFFLUENT  keyed on permit+outlet+effluent -> #geography-effluent
#
#     Every one is tagged with `wr:gridReferenceLevel` so a query asks for the level it means and no
#     query silently fans out across three geometries (that has already bitten twice - see app.js).
#
#     The point of publishing them is that Points apart can now COMPUTE the comparison at render time
#     instead of asserting it, and put the opposition's best case on the screen: the outlet reference is
#     nearly twice as good as the site reference, and it still only reaches about three in four. The
#     argument is not "our coordinate is bad". It is that a coordinate - ANY of them - is the wrong
#     thing to join on when an identifier already states the answer. Handing the reader the strongest
#     version of the counter-argument, with the numbers, is the only way to make that stick.
#
#     Note the finest reference is NOT the most accurate (see the build report): precision and accuracy
#     are different things, and "just use the most precise coordinate" is not a rule that saves you. ---
alt_df = con.execute("""
WITH src AS (
    SELECT PERMIT_NUMBER AS permit_ref,
           CAST(OUTLET_NUMBER AS VARCHAR) AS outlet,
           CAST(EFFLUENT_NUMBER AS VARCHAR) AS effluent,
           ANY_VALUE(OUTLET_GRID_REF) AS outlet_ngr,
           ANY_VALUE(EFFLUENT_GRID_REF) AS effluent_ngr
    FROM (""" + consents_reads + """)
    GROUP BY 1, 2, 3
)
SELECT dp.permit_ref, dp.outlet, dp.effluent, 'outlet' AS level,
       ngr_easting(s.outlet_ngr) AS easting, ngr_northing(s.outlet_ngr) AS northing
FROM discharge_points dp JOIN src s USING (permit_ref, outlet, effluent)
WHERE ngr_easting(s.outlet_ngr) IS NOT NULL
UNION ALL
SELECT dp.permit_ref, dp.outlet, dp.effluent, 'effluent' AS level,
       ngr_easting(s.effluent_ngr), ngr_northing(s.effluent_ngr)
FROM discharge_points dp JOIN src s USING (permit_ref, outlet, effluent)
WHERE ngr_easting(s.effluent_ngr) IS NOT NULL;
""").df()
alt_df = add_wkt(alt_df)
con.execute("CREATE OR REPLACE TABLE discharge_point_geometry_alt AS "
            "SELECT permit_ref, outlet, effluent, level, wkt, wkt_crs84 FROM alt_df")

# --- Permit version effective/revocation dates, fetched from the public register by
#     fetch_version_dates.py (cached in the committed permit_version_dates.csv). These date each
#     PermitDocument so the app can draw a limit as a step line following the versions. ---
#     Dates are emitted as xsd:dateTime, which is the range defra-core:applicableFrom/applicableTo
#     declare. The register gives a plain date, so it is widened to midnight - "2011-03-01" is not a
#     legal xsd:dateTime, "2011-03-01T00:00:00" is. Every graph in this store now agrees on the
#     datatype; they used to disagree (regulation and WINEP said xsd:date, breaches and SFI said
#     xsd:dateTime), which meant a cross-source date filter matched NOTHING and said so silently.
DATES_CSV = HERE / "permit_version_dates.csv"
if DATES_CSV.exists():
    con.execute(f"""
    CREATE OR REPLACE TABLE permit_version_dates AS
    SELECT permit_ref, version,
           effective_date || 'T00:00:00' AS effective_date,
           CASE WHEN revocation_date IS NULL OR revocation_date = '' THEN ''
                ELSE revocation_date || 'T00:00:00' END AS revocation_date
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

# --- Substances / parameters (the determinand concept scheme) -> skos:Concept + sosa:ObservableProperty.
#
#     TWO SCHEMES, because there are two different true statements to make and the app needs to tell
#     them apart:
#
#       wr:substance            every determinand the REGISTER regulates in this catchment - all 38.
#                               This is what the permits actually say. It includes flow and dry-weather
#                               flow, weir settings, storm-overflow telemetry (spill days, FPF data
#                               coverage), heavy metals, pesticides and solvents, and a pass/fail site
#                               inspection. They are real conditions and the store now holds them.
#
#       wr:substance/monitored  the subset the catchment holds a TIME SERIES for - the 12 the archive's
#                               observations cover. These are the ones the app can chart, so they are
#                               the ones its substance filter offers.
#
#     A concept is legitimately in both. What we must not do is let the second scheme define the first,
#     which is what the old observation-sourced substances table did: the store's vocabulary WAS the
#     list of things somebody had sampled, so a permit condition on a determinand nobody measured did
#     not exist. `monitored` is a fact about the OBSERVATION SET, not about the permit. ---
con.execute("""
CREATE OR REPLACE TABLE substances AS
SELECT
    r.substance AS notation,
    ANY_VALUE(r.substance_label) AS pref_label,
    r.substance IN (SELECT DISTINCT lpad("determinand.notation", 4, '0') FROM raw) AS monitored
FROM register_rules r
GROUP BY r.substance;
""")
# The canonical EA label wins over the register's abbreviated DETE where the codelist knows the code.
codelist = json.load(open(ROOT / "raw_datasets" / "determinand_codelist.json"))
labels_df = pd.DataFrame([{"notation": m["notation"].zfill(4), "ea_label": m["prefLabel"]}
                          for m in codelist])
con.register("ea_labels", labels_df)
con.execute("""
CREATE OR REPLACE TABLE substances AS
SELECT s.notation, COALESCE(e.ea_label, s.pref_label) AS pref_label, s.monitored
FROM substances s LEFT JOIN ea_labels e USING (notation);
""")

# --- Units. Mint a local unit IRI per distinct unit, linking to a QUDT unit where confidently known.
#     Sourced from the register AND the observations: the register sets the limit's unit, the archive
#     reports the sample's. Unmapped units keep a local IRI and are listed at the end of the build -
#     a local IRI with a label is honest; a wrong QUDT link is not. ---
con.execute("""
CREATE OR REPLACE TABLE unit_map AS
SELECT * FROM (VALUES
    ('MILLIGRAM PER LITRE',  'http://qudt.org/vocab/unit/MilliGM-PER-L'),
    ('MICROGRAM PER LITRE',  'http://qudt.org/vocab/unit/MicroGM-PER-L'),
    ('NANOGRAM PER LITRE',   'http://qudt.org/vocab/unit/NanoGM-PER-L'),
    ('PERCENTAGE',           'http://qudt.org/vocab/unit/PERCENT'),
    ('LITRE PER SECOND',     'http://qudt.org/vocab/unit/L-PER-SEC'),
    ('CUBIC METRE PER DAY',  'http://qudt.org/vocab/unit/M3-PER-DAY'),
    ('NUMBER',               'http://qudt.org/vocab/unit/NUM')
) AS t(unit_label, qudt_iri);
""")
con.execute("""
CREATE OR REPLACE TABLE units AS
WITH all_units AS (
    SELECT DISTINCT unit FROM register_rules WHERE unit IS NOT NULL AND unit <> ''
    UNION
    SELECT DISTINCT unit FROM raw WHERE unit IS NOT NULL AND unit <> ''
)
SELECT
    u.unit AS unit_label,
    lower(replace(replace(replace(u.unit, ' ', '-'), '/', '-'), '.', '')) AS unit_slug,
    m.qudt_iri AS qudt_iri
FROM all_units u
LEFT JOIN unit_map m ON u.unit = m.unit_label;
""")

# --- Statistical modifiers: the vocabulary that says WHAT a limit value means.
#
#     A permit limit is not just a number. The register's RULE_TYPE says whether "20 mg/l" is a
#     value no single sample may exceed, or one the discharge must sit under 95% of the time, or
#     a 12-month mean - three very different obligations that were previously flattened into one
#     unqualified "upperBound". At a sewage works the 95th percentile is the BINDING limit and the
#     MAXIMUM is an upper-tier backstop 2-4x looser, so publishing only the maximum made every such
#     permit read far slacker than it is.
#
#     These concepts ALREADY EXIST in the store: ttl/winep mints wr:statistical-modifier/{slug} for
#     WINEP's *proposed* limits, following the Agrimetrics application profile (iop:StatisticalModifier,
#     https://agrimetrics.github.io/application-profile/#iop-statisticalmodifier). Regulation adopts the
#     SAME concepts for *current* limits - that is what makes a current limit and a proposed limit
#     comparable. prefLabels are therefore kept byte-identical to WINEP's or the concept would end up
#     with two skos:prefLabels; anything extra goes in altLabel.
#
#     MEAN VALUE maps onto 'annual-average' rather than a new concept because the EA defines the mean
#     compliance limit AS an annual 12-month mean - the same thing WINEP's "annual average" column means.
#
#     bound_kind: MAXIMUM / 95 PERCENTILE / MEAN VALUE are all UPPER bounds; only MINIMUM is a lower
#     bound. The statistic, not the bound direction, is what tells them apart.
GUIDANCE = ("https://www.gov.uk/government/publications/"
            "site-specific-quality-numeric-permit-limits-discharges-to-surface-water-and-groundwater/"
            "site-specific-quality-numeric-permit-limits-discharges-to-surface-water-and-groundwater")
STATISTICS = [
    # rule_type,       slug,             bound_kind, label (must match ttl/winep), altLabel, definition
    ("MAXIMUM VALUE",  "maximum",        "upper", "Maximum (absolute)", None,
     "A concentration that no sample result must exceed. Assessed per sample: if a result exceeds "
     "it, that is a failure. Where a permit also carries a 95th-percentile limit for the same "
     "substance, this maximum is the upper-tier backstop and the percentile is the binding limit."),
    ("MINIMUM VALUE",  "minimum",        "lower", "Minimum (absolute)", None,
     "A concentration that no sample result must fall below. Assessed per sample."),
    ("95 PERCENTILE",  "percentile-95",  "upper", "95th percentile", "95 percentile",
     "A concentration the discharge must be under at least 95% of the time. NOT a per-sample rule: "
     "assessed over a 12-month period, where each sample above the value is a look-up-table (LUT) "
     "exceedance and the permit fails only if the count of exceedances is greater than the maximum "
     "allowed for that number of samples."),
    ("MEAN VALUE",     "annual-average", "upper", "Annual average", "Mean value",
     "The mean of the pre-scheduled sample results over 12 consecutive months, used to limit the "
     "overall load of a substance with low acute toxicity. NOT a per-sample rule: the permit fails "
     "if the lower bound of the 90% confidence interval of the mean (mean minus t times the standard "
     "error of the mean) exceeds the value."),
    ("MEDIAN",         "median",         "upper", "Median", None,
     "The middle sample result over the assessment period. NOT a per-sample rule."),
]
stats_rows = ",\n    ".join(
    "(" + ", ".join("NULL" if v is None else "'" + str(v).replace("'", "''") + "'"
                    for v in (rule, slug, kind, label, alt, defn, GUIDANCE)) + ")"
    for rule, slug, kind, label, alt, defn in STATISTICS
)
con.execute(f"""
CREATE OR REPLACE TABLE statistics AS
SELECT * FROM (VALUES
    {stats_rows}
) AS t(rule_type, slug, bound_kind, label, alt_label, definition, source);
""")

# Every rule type the source actually uses must be known to the vocabulary, or its limits would be
# silently dropped on the join below. Fail loudly rather than publish a permit missing a limit.
unknown = con.execute("""
    SELECT DISTINCT rule_type FROM register_rules
    WHERE rule_type NOT IN (SELECT rule_type FROM statistics);
""").fetchall()
if unknown:
    raise SystemExit(f"ABORT: RULE_TYPE(s) with no statistical modifier mapped: {[u[0] for u in unknown]}")

# --- Conditions: one per (permit, version, OUTLET, EFFLUENT, substance) - the grain the register
#     actually sets limits at. The unit is constant per condition (validated below).
#
#     THIS GRAIN IS THE FIX. A Condition used to be keyed at (permit, version, substance), which is
#     coarser than the law: the register sets a limit per EFFLUENT, and one permit's effluents can
#     carry DIFFERENT limits for the same substance. Permit 042116 (Milborne St Andrew STW) is the
#     worked example - three effluents on outlet 1, sampled at three different points:
#
#         effluent 1 (SW-50440194):  BOD 15 mg/l 95%ile,  suspended solids 25 mg/l
#         effluent 2 (SW-50440001):  BOD 25 mg/l 95%ile,  suspended solids 35 mg/l
#
#     At the coarse grain those clashed, and MAX() resolved the clash by publishing the LOOSEST value.
#     So the store told the world effluent 1 was permitted 25 mg/l of BOD when the register says 15 -
#     67% looser than the law, on a permit that is also a WINEP targetPermit, so the app's
#     current-vs-proposed comparison ran off the loosened number. reg:limitStatement carried the truth
#     verbatim all along ("95 PERCENTILE 15 ...; 95 PERCENTILE 25 ..."), but nothing READ it: every
#     query, the breach engine and the WINEP comparison read the structured bound.
#
#     At this grain the clash cannot arise - there is exactly one value per (permit, version, outlet,
#     effluent, substance, statistic), verified by the ABORT below. No aggregate has to choose.
#
#     The cost is that the Condition IRIs move (they now carry /outlet/{n}/effluent/{n}/), so
#     ttl/winep's reg:continuesCondition and ttl/breaches' reg:breachesCondition move with them. Both
#     are rebuilt from this database, so both follow automatically. ---
con.execute("""
CREATE OR REPLACE TABLE conditions AS
SELECT
    permit_ref, version, outlet, effluent, substance,
    lower(replace(replace(replace(ANY_VALUE(unit), ' ', '-'), '/', '-'), '.', '')) AS unit_slug
FROM register_rules
GROUP BY permit_ref, version, outlet, effluent, substance;
""")

# --- Condition bounds: one per (condition, statistic). This is the shape change - a Limit now carries
#     ONE BOUND PER STATISTIC rather than a single anonymous upper and lower value. Bounds are keyed by
#     the statistic slug, never by the source column position: the register puts them in no fixed order
#     (permit 042451 carries the maximum in CODE_1 and the percentile in CODE_2; permit 401747 does the
#     reverse), so position carries no meaning.
#
#     Values -> DECIMAL so they render in plain notation (no scientific).
#
#     ONE VALUE PER BOUND, NO AGGREGATE. At the (permit, version, outlet, effluent, substance,
#     statistic) grain the register states exactly one value, so ANY_VALUE is a formality rather than a
#     choice - and the ABORT below proves it, rather than asking you to trust it. This is what replaced
#     the old MAX(): see the note on `conditions` above for what MAX() was quietly doing. ---
#     ONE LIMIT PER STATISTIC PER SEASON. A defra-reg:Limit is a single obligation with a single value.
#     A Condition ("this outlet is regulated for BOD") holds SEVERAL of them, and they are not
#     interchangeable: the 95th percentile is what the permit requires, the MAXIMUM is an upper-tier
#     backstop 2-4x looser, and at permit 040067 the percentile itself changes with the month (15 mg/l
#     May-Oct, 20 mg/l Nov-Apr).
#
#     This shape is what lets a breach say WHICH obligation it broke. reg:breachesLimit points at the
#     Limit, and because each Limit is one statistic in one season, that is a complete answer. The old
#     shape hung every bound off ONE Limit per condition, so naming the Limit did not distinguish a
#     single sample over an absolute ceiling from a year-long statistical failure - which is why the
#     store had to invent a `reg:breachesBound` predicate under DEFRA's namespace to say it. With this
#     shape the invented term is unnecessary and it is gone.
#
#     `season` is '' for the year-round case (months 01-12), so the overwhelming majority of Limit IRIs
#     keep their plain `#limit-{statistic}` shape and only the genuinely seasonal ones carry
#     `-{from}{to}`. ---
MONTH_NAMES = ("'January','February','March','April','May','June','July','August','September',"
               "'October','November','December'")
con.execute(f"""
CREATE OR REPLACE TABLE condition_bounds AS
SELECT
    r.permit_ref, r.version, r.outlet, r.effluent, r.substance,
    s.slug AS statistic,
    s.bound_kind,
    r.month_from, r.month_to,
    CASE WHEN r.month_from = '01' AND r.month_to = '12' THEN ''
         ELSE '-' || r.month_from || r.month_to END AS season,
    ANY_VALUE(r.rule_value) AS value,
    lower(replace(replace(replace(ANY_VALUE(r.unit), ' ', '-'), '/', '-'), '.', '')) AS unit_slug,
    -- the register's own words for THIS obligation, carried onto the Limit it describes
    ANY_VALUE(
        r.rule_type || ' '
        || regexp_replace(regexp_replace(CAST(r.rule_value AS VARCHAR), '0+$', ''), '\\.$', '')
        || ' ' || r.unit
        || CASE WHEN r.month_from = '01' AND r.month_to = '12' THEN ''
                ELSE ' (' || list_extract([{MONTH_NAMES}], CAST(r.month_from AS INTEGER))
                     || ' to ' || list_extract([{MONTH_NAMES}], CAST(r.month_to AS INTEGER)) || ')' END
    ) AS statement
FROM register_rules r
JOIN statistics s ON s.rule_type = r.rule_type
GROUP BY r.permit_ref, r.version, r.outlet, r.effluent, r.substance,
         s.slug, s.bound_kind, r.month_from, r.month_to;
""")

# The claim the grain above rests on: at the register's own grain no bound has two values, so nothing
# had to be chosen. Checked, not assumed - if the register ever does state two, this must fail rather
# than silently pick one (which is precisely the bug this replaced).
ambiguous = con.execute("""
    SELECT permit_ref, version, outlet, effluent, substance, s.slug, month_from, month_to,
           COUNT(DISTINCT rule_value)
    FROM register_rules r JOIN statistics s ON s.rule_type = r.rule_type
    GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
    HAVING COUNT(DISTINCT rule_value) > 1;
""").fetchall()
if ambiguous:
    raise SystemExit(
        f"ABORT: {len(ambiguous)} bound(s) carry more than one value at the register's own grain "
        f"(permit, version, outlet, effluent, substance, statistic, season): {ambiguous[:5]}. "
        f"Publishing either one would be a guess. Resolve the source before rebuilding.")

# --- Limit statements: what the register ACTUALLY SAYS, carried verbatim alongside the structured
#     bounds. defra-reg:limitStatement is defined for use "in place of (or ALONGSIDE) a quantity-value
#     bound", and alongside is the point: the bounds above are our INTERPRETATION of the register's
#     CODE_n/VAL_n columns, and a reader is entitled to see the source in the source's own words rather
#     than take our structuring on trust. Every Limit gets one - not just the ones that resisted parsing.
#
#     Rendered from the register's own tokens (RULE_TYPE, VAL_n, UNITS), e.g.
#         "95 PERCENTILE 20 MILLIGRAM PER LITRE; MAXIMUM VALUE 48 MILLIGRAM PER LITRE"
#     Ordered by rule type so the string is stable across rebuilds. Trailing zeros are trimmed off the
#     DECIMAL rendering so a limit of 20 reads "20", not "20.0000". ---
#     Each Limit carries the register's words for ITS OWN obligation - "95 PERCENTILE 15 MILLIGRAM PER
#     LITRE (May to October)" - built alongside the bound in `condition_bounds` above. There is no
#     separate statement table: a statement belongs to the limit it states, and now that each statistic
#     and season is its own defra-reg:Limit, that is exactly where it can sit. Previously one Limit per
#     condition carried a single ";"-joined sentence covering several different obligations, which is
#     what a Limit had to do when it was the only place to put it. ---

# --- Substance alignment. The permit register codes Total Nitrogen 9686; WINEP's proposed-limit columns
#     code it 9194. The EA determinand codelist gives BOTH the label "Nitrogen, Total as N" - they are the
#     same observable property under two notations. Without this triple a current nitrogen limit and a
#     proposed nitrogen limit never meet, and the catchment's whole nitrogen story stays untellable. Only
#     emitted when the register side is actually present. ---
#     The alias is minted as a real skos:Concept (notation, labels) so the duplication is documented
#     rather than left as a bare IRI - but deliberately WITHOUT skos:inScheme, because the app builds
#     its substance filter from the concept scheme and would otherwise list "Nitrogen, Total as N"
#     twice, only one of which has any observations behind it. The scheme holds the codes the data
#     actually uses; the alias hangs off its canonical concept by skos:exactMatch. ---
con.execute("""
CREATE OR REPLACE TABLE substance_aliases AS
SELECT * FROM (VALUES
    ('9686', '9194', 'Nitrogen, Total as N', 'Nitrogen Tot')
) AS t(notation, alias, alias_label, alias_alt_label)
WHERE notation IN (SELECT notation FROM substances);
""")

# --- Condition breaches have MOVED to ttl/breaches/ -------------------------------------------
#
# A permit, a condition and a limit are ASSERTED facts - the EA published them and this graph
# reproduces them. A breach is a DERIVED judgement: nobody published it, we computed it. Keeping
# both in one file invites a reader to treat our arithmetic with the register's authority, so the
# assessment now lives in its own pipeline and its own graph (ttl/breaches.ttl).
#
# The code that used to sit here was also wrong in two ways that ttl/breaches/breaches_to_db.py
# fixes: it judged every observation against EVERY version of the permit (including versions
# revoked years before the sample was taken - 64 breach rows for 39 real events), and it ran on an
# observation set with all the 'less than' non-detects dropped, which shrinks the sample count and
# manufactures 95-percentile failures. See ttl/breaches/README.md.

# Summary + a couple of integrity checks for the operator
for tbl in ["permits", "permit_versions", "permit_version_dates", "discharge_points",
            "discharge_point_monitoring", "sampling_points", "unpublished_sampling_points",
            "sampling_point_types", "discharge_point_geometry",
            "substances", "units", "statistics", "conditions", "condition_bounds",
            "register_rules", "substance_aliases"]:
    n = con.execute(f"SELECT COUNT(*) FROM {tbl}").fetchone()[0]
    print(f"{tbl:>20}: {n}")

# The two failure modes app/points.html is built to show, counted at build time so the page's prose
# can be checked against the data rather than trusted. (1) How many discharge points share their
# published coordinate with another outlet - the site NGR is a SITE fact inherited by every outlet of
# every permit there, so a map collapses them onto one dot. (2) How many outlets fall back to their
# sampling point's coordinate because the consents extracts carry no NGR for that permit - those sit
# exactly ON their sampling point, which is not a real discharge location.
stacked, coords, total_dp = con.execute("""
    WITH by_coord AS (SELECT wkt, COUNT(*) AS n FROM discharge_point_geometry GROUP BY wkt)
    SELECT COALESCE(SUM(CASE WHEN n > 1 THEN n END), 0), COUNT(*), COALESCE(SUM(n), 0) FROM by_coord
""").fetchone()
print(f"  discharge points: {total_dp} on {coords} distinct coordinates; "
      f"{stacked} share a coordinate with another outlet")

# Outlets the register gives us no location for. They keep their identity and their monitoredAt edge;
# they simply are not drawn. (The old check here tested `wkt NOT LIKE '%27700%'` to spot the
# now-deleted sampling-point fallback — which never fired, because the fallback copied a sampling
# point's WKT and that carries the EPSG:27700 CRS URI too. It reported a clean bill of health while
# 6 outlets were being published at fabricated coordinates. Compare against the source, not a string.)
no_geom = con.execute("""
    SELECT COUNT(*) FROM discharge_points dp
    WHERE NOT EXISTS (SELECT 1 FROM discharge_point_geometry g
                      WHERE g.permit_ref = dp.permit_ref AND g.outlet = dp.outlet
                        AND g.effluent = dp.effluent)
""").fetchone()[0]
if no_geom:
    print(f"NOTE: {no_geom} discharge point(s) have no site NGR in the consents extracts, so they are "
          f"published with NO geometry (never a guessed one). water:monitoredAt still names their "
          f"sampling point — which is the point.")

# Discharge points that land exactly on their own sampling point. With the fallback gone this can no
# longer be an artefact of ours — the geometry above is built ONLY from the consents register — so any
# coincidence left is the register and the archive genuinely agreeing. It still deserves a mention,
# for two reasons: the site NGR is a coarse (100 m) reference, so agreement may be rounding rather
# than truth; and such an outlet sits 0 m from its sampling point, which hands a nearest-point join a
# free correct answer it did not earn. Reported, not fixed — it is what the sources say.
coincident = con.execute("""
    SELECT g.permit_ref, g.outlet, g.effluent, m.sp_notation
    FROM discharge_point_geometry g
    JOIN discharge_point_monitoring m USING (permit_ref, outlet, effluent)
    JOIN sampling_points p ON p.sp_notation = m.sp_notation
    WHERE g.wkt = p.wkt
""").fetchall()
if coincident:
    pairs = ", ".join(f"{p}/{o}/{e} = {sp}" for p, o, e, sp in coincident)
    print(f"NOTE: {len(coincident)} discharge point(s) coincide with their own sampling point IN THE "
          f"SOURCES (coarse 100 m site NGR): {pairs}. They score a free hit for any proximity join.")

unmonitored = con.execute("""
    SELECT COUNT(*) FROM discharge_points dp
    WHERE NOT EXISTS (SELECT 1 FROM discharge_point_monitoring m
                      WHERE m.permit_ref = dp.permit_ref AND m.outlet = dp.outlet
                        AND m.effluent = dp.effluent)
""").fetchone()[0]
if unmonitored:
    print(f"NOTE: {unmonitored} discharge point(s) name no sampling point at all in the register.")

unpublished = [r[0] for r in con.execute(
    "SELECT sp_notation FROM unpublished_sampling_points ORDER BY 1").fetchall()]
if unpublished:
    print(f"NOTE: {len(unpublished)} sampling point(s) are named by the register but not published by "
          f"the Water Quality Archive: {', '.join(unpublished)}. water:monitoredAt is asserted to them "
          f"anyway - an IRI is a name, not a promise that it dereferences. They carry no geometry, so "
          f"nothing draws or scores them.")

print("       bounds by statistic:")
for slug, kind, n in con.execute("""
    SELECT statistic, bound_kind, COUNT(*) FROM condition_bounds GROUP BY 1, 2 ORDER BY 3 DESC
""").fetchall():
    print(f"{slug:>26} ({kind}): {n}")

# A condition whose unit is not constant would make its bounds incomparable.
mixed_units = con.execute("""
    SELECT COUNT(*) FROM (
        SELECT 1 FROM register_rules
        GROUP BY permit_ref, version, outlet, effluent, substance
        HAVING COUNT(DISTINCT unit) > 1)
""").fetchone()[0]
if mixed_units:
    print(f"WARNING: {mixed_units} condition(s) carry more than one unit; ANY_VALUE picked arbitrarily.")

# What the old COARSE (permit, version, substance) grain was hiding, reported so the re-key earns its
# keep. Each of these is a limit the store used to publish at the LOOSEST of several real values.
per_effluent = con.execute("""
    SELECT r.permit_ref, r.version, r.substance_label, s.slug,
           COUNT(DISTINCT r.rule_value), MIN(r.rule_value), MAX(r.rule_value)
    FROM register_rules r JOIN statistics s ON s.rule_type = r.rule_type
    GROUP BY r.permit_ref, r.version, r.substance_label, r.substance, s.slug
    HAVING COUNT(DISTINCT r.rule_value) > 1
    ORDER BY 1, 3, 2
""").fetchall()
if per_effluent:
    print(f"NOTE: {len(per_effluent)} (permit, version, substance) limit(s) differ across EFFLUENT or "
          f"SEASON. The old coarse grain collapsed each to MAX() - the loosest. Now published apart:")
    for ref, ver, sub, stat, n, lo, hi in per_effluent:
        print(f"       {ref} v{ver} {sub} ({stat}): {n} values, {lo:g}..{hi:g} "
              f"- was published as {hi:g} for the whole permit")

# Seasonal limits, called out on their own: the register tightens these in summer.
seasonal = con.execute("""
    SELECT DISTINCT permit_ref, substance_label, month_from, month_to, rule_type, rule_value
    FROM register_rules WHERE NOT (month_from = '01' AND month_to = '12')
    ORDER BY 1, 2, 3
""").fetchall()
if seasonal:
    permits = sorted({r[0] for r in seasonal})
    print(f"NOTE: {len(seasonal)} SEASONAL rule(s) on permit(s) {', '.join(permits)} - the limit "
          f"changes with the month. Bounds carry their month range; the breach engine judges each "
          f"sample against the bound in force in the month it was taken.")

unmapped = con.execute("SELECT unit_label FROM units WHERE qudt_iri IS NULL").fetchall()
if unmapped:
    print("NOTE: units with no QUDT mapping (local IRI only):", [u[0] for u in unmapped])
