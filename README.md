# Poole Harbour Rivers — Linked Data Catchment Demonstrator

A demonstrator that takes three Environment Agency datasets for the **Poole Harbour Rivers**
operational catchment — water **regulation** (permits, conditions, breaches), the **WINEP**
improvement programme, and **Sustainable Farming Incentive** (SFI) agreements — shreds each into
RDF, loads them into an in-memory [Oxigraph](https://pyoxigraph.readthedocs.io/) triplestore, and
explores them through a single Leaflet web app (the "three-ways" app) with conservation-designation
map underlays.

> Scope note: everything here is deliberately cut down to one catchment and the simplest defensible
> model. The per-dataset READMEs record exactly how each was whittled down and what was assumed —
> see **[Documentation map](#documentation-map)**.

## Architecture

```
raw_datasets/ ──► per-dataset pipeline ──► ttl/*.ttl ──► app/server.py ──► browser
                  (DuckDB shred → ontop      (RDF)        (pyoxigraph      (Leaflet map
                   → rdfpipe)                              triplestore)     + tables)
```

Each dataset is shredded to one Turtle file — `ttl/regulation.ttl`, `ttl/winep.ttl`, `ttl/sfi.ttl`
via **DuckDB shred → ontop map → rdfpipe**, and `ttl/designations.ttl` (SSSI/SAC/SPA as GeoSPARQL
features) straight via **geopandas → rdflib**. `app/server.py` loads all four into a single
pyoxigraph store and serves, **from one origin (port 8000)**, a SPARQL endpoint, a small proxy to the
EA Water Quality Archive, the static frontend (map, plus in-app SPARQL editor and docs viewer), and
the repo's Markdown docs. Serving everything from one origin
means the browser makes same-origin requests, so there is no CORS to configure. The store is rebuilt
from the `.ttl` files on every start — nothing is persisted.

## Quickstart — run the app

```bash
poetry install --no-root
eval $(poetry env activate)
python app/server.py          # loads the 4 graphs, then serves on port 8000
```

Then open **http://localhost:8000**.

| URL                                                              | What it serves                                                                                                        |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `http://localhost:8000/`                                         | the frontend (Leaflet map + tables)                                                                                   |
| `http://localhost:8000/sparql.html`                              | in-browser SPARQL editor (SPARQL 1.1) over the store — reachable from the header and footer                          |
| `http://localhost:8000/docs.html`                                | in-app documentation viewer that renders this repo's Markdown — reachable from the header                            |
| `http://localhost:8000/sparql`                                   | SPARQL 1.1 endpoint (GET `?query=` or POST), returns `application/sparql-results+json`                                |
| `http://localhost:8000/observations?samplingPoint=&determinand=` | server-side proxy to the EA Water Quality Archive (follows `Link` pagination), powers the substance time-series chart |
| `http://localhost:8000/*.md`                                     | raw Markdown docs from the repo root (what the docs viewer fetches; `.md` under the repo only)                        |

The rendered `.ttl` files are committed, so **running the app needs no pipeline rebuild** — only
`poetry install` and `python app/server.py`.

### The app's views

The page always shows the catchment map with tables beneath it, grouped into **Water** and **Land**:

- **Breaches** — condition breaches as *periods* (a run of consecutive failing observations with no
  passing result in between). A breach is **current** while its period is still open (nothing has
  passed since it began), otherwise **past** with a start and end; a lone failure is a period whose
  start and end are the same day. Each links out to the Water Quality Explorer sampling point.
- **Substance Views** — pick a substance (defaults to Ammoniacal Nitrogen, `0111`); the map and
  tables show its in-force permit limits and the WINEP actions proposing future limits, plus a live
  hit/miss time-series chart per discharge point.
- **WINEP** — the Water Industry National Environment Programme actions (all Wessex Water here) with
  completion dates and their proposed / continued limits.
- **Sustainable Farming Incentive** — SFI agreements as convex-hull polygons coloured by programme,
  with a cost-per-intervention pie (or count bar chart), an option-type filter, and per-application
  valuations. See the [SFI data warnings](ttl/sfi/README.md#data-warnings) for the pricing caveats.

**Conservation designations** (SSSI / SAC / SPA) can be toggled on any map view from the legend —
individually or by category — and render beneath all plotted locations. The legend collapses while
the chart panel is open.

Two utility pages hang off the app chrome (top-right of the header, and the footer):

- **SPARQL** ([`/sparql.html`](app/sparql.html)) — an embedded [SPARQL editor](https://github.com/sib-swiss/sparql-editor)
  wired to the same-origin `/sparql` endpoint, for running ad-hoc queries against the loaded graphs.
- **Docs** ([`/docs.html`](app/docs.html)) — an in-app viewer that renders this repo's Markdown (the
  top-level and per-dataset READMEs, the TODOs) with a sidebar and working cross-links.

Geometry notes: regulation discharge points and SFI options carry WGS84 lon/lat; WINEP action sites
carry EPSG:27700 (British National Grid), reprojected in the browser with proj4. The discharge-point
geometry is asserted on the discharge point we own (a `#geography` fragment), transcribed from the
coordinates of the sampling point it is `monitoredAt`; the `environment.data.gov.uk` sampling point
itself is left as a bare `geo:Feature`.

## Rebuilding the RDF pipelines

All intermediates (`*.duckdb`, `*_raw.ttl`) are gitignored and regenerated; the final `ttl/*.ttl`
are committed. Each dataset's own README documents its scope, columns and modelling in detail — the
commands below are the reproducible rebuild in **dependency order** (WINEP reads `regulation.duckdb`,
so regulation must be built first).

**1. Regulation** — [`ttl/regulation/README.md`](ttl/regulation/README.md)

```bash
python link_data.py                                  # joins raw CSVs → output_data/observations_with_permits_and_rules.csv
python ttl/regulation/fetch_version_dates.py         # (occasional) refresh permit_version_dates.csv from the EA public register
python ttl/regulation/regulation_to_db.py            # shred → regulation.duckdb
./ontop/ontop materialize --mapping ttl/regulation/regulation.obda \
    --properties ontop/duckdb-regulation.properties \
    --output ttl/regulation/regulation_raw.ttl --format turtle \
  && rdfpipe -i turtle -o turtle ttl/regulation/regulation_raw.ttl > ttl/regulation.ttl
```

**2. WINEP** — [`ttl/winep/README.md`](ttl/winep/README.md) · backlog in [`ttl/winep/TODO.md`](ttl/winep/TODO.md)

```bash
python ttl/winep/winep_to_db.py                      # shred PR24 xlsx (+ regulation.duckdb, + catchment) → winep.duckdb
./ontop/ontop materialize --mapping ttl/winep/winep.obda \
    --properties ontop/duckdb-winep.properties \
    --output ttl/winep/winep_raw.ttl --format turtle \
  && rdfpipe -i turtle -o turtle ttl/winep/winep_raw.ttl > ttl/winep.ttl
```

**3. SFI** — [`ttl/sfi/README.md`](ttl/sfi/README.md)

```bash
python ttl/sfi/sfi_to_db.py                          # spatial clip + aggregate + concept scheme → sfi.duckdb
./ontop/ontop materialize --mapping ttl/sfi/sfi.obda --properties ontop/duckdb.properties \
    --output ttl/sfi/sfi_raw.ttl --format turtle \
  && rdfpipe -i turtle -o turtle ttl/sfi/sfi_raw.ttl > ttl/sfi.ttl
```

**4. Designations** (SSSI/SAC/SPA) — [`ttl/designations/README.md`](ttl/designations/README.md) · spatial queries in [`ttl/designations/TODO.md`](ttl/designations/TODO.md)

```bash
python ttl/designations/designations_to_ttl.py       # clip → ttl/designations.ttl (RDF) + app/{sssi,sac,spa}.geojson (display)
```

The ontology the mappings target lives in the sibling **`ontology-work`** repo
(`defra-core-ontology.ttl`, `defra-regulation.ttl`, `defra-water.ttl`, `defra-farming.ttl`,
`defra-nature.ttl`).

## Scope, warnings & assumptions (summary)

Cross-cutting points a consumer of the graph should know. Detail — and every column-level choice —
is in the linked per-dataset READMEs.

- **One catchment, deliberately cut down.** Every dataset is filtered to Poole Harbour Rivers (by
  region, spatial clip, or permit overlap). Counts and the exact filters are in each README.
- **Regulation is abstracted.** Absolute min/max rules only (no percentile/rolling/load), seasonality
  collapsed to one limit per (permit, version, substance), numeric results only. Breaches are
  **periods**, not single failures. → [regulation README](ttl/regulation/README.md).
- **WINEP proposed limits are semi-structured text**, interpreted deterministically; 5 cells remain
  verbatim, one generic `chemical` analyte is unresolved, and a permit+substance can carry competing
  proposals from different regulatory drivers (the app lists all). → [WINEP TODO](ttl/winep/TODO.md).
- **SFI payments are indicative.** Costs are base-rate × extent only (per-hectare / per-100-metres),
  ignoring qualifying pay text; **SFI 2023 options are unpriced** (only the Expanded Offer has
  published rates in source); group labels are curated. → [SFI data warnings](ttl/sfi/README.md#data-warnings).
- **Designations are GeoSPARQL, WGS84/CRS84.** SSSI/SAC/SPA are `defra-nature:ProtectedSite` features
  with ~2 m `geo:asWKT` geometry, so spatial questions (e.g. discharges within 200 m of a protected
  area) run in SPARQL. The bundled pyoxigraph store's GeoSPARQL is **point-only** (`geof:distance`
  returns unbound for polygons, no `geof:buffer` — see oxigraph#1560), so accurate point-to-polygon
  proximity needs **GraphDB**; `TODO.md` has that query plus a centroid approximation that runs on the
  bundled endpoint. → [designations README](ttl/designations/README.md) · [spatial-query TODO](ttl/designations/TODO.md).
- **Some geometry is transcribed / reprojected**, and one SFI option group (PAC) shows its code where
  the option isn't in the concept scheme. See the app geometry note above.

## Data sources

- Operational Catchment GeoJSON: `raw_datasets/poole_harbour_rivers_operational_catchment.geojson`
  — https://environment.data.gov.uk/catchment-planning/OperationalCatchment/3367
- Water Quality observations 2020–2026: `raw_datasets/poole_harbour_rivers_water_quality_observations_2020_2026_combined.csv`
  — https://environment.data.gov.uk/water-quality/downloads (multi-year files concatenated by `raw_datasets/merge_observational_data.py`)
- Consented Discharges to Controlled Waters with Conditions
  — https://www.data.gov.uk/dataset/55b8eaa8-60df-48a8-929a-060891b7a109 (tables extracted with `mdb-export`, see `raw_datasets/access_database_csv_files/README.md`):
  discharges/permits `consents_active.csv`, permit rules `determinands.csv`, effluents `effluents.csv`
- PR24 WINEP National Dataset: `raw_datasets/PR24 WINEP National Dataset.xlsx`
  — https://environment.data.gov.uk/dataset/39b11ea0-3cfa-4cbb-b3a1-b5950019f169
- SFI options GeoJSON: `raw_datasets/poole_harbour_rivers_sustainable_farming_initiatives.geojson`
  — https://environment.data.gov.uk/explore/58cc85ab-a955-4b37-9c42-eee8532cbd01 ;
  option details `raw_datasets/SFI Option details.xlsx` ; data-notes PDF (concept scheme)
- Sites of Special Scientific Interest England — https://environment.data.gov.uk/dataset/ba8dc201-66ef-4983-9d46-7378af21027e
- Special Protection Areas England — https://environment.data.gov.uk/dataset/4c660eee-887e-4c8b-91e5-d84b4c1078ac
- Special Areas of Conservation England — https://environment.data.gov.uk/dataset/6ecea2a1-5d2e-4f53-ba1f-690f4046ed1c

## Repository layout

```
app/                     three-ways web app: server.py (pyoxigraph + SPARQL + proxy + static + .md),
                         index.html, app.js, style.css, catchment.geojson, {sssi,sac,spa}.geojson,
                         docs.{html,js,css} (Markdown docs viewer), sparql.{html,css} (SPARQL editor)
ttl/                     the four committed graphs + per-dataset pipelines
  regulation/ winep/ sfi/ designations/  {pipeline, README.md} (+ winep/TODO.md, designations/TODO.md,
                         regulation/fetch_version_dates.py)
ontop/                   vendored ontop CLI + duckdb JDBC .properties (one per dataset)
raw_datasets/            source data + merge_observational_data.py
link_data.py             joins the regulation raw CSVs → output_data/ (input to regulation_to_db.py)
```

## Documentation map

All of the docs below also render in-app in the **Docs** viewer (`/docs.html`) while the server is running.

- **This README** — front door: what it is, how to run/rebuild, ports, views, and the scope/warnings
  *summary* above.
- **`ttl/<dataset>/README.md`** — the authoritative per-dataset detail: scope whittling, enrichments,
  modelling and data warnings.
- **`ttl/winep/TODO.md`** — the remaining curation backlog and interpretive assumptions for WINEP
  (the messiest dataset), including the competing-driver worked example.

## License

Unless stated otherwise, the codebase in this repository is released under the MIT License.

Copyright (c) 2026 Crown Copyright (Government Digital Service)

The documentation and any other non-code content in this repository is licensed under the Open
Government Licence v3.0, except where otherwise stated.

Contains public sector information licensed under the Open Government Licence v3.0.s