from pathlib import Path
import json
import re

import duckdb
import geopandas as gpd
import openpyxl
import pandas as pd
from shapely.geometry import Point

# =============================================================================
# WINEP -> RDF shredder (Wessex Water + Water Quality, actions with proposed limits)
#
# The WINEP proposed-limit cells are human-authored, but they are NOT free prose - they
# are semi-structured, and the COLUMN HEADER already fixes (substance, unit, statistic).
# The parser below uses the column PLUS the cell contents to extract as much structure
# as it deterministically can. Every cell gets a destination; nothing is dropped.
#
#   CELL (with its column's meaning)                 -> OUTCOME       -> bounds emitted
#   -------------------------------------------------------------------------------------
#   "0.25"        on P annual-average col            -> structured    P 0.25 mg/l annual-average
#   "13.5"        on Chemical annual-average col     -> structured    chemical 13.5 ug/l annual-average
#   "8 UT 30"     on NH3 95%ile col                  -> structured    NH3 8 mg/l 95%ile + 30 mg/l upper-tier
#   "0.0019 (upper tier ug/l)" on Chemical 99%ile    -> structured    chemical 0.0019 ug/l 99%ile
#   "Fe 4mg/l 95%ile 8mg/l Max."                     -> structured    Iron 4 mg/l 95%ile + 8 mg/l maximum
#   "N 10mg/l"    on the free-text "other" col       -> structured    Nitrogen 10 mg/l
#   "No change from current"                         -> carried_over  continuesCondition -> existing condition
#   "TBC"                                            -> uninterpreted limitStatement "TBC"
#   genuinely un-structurable text                   -> uninterpreted limitStatement "<verbatim>"
#   "N/A" / blank                                    -> skip          (nothing)
#
# A limit can carry MULTIPLE bounds (tiers) - each is a QuantityValue with its own
# statistical modifier. Where the column names only a parameter FAMILY ("Chemical") the
# specific analyte is unknown, so the substance is a generic placeholder to be resolved
# later from the driver code. Anything the rules below can't handle is kept verbatim as
# a limitStatement (see ttl/winep/TODO.md for the overrides upgrade path).
# =============================================================================

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
XLSX = ROOT / "raw_datasets" / "PR24 WINEP National Dataset.xlsx"
CODELIST = ROOT / "output_data" / "determinand_codelist.json"
REG_DB = ROOT / "ttl" / "regulation" / "regulation.duckdb"
CATCHMENT = ROOT / "raw_datasets" / "poole_harbour_rivers_operational_catchment.geojson"
WR = "http://example.com/water-regulation/"


def canon_permit(ref):
    """Normalise a permit ref to the regulation graph's form so targetPermit / continuesCondition
    IRIs resolve to the real permit. WINEP stores numeric refs unpadded (e.g. '42451') whereas
    regulation permits are all 6-digit zero-padded ('042451'); non-numeric (EPR) refs pass through."""
    ref = str(ref).strip()
    return ref.zfill(6) if ref.isdigit() else ref

# column -> (substances it can carry, its unit, its statistic). [] substances = generic chemical.
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

NUM = r"\d+(?:\.\d+)?"
CLEAN_NUM = re.compile(rf"^-?{NUM}$")
SUB_MARK = re.compile(r"\b(Fe|Al|N|P)\b")                       # inline analyte markers
SEG = re.compile(rf"({NUM})\s*(mg/l|ug/l)\s*(95%ile|99%ile|max\.?|maximum)?", re.I)  # value+unit(+stat)
UT = re.compile(rf"^({NUM})\s*UT\s*({NUM})$", re.I)             # "8 UT 30"
UPPER = re.compile(rf"^({NUM})\s*\(?\s*upper\s*tier", re.I)     # "0.0019 (upper tier ug/l)"
LETTER_SUB = {"fe": "6051", "al": "6057", "n": "9194", "p": "0348"}
STAT_TOKEN = {"95%ile": "percentile-95", "99%ile": "percentile-99",
              "max": "maximum", "maximum": "maximum"}
UNIT_SLUG = {"mg/l": "milligram-per-litre", "ug/l": "microgram-per-litre"}
CHEMICAL = "chemical"   # generic placeholder analyte
STAT_LABEL = {"annual-average": "Annual average", "percentile-95": "95th percentile",
              "percentile-99": "99th percentile", "maximum": "Maximum (absolute)",
              "upper-tier": "Upper tier"}


def _lim(sub, bounds, meta):
    """Build a structured limit record. Keyed by substance notation, or the column slug
    when the analyte is the generic 'chemical' placeholder (keeps chemical columns distinct)."""
    key = sub if sub and sub != CHEMICAL else meta["slug"]
    return dict(kind="structured", key=key, substance=sub, bounds=bounds)


def _sole_sub(meta):
    """The substance to assume when the cell doesn't name one: the column's single
    substance, or the generic chemical placeholder for the chemical columns; else None."""
    if len(meta["subs"]) == 1:
        return meta["subs"][0]
    if not meta["subs"]:
        return CHEMICAL
    return None                                    # multi-substance column, cell must name it


def _parse_inline(s, meta):
    """Parse cells that name analytes and/or units inline, e.g.
    'Fe 4mg/l 95%ile 8mg/l Max.'  -> {6051: [(4,mg/l,95%ile),(8,mg/l,maximum)]}
    'N 10mg/l'                    -> {9194: [(10,mg/l,None)]}
    Each value+unit segment is attributed to the nearest preceding analyte marker, or the
    column's sole substance if none. Returns {substance: [bounds]} or None if not inline."""
    segs = list(SEG.finditer(s))
    if not segs:
        return None
    marks = [(m.start(), m.group(1).lower()) for m in SUB_MARK.finditer(s)]
    by_sub = {}
    for seg in segs:
        value, unit, stat_tok = seg.group(1), seg.group(2).lower(), seg.group(3)
        letter = None
        for pos, lt in marks:
            if pos < seg.start():
                letter = lt
            else:
                break
        sub = LETTER_SUB[letter] if letter else _sole_sub(meta)
        if sub is None:
            return None
        stat = STAT_TOKEN.get((stat_tok or "").lower().rstrip(".")) or meta["stat"]
        by_sub.setdefault(sub, []).append(dict(value=value, unit=unit, statistic=stat))
    return by_sub


def classify(meta, raw, permit_ref, cond_versions):
    """One proposed-limit cell -> zero or more limit records (see module header)."""
    s = ("" if raw is None else str(raw)).strip()
    low = s.lower()
    if low in SKIP:
        return []

    if low in CARRY:
        existing = [(sub, cond_versions[(permit_ref, sub)])
                    for sub in meta["subs"] if (permit_ref, sub) in cond_versions]
        if existing:
            return [dict(kind="carried_over", key=sub, substance=sub,
                         continues_iri=f"{WR}permit/{permit_ref}/version/{ver}/condition/{sub}",
                         statement=None)
                    for sub, ver in existing]
        one = meta["subs"][0] if len(meta["subs"]) == 1 else None
        return [dict(kind="carried_over", key=one or meta["slug"], substance=one,
                     continues_iri=None, statement="No change from current")]

    if low in PENDING:
        return [dict(kind="uninterpreted", key=meta["slug"], substance=None, statement=s)]

    # inline analytes / units (Fe/Al tiers, "N 10mg/l")
    inl = _parse_inline(s, meta)
    if inl:
        return [_lim(sub, bounds, meta) for sub, bounds in inl.items()]

    # "8 UT 30" -> column value at column statistic + upper-tier value
    m = UT.match(s)
    if m and (sub := _sole_sub(meta)) and meta["unit"]:
        return [_lim(sub, [dict(value=m.group(1), unit=meta["unit"], statistic=meta["stat"]),
                           dict(value=m.group(2), unit=meta["unit"], statistic="upper-tier")], meta)]

    # "0.0019 (upper tier ug/l)" -> value at the column statistic; unit from the cell if given
    m = UPPER.match(s)
    if m and (sub := _sole_sub(meta)):
        unit = "ug/l" if "ug/l" in low else ("mg/l" if "mg/l" in low else meta["unit"])
        if unit:
            return [_lim(sub, [dict(value=m.group(1), unit=unit, statistic=meta["stat"])], meta)]

    # bare number -> the column's (substance, unit, statistic)
    if CLEAN_NUM.match(s) and (sub := _sole_sub(meta)) and meta["unit"]:
        return [_lim(sub, [dict(value=s, unit=meta["unit"], statistic=meta["stat"])], meta)]

    # nothing structured -> keep verbatim
    sub = meta["subs"][0] if len(meta["subs"]) == 1 else None
    return [dict(kind="uninterpreted", key=sub or meta["slug"], substance=sub, statement=s)]


# --- Reference data ----------------------------------------------------------------
labels = {m["notation"]: m["prefLabel"] for m in json.load(open(CODELIST))}
labels[CHEMICAL] = "Priority chemical substance (unspecified)"

cond_versions = {}
reg_permits = set()
regcon = duckdb.connect(str(REG_DB), read_only=True)
for ref, sub, ver in regcon.execute(
        "SELECT permit_ref, substance, MAX(version) FROM conditions GROUP BY 1, 2").fetchall():
    cond_versions[(ref, sub)] = ver
for (ref,) in regcon.execute("SELECT DISTINCT permit_ref FROM permits").fetchall():
    reg_permits.add(ref)                            # the catchment's regulation permits
regcon.close()

# Poole Harbour operational catchment as a single polygon, reprojected to British National Grid
# (EPSG:27700) to match the WINEP action Easting/Northing.
catchment_27700 = gpd.read_file(CATCHMENT).to_crs(27700).union_all()

# --- Read + filter -----------------------------------------------------------------
wb = openpyxl.load_workbook(XLSX, read_only=True, data_only=True)
ws = wb["PR24 WINEP National Data"]
it = ws.iter_rows(values_only=True)
H = list(next(it))
idx = {h: i for i, h in enumerate(H)}

actions, limits, bounds = {}, [], []
for r in it:
    if r[idx["EA_Function"]] != "Water Quality" or r[idx["Water_Company"]] != "Wessex Water Service Ltd":
        continue
    action_id = r[idx["Action_ID"]]
    permit_ref = canon_permit(r[idx["Licence_Permit_Obstruction_ID"]])
    easting, northing = r[idx["Easting"]], r[idx["Northing"]]

    # --- Catchment scope (UNION): keep an action only if it belongs to the Poole Harbour catchment ---
    # An action is in scope if EITHER of these holds; anything satisfying neither is dropped here:
    #   (a) its site falls within the catchment boundary, OR
    #   (b) its target permit is one of the catchment's regulation permits.
    # Both clauses are needed: WINEP sites are rounded to 1 km, so a boundary works can land just
    # outside the polygon (kept by (b)); conversely a site can be inside the catchment for a permit
    # we hold no regulation data on (kept by (a)).
    try:
        site_in_catchment = catchment_27700.contains(Point(float(easting), float(northing)))
    except (TypeError, ValueError):        # missing / blank Easting or Northing
        site_in_catchment = False
    permit_in_catchment = permit_ref in reg_permits
    if not (site_in_catchment or permit_in_catchment):
        continue

    emitted = []
    for col, meta in COLS.items():
        for rec in classify(meta, r[idx[col]], permit_ref, cond_versions):
            rec["action_id"] = action_id
            emitted.append(rec)
    if not emitted:
        continue

    cd = r[idx["Completion_Date"]]
    actions.setdefault(action_id, dict(
        action_id=action_id, label=r[idx["Action_Name"]], description=r[idx["Action_Description"]],
        completion_date=cd.date().isoformat() if cd else None, permit_ref=permit_ref,
        easting=easting, northing=northing, waterbody_id=r[idx["Waterbody_ID"]]))

    for l in emitted:
        limits.append(dict(action_id=action_id, limit_key=l["key"], kind=l["kind"],
                           substance=l.get("substance"), continues_iri=l.get("continues_iri"),
                           statement=l.get("statement")))
        for i, b in enumerate(l.get("bounds", [])):
            bounds.append(dict(action_id=action_id, limit_key=l["key"], bound_key=str(i),
                               value=b["value"], unit_slug=UNIT_SLUG[b["unit"]], statistic=b["statistic"]))

# --- Reference tables (only what's used) -------------------------------------------
actions_df = pd.DataFrame(actions.values())
limits_df = pd.DataFrame(limits)
bounds_df = pd.DataFrame(bounds)

used_subs = sorted({l["substance"] for l in limits if l["substance"]})
subs_df = pd.DataFrame([dict(notation=n, pref_label=labels.get(n)) for n in used_subs])

UNIT_QUDT = {"milligram-per-litre": "http://qudt.org/vocab/unit/MilliGM-PER-L",
             "microgram-per-litre": "http://qudt.org/vocab/unit/MicroGM-PER-L"}
UNIT_LABEL = {"milligram-per-litre": "MILLIGRAM PER LITRE", "microgram-per-litre": "MICROGRAM PER LITRE"}
used_units = sorted({b["unit_slug"] for b in bounds})
units_df = pd.DataFrame([dict(unit_slug=u, unit_label=UNIT_LABEL[u], qudt_iri=UNIT_QUDT[u]) for u in used_units])

used_stats = sorted({b["statistic"] for b in bounds if b["statistic"]})
stats_df = pd.DataFrame([dict(slug=s, label=STAT_LABEL[s]) for s in used_stats])

# --- Write DuckDB ------------------------------------------------------------------
con = duckdb.connect(str(HERE / "winep.duckdb"))
for name, df in [("actions", actions_df), ("proposed_limits", limits_df), ("proposed_bounds", bounds_df),
                 ("substances", subs_df), ("units", units_df), ("statistics", stats_df)]:
    con.execute(f"CREATE OR REPLACE TABLE {name} AS SELECT * FROM df")

# --- Summary -----------------------------------------------------------------------
print(f"{'actions':>16}: {len(actions_df)}")
print(f"{'proposed_limits':>16}: {len(limits_df)}")
for k, n in limits_df["kind"].value_counts().items():
    print(f"{'  - ' + k:>16}: {n}")
print(f"{'proposed_bounds':>16}: {len(bounds_df)}")
print(f"{'substances':>16}: {used_subs}")
print(f"{'statistics':>16}: {used_stats}")
