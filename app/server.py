"""Three-Ways app server.

Loads the regulation / winep / sfi Turtle graphs into an in-memory Oxigraph
store (the "federated data layer") and serves two things from one origin:

  GET/POST /sparql   -> SPARQL 1.1 query, returns application/sparql-results+json
  GET      /*        -> static files from this directory (the Leaflet frontend)

Serving both from one process means the browser makes same-origin requests, so
there is no CORS to configure. Run:

    source .venv/bin/activate
    python app/server.py            # then open http://localhost:8000

Nothing here is persisted: the store is rebuilt from the .ttl files on every
start, so the graphs are always exactly what is on disk.
"""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pyoxigraph as ox

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
TTL = ROOT / "ttl"
PORT = 8000

GRAPHS = ["regulation.ttl", "winep.ttl", "sfi.ttl"]


def build_store() -> ox.Store:
    store = ox.Store()
    for name in GRAPHS:
        path = TTL / name
        store.load(path=str(path), format=ox.RdfFormat.TURTLE)
        print(f"  loaded {name}")
    print(f"  store holds {len(store)} triples")
    return store


def term_to_json(term) -> dict:
    """A single RDF term -> a SPARQL-results-JSON binding value."""
    kind = type(term).__name__
    if kind == "NamedNode":
        return {"type": "uri", "value": term.value}
    if kind == "BlankNode":
        return {"type": "bnode", "value": term.value}
    # Literal
    out = {"type": "literal", "value": term.value}
    if term.language:
        out["xml:lang"] = term.language
    elif term.datatype and term.datatype.value != "http://www.w3.org/2001/XMLSchema#string":
        out["datatype"] = term.datatype.value
    return out


def results_to_json(results) -> dict:
    """pyoxigraph query result (SELECT or ASK) -> SPARQL-results-JSON dict."""
    if isinstance(results, bool):
        return {"head": {}, "boolean": results}
    variables = [v.value for v in results.variables]
    bindings = []
    for sol in results:
        row = {}
        for var in variables:
            term = sol[var]
            if term is not None:
                row[var] = term_to_json(term)
        bindings.append(row)
    return {"head": {"vars": variables}, "results": {"bindings": bindings}}


STORE = None  # populated in main()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # quieter console
        pass

    def _run_query(self, query: str):
        try:
            results = STORE.query(query)
            payload = json.dumps(results_to_json(results)).encode("utf-8")
        except Exception as exc:  # surface SPARQL errors to the client
            self.send_response(400)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(str(exc).encode("utf-8"))
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/sparql-results+json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/sparql":
            params = parse_qs(parsed.query)
            query = (params.get("query") or [None])[0]
            if not query:
                self.send_error(400, "missing ?query")
                return
            self._run_query(query)
            return
        self._serve_static(parsed.path)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/sparql":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length).decode("utf-8")
        ctype = self.headers.get("Content-Type", "")
        if "application/sparql-query" in ctype:
            query = body
        else:  # application/x-www-form-urlencoded
            query = (parse_qs(body).get("query") or [None])[0]
        if not query:
            self.send_error(400, "missing query")
            return
        self._run_query(query)

    def _serve_static(self, path: str):
        rel = path.lstrip("/") or "index.html"
        target = (HERE / rel).resolve()
        if HERE not in target.parents and target != HERE or not target.is_file():
            self.send_error(404)
            return
        ctype = {
            ".html": "text/html",
            ".js": "application/javascript",
            ".css": "text/css",
            ".json": "application/json",
        }.get(target.suffix, "application/octet-stream")
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.end_headers()
        self.wfile.write(data)


def main():
    global STORE
    print("Loading graphs into Oxigraph store...")
    STORE = build_store()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"\nThree-Ways app ready:  http://localhost:{PORT}")
    print(f"SPARQL endpoint:       http://localhost:{PORT}/sparql")
    print("Ctrl-C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping.")


if __name__ == "__main__":
    main()
