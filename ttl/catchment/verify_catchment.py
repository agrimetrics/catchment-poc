"""Assert the delivered ../catchment.ttl says what the source said.

    python ttl/catchment/verify_catchment.py

Runs against the local file in pyoxigraph -- the same engine the app uses -- so it checks
the graph as shipped, not as queried remotely. Every expected number here was validated
against the source first (PLAN.md §6); this file is what stops the extract silently
shrinking if it is ever re-run.

The cross-table check is the strongest of these: it exercises
RNAG -> classification -> status -> concept-label resolution in a single query, and its
answer is known-correct against both the CDE website and the published CSV.
"""

import sys
from pathlib import Path

import pyoxigraph as ox

TTL = Path(__file__).resolve().parents[1] / "catchment.ttl"
CP = "http://environment.data.gov.uk/catchment-planning/"

P = f"""
PREFIX wfd:  <{CP}def/water-framework-directive/>
PREFIX wbc:  <{CP}def/waterbody-classification/>
PREFIX rff:  <{CP}def/reason-for-failure/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX dct:  <http://purl.org/dc/terms/>
PREFIX geo:  <http://www.opengis.net/ont/geosparql#>
"""

CHECKS = [
    ("waterbodies", 19,
     "SELECT (COUNT(DISTINCT ?wb) AS ?n) WHERE { ?wb wfd:inOperationalCatchment ?oc }"),
    ("classification records", 5852,
     "SELECT (COUNT(DISTINCT ?c) AS ?n) WHERE { ?c a wbc:Classification }"),
    ("distinct classification items", 74,
     "SELECT (COUNT(DISTINCT ?i) AS ?n) WHERE { ?c a wbc:Classification ; wbc:classificationItem ?i }"),
    ("distinct classification years", 10,
     "SELECT (COUNT(DISTINCT ?y) AS ?n) WHERE { ?c a wbc:Classification ; wbc:classificationYear ?y }"),
    ("RNAGs (95, not the CSV's 93 -- ISSUES.md §2)", 95,
     "SELECT (COUNT(DISTINCT ?x) AS ?n) WHERE { ?x a rff:ReasonForFailure }"),
    ("RNAGs with no nationalSWMIheader", 57,
     """SELECT (COUNT(DISTINCT ?x) AS ?n) WHERE { ?x a rff:ReasonForFailure .
        FILTER NOT EXISTS { ?x rff:nationalSWMIheader ?h } }"""),
    ("waterbodies whose designation changed between versions", 3,
     """SELECT (COUNT(DISTINCT ?wb) AS ?n) WHERE {
        ?wb dct:hasVersion ?v1, ?v2 .
        ?v1 wfd:hydromorphologicalDesignation ?d1 .
        ?v2 wfd:hydromorphologicalDesignation ?d2 . FILTER(?d1 != ?d2) }"""),
    ("geometries carrying WKT (19 catchment polygons + 19 river lines)", 38,
     "SELECT (COUNT(DISTINCT ?g) AS ?n) WHERE { ?g geo:asWKT ?w }"),
    # ISSUES.md §1 -- must be absent, not merely rare.
    ("Stannon Lake triples (the dual-catchment defect)", 0,
     f"SELECT (COUNT(*) AS ?n) WHERE {{ <{CP}so/WaterBody/GB30846165> ?p ?o }}"),
    # A concept with no label is unusable in a UI: it renders as a raw URI or as blank.
    ("referenced concepts lacking any label", 0,
     """SELECT (COUNT(DISTINCT ?c) AS ?n) WHERE {
        ?c a skos:Concept .
        FILTER NOT EXISTS { ?c skos:prefLabel ?p }
        FILTER NOT EXISTS { ?c rdfs:label ?l } }"""),
]

CROSSTAB = """SELECT ?sector ?swmi (COUNT(*) AS ?n) WHERE {
  SELECT DISTINCT ?sector ?swmi ?wb ?status ?p3 WHERE {
    ?x a rff:ReasonForFailure ; wfd:waterBody ?wb ;
       rff:nationalSWMIheader ?swmiL ; rff:category ?cat ;
       rff:pressureTier3 ?p3L ; wbc:classification ?cl .
    ?cat rdfs:label ?sectorL .
    ?cl wbc:classificationValue ?sv . ?sv rdfs:label ?statusL .
    BIND(STR(?statusL) AS ?status) BIND(STR(?sectorL) AS ?sector)
    BIND(STR(?swmiL) AS ?swmi)     BIND(STR(?p3L) AS ?p3)
    FILTER(?status IN ("Bad","Poor","Moderate","Fail","Does Not Support Good"))
  } } GROUP BY ?sector ?swmi"""


def main():
    if not TTL.exists():
        sys.exit(f"{TTL} not found -- run catchment_construct.py then rdfpipe (see README).")

    store = ox.Store()
    store.bulk_load(path=str(TTL), format=ox.RdfFormat.TURTLE)
    print(f"Loaded {len(store):,} triples from {TTL.name}\n")

    ok = True
    for name, expected, sparql in CHECKS:
        got = int(list(store.query(P + sparql))[0][0].value)
        # Compare explicitly against None, never truthiness: an expected value of 0 is a
        # real expectation ("this defect must be absent"), and `if expected` silently
        # turns it into "any value will do". That bug produced a false DIFF on the
        # Stannon Lake check the first time this ran.
        agree = got == expected
        ok &= agree
        print(f"  [{'OK  ' if agree else 'FAIL'}] {name}: {got} (expected {expected})")

    cells = list(store.query(P + CROSSTAB))
    total = sum(int(c[2].value) for c in cells)
    agree = len(cells) == 8 and total == 29
    ok &= agree
    print(f"  [{'OK  ' if agree else 'FAIL'}] published cross-table: {len(cells)} cells, "
          f"total {total} (expected 8, 29)")

    print("\n" + ("ALL ASSERTIONS PASS" if ok else "FAILURES -- the extract disagrees with the source"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
