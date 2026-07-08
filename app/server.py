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
import os
import re
import tempfile
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pyoxigraph as ox

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
TTL = ROOT / "ttl"
# Host/port come from the environment so the same image runs unchanged in a container (platforms
# inject PORT and expect the process to listen on all interfaces).
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8000"))

GRAPHS = ["regulation.ttl", "winep.ttl", "sfi.ttl", "designations.ttl"]

# Environment Agency Water Quality Archive — live observation time series. We proxy it
# server-side so the browser stays same-origin and we can follow the Link-header pagination.
# Overridable via env so egress can be routed through a platform proxy without a code change.
EA_BASE = os.environ.get("EA_BASE", "https://environment.data.gov.uk/water-quality/sampling-point")

# Disk caches (observations + basemap tiles) live OUTSIDE the project tree so downloaded data never
# lands among the source files. Defaults to a temp dir; set CACHE_DIR to a mounted volume in a
# container (or to "" / "none" to disable disk caching entirely — everything then fetches live).
_cache_env = os.environ.get("CACHE_DIR", None)
CACHE_ENABLED = _cache_env not in ("", "none", "off", "0")
CACHE_DIR = Path(_cache_env) if (_cache_env and CACHE_ENABLED) else Path(tempfile.gettempdir()) / "catchment-poc-cache"

# Raster basemap tiles, proxied same-origin (see the /tiles route) so the browser never leaves this
# origin — no external CDN for a locked-down deployment. Point at any {z}/{x}/{y} XYZ source.
TILE_BASE = os.environ.get("TILE_BASE", "https://tile.openstreetmap.org")
TILE_CACHE = CACHE_DIR / "tiles"
_TILE_RE = re.compile(r"^/tiles/(\d{1,2})/(\d{1,7})/(\d{1,7})\.png$")
_NEXT_RE = re.compile(r"<([^>]+)>;\s*rel=\"next\"")

# Behind a restrictive/flaky firewall the upstream archive can be slow or unreachable. Two guards
# keep the /observations endpoint responsive so the browser never sits without a reply (which the
# frontend surfaces as an opaque "Failed to fetch"):
#   * a per-page timeout AND an overall deadline bound how long a single request can take, and
#   * successful fetches are cached (in CACHE_DIR, outside the repo) so a chart still draws from the
#     last good copy when the archive is unreachable. The cache is best-effort and regenerable.
OBS_PAGE_TIMEOUT = 20   # seconds allowed per upstream page request
OBS_DEADLINE = 45       # seconds total budget across the whole pagination walk
OBS_CACHE = CACHE_DIR / "observations"


def fetch_observations(sampling_point: str, determinand: str, cap: int = 3000,
                       page_timeout: int = OBS_PAGE_TIMEOUT,
                       deadline: int = OBS_DEADLINE) -> tuple[list[dict], bool]:
    """All observations for a sampling point + determinand, following rel=next pagination.

    Bounded so it always returns promptly: each upstream page has its own timeout and the whole
    walk is capped by an overall deadline. Returns (observations, partial) where `partial` is True
    if the deadline or the cap cut the walk short before the archive ran out of pages.
    """
    url = (f"{EA_BASE}/{sampling_point}/observation"
           f"?skip=0&limit=200&determinand={determinand}&complianceOnly=false")
    seen_urls: set[str] = set()
    out: list[dict] = []
    start = time.monotonic()
    partial = False
    while url and url not in seen_urls and len(out) < cap:
        if time.monotonic() - start > deadline:  # give up walking; return what we have
            partial = True
            break
        seen_urls.add(url)
        req = urllib.request.Request(url, headers={
            "accept": "application/x-jsonlines",
            "CSV-Header": "present",
            "API-Version": "1",
        })
        with urllib.request.urlopen(req, timeout=page_timeout) as resp:
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
    if url and len(out) >= cap:  # stopped on the cap, not on the last page
        partial = True
    return out, partial


def _cache_path(sampling_point: str, determinand: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", f"{sampling_point}__{determinand}")
    return OBS_CACHE / f"{safe}.json"


def _read_cache(sampling_point: str, determinand: str) -> dict | None:
    if not CACHE_ENABLED:
        return None
    path = _cache_path(sampling_point, determinand)
    try:
        return json.loads(path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _write_cache(sampling_point: str, determinand: str, payload: dict) -> None:
    if not CACHE_ENABLED:
        return
    try:  # best-effort; a cache miss must never break the response
        OBS_CACHE.mkdir(parents=True, exist_ok=True)
        path = _cache_path(sampling_point, determinand)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload), "utf-8")
        tmp.replace(path)  # atomic, so concurrent requests never read a half-written file
    except OSError:
        pass


def get_observations(sampling_point: str, determinand: str) -> tuple[dict, bool]:
    """Fetch live with graceful degradation. Returns (payload, ok).

    Live success caches the result and returns it fresh. On an upstream failure we fall back to a
    cached copy (marked stale) so the chart still draws; only when nothing is cached does the caller
    surface the error.
    """
    try:
        obs, partial = fetch_observations(sampling_point, determinand)
    except Exception as exc:
        cached = _read_cache(sampling_point, determinand)
        if cached is not None:
            return {**cached, "source": "cache", "stale": True, "error": str(exc)}, True
        return {"error": str(exc)}, False
    payload = {
        "samplingPoint": sampling_point, "determinand": determinand,
        "count": len(obs), "observations": obs,
        "source": "live", "stale": False, "partial": partial,
    }
    _write_cache(sampling_point, determinand, payload)
    return payload, True


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
            payload, ok = get_observations(sp, det)
            if not ok:  # upstream failed and nothing cached — surface the real error, promptly
                self.send_response(502)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(f"upstream error: {payload['error']}".encode("utf-8"))
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(payload).encode("utf-8"))
            return
        m = _TILE_RE.match(parsed.path)
        if m:
            self._serve_tile(*m.groups())
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

    def _serve_tile(self, z: str, x: str, y: str):
        """Proxy + disk-cache one basemap tile so the browser stays same-origin.

        Tiles are immutable, so once fetched they are served straight from disk — the container only
        needs egress to TILE_BASE to warm the cache (or none at all if the cache is pre-seeded). A
        fetch failure is not fatal: the map simply renders without that tile.
        """
        cached = TILE_CACHE / z / x / f"{y}.png"
        if CACHE_ENABLED and cached.is_file():
            data = cached.read_bytes()
        else:
            try:
                req = urllib.request.Request(f"{TILE_BASE}/{z}/{x}/{y}.png",
                                             headers={"User-Agent": "poole-harbour-catchment-poc"})
                with urllib.request.urlopen(req, timeout=15) as resp:
                    data = resp.read()
            except Exception:
                self.send_error(502, "tile fetch failed")
                return
            if CACHE_ENABLED:
                try:
                    cached.parent.mkdir(parents=True, exist_ok=True)
                    tmp = cached.with_suffix(".png.tmp")
                    tmp.write_bytes(data)
                    tmp.replace(cached)
                except OSError:
                    pass
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Cache-Control", "public, max-age=604800")
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
            ".mjs": "application/javascript",
            ".css": "text/css",
            ".json": "application/json",
            ".geojson": "application/geo+json",
            ".png": "image/png",
            ".gif": "image/gif",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".svg": "image/svg+xml",
            ".ico": "image/x-icon",
            ".webp": "image/webp",
            ".woff": "font/woff",
            ".woff2": "font/woff2",
            ".ttf": "font/ttf",
            ".map": "application/json",
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
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"\nThree-Ways app ready:  http://{HOST}:{PORT}")
    print(f"SPARQL endpoint:       http://{HOST}:{PORT}/sparql")
    print("Ctrl-C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping.")


if __name__ == "__main__":
    main()
