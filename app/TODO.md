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
