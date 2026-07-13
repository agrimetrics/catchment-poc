#!/usr/bin/env python3
"""Enrich sampling points in ttl/regulation.ttl from the EA Water Quality Archive.

Why this exists
---------------
The regulation graph links a breach to the *observation* that evidences it
(``reg:evidencedByObservation``) and a discharge point to the *sampling point* it is
``water:monitoredAt``. It did NOT link an observation to its sampling point, so the app's
breach query had to bridge the two with ``FILTER(STRSTARTS(STR(?obs), STR(?sp)))`` — a
string-prefix pseudo-join the engine cannot key on, forcing a Cartesian product that trips
"Size Limit Exceeded" on any store larger than this demo.

This step dereferences each breach-evidencing observation and each sampling point as
``application/ld+json`` straight from the WQA and captures two things, and only two:

  1. The structural edge ``<observation> sosa:hasFeatureOfInterest <sampling-point>`` — the
     real join key that replaces the STRSTARTS hack.
  2. Sampling-point reference data in the encoding *as received*: the ``skos:prefLabel`` and
     the geometry in its **source CRS** (EPSG:27700 / British National Grid, carrying the OGC
     CRS URI), replacing the earlier convenience WGS84 reprojection.

We deliberately do NOT bring the observational *values* (result, unit, determinand, dates)
into the store — those stay federated, pulled live via the /observations proxy. Only the
stable structural/reference facts are materialised.

IRIs from the WQA come back ``https:``; the store uses ``http:`` by convention, so every
captured IRI is normalised to ``http:`` before it is written.

Run from the repo root (needs outbound egress to environment.data.gov.uk):

    python ttl/regulation/enrich_sampling_points.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import requests

TTL = Path("ttl/regulation.ttl")
WQA = "http://environment.data.gov.uk/water-quality"
HEADERS = {"Accept": "application/ld+json"}
TIMEOUT = 30


def http(iri: str) -> str:
    """Normalise a WQA IRI to the store's http scheme."""
    return iri.replace("https://environment.data.gov.uk", "http://environment.data.gov.uk")


def fetch(iri: str) -> dict:
    """Dereference a WQA resource as JSON-LD and return its single hydra member."""
    r = requests.get(iri, headers=HEADERS, timeout=TIMEOUT)
    r.raise_for_status()
    members = r.json().get("member", [])
    if not members:
        raise ValueError(f"no member in {iri}")
    return members[0]


def sp_facts(sp_node: dict) -> tuple[str, str]:
    """(prefLabel, source-CRS WKT) from a sampling-point JSON-LD node."""
    label = sp_node.get("prefLabel") or sp_node.get("notation") or ""
    wkt = sp_node["geometry"]["asWKT"]  # e.g. POINT(375100 94950) <...EPSG/0/27700>
    return label, wkt


def main() -> int:
    ttl = TTL.read_text("utf-8")

    # Sampling points present in the store (bare feature subjects) and the breach-evidencing
    # observations that need a feature-of-interest edge.
    sampling_points = sorted(set(re.findall(
        r"<http://environment\.data\.gov\.uk/water-quality/sampling-point/([A-Za-z0-9-]+)> a geo:Feature",
        ttl)))
    observations = sorted(set(re.findall(
        r"http://environment\.data\.gov\.uk/water-quality/sampling-point/[A-Za-z0-9-]+/sample/[^ >]+/observation/[0-9]+",
        ttl)))
    print(f"{len(sampling_points)} sampling points, {len(observations)} breach observations", file=sys.stderr)

    facts: dict[str, tuple[str, str]] = {}   # notation -> (label, wkt)
    links: list[tuple[str, str]] = []        # (observation http-iri, sampling-point http-iri)

    # 1. Fetch each breach observation: authoritative obs->sp edge, and the embedded sampling point.
    for obs in observations:
        node = fetch(obs)
        sp = node["hasSamplingPoint"]
        sp_iri = http(sp["id"])
        links.append((http(node["id"]), sp_iri))
        facts.setdefault(sp["notation"], sp_facts(sp))

    # 2. Any sampling point without a breach observation: fetch its own resource for geometry+label.
    for notation in sampling_points:
        if notation not in facts:
            facts[notation] = sp_facts(fetch(f"{WQA}/sampling-point/{notation}"))

    # --- Patch the TTL text in place (targeted edits keep the diff reviewable) ---
    def replace_geometry(m: re.Match) -> str:
        notation = m.group("n")
        wkt = facts.get(notation, (None, None))[1]
        if not wkt:
            return m.group(0)
        return f'{m.group("head")}"{wkt}"^^geo:wktLiteral .'

    ttl, n_geom = re.subn(
        r'(?P<head><http://environment\.data\.gov\.uk/water-quality/sampling-point/'
        r'(?P<n>[A-Za-z0-9-]+)#geometry> a geo:Geometry ;\s*\n\s*geo:asWKT )'
        r'"[^"]*"\^\^geo:wktLiteral \.',
        replace_geometry, ttl)

    def add_label(m: re.Match) -> str:
        notation = m.group("n")
        label = facts.get(notation, ("", ""))[0]
        if not label:
            return m.group(0)
        esc = label.replace("\\", "\\\\").replace('"', '\\"')
        return (f'{m.group("subj")} a geo:Feature,\n        sosa:FeatureOfInterest ;\n'
                f'    skos:prefLabel "{esc}" ;\n    geo:hasGeometry ')

    ttl, n_label = re.subn(
        r'(?P<subj><http://environment\.data\.gov\.uk/water-quality/sampling-point/'
        r'(?P<n>[A-Za-z0-9-]+)>) a geo:Feature,\s*\n\s*sosa:FeatureOfInterest ;\s*\n\s*geo:hasGeometry ',
        add_label, ttl)

    # Observation -> sampling point, the real join key. Appended as its own captured-provenance block.
    if links:
        block = ["", "# Observation -> sampling point (sosa:FeatureOfInterest), captured from the EA Water",
                 "# Quality Archive as application/ld+json. This is the join key the breach query uses in",
                 "# place of an IRI-prefix STRSTARTS filter; observational values are NOT stored (they stay",
                 "# federated via the /observations proxy)."]
        for obs, sp in sorted(links):
            block.append(f"<{obs}> a sosa:Observation ;\n    sosa:hasFeatureOfInterest <{sp}> .")
        ttl = ttl.rstrip() + "\n" + "\n".join(block) + "\n"

    TTL.write_text(ttl, "utf-8")
    print(f"geometry rewritten: {n_geom}; prefLabel added: {n_label}; obs->sp links: {len(links)}",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
