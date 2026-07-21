"""Authenticated client for the internal Catchment Data Explorer SPARQL endpoint.

The endpoint and credentials are taken from the environment, so nothing about the
source deployment is embedded here:

    CDE_SPARQL_ENDPOINT   base URL of the SPARQL service (no trailing slash)
    CDE_SPARQL_USER       username for basic auth
    CDE_SPARQL_PASSWORD   password for basic auth
    CDE_REPOSITORY        repository/dataset id (used by the extraction scripts)

The credential lives only in this process's memory. It is never written to disk, never
placed in a command line (where `ps` would expose it to every other user on the
machine), never echoed, and never included in an exception message -- see `_redact`
below, which exists because the obvious failure mode of a script like this is a
traceback that helpfully prints the Authorization header.

If the endpoint is served over plain HTTP, basic auth is base64, not encryption, so the
credential is recoverable by anything on-path. That is a property of the deployment, not
of this script -- flagged here so it is not mistaken for a secure channel.

Usage:
    python ttl/catchment/sparql_client.py query <repo> <<'SPARQL'
    SELECT * WHERE { ?s ?p ?o } LIMIT 10
    SPARQL
"""

import json
import os
import sys

import requests
from requests.auth import HTTPBasicAuth


def _endpoint():
    base = os.environ.get("CDE_SPARQL_ENDPOINT")
    if not base:
        sys.exit(
            "CDE_SPARQL_ENDPOINT is not set.\n"
            "Point it at the source SPARQL service (base URL, no trailing slash) and set "
            "CDE_SPARQL_USER / CDE_SPARQL_PASSWORD for basic auth."
        )
    return base.rstrip("/")


def _credentials():
    """Return (username, password) from the environment. Never logs either."""
    user = os.environ.get("CDE_SPARQL_USER")
    password = os.environ.get("CDE_SPARQL_PASSWORD")
    if not user or not password:
        sys.exit(
            "CDE_SPARQL_USER and CDE_SPARQL_PASSWORD must both be set.\n"
            "Provide them via the environment (e.g. a secrets manager or a local .env "
            "that is not committed)."
        )
    return user, password


def _redact(exc):
    """requests puts the full request -- including the Authorization header -- into
    some exception reprs. Never surface one raw."""
    return type(exc).__name__


def _get(path, **kw):
    user, password = _credentials()
    try:
        r = requests.get(f"{_endpoint()}{path}", auth=HTTPBasicAuth(user, password),
                         timeout=30, **kw)
    except requests.RequestException as e:
        sys.exit(f"Request to {path} failed: {_redact(e)}")
    if r.status_code == 401:
        sys.exit(f"401 Unauthorized for {path}. Credential rejected by the endpoint.")
    if r.status_code == 403:
        sys.exit(f"403 Forbidden for {path}. Authenticated, but lacking read rights.")
    r.raise_for_status()
    return r


def query(repo, sparql):
    """Run a SELECT and return the raw SPARQL-results JSON."""
    r = _get(f"/repositories/{repo}",
             params={"query": sparql},
             headers={"Accept": "application/sparql-results+json"})
    return r.json()


def construct(repo, sparql):
    """Run a CONSTRUCT and return N-Triples text.

    N-Triples rather than Turtle deliberately: the extract concatenates the output of
    several CONSTRUCTs, and N-Triples is the only RDF syntax where concatenation is
    itself valid RDF. Turtle carries @prefix state, so gluing two Turtle documents
    together can silently rebind a prefix and change what the triples mean.
    """
    r = _get(f"/repositories/{repo}",
             params={"query": sparql},
             headers={"Accept": "application/n-triples"})
    return r.text


if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] != "query":
        sys.exit(__doc__)
    print(json.dumps(query(sys.argv[2], sys.stdin.read()), indent=2))
