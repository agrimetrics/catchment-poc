"""Decompose SFI options to water-body sub-catchments, for every option group, and
reconcile against the current by-application aggregation.

    python ttl/sfi/waterbody_reconcile.py

BACKGROUND. The app aggregates SFI **by application**: one hull per application, option
counts and annual-payment summed per application (see `Q.applications` / `renderFarming`
in app/app.js). An application's footprint is a bag of MULTIPOINT options and it can span
several of the 19 water-body catchments in ttl/catchment.ttl. To show any option group --
soil management, hedgerows, nutrient management, all of them -- *in a given water body*,
each option's points have to be attributed to those sub-catchments (the "Level 2"
approach). Soil management is just one group; this does it for all of them.

This script implements that attribution offline (in pyoxigraph, the same engine the app
uses) and proves it reconciles with the numbers the app already shows. The app's farming
view now does the same attribution live -- `sfiByCatchment` / `sfiCatchmentCard` in
app/app.js, the "Farming by option group" table that rescopes when you click a
sub-catchment -- and this script is its offline proof and guardrail, run like
verify_catchment.py. The two agree group-for-group by construction (same grouping, same
point-in-polygon).

WHAT RECONCILES, AND WHAT DOES NOT -- this is the whole point of the multipoint question,
and it holds for every group, not just soil:

  * POINTS reconcile exactly. The water-body catchments are disjoint (no point lands in
    two) and every option-point lies inside the operational catchment, so attributing each
    point to its water body PARTITIONS the 12,885 option-points. Per group and overall, the
    per-water-body point counts sum back to the app's per-application totals exactly.

  * ANNUAL PAYMENT reconciles, once apportioned. An option's cost is a single scalar for
    the whole option, so a straddling option's cost is split across the water bodies its
    points fall in, pro rata by point share. By construction the shares sum back to the
    option's cost, hence to the group and application totals.

  * WHOLE-OPTION and WHOLE-APPLICATION COUNTS do NOT reconcile at water-body granularity.
    An option whose points straddle two water bodies is "in" both; counting it once per
    water body double-counts it. The overcount is reported per group, not hidden -- it is
    exactly the straddle the multipoint creates, and no point-free rule removes it.
"""

import re
import sys
from collections import defaultdict
from pathlib import Path

import pyoxigraph as ox

SFI = Path(__file__).resolve().parents[1] / "sfi.ttl"   # includes the per-parcel nodes (SFIParcels)
CATCHMENT = Path(__file__).resolve().parents[1] / "catchment.ttl"
CP = "http://environment.data.gov.uk/catchment-planning/"
TOL = 1e-6

P = f"""
PREFIX exf:  <http://example.com/farming/>
PREFIX geo:  <http://www.opengis.net/ont/geosparql#>
PREFIX core: <http://environment.data.gov.uk/ontology/core/>
PREFIX farm: <http://environment.data.gov.uk/ontology/farming/>
PREFIX qudt: <http://qudt.org/schema/qudt/>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX ver:  <http://purl.org/linked-data/version#>
PREFIX wfd:  <{CP}def/water-framework-directive/>
PREFIX cpg:  <{CP}def/geometry/>
"""


def parse_multipoint(wkt):
    """The lon/lat pairs of a MULTIPOINT wktLiteral. The optional CRS URI is CRS84 here,
    so no reprojection -- but it is sliced off first because it is full of digits that a
    naive number scrape would turn into a phantom coordinate."""
    nums = re.findall(r"-?\d+\.\d+", wkt.split("MULTIPOINT", 1)[1])
    return [(float(nums[i]), float(nums[i + 1])) for i in range(0, len(nums), 2)]


def parse_polygon(wkt):
    nums = re.findall(r"-?\d+\.\d+", wkt.split("POLYGON", 1)[1])
    return [(float(nums[i]), float(nums[i + 1])) for i in range(0, len(nums), 2)]


def parse_point(wkt):
    """(lon, lat) of a POINT wktLiteral, CRS URI sliced off first."""
    nums = re.findall(r"-?\d+\.\d+", wkt.split("POINT", 1)[1])
    return float(nums[0]), float(nums[1])


def in_ring(lon, lat, ring):
    """Ray-cast point-in-polygon. Same test the app uses (pointInRing in app.js)."""
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if ((yi > lat) != (yj > lat)) and (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def main():
    for f in (SFI, CATCHMENT):
        if not f.exists():
            sys.exit(f"{f} not found.")

    store = ox.Store()
    store.bulk_load(path=str(SFI), format=ox.RdfFormat.TURTLE)
    store.bulk_load(path=str(CATCHMENT), format=ox.RdfFormat.TURTLE)

    def q(sparql):
        return list(store.query(P + sparql))

    # --- the 19 water-body catchment polygons (the sub-catchments to attribute into) ----
    wbs = []  # (notation, label, ring)
    for r in q("""SELECT ?n ?lbl ?wkt WHERE {
        ?wb wfd:inOperationalCatchment ?oc ; skos:notation ?n ; ver:currentVersion ?cv .
        ?cv rdfs:label ?lbl . ?wb geo:hasGeometry ?g . ?g a cpg:Catchment ; geo:asWKT ?wkt .
    } ORDER BY ?lbl"""):
        wbs.append((r[0].value, r[1].value, parse_polygon(r[2].value)))
    wb_names = [n for n, _, _ in wbs]

    def membership(lon, lat):
        return [n for n, _, ring in wbs if in_ring(lon, lat, ring)]

    # --- group labels: the prefLabel of every option-scheme concept (SAM -> "Soil management") -
    # Used to label a group derived from an option code when the option has no broader concept,
    # exactly as the app does (DB.groupLabels in app.js).
    group_labels = {}
    for r in q("""SELECT ?code ?label WHERE {
        ?bc skos:prefLabel ?label .
        FILTER(STRSTARTS(STR(?bc), "http://example.com/sfi/Option/Concept/"))
        BIND(REPLACE(STR(?bc), ".*/Concept/", "") AS ?code)
    }"""):
        group_labels[r[0].value] = r[1].value

    def group_of(opt_uri, broader_code):
        """Match app.js: if the option has a broader concept use it; otherwise derive the group
        from the option code -- its letter prefix, less a leading 'C' (CSAM1 -> SAM, HRW1 -> HRW).
        Return (code, label)."""
        opt_code = opt_uri.rsplit("/", 1)[-1]
        if broader_code:
            code = broader_code
        else:
            m = re.match(r"[A-Za-z]+", opt_code)
            code = re.sub(r"^C", "", m.group(0)) if m else opt_code
        return code, group_labels.get(code, code)

    # --- every option: app, cost, broader concept (if any), and its MULTIPOINT ----------
    # SAMPLE(?w) mirrors the app (there is one geometry per option anyway).
    rows = q("""SELECT ?app ?opt ?cost ?bcode (SAMPLE(?w) AS ?wkt) WHERE {
        ?app a farm:Application ; core:hasPart ?opt .
        ?opt geo:hasGeometry/geo:asWKT ?w .
        OPTIONAL { ?opt farm:annualPayment/qudt:numericValue ?cost }
        OPTIONAL { ?opt core:hasClassification/skos:broader ?b .
                   BIND(REPLACE(STR(?b), ".*/Concept/", "") AS ?bcode) }
    } GROUP BY ?app ?opt ?cost ?bcode""")

    # --- CURRENT results, summed by application (the reconciliation target) --------------
    cur_apps = set()
    cur_options = 0
    cur_points = 0
    cur_cost = 0.0
    cur_group_options = defaultdict(int)
    cur_group_points = defaultdict(int)
    cur_group_cost = defaultdict(float)
    app_points = defaultdict(int)                          # per-application point totals

    # --- water-body decomposition, per group (the Level-2 attribution) ------------------
    wb_group_points = defaultdict(int)                    # (group, wb) -> points
    wb_group_cost = defaultdict(float)                    # (group, wb) -> apportioned cost
    wb_group_optmemberships = defaultdict(int)            # (group, wb) -> options touching it
    none_group_points = defaultdict(int)                  # in the OC, in no water body
    none_group_cost = defaultdict(float)
    group_straddle_options = defaultdict(int)             # options whose points span >1 wb
    points_attributed_by_app = defaultdict(int)           # tests the attribution loop
    overlap_points = 0                                    # a point in >1 water body (must stay 0)
    seen = set()                                          # guard against a double-broader fan-out

    for r in rows:
        opt = r[1].value
        if opt in seen:
            continue                                       # one row per option, whatever the join did
        seen.add(opt)
        app = r[0].value
        cost = float(r[2].value) if r[2] is not None else 0.0
        _, group = group_of(opt, r[3].value if r[3] is not None else None)
        pts = parse_multipoint(r[4].value)
        if not pts:
            continue                                       # the app drops point-less options too

        cur_apps.add(app)
        cur_options += 1
        cur_points += len(pts)
        cur_cost += cost
        cur_group_options[group] += 1
        cur_group_points[group] += len(pts)
        cur_group_cost[group] += cost
        app_points[app] += len(pts)

        # attribute each point to its water body; apportion the option's scalar cost by
        # point share so the parts sum back to the whole.
        share = cost / len(pts)
        touched = set()
        for lon, lat in pts:
            m = membership(lon, lat)
            if len(m) > 1:
                overlap_points += 1
            points_attributed_by_app[app] += 1
            if not m:
                none_group_points[group] += 1
                none_group_cost[group] += share
                continue
            n = m[0]
            touched.add(n)
            wb_group_points[(group, n)] += 1
            wb_group_cost[(group, n)] += share
        for n in touched:
            wb_group_optmemberships[(group, n)] += 1
        if len(touched) > 1:
            group_straddle_options[group] += 1

    groups = sorted(cur_group_options, key=lambda g: (-cur_group_points[g], g))

    # --- report --------------------------------------------------------------------------
    print(f"Loaded {len(store):,} triples ({SFI.name} + {CATCHMENT.name})\n")
    print("CURRENT, summed by application (what the app shows):")
    print(f"  applications ......... {len(cur_apps)}")
    print(f"  options .............. {cur_options}")
    print(f"  option-points ........ {cur_points}")
    print(f"  annual payment ....... {cur_cost:,.2f}")
    print(f"  option groups ........ {len(groups)}\n")

    # Per-group: how the water-body attribution behaves, and where whole-option counting breaks.
    print("Per option group (attribution to the 19 water-body catchments):")
    print(f"  {'group':<32}{'opts':>6}{'points':>8}{'straddle':>9}{'overcount':>10}")
    for g in groups:
        memb_total = sum(wb_group_optmemberships[(g, n)] for n in wb_names)
        # overcount = extra whole-option memberships beyond the true option count, i.e. what
        # straddling adds if you count each option once per water body it touches. (Every
        # option here touches at least one water body -- none_points is 0 -- so the true
        # count and the touched count coincide.)
        overcount = memb_total - cur_group_options[g]
        print(f"  {g[:32]:<32}{cur_group_options[g]:>6}{cur_group_points[g]:>8}"
              f"{group_straddle_options[g]:>9}{overcount:>+10}")
    print("  straddle = options spanning >1 water body; overcount = extra memberships if you")
    print("  count each whole option once per water body it touches.\n")

    # --- reconciliation ------------------------------------------------------------------
    ok = True

    def check(name, got, expected, tol=0):
        nonlocal ok
        agree = abs(got - expected) <= tol if tol else got == expected
        ok = ok and agree
        g = f"{got:,.2f}" if tol else f"{got:,}"
        e = f"{expected:,.2f}" if tol else f"{expected:,}"
        print(f"  [{'OK  ' if agree else 'FAIL'}] {name}: {g} vs {e}")

    print("Reconciliation against the by-application totals:")
    total_wb_points = sum(wb_group_points.values())
    total_none_points = sum(none_group_points.values())
    check("points partition (Σ water-body + none = current)",
          total_wb_points + total_none_points, cur_points)
    check("no point lands in two water bodies (disjoint)", overlap_points, 0)
    check("annual payment (Σ apportioned + none = current)",
          sum(wb_group_cost.values()) + sum(none_group_cost.values()), cur_cost, TOL)
    check("every application's points fully attributed",
          1 if points_attributed_by_app == app_points else 0, 1)

    # Per-group conservation: every group's points and payment are fully attributed across
    # the water bodies plus its 'none' bucket. This is the "for all, not just soil" check.
    group_points_ok = all(
        sum(wb_group_points[(g, n)] for n in wb_names) + none_group_points[g] == cur_group_points[g]
        for g in groups
    )
    group_cost_ok = all(
        abs(sum(wb_group_cost[(g, n)] for n in wb_names) + none_group_cost[g] - cur_group_cost[g]) <= TOL
        for g in groups
    )
    ok = ok and group_points_ok and group_cost_ok
    print(f"  [{'OK  ' if group_points_ok else 'FAIL'}] every group's points partition across "
          f"water bodies ({len(groups)} groups)")
    print(f"  [{'OK  ' if group_cost_ok else 'FAIL'}] every group's payment apportions across "
          f"water bodies ({len(groups)} groups)")

    # --- the multipoint cost, stated (generalised to all groups) -------------------------
    tot_straddle = sum(group_straddle_options.values())
    tot_memberships = sum(wb_group_optmemberships.values())
    print(f"\nThe multipoint cost, stated (does NOT reconcile, by nature):")
    print(f"  {tot_straddle} of {cur_options} options (all groups) straddle >1 water-body catchment.")
    print(f"  Counting whole options once per water body overcounts the {cur_options} options by "
          f"{tot_memberships - cur_options} (Σ memberships = {tot_memberships}).")
    print(f"  Only point counts and pro-rata payment reconcile; whole-option membership cannot,")
    print(f"  because a MULTIPOINT option has no single home. {total_none_points} points fall inside")
    print(f"  the operational catchment but outside every water-body catchment (kept as 'none').")

    # --- EXACT per-parcel extent (SFIParcels nodes in sfi.ttl), attributed to water bodies ---
    # Each parcel carries its OWN area (ha) or length (m) and lies in exactly one water body, so extent
    # PARTITIONS exactly -- no apportionment. This is what the app's "Extent" column reports (per action
    # type; it is deliberately never summed into a catchment total, because a field carries several
    # actions). Here we prove the partition: per group, Σ over water bodies == the whole-catchment total.
    parcels = q("""SELECT ?opt ?wkt ?area ?mtl WHERE {
        ?parcel core:partOf ?opt ; geo:asWKT ?wkt .
        OPTIONAL { ?parcel exf:area ?area } OPTIONAL { ?parcel exf:mtl ?mtl } }""")
    # group per option, via the same grouping used above
    opt_group = {}
    for r in rows:
        opt_group[r[1].value] = group_of(r[1].value, r[3].value if r[3] is not None else None)[1]
    cur_group_ha = defaultdict(float); cur_group_m = defaultdict(float)
    wb_group_ha = defaultdict(float); wb_group_m = defaultdict(float)
    none_ha = none_m = 0.0
    n_parcels = 0
    for r in parcels:
        grp = opt_group.get(r[0].value)
        if grp is None:
            continue
        n_parcels += 1
        lon, lat = parse_point(r[1].value)
        ha = float(r[2].value) if r[2] is not None else 0.0
        m = float(r[3].value) if r[3] is not None else 0.0
        cur_group_ha[grp] += ha; cur_group_m[grp] += m
        mem = membership(lon, lat)
        if not mem:
            none_ha += ha; none_m += m; continue
        wb_group_ha[(grp, mem[0])] += ha; wb_group_m[(grp, mem[0])] += m

    ha_ok = all(abs(sum(wb_group_ha[(g, n)] for n in wb_names) + 0 - cur_group_ha[g]) <= 1e-4
                for g in cur_group_ha)
    m_ok = all(abs(sum(wb_group_m[(g, n)] for n in wb_names) + 0 - cur_group_m[g]) <= 1e-4
               for g in cur_group_m)
    tot_ha = sum(cur_group_ha.values()); tot_m = sum(cur_group_m.values())
    print(f"\nExact per-parcel extent (SFIParcels in sfi.ttl), partitioned to water bodies:")
    check("parcels line up with options (== option-points)", n_parcels, cur_points)
    check("no parcel outside every water body (all inside the OC)", round(none_ha + none_m, 4), 0.0, TOL)
    print(f"  [{'OK  ' if ha_ok else 'FAIL'}] every group's HECTARES partition across water bodies "
          f"(Σ = {tot_ha:,.1f} ha)")
    print(f"  [{'OK  ' if m_ok else 'FAIL'}] every group's METRES partition across water bodies "
          f"(Σ = {tot_m:,.0f} m)")
    ok = ok and ha_ok and m_ok
    print(f"  (extent is exact per sub-catchment; it is reported PER ACTION TYPE and never summed to a "
          f"catchment total -- a field carries several actions.)")

    print("\n" + ("ALL RECONCILIATIONS PASS" if ok else "FAILURES -- decomposition does not tie out"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
