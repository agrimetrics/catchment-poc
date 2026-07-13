from pathlib import Path

import duckdb

# This script shreds the source registers into a small star of tables, one row per instance, so
# ontop can materialise Permit / DischargePoint / SamplingPoint / Condition / ConditionBreach
# individuals against the DEFRA regulation + water ontologies.
#
# WHAT DEFINES A THING, AND WHAT MERELY DESCRIBES IT
# --------------------------------------------------
# Two different registers feed this graph, and which one a table comes from is a modelling
# decision, not a convenience:
#
#   * WHAT EXISTS comes from the REGISTERS. A permit, its outlets, and the sampling point each
#     outlet is monitored at are facts of the permit register (effluents.csv + consents_*.csv) and
#     the Water Quality Archive. They are true whether or not anyone sampled there this decade.
#
#   * WHAT WAS MEASURED comes from the OBSERVATIONS (the CSV below). Conditions, limit values and
#     breaches are still derived from the observations-with-rules join.
#
# This split is a FIX, not decoration. Everything used to be materialised from the observations
# CSV, which meant a thing existed only if it had a numeric result that matched a permit rule -
# so the store quietly lost real regulated outlets. Permit 043231 showed 1 of its 2 outlets and
# 400114/CF/01 showed 1 of its 3, because the missing outlets' every 2020-2026 sample reads
# "No flow/discharge at sampling point" (a true and useful fact, dropped by the numeric filter in
# link_data.py); permit 050922 vanished entirely, its only samples being a site inspection. An
# outlet that is never sampled is still an outlet, and app/points.html - whose whole argument is
# about outlets that a map collapses onto one dot - was counting the wrong number of them.
#
# KNOWN LIMITATION, same shape, not yet fixed: conditions and their bounds are still observation-
# sourced (see the `conditions` table below), so a permit limit appears only if that substance was
# actually sampled at that permit. Sourcing them from determinands.csv instead would take the
# catchment from 587 conditions over 12 substances to 919 over 38 - and those extra 26 include
# flow, colour, turbidity and pH, which would reshape the app's "substance" vocabulary. That is a
# deliberate separate change, not an oversight.
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

# --- Sampling points, from the Water Quality Archive (fetch_sampling_points.py). Every sampling
#     point the catchment holds observations for, PLUS every one the register names as a permit's
#     effluent sample point. Geometry is carried verbatim in its published CRS (EPSG:27700). ---
con.execute(f"""
CREATE OR REPLACE TABLE sampling_points AS
SELECT sp_notation, pref_label, wkt, type_notation, type_label, status_label
FROM read_csv('{SAMPLING_POINTS_CSV}', header=true, types={{'sp_notation': 'VARCHAR',
    'pref_label': 'VARCHAR', 'wkt': 'VARCHAR', 'type_notation': 'VARCHAR',
    'type_label': 'VARCHAR', 'status_label': 'VARCHAR'}})
WHERE wkt IS NOT NULL AND wkt <> '';
""")

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
#     the sampling point that effluent is monitored at. Restricted to the region whose notation
#     scheme we can reconstruct (see link_data.py: a sampling point is REGION + '-' + code). ---
con.execute(f"""
CREATE OR REPLACE TABLE register_effluents AS
SELECT DISTINCT
    CAST(PERMIT_REF AS VARCHAR) AS permit_ref,
    CAST(VERSION AS VARCHAR) AS version,
    CAST(OUTLET_NUMBER AS VARCHAR) AS outlet,
    CAST(EFFLUENT_NUMBER AS VARCHAR) AS effluent,
    EA_REGION || '-' || EFF_SAMPLE_POINT AS sp_notation
FROM read_csv('{EFFLUENTS_CSV}', header=true, types={{'PERMIT_REF': 'VARCHAR',
    'VERSION': 'VARCHAR', 'OUTLET_NUMBER': 'VARCHAR', 'EFFLUENT_NUMBER': 'VARCHAR'}})
WHERE EA_REGION = 'SW' AND EFF_SAMPLE_POINT IS NOT NULL;
""")

# --- SCOPE. The register is national (59k permits); this demonstrator is one catchment. A permit is
#     in scope if it is monitored at a sampling point the catchment holds observations for. That is a
#     property of the REGISTER, not of what happened to be sampled - so once a permit is in, ALL of
#     its outlets come with it, including the ones that have never produced a numeric result. ---
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
SELECT DISTINCT PERMIT_REF, OUTLET_NUMBER, EFFLUENT_NUMBER FROM raw;
""")

# --- Discharge point -> sampling point (defra-water:monitoredAt). The register states this link;
#     it is the identifier-borne edge that app/points.html sets against a spatial join. Restricted
#     to sampling points we could resolve in the archive, so the edge never dangles. ---
con.execute("""
CREATE OR REPLACE TABLE discharge_point_monitoring AS
SELECT DISTINCT e.permit_ref, e.outlet, e.effluent, e.sp_notation
FROM register_effluents e
JOIN scoped_permits s USING (permit_ref)
JOIN sampling_points p ON p.sp_notation = e.sp_notation;
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
)
SELECT dp.permit_ref, dp.outlet, dp.effluent,
       'POINT(' || ngr_easting(c.ngr) || ' ' || ngr_northing(c.ngr)
                || ') <http://www.opengis.net/def/crs/EPSG/0/27700>' AS wkt
FROM discharge_points dp
JOIN consents c USING (permit_ref)
WHERE ngr_easting(c.ngr) IS NOT NULL;
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
            "discharge_point_monitoring", "sampling_points", "sampling_point_types",
            "discharge_point_geometry",
            "substances", "units", "statistics", "conditions", "condition_bounds",
            "limit_statements", "substance_aliases"]:
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
    print(f"NOTE: {unmonitored} discharge point(s) name no sampling point we could resolve.")

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
