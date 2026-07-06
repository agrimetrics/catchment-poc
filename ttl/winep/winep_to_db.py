from pathlib import Path
import json
import re

import duckdb
import openpyxl
import pandas as pd

# =============================================================================
# WINEP -> RDF shredder (Wessex Water + Water Quality, actions with proposed limits)
#
# The WINEP proposed-limit cells are human-authored free text and cannot be parsed
# with pure SQL, so the parsing happens HERE, in Python, once. The result is written
# to plain tables; the pipeline downstream (ontop) is fully deterministic. Every cell
# is given a deterministic destination - nothing is silently dropped or guessed:
#
#   CELL                              -> OUTCOME        -> RDF
#   -------------------------------------------------------------------------------
#   clean number "0.25"               -> structured     ProposedLimit + upperBound (QuantityValue)
#   "N 10mg/l"  (letter+value+unit)   -> structured     ProposedLimit(N) + upperBound
#   "No change from current"          -> carried_over   CarriedOverLimit + continuesCondition -> existing condition
#   "TBC" / "To be confirmed"         -> pending         ProposedLimit + limitStatement "TBC"
#   "Fe 4mg/l 95%ile 8mg/l Max."      -> uninterpreted  ProposedLimit + limitStatement "<verbatim>"
#   "N/A" / blank                     -> skip            (nothing emitted)
#
# The column header fixes (substance, unit, statistic) - the deterministic backbone;
# only the cell VALUE is variable, and it falls into the small set of shapes above.
# Anything the parser can't confidently structure is captured verbatim as a
# limitStatement (never lost), to be upgraded later via a curated overrides file.
# =============================================================================

HERE = Path(__file__).resolve().parent          # ttl/winep
ROOT = HERE.parents[1]                           # repo root
XLSX = ROOT / "raw_datasets" / "PR24 WINEP National Dataset.xlsx"
CODELIST = ROOT / "output_data" / "determinand_codelist.json"
REG_DB = ROOT / "ttl" / "regulation" / "regulation.duckdb"
WR = "http://example.com/water-regulation/"

# --- Column dictionary: each proposed column -> (substances, unit, statistic) --------
# substances is a list of determinand notations (reusing regulation.ttl IDs where they
# exist, else codelist). An empty list means the substance is not fixed by the column
# (e.g. generic "Chemical", or the free-text "other" column).
COLS = {
    "Proposed_BOD_permit_95%ile(mg/l)(S=Summer;W=Winter)_plus_Upper_Tiers_where_applicable":
        dict(subs=["0085"], unit="mg/l", stat="percentile-95", slug="bod"),
    "Proposed_NH3_permit_95%ile(mg/l)(S=Summer;W=Winter)_plus_Upper_Tiers_where_applicable":
        dict(subs=["0111"], unit="mg/l", stat="percentile-95", slug="nh3"),
    "Proposed_P_annual_average_permit_mg/l_(S=summer)/backstop_limit(mg/l)":
        dict(subs=["0348"], unit="mg/l", stat="annual-average", slug="p"),
    "Proposed_P_95%ile_permit_(mg/l)":
        dict(subs=["0348"], unit="mg/l", stat="percentile-95", slug="p95"),
    "Proposed_Iron_/_Aluminium_permit_limits_(ug/l)":
        dict(subs=["6051", "6057"], unit="ug/l", stat=None, slug="feal"),
    "Proposed_Chemical_permit_99%ile_LUT_(ug/l)":
        dict(subs=[], unit="ug/l", stat="percentile-99", slug="chem99"),
    "Proposed_Chemical_permit_95%ile_LUT_(ug/l)":
        dict(subs=[], unit="ug/l", stat="percentile-95", slug="chem95"),
    "Proposed_Chemical_annual_average_permit_conditions_(ug/l)":
        dict(subs=[], unit="ug/l", stat="annual-average", slug="chemaa"),
    "Proposed_permit_other":
        dict(subs=[], unit=None, stat=None, slug="other"),
}

CARRY = {"no change from current", "no change"}
PENDING = {"tbc", "to be confirmed"}
SKIP = {"", "n/a", "na", "none", "not applicable"}
CLEAN_NUM = re.compile(r"^-?\d+(\.\d+)?$")
# letter-prefixed value in the free-text "other" column, e.g. "N 10mg/l"
LETTER_VAL = re.compile(r"^([A-Za-z]+)\s*([\d.]+)\s*mg/l$", re.I)
LETTER_SUB = {"N": "9194"}  # Nitrogen, Total as N (lower of the two duplicate codes)
UNIT_SLUG = {"mg/l": "milligram-per-litre", "ug/l": "microgram-per-litre"}


def classify(meta, raw, permit_ref, cond_versions):
    """Turn one proposed-limit cell into zero or more limit records.

    meta          the COLS entry for this column (subs / unit / stat / slug)
    raw           the raw cell value
    permit_ref    the action's target permit (Licence_Permit_Obstruction_ID)
    cond_versions {(permit_ref, substance): max_version} from regulation.duckdb

    Returns a list of dicts, each with a 'kind' in
    {structured, carried_over, uninterpreted} plus the fields that kind needs.

    Examples
    --------
    "0.25"  on the P column        -> [structured  P 0.25 mg/l annual-average]
    "N 10mg/l" on the other column -> [structured  N 10 mg/l]
    "No change from current" (Fe/Al on a permit that has an Iron condition)
                                   -> [carried_over 6051 -> that permit's condition/6051]
    "TBC"                          -> [uninterpreted statement "TBC"]
    "Fe 4mg/l 95%ile 8mg/l Max."   -> [uninterpreted statement "<verbatim>"]
    "N/A" / blank                  -> []   (skipped)
    """
    s = ("" if raw is None else str(raw)).strip()
    low = s.lower()
    if low in SKIP:
        return []

    # --- carry-over: keep the existing condition(s) in force -------------------
    if low in CARRY:
        existing = [(sub, cond_versions[(permit_ref, sub)])
                    for sub in meta["subs"] if (permit_ref, sub) in cond_versions]
        if existing:
            return [dict(kind="carried_over", key=sub, substance=sub,
                         continues_iri=f"{WR}permit/{permit_ref}/version/{ver}/condition/{sub}",
                         statement=None)
                    for sub, ver in existing]
        # target permit not in the local graph -> record the intent, no link
        one = meta["subs"][0] if len(meta["subs"]) == 1 else None
        return [dict(kind="carried_over", key=one or meta["slug"], substance=one,
                     continues_iri=None, statement="No change from current")]

    # --- pending: known-unknown, keep as a statement ---------------------------
    if low in PENDING:
        return [dict(kind="uninterpreted", key=meta["slug"], substance=None, statement=s)]

    # --- structured: a clean number on a single-substance column ---------------
    if CLEAN_NUM.match(s) and len(meta["subs"]) == 1:
        return [dict(kind="structured", key=meta["subs"][0], substance=meta["subs"][0],
                     value=float(s), unit=meta["unit"], stat=meta["stat"])]

    # --- structured: letter-prefixed value in the free-text column -------------
    m = LETTER_VAL.match(s)
    if m and m.group(1).upper() in LETTER_SUB:
        sub = LETTER_SUB[m.group(1).upper()]
        return [dict(kind="structured", key=sub, substance=sub,
                     value=float(m.group(2)), unit="mg/l", stat=None)]

    # --- everything else: captured verbatim, never dropped ---------------------
    sub = meta["subs"][0] if len(meta["subs"]) == 1 else None
    return [dict(kind="uninterpreted", key=sub or meta["slug"], substance=sub, statement=s)]


# --- Load reference data -----------------------------------------------------------
labels = {m["notation"]: m["prefLabel"] for m in json.load(open(CODELIST))}

cond_versions = {}
regcon = duckdb.connect(str(REG_DB), read_only=True)
for ref, sub, ver in regcon.execute(
        "SELECT permit_ref, substance, MAX(version) FROM conditions GROUP BY 1, 2").fetchall():
    cond_versions[(ref, sub)] = ver
regcon.close()

# --- Read + filter the WINEP sheet -------------------------------------------------
wb = openpyxl.load_workbook(XLSX, read_only=True, data_only=True)
ws = wb["PR24 WINEP National Data"]
it = ws.iter_rows(values_only=True)
H = list(next(it))
idx = {h: i for i, h in enumerate(H)}

actions = {}       # action_id -> attributes
limits = []        # one row per emitted limit
STAT_LABEL = {"annual-average": "Annual average", "percentile-95": "95th percentile",
              "percentile-99": "99th percentile"}

for r in it:
    if r[idx["EA_Function"]] != "Water Quality" or r[idx["Water_Company"]] != "Wessex Water Service Ltd":
        continue
    action_id = r[idx["Action_ID"]]
    permit_ref = str(r[idx["Licence_Permit_Obstruction_ID"]]).strip()

    emitted = []
    for col, meta in COLS.items():
        for rec in classify(meta, r[idx[col]], permit_ref, cond_versions):
            rec["action_id"] = action_id
            emitted.append(rec)
    if not emitted:            # no proposed limits on this action -> skip entirely
        continue

    cd = r[idx["Completion_Date"]]
    actions.setdefault(action_id, dict(
        action_id=action_id,
        label=r[idx["Action_Name"]],
        description=r[idx["Action_Description"]],
        completion_date=cd.date().isoformat() if cd else None,
        permit_ref=permit_ref,
        easting=r[idx["Easting"]],
        northing=r[idx["Northing"]],
        waterbody_id=r[idx["Waterbody_ID"]],
    ))
    limits.extend(emitted)

# --- Assemble tables ---------------------------------------------------------------
actions_df = pd.DataFrame(actions.values())

lim_rows = []
for l in limits:
    lim_rows.append(dict(
        action_id=l["action_id"], limit_key=l["key"], kind=l["kind"],
        substance=l.get("substance"),
        value=l.get("value"), unit_slug=UNIT_SLUG.get(l.get("unit")) if l.get("unit") else None,
        statistic=l.get("stat"),
        continues_iri=l.get("continues_iri"), statement=l.get("statement"),
    ))
limits_df = pd.DataFrame(lim_rows)

used_subs = sorted({l["substance"] for l in lim_rows if l["substance"]})
subs_df = pd.DataFrame([dict(notation=n, pref_label=labels.get(n)) for n in used_subs])

used_units = sorted({l["unit_slug"] for l in lim_rows if l["unit_slug"]})
UNIT_QUDT = {"milligram-per-litre": "http://qudt.org/vocab/unit/MilliGM-PER-L",
             "microgram-per-litre": "http://qudt.org/vocab/unit/MicroGM-PER-L"}
UNIT_LABEL = {"milligram-per-litre": "MILLIGRAM PER LITRE", "microgram-per-litre": "MICROGRAM PER LITRE"}
units_df = pd.DataFrame([dict(unit_slug=u, unit_label=UNIT_LABEL[u], qudt_iri=UNIT_QUDT[u]) for u in used_units])

used_stats = sorted({l["statistic"] for l in lim_rows if l["statistic"]})
stats_df = pd.DataFrame([dict(slug=s, label=STAT_LABEL[s]) for s in used_stats])

# --- Write DuckDB ------------------------------------------------------------------
con = duckdb.connect(str(HERE / "winep.duckdb"))
for name, df in [("actions", actions_df), ("proposed_limits", limits_df),
                 ("substances", subs_df), ("units", units_df), ("statistics", stats_df)]:
    con.execute(f"CREATE OR REPLACE TABLE {name} AS SELECT * FROM df")

# --- Summary -----------------------------------------------------------------------
print(f"{'actions':>16}: {len(actions_df)}")
print(f"{'proposed_limits':>16}: {len(limits_df)}")
for k, n in limits_df["kind"].value_counts().items():
    print(f"{'  - ' + k:>16}: {n}")
print(f"{'substances':>16}: {len(subs_df)}  {used_subs}")
carried = limits_df[(limits_df.kind == "carried_over") & (limits_df.continues_iri.notna())]
print(f"carried-over resolving to an existing condition: {len(carried)}")
