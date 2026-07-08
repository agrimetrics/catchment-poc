# App / server TODO

## `ASK` queries return HTTP 400

**Symptom.** Running a SPARQL `ASK` query (e.g. `ASK { ?s ?p ?o }`) against `/sparql` — including
from the in-app SPARQL editor — fails with **HTTP 400** and the message:

```
'pyoxigraph.QueryBoolean' object has no attribute 'variables'
```

`SELECT` and `CONSTRUCT`/`DESCRIBE` are unaffected.

**Cause.** [`results_to_json()`](server.py) detects an `ASK` result with `isinstance(results, bool)`,
but pyoxigraph 0.5.x returns a **`pyoxigraph.QueryBoolean`** object, not a Python `bool`. The check is
`False`, so the code falls through to the `SELECT` path and reads `results.variables` → `AttributeError`
→ caught by `_run_query` → 400.

**Fix.** Detect the boolean result by type rather than `isinstance(..., bool)`, e.g. check
`isinstance(results, ox.QueryBoolean)` (or `not hasattr(results, "variables")`) and return
`{"head": {}, "boolean": bool(results)}`. `bool(QueryBoolean)` gives the right truth value.

**Notes.** Pre-existing (predates the container/sub-path work). Low-risk one-liner; add a quick check
that `ASK { ?s ?p ?o }` returns `{"boolean": true}` so this doesn't regress on a future pyoxigraph bump.

---

## Help page: "Why linked data beats a GIS spatial merge"

**Goal.** A page that makes the demonstrator's central argument concrete: heterogeneous EA datasets
about the *same regulated thing* can only be merged **reliably and deterministically by identifier**,
not by location. A GIS "put them on a map and spatially join what's nearby" approach quietly fails
here — the records that belong together sit hundreds of metres to over a kilometre apart, in
*different coordinate reference systems*, in the source data.

### The worked example (real data — verified in the store)

Permit **042451** (Blackheath WRC) and its two WINEP actions all describe the same works — one is the
discharge/monitoring point, the others are proposed changes to the *state* of that same permit:

| Thing | Identifier | Source geometry | CRS |
| --- | --- | --- | --- |
| Permit discharge point | `permit/042451` (`…/outlet/1/effluent/1`) | `POINT(-2.1463 50.7388)` | WGS84 (EPSG:4326) |
| Action — "Blackheath WRC - Phosphorus & Nitrogen Removal" | `action/08WW102103` | `POINT(389000 93000)` | BNG (EPSG:27700) |
| Action — "Blackheath WRC - Permit Change" | `action/08WW100250` | `POINT(390000 92000)` | BNG (EPSG:27700) |

Reprojecting to a common CRS to measure the gaps:

- The **two actions are ~1.4 km apart from each other** — despite both being *Blackheath WRC*.
- Discharge point → the two action sites: **~813 m** and **~1,274 m**.
- Two different CRS to begin with; a naïve merge that skips reprojection misplaces them entirely.

**Why GIS spatial-merge fails here.** Any nearest-feature / point-in-buffer join needs a distance
tolerance. Too tight (say 100 m) and none of these three associate. Loose enough to capture 1.4 km and
you sweep in *unrelated* neighbouring permits/actions — false positives. There is no tolerance that is
simultaneously correct for this cluster and safe across the catchment. The spatial relationship is
simply not a reliable proxy for "same regulatory thing."

**Why identifiers work.** `reg:targetPermit` links each action to the permit deterministically,
independent of geometry. One traversal assembles the complete picture — no tolerance, no CRS handling,
no false positives.

### Example queries (tested against the store)

**A — "What GIS sees": the three geometries, different CRS, far apart.**

```sparql
PREFIX reg: <http://environment.data.gov.uk/ontology/regulation/>
PREFIX geo: <http://www.opengis.net/ont/geosparql#>
SELECT ?role ?feature ?wkt WHERE {
  { <http://example.com/water-regulation/permit/042451> reg:permitSite ?feature .
    ?feature geo:hasGeometry/geo:asWKT ?wkt . BIND("permit discharge point" AS ?role) }
  UNION
  { ?a reg:targetPermit <http://example.com/water-regulation/permit/042451> ; reg:actionSite ?feature .
    ?feature geo:hasGeometry/geo:asWKT ?wkt . BIND("WINEP action site" AS ?role) }
} ORDER BY ?role
```

**B — "What linked data does": merge by identifier, geometry-independent.**

```sparql
PREFIX reg: <http://environment.data.gov.uk/ontology/regulation/>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?action ?label ?sub WHERE {
  ?action reg:targetPermit <http://example.com/water-regulation/permit/042451> .
  OPTIONAL { ?action rdfs:label ?label }
  OPTIONAL { ?action reg:proposesLimit/reg:regulatedProperty/skos:prefLabel ?sub }
} ORDER BY ?action
```

Query B returns both actions cleanly joined to the permit, with the substances each proposes to
regulate (Ammoniacal Nitrogen; Total Nitrogen, Iron, Total Phosphorus) — one coherent record built
from identifiers alone.

### Design decision: docs help-page vs. interactive explorer page

The user raised this directly. Two options:

1. **Markdown help-page in the docs viewer.** Prose argument + the table above + the two queries, with
   each query as a **"◈ SPARQL" deep-link** that opens the editor pre-loaded (reuse the existing
   `sparql.html#q=<url-encoded query>` mechanism the table cards already use). Low effort — no new page
   type, reuses the docs viewer and the card deep-link. The reader can *run the proof* in one click.
2. **Dedicated interactive explorer page.** A mini-map plotting the three points in their real
   positions (visibly scattered ~1.4 km apart), a toggle between "spatial view" (they look unrelated)
   and "identifier view" (the `reg:targetPermit` edges snap them together), with the live query results
   beside it. Most persuasive — it *shows* the gap rather than asserting it — but a real build:
   new page, map wiring, reprojection of the WGS84 point for side-by-side plotting.

**Recommendation: do #1 first as the MVP** — it lands the argument and is runnable, at a fraction of
the cost, entirely on existing infrastructure. Treat #2 as a stretch "wow" demo once #1 exists. The
hybrid (a docs page whose queries are deep-links) is the best effort-to-impact ratio for a POC and is
consistent with how the rest of the app already exposes its provenance.

### Scope / acceptance criteria (for the MVP)

- [ ] New doc `app/help/linked-data-vs-gis.md` (or similar), added to the `DOCS` list in
      [`app/docs.js`](docs.js) under a new "Concepts" group.
- [ ] Contains the argument, the worked example table, and both queries.
- [ ] Each query renders as a deep-link into the SPARQL editor (`sparql.html#q=…`) — verify the encoded
      link opens the editor with the query loaded and runs against the configured endpoint.
- [ ] Distances/CRS in the prose match the source data (recompute if the graphs are rebuilt).
- [ ] Linked from somewhere discoverable (docs sidebar is enough; optionally a note on the WINEP view).
- [ ] Stretch: interactive map page showing the three points scattered vs. identifier-linked.
