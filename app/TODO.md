# App / server TODO

## ~~`ASK` queries return HTTP 400~~ — FIXED (2026-07-14), and it was worse than this said

**What was wrong.** `ASK`, `CONSTRUCT` **and** `DESCRIBE` all returned **HTTP 400** — three of the four
SPARQL query forms, on an endpoint the README advertises as "SPARQL 1.1" with an in-app editor that
invites ad-hoc queries. Anyone who typed a `CONSTRUCT` got an error that looked like their own fault.

```
ASK { ?s ?p ?o }             -> 400  'pyoxigraph.QueryBoolean' object has no attribute 'variables'
CONSTRUCT { … } WHERE { … }  -> 400  'pyoxigraph.QueryTriples'  object has no attribute 'variables'
DESCRIBE <…>                 -> 400  'pyoxigraph.QueryTriples'  object has no attribute 'variables'
```

**This file previously claimed "`SELECT` and `CONSTRUCT`/`DESCRIBE` are unaffected."** That was false,
and it is the reason the bug sat here as a one-line curiosity rather than a broken endpoint: the ticket
described a third of the problem and then reassured the reader about the rest of it. Worth remembering
next time a symptom is written up from a single reproduction.

**Cause.** `_run_query()` read `results.variables` unconditionally. pyoxigraph returns a *different
type per query form* — `QuerySolutions`, `QueryBoolean`, `QueryTriples` — and only the first has
`.variables`, so the other two raised `AttributeError`, which `_run_query` caught and turned into a 400.

**Fix.** Branch on the result type in [`server.py`](server.py):

| Form | pyoxigraph type | Response |
| --- | --- | --- |
| `SELECT` | `QuerySolutions` | `application/sparql-results+json` |
| `ASK` | `QueryBoolean` | `{"head": {}, "boolean": …}` |
| `CONSTRUCT` / `DESCRIBE` | `QueryTriples` | `text/turtle` |

Verified: all four forms return **200**. `ASK { ?s ?p ?o }` → `{"head": {}, "boolean": true}`;
`CONSTRUCT` → Turtle.

**Still worth doing:** a startup smoke check that runs one of each form, so a future pyoxigraph bump
that renames a result type is caught at boot rather than by a user in the query editor.

## Content negotiation is not implemented

The endpoint ignores `Accept` and always answers `SELECT` in SPARQL-results-JSON and
`CONSTRUCT`/`DESCRIBE` in Turtle. The SPARQL 1.1 Protocol allows a client to ask for XML, CSV/TSV, or
RDF/XML, N-Triples, JSON-LD. Nothing in the app needs it — noted so nobody assumes it works.

---

# Future works — latent traps

Two audit findings were logged as "warn and move on". Both turned out to be cheap, so they were
**fixed** instead. They are written up here because the *class* of bug is what matters, and it will
come back in a different costume.

## ~~A breach at an outlet with no coordinate would vanish from the app~~ — FIXED

The breach query required `?dp geo:hasGeometry`. All breaches happened to display — but **only by
luck**: the outlets with no coordinate happened to have no breaches. Had one ever breached, it would
have disappeared from the UI with no error and no gap. Geometry is now `OPTIONAL` in `Q.breaches`, so a
breach at an unlocatable outlet appears in the table (it simply cannot be drawn on the map).

This is the project's own thesis, aimed at the project: **the presence of a coordinate must never decide
what exists.** It had crept into the app's own query.

## ~~A slash-bearing permit ref would silently fail to join~~ — FIXED

`winep_to_db.py` hand-built `reg:continuesCondition` as an f-string rather than percent-encoding it as
ontop does, so a ref like `400114/CF/01` would have produced an **unencoded** IRI and the join would
have failed **silently** — no error, just a missing link. All four current WINEP targets are numeric, so
it never fired; it would have fired the day WINEP touched an EPR-style permit. Now built with
`urllib.parse.quote(ref, safe="")`, which is exactly what ontop's IRI templates do.

## The class of bug, and the standing rule

All three of these — and the geometry fallback, and the dropped `monitoredAt` edges, and the
observation-sourced conditions — are **one mistake**: *an absence rendered as a value.*

- an unfetched sampling point → displayed as "no breach"
- a dropped edge → displayed as "no link"
- a missing coordinate → displayed as a plausible dot
- an unencoded IRI → a join that returns nothing, and says nothing

Each time, the pipeline had no way to say **"I don't know"**, so it said something false, and said it
quietly. **When a fact is absent, the graph must say so and the app must show it.** That is why
conditions now carry `wr:assessed` / `wr:notAssessedBecause`, why unlocatable outlets carry no geometry
rather than a guessed one, and why the map has a **grey** marker state that is neither "clean" nor
"breached".

## Still latent: fan-out on OPTIONAL

Twice now, adding a second value for something an `OPTIONAL` reads has silently **doubled** rows — first
when discharge points gained a CRS84 geometry alongside their British National Grid one, then when
breaches gained a second `rdfs:comment`. On both occasions **every row-count check still passed**,
because the table and its provenance query fanned out *together*: matching counts prove the two agree,
not that either is right. `app.js` now asserts distinctness on the subject IRI at load and logs a
`FAN-OUT` error — but the real fix is a schema-level guard, and there isn't one.
