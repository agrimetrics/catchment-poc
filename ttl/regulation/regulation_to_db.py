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
    SELECT DISTINCT RULE_TYPE FROM raw
    WHERE RULE_TYPE IS NOT NULL AND RULE_TYPE NOT IN (SELECT rule_type FROM statistics);
""").fetchall()
if unknown:
    raise SystemExit(f"ABORT: RULE_TYPE(s) with no statistical modifier mapped: {[u[0] for u in unknown]}")

# --- Conditions: one per (permit, version, substance). The unit is constant per condition (validated
#     below). ---
con.execute("""
CREATE OR REPLACE TABLE conditions AS
SELECT
    PERMIT_REF AS permit_ref,
    VERSION AS version,
    lpad("determinand.notation", 4, '0') AS substance,
    lower(replace(replace(replace(ANY_VALUE(unit), ' ', '-'), '/', '-'), '.', '')) AS unit_slug
FROM raw
GROUP BY PERMIT_REF, VERSION, "determinand.notation";
""")

# --- Condition bounds: one per (condition, statistic). This is the shape change - a Limit now carries
#     ONE BOUND PER STATISTIC rather than a single anonymous upper and lower value. Bounds are keyed by
#     the statistic slug, never by the source column position: the register puts them in no fixed order
#     (permit 042451 carries the maximum in CODE_1 and the percentile in CODE_2; permit 401747 does the
#     reverse), so position carries no meaning.
#
#     Values -> DECIMAL so they render in plain notation (no scientific).
#
#     KNOWN LIMITATION - the condition grain is coarser than the rule grain. The register sets limits per
#     (permit, version, OUTLET, EFFLUENT, substance) but a Condition here is keyed at (permit, version,
#     substance), inherited from the existing model (WINEP's reg:continuesCondition already points at
#     these IRIs, so re-keying is a separate change). Where one permit's outlets carry DIFFERENT values
#     for the same statistic, MAX() collapses them to the loosest - preserving the behaviour the store
#     already had. The count of collapsed conditions is reported at the end of this script. ---
con.execute("""
CREATE OR REPLACE TABLE condition_bounds AS
SELECT
    r.PERMIT_REF AS permit_ref,
    r.VERSION AS version,
    lpad(r."determinand.notation", 4, '0') AS substance,
    s.slug AS statistic,
    s.bound_kind,
    MAX(CAST(r.RULE_VALUE AS DECIMAL(18,4))) AS value,
    lower(replace(replace(replace(ANY_VALUE(r.unit), ' ', '-'), '/', '-'), '.', '')) AS unit_slug
FROM raw r
JOIN statistics s ON s.rule_type = r.RULE_TYPE
WHERE r.RULE_VALUE IS NOT NULL
GROUP BY r.PERMIT_REF, r.VERSION, lpad(r."determinand.notation", 4, '0'), s.slug, s.bound_kind;
""")

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
con.execute("""
CREATE OR REPLACE TABLE limit_statements AS
WITH parts AS (
    SELECT DISTINCT
        PERMIT_REF AS permit_ref,
        VERSION AS version,
        lpad("determinand.notation", 4, '0') AS substance,
        RULE_TYPE AS rule_type,
        RULE_TYPE || ' '
          || regexp_replace(regexp_replace(
                 CAST(CAST(RULE_VALUE AS DECIMAL(18,4)) AS VARCHAR), '0+$', ''), '\\.$', '')
          || ' ' || unit AS part
    FROM raw
    WHERE RULE_VALUE IS NOT NULL AND RULE_TYPE IS NOT NULL
)
SELECT permit_ref, version, substance,
       string_agg(part, '; ' ORDER BY rule_type, part) AS statement
FROM parts
GROUP BY permit_ref, version, substance;
""")

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
            "discharge_point_monitoring", "sampling_point_geometry", "discharge_point_geometry",
            "substances", "units", "statistics", "conditions", "condition_bounds",
            "limit_statements", "substance_aliases"]:
    n = con.execute(f"SELECT COUNT(*) FROM {tbl}").fetchone()[0]
    print(f"{tbl:>20}: {n}")

print("       bounds by statistic:")
for slug, kind, n in con.execute("""
    SELECT statistic, bound_kind, COUNT(*) FROM condition_bounds GROUP BY 1, 2 ORDER BY 3 DESC
""").fetchall():
    print(f"{slug:>26} ({kind}): {n}")

# A condition whose unit is not constant would make its bounds incomparable.
mixed_units = con.execute("""
    SELECT COUNT(*) FROM (
        SELECT 1 FROM raw GROUP BY PERMIT_REF, VERSION, "determinand.notation"
        HAVING COUNT(DISTINCT unit) > 1)
""").fetchone()[0]
if mixed_units:
    print(f"WARNING: {mixed_units} condition(s) carry more than one unit; ANY_VALUE picked arbitrarily.")

# Conditions where the register sets DIFFERENT values per outlet/effluent for the same statistic, and the
# (permit, version, substance) grain collapses them to the loosest. See the condition_bounds note above.
collapsed = con.execute("""
    SELECT COUNT(*) FROM (
        SELECT 1 FROM raw r JOIN statistics s ON s.rule_type = r.RULE_TYPE
        WHERE r.RULE_VALUE IS NOT NULL
        GROUP BY r.PERMIT_REF, r.VERSION, r."determinand.notation", s.slug
        HAVING COUNT(DISTINCT r.RULE_VALUE) > 1)
""").fetchone()[0]
if collapsed:
    print(f"NOTE: {collapsed} bound(s) differ across outlet/effluent within one condition; "
          f"MAX() published (the loosest). The condition grain is coarser than the rule grain.")

unmapped = con.execute("SELECT unit_label FROM units WHERE qudt_iri IS NULL").fetchall()
if unmapped:
    print("NOTE: units with no QUDT mapping (local IRI only):", [u[0] for u in unmapped])
