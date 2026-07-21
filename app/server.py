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
import urllib.error
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
# Mount prefix for serving under a sub-path (e.g. https://host/catchment-demo). Set BASE_PATH to the
# prefix and the server strips it from every request, so a plain pass-through reverse proxy is all
# that's needed — no proxy-side URL rewriting. Empty means served at the origin root. The frontend
# uses relative URLs, so it adapts to whatever prefix the page is loaded under.
BASE_PATH = "/" + os.environ.get("BASE_PATH", "").strip("/") if os.environ.get("BASE_PATH", "").strip("/") else ""

GRAPHS = ["regulation.ttl", "breaches.ttl", "winep.ttl", "sfi.ttl", "designations.ttl",
          "catchment.ttl"]

# catchment.ttl is unlike the others: its subjects keep their real Environment Agency URIs
# (http://environment.data.gov.uk/catchment-planning/so/...) rather than the example.com URIs
# the rest of this repository mints, because they are the identifiers the source triplestore
# uses and re-minting would orphan the 29 SKOS schemes it reuses. Pasted verbatim these `/so/`
# URIs 404 — but each water body DOES have a human-readable Catchment Data Explorer page at the
# `/so/`-stripped https URL (a web page, not RDF; the site publishes none). The water body panel
# derives and links to it (cdePageUrl in app.js). See ttl/catchment/.

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

# The upstream Water Quality Archive is paged: /observation takes skip & limit (limit max 250, per
# the API's swagger), and every response carries `x-total-items` — the count of matching observations
# in scope. The browser drives the walk one page at a time so it can show a progress bar and pace
# itself to one request per second; this server just serves the requested page (with backoff on
# transient upstream errors) and assembles the pages into a full-set disk cache as they arrive, so a
# repeat view of the same series is a single request that short-circuits the whole walk.
OBS_PAGE_TIMEOUT = 20   # seconds allowed per upstream page request
OBS_PAGE_LIMIT = 250    # the archive's hard maximum page size
OBS_RETRIES = 4         # transient-error attempts per page, each backing off
OBS_CACHE = CACHE_DIR / "observations"

# In-progress full-set assembly, keyed (sampling_point, determinand). A skip=0 request (re)starts it;
# the page that completes the walk flushes it to the disk cache and clears it. Single-process only,
# which the ThreadingHTTPServer is for one user — a demonstrator, not a shared service.
_obs_accum: dict[tuple[str, str], list] = {}


def _fetch_wqe_page(sampling_point: str, determinand: str, skip: int, limit: int) -> tuple[list[dict], int]:
    """One upstream page. Returns (observations, total_items). Retries transient upstream errors
    (429 / 5xx / timeout) with exponential backoff, honouring Retry-After when the archive sends it."""
    url = (f"{EA_BASE}/{sampling_point}/observation"
           f"?skip={skip}&limit={limit}&determinand={determinand}&complianceOnly=false")
    delay, last_exc = 1.0, None
    for _ in range(OBS_RETRIES):
        try:
            req = urllib.request.Request(url, headers={
                "accept": "application/x-jsonlines", "CSV-Header": "present", "API-Version": "1"})
            with urllib.request.urlopen(req, timeout=OBS_PAGE_TIMEOUT) as resp:
                total = int(resp.headers.get("x-total-items") or 0)
                body = resp.read().decode("utf-8")
            out = []
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
            return out, total
        except urllib.error.HTTPError as exc:
            last_exc = exc
            if exc.code in (429, 500, 502, 503, 504):
                ra = exc.headers.get("Retry-After") if exc.headers else None
                time.sleep(float(ra) if (ra and str(ra).isdigit()) else delay)
                delay *= 2
                continue
            raise
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last_exc = exc
            time.sleep(delay)
            delay *= 2
    raise last_exc or RuntimeError("WQE page fetch failed")


def get_observations_page(sampling_point: str, determinand: str,
                          skip: int, limit: int) -> tuple[dict, bool]:
    """Serve one page and the total. Returns (payload, ok).

    On skip=0 a *complete* cached set short-circuits the walk — the whole series comes back in one
    response (complete=True), so a repeat view is a single request. Otherwise the live page is fetched,
    appended to the in-progress assembly, and the page that finishes the walk flushes the full set to
    disk. On upstream failure we fall back to any cached full set (marked stale) so a chart still draws.
    """
    key = (sampling_point, determinand)
    if skip == 0:
        cached = _read_cache(sampling_point, determinand)
        if cached and cached.get("complete"):
            return {**cached, "skip": 0, "limit": limit,
                    "source": "cache", "stale": False, "complete": True}, True
        _obs_accum[key] = []                      # (re)start assembly
    try:
        page, total = _fetch_wqe_page(sampling_point, determinand, skip, limit)
    except Exception as exc:                      # noqa: BLE001 — any upstream failure degrades to cache
        cached = _read_cache(sampling_point, determinand)
        if cached is not None:
            return {**cached, "skip": 0, "limit": limit, "source": "cache",
                    "stale": True, "error": str(exc), "complete": True}, True
        return {"error": str(exc)}, False
    acc = _obs_accum.setdefault(key, [])
    acc.extend(page)
    complete = (not page) or (skip + len(page) >= total)
    if complete:                                  # last page — flush the assembled set to disk
        _write_cache(sampling_point, determinand, {
            "samplingPoint": sampling_point, "determinand": determinand,
            "total": total, "count": len(acc), "observations": list(acc), "complete": True})
        _obs_accum.pop(key, None)
    return {
        "samplingPoint": sampling_point, "determinand": determinand,
        "skip": skip, "limit": limit, "total": total, "count": len(page),
        "observations": page, "source": "live", "stale": False, "complete": complete,
    }, True


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
    """pyoxigraph SELECT / ASK query result -> SPARQL-results-JSON dict."""
    if isinstance(results, (bool, ox.QueryBoolean)):
        return {"head": {}, "boolean": bool(results)}
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
        """All FOUR SPARQL query forms, not just SELECT.

        This used to read `results.variables` unconditionally, so ASK, CONSTRUCT and DESCRIBE each
        died with an AttributeError and came back as HTTP 400 — three of the four forms, on an endpoint
        the README advertises as "SPARQL 1.1" and an editor that invites ad-hoc queries. Anyone who
        typed a CONSTRUCT got an error that looked like their fault.

        pyoxigraph returns a different type per form, so branch on it:
            SELECT              -> QuerySolutions  -> SPARQL-results-JSON
            ASK                 -> QueryBoolean    -> {"boolean": …}
            CONSTRUCT/DESCRIBE  -> QueryTriples    -> Turtle
        """
        try:
            results = STORE.query(query)
            if isinstance(results, ox.QueryTriples):
                payload = ox.serialize(results, format=ox.RdfFormat.TURTLE)
                content_type = "text/turtle"
            else:
                payload = json.dumps(results_to_json(results)).encode("utf-8")
                content_type = "application/sparql-results+json"
        except Exception as exc:  # surface SPARQL errors to the client
            self.send_response(400)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(str(exc).encode("utf-8"))
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload)

    def _effective_path(self, raw_path: str) -> str | None:
        """Strip BASE_PATH from an incoming request path (no-op when BASE_PATH is unset).

        Returns None when a redirect has already been sent — the bare prefix without a trailing slash
        (`/catchment-demo`) is redirected to `/catchment-demo/` so the browser resolves the page's
        relative URLs under the sub-path rather than against the origin root.
        """
        if not BASE_PATH:
            return raw_path
        if raw_path == BASE_PATH:
            self.send_response(301)
            self.send_header("Location", BASE_PATH + "/")
            self.end_headers()
            return None
        if raw_path.startswith(BASE_PATH + "/"):
            return raw_path[len(BASE_PATH):]  # keep the leading slash of the remainder
        return raw_path  # outside the mount (e.g. the container's own healthcheck on "/") — serve as-is

    def do_GET(self):
        parsed = urlparse(self.path)
        path = self._effective_path(parsed.path)
        if path is None:
            return
        if path == "/sparql":
            params = parse_qs(parsed.query)
            query = (params.get("query") or [None])[0]
            if not query:
                self.send_error(400, "missing ?query")
                return
            self._run_query(query)
            return
        if path == "/observations":
            params = parse_qs(parsed.query)
            sp = (params.get("samplingPoint") or [None])[0]
            det = (params.get("determinand") or [None])[0]
            if not sp or not det:
                self.send_error(400, "need ?samplingPoint and ?determinand")
                return
            try:
                skip = max(0, int((params.get("skip") or ["0"])[0]))
            except ValueError:
                skip = 0
            try:
                limit = min(OBS_PAGE_LIMIT, max(1, int((params.get("limit") or [str(OBS_PAGE_LIMIT)])[0])))
            except ValueError:
                limit = OBS_PAGE_LIMIT
            payload, ok = get_observations_page(sp, det, skip, limit)
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
        m = _TILE_RE.match(path)
        if m:
            self._serve_tile(*m.groups())
            return
        if path.endswith(".md"):
            self._serve_markdown(path)
            return
        self._serve_static(path)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = self._effective_path(parsed.path)
        if path is None:
            return
        if path != "/sparql":
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
