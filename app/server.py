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
import re
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pyoxigraph as ox

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
TTL = ROOT / "ttl"
PORT = 8000

GRAPHS = ["regulation.ttl", "winep.ttl", "sfi.ttl", "designations.ttl"]

# Environment Agency Water Quality Archive — live observation time series. We proxy it
# server-side so the browser stays same-origin and we can follow the Link-header pagination.
EA_BASE = "https://environment.data.gov.uk/water-quality/sampling-point"
_NEXT_RE = re.compile(r"<([^>]+)>;\s*rel=\"next\"")


def fetch_observations(sampling_point: str, determinand: str, cap: int = 3000) -> list[dict]:
    """All observations for a sampling point + determinand, following rel=next pagination."""
    url = (f"{EA_BASE}/{sampling_point}/observation"
           f"?skip=0&limit=200&determinand={determinand}&complianceOnly=false")
    seen_urls: set[str] = set()
    out: list[dict] = []
    while url and url not in seen_urls and len(out) < cap:
        seen_urls.add(url)
        req = urllib.request.Request(url, headers={
            "accept": "application/x-jsonlines",
            "CSV-Header": "present",
            "API-Version": "1",
        })
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode("utf-8")
            link = resp.headers.get("link", "")
        n_before = len(out)
        for line in body.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except json.JSONDecodeError:
                continue
            out.append({
                "time": o.get("phenomenonTime"),
                "result": o.get("result"),
                "unit": o.get("unit"),
                "determinand": (o.get("determinand") or {}).get("notation"),
            })
        if len(out) == n_before:  # empty page → stop
            break
        m = _NEXT_RE.search(link)
        url = m.group(1) if m else None
    return out


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
        if parsed.path == "/observations":
            params = parse_qs(parsed.query)
            sp = (params.get("samplingPoint") or [None])[0]
            det = (params.get("determinand") or [None])[0]
            if not sp or not det:
                self.send_error(400, "need ?samplingPoint and ?determinand")
                return
            try:
                obs = fetch_observations(sp, det)
                payload = json.dumps({"samplingPoint": sp, "determinand": det,
                                      "count": len(obs), "observations": obs}).encode("utf-8")
            except Exception as exc:
                self.send_response(502)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(f"upstream error: {exc}".encode("utf-8"))
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(payload)
            return
        if parsed.path.endswith(".md"):
            self._serve_markdown(parsed.path)
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

    def _serve_markdown(self, path: str):
        """Serve a Markdown doc from the repository root (the docs viewer fetches these).

        The frontend static files live in app/, but the docs (README.md, ttl/*/README.md,
        TODO.md …) live across the repo, so these resolve against ROOT — restricted to .md
        files under ROOT, with `..` traversal rejected by the resolved-parent check.
        """
        rel = path.lstrip("/")
        target = (ROOT / rel).resolve()
        if ROOT not in target.parents or target.suffix != ".md" or not target.is_file():
            self.send_error(404)
            return
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "text/markdown; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

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
            ".geojson": "application/geo+json",
        }.get(target.suffix, "application/octet-stream")
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-cache")  # always revalidate; the app files change often
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
