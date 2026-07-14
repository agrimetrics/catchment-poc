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

Each dataset is shredded to one Turtle file — `ttl/regulation.ttl`, `ttl/winep.ttl`, `ttl/breaches.ttl`
and `ttl/sfi.ttl` via **DuckDB shred → ontop map → rdfpipe**, and `ttl/designations.ttl` (SSSI/SAC/SPA
as GeoSPARQL features) straight via **geopandas → rdflib**. `app/server.py` loads all **five** into a
single pyoxigraph store and serves, **from one origin (port 8000)**, a SPARQL endpoint, a small proxy
to the EA Water Quality Archive, the static frontend (map, plus in-app SPARQL editor and docs viewer),
and the repo's Markdown docs. Serving everything from one origin
means the browser makes same-origin requests, so there is no CORS to configure. The store is rebuilt
from the `.ttl` files on every start — nothing is persisted.

`ttl/breaches.ttl` is deliberately its own graph. A permit, a condition and a limit are **asserted**
facts — the EA published them and this store reproduces them. A breach is a **derived judgement**:
nobody published it, we computed it. Keeping the two in one file would invite a reader to lend our
arithmetic the register's authority.

## Quickstart — run the app

```bash
poetry install --no-root
eval $(poetry env activate)
python app/server.py          # loads the 5 graphs, then serves on port 8000
```

Then open **http://localhost:8000**. The server runs in the foreground — press **Ctrl-C** in
that terminal to stop it. Nothing is persisted (the store is rebuilt in memory on each start), so
there is no cleanup and no state to reset between runs.

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

### Configuring the endpoints (pointing at another SPARQL server)

The frontend reads its endpoints from [`app/config.js`](app/config.js) (`window.APP_CONFIG`), a plain
static asset loaded before `app.js` — edit it, no rebuild:

```js
window.APP_CONFIG = {
  sparqlEndpoint: "sparql",                  // every table + the query editor
  observationsEndpoint: "observations",      // the substance time-series chart
  tilesUrl: "tiles/{z}/{x}/{y}.png",         // basemap tiles (same-origin proxy by default)
};
```

- **No leading slash.** These are resolved against the *page* URL, so the app works both at the origin
  root and under a sub-path (`/catchment-demo/`). A leading slash (`"/sparql"`) pins the request to the
  origin root and **breaks any sub-path deployment** — see the pitfall note under *Deploying as a static
  site*. This block used to show leading slashes and contradict its own warning ten lines later; copying
  it broke the deploy it was meant to explain.
- An **absolute** URL (`https://data.internal/sparql`) targets another host directly, which then must
  send `Access-Control-Allow-Origin`, or the browser blocks it.
- Quick, file-free override for testing: append `?sparql=<url>` (or `?observations=<url>`) to the page
  URL.

This is what lets the app run as a **static site** with the Python server removed entirely: host
`app/` on any static host and set `sparqlEndpoint` to a same-origin path your proxy forwards to your
SPARQL server. Two caveats for that mode:

- **The EA Water Quality Archive has no CORS** (verified: its responses carry no
  `Access-Control-Allow-Origin`, and the request's custom headers would trigger a preflight `OPTIONS`
  that 404s). So the browser **cannot** call it directly — `observationsEndpoint` must point at a
  proxy (e.g. the same reverse proxy that fronts your SPARQL server), not at `environment.data.gov.uk`.
- The bundled `python app/server.py` remains the simplest way to serve everything from one origin for
  local use; the config just decouples the frontend from it.

### Deploying as a self-contained container

For a hosted deployment (e.g. `environment-test.data.gov.uk`) the easiest path is the bundled Python
app in a container — it serves **everything from one origin**, so there is no CORS anywhere and the
browser only ever talks to your host:

```bash
docker build -t catchment-poc .
docker run --rm -p 8000:8000 catchment-poc      # http://localhost:8000
```

To keep it working on a locked-down network, the frontend's third-party assets are **vendored** into
[`app/vendor/`](app/vendor/) (Leaflet, markercluster, proj4, marked, and the SPARQL editor as a
mirrored ES-module closure), and basemap tiles are proxied same-origin via `/tiles/{z}/{x}/{y}.png`.
The page loads **no external CDN** — only this origin. The only outbound calls are *server-side*: the
observations proxy to the EA archive, and the tile fetch.

Runtime is configured by environment variables (all optional):

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` (the image sets `0.0.0.0`) | Interface to bind |
| `PORT` | `8000` | Port to listen on (platforms inject this) |
| `BASE_PATH` | _(empty — served at root)_ | Mount prefix for serving under a **sub-path** (see below) |
| `EA_BASE` | `https://environment.data.gov.uk/water-quality/sampling-point` | Observations upstream — point at an egress proxy if direct egress is blocked |
| `TILE_BASE` | `https://tile.openstreetmap.org` | Basemap tile source for the `/tiles` proxy |
| `CACHE_DIR` | a temp dir (e.g. `/tmp/catchment-poc-cache`) | Where the observation + tile disk caches live — **outside the repo**. Set to a mounted volume to persist, or to `none`/`off`/empty to disable disk caching entirely |

#### Serving under a sub-path (e.g. `https://host/catchment-demo`)

The app serves happily at the origin root **or** under a sub-path. The frontend uses only relative
URLs, and the server strips a configurable mount prefix, so **a plain pass-through reverse proxy is
all you need** — no proxy-side URL rewriting:

```bash
docker run -e BASE_PATH=/catchment-demo -p 8000:8000 catchment-poc
```

Point the proxy's `/catchment-demo/` location at the container **without stripping the prefix** (e.g.
nginx `location /catchment-demo/ { proxy_pass http://catchment:8000; }`). The container then handles
everything itself: it strips `BASE_PATH` from each request and 301-redirects the bare
`/catchment-demo` to `/catchment-demo/` so the browser resolves the page's relative URLs under the
sub-path. Requests to `/` (e.g. the container healthcheck) still work regardless of `BASE_PATH`.

> A leading-slash pitfall: everything the frontend requests is relative on purpose. If you customise
> `app/config.js`, keep endpoints relative (`"sparql"`, not `"/sparql"`) — a leading slash pins the
> request to the origin root and breaks the sub-path.

The store is the in-memory Oxigraph rebuilt from the committed `.ttl` on boot, so the container is
fully self-sufficient — no external database. A note on the server itself: it uses the stdlib
`http.server` (fine for an internal/test deployment with modest traffic); TLS and ingress are expected
to be terminated by the platform's load balancer.

> **Downloaded data never lands in the source tree.** The observation and tile caches default to a
> temp directory outside the project (`CACHE_DIR`); nothing under `.obs_cache/` / `.tile_cache/` is
> written into the repo or committed.

### The app's views

The page always shows the catchment map with tables beneath it, grouped into **Water** and **Land**.
The two water views are the demonstrator's argument in miniature. They are two different worlds:

> **The regulated world** exists because a permit says so. It is knowable in advance, from a register,
> whether or not anyone ever visits.
> **The measured world** exists because someone took a sample. Most of it belongs to no permit at all.
>
> Neither is a view of the other. A permit is not evidence that anything was measured, and a
> measurement is not evidence that anything was permitted. Keeping them apart on the screen is what
> makes it possible to ask where they disagree.

- **The regulated world** — everything that hangs off a permit identifier, in one view: the **limits**
  in force, the **breaches** of them, and the **WINEP** actions proposing the limits that will replace
  them. Breaches are *periods* (a run of consecutive failing observations with no passing result in
  between): **current** while the period is still open, otherwise **past** with a start and end; a
  lone failure is a period whose start and end are the same day. Pick a substance and the view
  becomes the story for that substance — its limits, its breaches, its proposed future limits, and a
  live hit/miss time-series chart per discharge point. (These were three separate tabs — *Breaches*,
  *Substance Views* and *WINEP* — which made one subject, seen at three points in time, read as
  three subjects. View key: `?view=regulated`.)
- **The measured world** — pollution as actually sampled, **regardless of sampling-point source**.
  Every one of the catchment's **161 sampling points**, coloured by what the EA samples there, with
  the same live time-series chart on any of them. **91 of them belong to no permit at all** — rivers,
  boreholes, bathing waters, investigation points — so the regulated world is structurally blind to
  them: there is no permit to reach them through. A point that is measured but not regulated has no
  limit, so its chart shows readings and no pass mark; a river is not "compliant", it is merely
  measured. (View key: `?view=measured`.)
- **Sustainable Farming Incentive** — SFI agreements as convex-hull polygons coloured by programme,
  with a cost-per-intervention pie (or count bar chart), an option-type filter, and per-application
  valuations. See the [SFI data warnings](ttl/sfi/README.md#data-warnings) for the pricing caveats.

**Conservation designations** (SSSI / SAC / SPA) can be toggled on any map view from the legend —
individually or by category — and render beneath all plotted locations. The legend collapses while
the chart panel is open.

**Every table** is paginated at 10 rows (`« ‹ 1 2 3 › »`) and sortable by clicking any column header.
Two details worth knowing, because both are easy to get subtly wrong:

- A column is numeric only if **every** value in it is a bare, unpadded number. Permit refs like
  `040136` are *identifiers that look like digits* — the leading zero is the giveaway — and they share
  a column with `400114/CF/01` and `EPRBB3593EG`. Coercing them per-cell yields one column holding two
  incomparable kinds of key, and an order that is neither numeric nor alphabetical.
- Rows sort and page in **groups**: an expandable summary row carries its hidden detail row with it,
  so a permit's limits can never end up filed under a different permit.

**SPARQL** ([`/sparql.html`](app/sparql.html)) and **Docs** ([`/docs.html`](app/docs.html)) hang off the
app chrome (top-right of the header, and the footer):

- **SPARQL** — an embedded [SPARQL editor](https://github.com/sib-swiss/sparql-editor)
  wired to the same-origin `sparql` endpoint, for running ad-hoc queries against the loaded graphs.
- **Docs** — an in-app viewer that renders this repo's Markdown (the
  top-level and per-dataset READMEs, the TODOs) with a sidebar and working cross-links.

**Points apart** ([`/points.html`](app/points.html)) is the demonstrator's central argument. It is
*not* in the header or the footer — it is reached from an inline link in the regulated world's lede,
because it is an argument you arrive at from the data, not a utility page.

### Points apart — the argument, in six screens

`points.html` makes the case that these records can be merged reliably **only by identifier**. It is
six screens, stepped through in order, each with its own map framed on its own subject:

| Screen | What it shows |
| --- | --- |
| [Why identifiers](app/points.html) `#/why` | The join this store makes, drawn as a diagram, against the same three things with their identifiers thrown away. The catchment holds **122 outlets**; **115** have a coordinate, **102** have a sampling point, and **91** have both — so 91 is the only honest denominator for scoring a guess. Over those 91, proximity recovers **42 / 91 (46%)** of what the register states. The screen then answers its own two best objections **with numbers rather than argument**. *"Restrict the layer to outfall points"* — hand proximity an **oracle** (only the 70 points that genuinely monitor a discharge, a layer you could build only if you already had the answer) and it still gets just **47 / 91 (52%)**. Even cheating, it barely beats a coin toss. *"You used the worst coordinate"* — the register carries a grid reference at **three** levels and the store publishes **all three**, so the same join is scored against each, live: site **41/87 (47%)**, outlet **64/87 (74%)**, effluent **66/87 (76%)**, `water:monitoredAt` **87/87**. The finest coordinate is not reliably the most accurate, and the best of them still files one outlet in four under the wrong watercourse. |
| **1 · Blackheath** `#/blackheath` | *It can return something that is not an outfall at all.* The nearest sampling point to the works is `SW-50951085`, a **river station sited upstream** — the one place guaranteed to carry none of its effluent. It is 19 m away; the works' own sampling points are 188–201 m away. Proximity: **0 / 5**. |
| **2 · Brockhill** `#/brockhill` | *It cannot separate things that share a coordinate.* Seven outlets across four permits are published at **one identical grid reference** (the discharge *site's*, inherited by every outlet of every permit there). To a map they are one dot, so all seven get the same answer. Proximity: **1 / 7**, and the one it gets right it gets right by luck. |
| **3 · Doreys** `#/doreys` | *It cannot be given a radius that works.* Here proximity's answer is **right** — it is just **1.01 km away**. Tighten the radius until Brockhill is unambiguous and Doreys silently matches nothing; widen it until Doreys is found and Brockhill's single dot is within reach of 7 candidates. |
| **4 · No location** `#/unlocatable` | *Where there is no geometry, it cannot be run at all.* **7 outlets have no coordinate** — the register gives their permit no grid reference, and the store refuses to invent one. Pick one of the four permits and you see everything that *is* known — its sampling points, any WINEP action site — with **5 m / 50 m / 500 m** circles drawn round them, and the question: *where is the outfall?* It answers itself from the store's own evidence: of the 91 outlets whose location we **do** know, only **1** sits within 5 m of its sampling point, **21%** within 50 m, and **4 lie beyond 500 m** — by which point the circle is 79 hectares of countryside. The outfall is not drawn on that map, because there is no honest place to put it. |
| **Explorer** `#/explorer` | The collections themselves — permits, discharge points, sampling points, WINEP actions — filterable, each placeable on the map, with the full chain (`targetPermit` → `permitSite` → `monitoredAt`) lit up and labelled with the distance every link spans. |

Every **count** on those screens is **computed from the store at render time**, so it cannot drift from
the data behind it. (The example ledes are hand-written prose and do name specific figures — "seven
outlets", "a kilometre away" — checked against the build output rather than derived at runtime.) Four
of the six screens deep-link into the SPARQL editor with the query that reproduces them — including
the nearest-neighbour join itself, so a reader can run the mistake and watch it succeed.

**Asserted vs drawable.** The page keeps these apart everywhere, and has to: it argues that geometry
must not decide what exists, so it cannot itself quietly count only what it can draw. 122 outlets
exist; 115 can be drawn; 102 are monitored; 91 can be *scored*. The explorer states how many links it
asserts (107) alongside how many it can draw (91), rather than reporting the second as the first.

### Geometry and CRS

Every point carries **two** geometries, and the distinction is load-bearing:

| | CRS | What it is |
| --- | --- | --- |
| `#geography` | **EPSG:27700** (British National Grid, metres) | the **source** — the EA's own numbers, verbatim, never reprojected |
| `#geography-crs84` | **CRS84** (WGS84 lon/lat) | **derived** by reprojection, and marked `geo:hasDefaultGeometry` |

The derived one exists because GeoSPARQL's `geof:` functions are defined over CRS84 and most engines —
oxigraph included — will not reproject: given only a British National Grid geometry they return
*unbound*. Designations and SFI options are natively CRS84 (their source GeoJSON carries no `crs`
member, and RFC 7946 says that means CRS84).

The CRS URI goes **first** in every `wktLiteral`, which is what GeoSPARQL requires. It used not to — and
that was not a formatting nit. A trailing URI is invisible to every parser, so engines silently assumed
CRS84 and read the easting `389950` as a *longitude*; the spatial query this repo shipped computed
~5,400 km, filtered everything out, and reported that **no discharges lie near any protected site**. Not
an error — an answer, and a reassuring one. See [`ttl/designations/TODO.md`](ttl/designations/TODO.md).

A discharge point's geometry comes from the permit register's own **site** grid reference — **not**
transcribed from its sampling point, because they are genuinely different places (see
[Points apart](app/points.html)). The sampling point carries **its own** geometry, captured from the EA
Water Quality Archive.

### Per-table SPARQL provenance links

Every table card carries a small **◈ SPARQL** link in its header that opens the embedded editor
pre-loaded with a single query reproducing that table's rows — click it to see, and run, the exact
question the table answers. This is the whole point of the demonstrator made legible: each table *is*
one declarative question over the linked graphs, not a pile of imperative glue.

There is a deliberate wrinkle worth stating plainly. At runtime the app does **not** run those
single queries. It runs a smaller set of queries once (the `Q` object in [`app/app.js`](app/app.js))
and **joins them in JavaScript**, because several views reuse the same base results and joining
client-side avoids re-querying. The provenance links are a **separate, hand-maintained** set of
queries (the `PQ` object) that fold each of those JS joins back into one SPARQL statement. Because
they are a second representation of the same logic, **they can drift**: if a table's join changes in
JS and its `PQ` query isn't updated to match, the link will show a query that no longer exactly
reproduces the table. A couple of them also simplify on purpose (e.g. the substance-story query
left-joins from current limits, so it omits the rare *proposed-only* row).

We accept that drift knowingly. This is a proof-of-concept about **why** linked data — the value on
show is that a heterogeneous catchment (regulation, WINEP, farming) becomes a set of tables each
answerable by one readable query. Keeping the runtime split-and-join for performance while offering
faithful-enough single queries for provenance serves that story better than distorting either side
to force a single source of truth. If this graduated past a POC, the honest fix would be to drive the
genuinely-single-query tables straight from their query (removing the JS join for those), and to add
a check that runs each `PQ` query and compares its row count against the rendered table.

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

**2. Breaches** — [`ttl/breaches/README.md`](ttl/breaches/README.md)

The **derived** graph: our assessment of the permits against the archive's own compliance samples. It
reads `regulation.duckdb`, so regulation must be built first.

```bash
python ttl/breaches/fetch_compliance_observations.py  # (occasional, needs EA egress) refresh compliance_observations.csv
python ttl/breaches/breaches_to_db.py                 # assess → breaches.duckdb
./ontop/ontop materialize --mapping ttl/breaches/breaches.obda \
    --properties ontop/duckdb-breaches.properties \
    --output ttl/breaches/breaches_raw.ttl --format turtle \
  && rdfpipe -i turtle -o turtle ttl/breaches/breaches_raw.ttl > ttl/breaches.ttl
```

> **Re-run the fetch whenever the regulation SCOPE changes.** `compliance_observations.csv` is a
> committed cache whose scope is *derived* from `regulation.duckdb` — so it moves when the register-
> sourced tables move, and it does not move with them unless someone re-runs it. That has bitten once:
> when outlets were re-sourced from the permit register, the store's monitored sampling points grew and
> this cache stayed put, so 15 points were assessed against nothing — and an unassessed point does not
> read as "unknown", it reads as **no breach**.

**3. WINEP** — [`ttl/winep/README.md`](ttl/winep/README.md) · backlog in [`ttl/winep/TODO.md`](ttl/winep/TODO.md)

```bash
python ttl/winep/winep_to_db.py                      # shred PR24 xlsx (+ regulation.duckdb, + catchment) → winep.duckdb
./ontop/ontop materialize --mapping ttl/winep/winep.obda \
    --properties ontop/duckdb-winep.properties \
    --output ttl/winep/winep_raw.ttl --format turtle \
  && rdfpipe -i turtle -o turtle ttl/winep/winep_raw.ttl > ttl/winep.ttl
```

**4. SFI** — [`ttl/sfi/README.md`](ttl/sfi/README.md)

```bash
python ttl/sfi/sfi_to_db.py                          # spatial clip + aggregate + concept scheme → sfi.duckdb
./ontop/ontop materialize --mapping ttl/sfi/sfi.obda --properties ontop/duckdb.properties \
    --output ttl/sfi/sfi_raw.ttl --format turtle \
  && rdfpipe -i turtle -o turtle ttl/sfi/sfi_raw.ttl > ttl/sfi.ttl
```

**5. Designations** (SSSI/SAC/SPA) — [`ttl/designations/README.md`](ttl/designations/README.md) · spatial queries in [`ttl/designations/TODO.md`](ttl/designations/TODO.md)

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
- **Regulation is abstracted.** Absolute rules only (`METHOD = ABSOLUTE`, so no comparative
  inlet-vs-discharge rules), seasonality collapsed to one limit per (permit, version, substance).
  Breaches are **periods**, not single failures. → [regulation README](ttl/regulation/README.md).
- **What EXISTS comes from the registers; what was MEASURED comes from the observations.** Permits,
  outlets, `monitoredAt` and sampling points are sourced from the permit register and the Water
  Quality Archive, so an outlet that has never produced a numeric result still exists (it used not
  to, and the store was quietly missing real regulated outlets as a result). *Conditions* are still
  observation-sourced, though — so a permit limit appears only if that substance was sampled at that
  permit, which is why 61 permits have outlets but only 58 have limits. Same bug, one level up, not
  yet fixed. → [regulation README](ttl/regulation/README.md).
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
                         index.html, app.js, style.css, config.js (endpoints, no rebuild needed),
                         points.{html,js,css} (Points apart — the argument, in six screens),
                         docs.{html,js,css} (Markdown docs viewer), sparql.{html,css} (SPARQL editor),
                         vendor/ (leaflet, proj4, marked, sparql-editor — no CDN at runtime),
                         catchment.geojson, {sssi,sac,spa}.geojson, TODO.md
ttl/                     the five committed graphs + per-dataset pipelines
  regulation/ breaches/ winep/ sfi/ designations/   {pipeline, README.md}
                         (+ winep/TODO.md, designations/TODO.md, regulation/fetch_version_dates.py,
                          regulation/fetch_sampling_points.py, breaches/fetch_compliance_observations.py)
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
- **`ttl/breaches/README.md`** — the **derived** graph: how a permit is assessed, what counts as a
  sample, which version applied, and — the part that matters — **what we could not judge, and why**.
- **`ttl/winep/TODO.md`** — the remaining curation backlog and interpretive assumptions for WINEP
  (the messiest dataset), including the competing-driver worked example.
- **[`audit/`](audit/)** — a full validation sweep of the demonstrator and its resolution.
  [`audit/README.md`](audit/README.md) is the record of what was wrong and what was done about it;
  [`audit/findings.md`](audit/findings.md) is the audit as delivered, unedited.

### If you read one thing besides this file

Read **[`audit/README.md`](audit/README.md)**. The audit found no arithmetic errors — every number in
every README re-derived exactly. What it found was a store that could not say *"I don't know"*, and so
kept saying something false instead: an unfetched sample displayed as **no breach**, a dropped link as
**no link**, a missing coordinate as **a plausible dot**. That is the same failure *Points apart* exists
to warn about, committed by the project making the argument.

The fix is the most important thing in the graph and it is not a corrected number — it is a **new fact
the store can state**: `wr:assessed false`, with a reason. **641 of 1,277 conditions** now say plainly
that they were never examined, instead of quietly reading as clean.

## License

Unless stated otherwise, the codebase in this repository is released under the MIT License.

Copyright (c) 2026 Crown Copyright (Government Digital Service)

The documentation and any other non-code content in this repository is licensed under the Open
Government Licence v3.0, except where otherwise stated.

Contains public sector information licensed under the Open Government Licence v3.0.s