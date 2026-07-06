# WINEP dataset — scope

The proposed future limits and improvement actions (the "future works" story) from the PR24 Water
Industry National Environment Programme. Built by `winep_to_db.py` (parses the national xlsx into
`winep.duckdb`) → ontop (`winep.obda`) → `../winep.ttl`.

```
python ttl/winep/winep_to_db.py
./ontop/ontop materialize --mapping ttl/winep/winep.obda --properties ontop/duckdb-winep.properties \
    --output ttl/winep/winep_raw.ttl --format turtle \
  && rdfpipe -i turtle -o turtle ttl/winep/winep_raw.ttl > ttl/winep.ttl
```

## How the scope was whittled down (for convenience)

The PR24 WINEP National Dataset is ~18.6k rows covering every water company and driver nationally.
This demonstrator keeps only what tells the "solving for a substance" story around Poole Harbour:

- **One company, one function.** Rows are filtered to
  `Water_Company = 'Wessex Water Service Ltd'` **AND** `EA_Function = 'Water Quality'`. (Wessex is
  the operator for Poole Harbour; everything under WINEP here is therefore Wessex Water.)
- **Only actions that propose a limit.** An action is emitted only if at least one of its 8
  `Proposed_*` limit cells parses to something (a structured limit, a carried-over continuance, or
  a verbatim statement). Actions with no proposed limit — e.g. monitoring-only actions — are skipped.
- **Clipped to the catchment (union rule).** This is the last filter, and it's a distinct,
  commented `if` in `winep_to_db.py`. An action is kept only if **either** its site falls within the
  Poole Harbour catchment boundary (`shapely` point-in-polygon, WINEP Easting/Northing tested against
  the catchment reprojected to EPSG:27700) **or** its `targetPermit` is one of the catchment's
  regulation permits. Both clauses are needed: WINEP sites are rounded to 1 km, so a boundary works
  can land just outside the polygon (kept by the permit clause, e.g. 401336, 401354); conversely a
  site can sit inside the catchment for a permit we hold no regulation data on (kept by the site
  clause, e.g. 042116). → **11 actions**, **27 proposed limits** across 7 permits.
- **Only the columns needed.** Reference tables (substances, units, statistics) are built from just
  the values actually used by the emitted limits.
- **Permit refs canonicalised.** `Licence_Permit_Obstruction_ID` is zero-padded to 6 digits so a
  WINEP `targetPermit` (e.g. `42451`) resolves to the regulation permit (`042451`) instead of
  dangling — this also lets the catchment permit clause match.

## Proposed-limit interpretation

The proposed-limit cells are human-authored, semi-structured text. `winep_to_db.py` classifies
each as **structured** (196), **carried-over** continuance (67), or **uninterpreted** verbatim (5).
See **`TODO.md`** for the parser's interpretive assumptions, the remaining uninterpreted cells, the
unresolved generic-`chemical` analyte, and the competing-driver caveat (one permit+substance can
carry more than one proposed limit from different regulatory drivers — the permit takes the most
stringent).

Regenerable intermediates (`winep.duckdb`, `winep_raw.ttl`) are gitignored.
