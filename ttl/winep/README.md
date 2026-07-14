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
  clause). → **11 actions**, **27 proposed limits** across 7 permits.

  > **Note, from an audit of this claim.** In the delivered graph the site clause is currently doing
  > **nothing**: all **11** emitted actions have a `targetPermit` that is already one of the catchment's
  > regulation permits, so the permit clause keeps every one of them and **deleting the site clause
  > would change the output by zero rows**. (This paragraph used to cite `042116` as an example of a
  > permit kept by the *site* clause — it is one of the 61 regulation permits, so the *permit* clause
  > keeps it; the example was backwards.) The clause is retained because it is the correct rule and it
  > will matter the moment WINEP proposes an action for a permit this catchment holds no regulation data
  > on. But it is not load-bearing today, and the README should not have implied it was.
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
