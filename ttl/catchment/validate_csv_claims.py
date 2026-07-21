"""Re-check the CSV-derived claims in PLAN.md against the triplestore.

Kept deliberately small. Its job is not to be a test suite -- it is the record of which
published-CSV numbers the graph agrees with, and it exists mainly so the two places they
disagree (RNAG count, and the hydromorphological designation) stay visible rather than
being quietly forgotten.

The first version of this file used `rff:waterBody` (does not exist), compared
language-tagged labels against plain strings (silently matches nothing), and did not filter
`a wbc:Classification` (inflates 5,852 -> 6,631 and pulls objective years 2027/2040/2063 in
as though they were observations). All three returned confident wrong answers. The idioms
below are the corrected ones -- see ISSUES.md §§4, 8, 10-12.

    CDE_SPARQL_ENDPOINT=... CDE_SPARQL_USER=... CDE_SPARQL_PASSWORD=... \\
        CDE_REPOSITORY=... python ttl/catchment/validate_csv_claims.py
"""

import os
import sys

from sparql_client import query

REPO = os.environ.get("CDE_REPOSITORY", "")
CP = "http://environment.data.gov.uk/catchment-planning/"
OC = f"<{CP}so/OperationalCatchment/3367>"
# ISSUES.md §1 -- a Cornish lake asserted into a Dorset catchment. Excluded everywhere.
STANNON = f"<{CP}so/WaterBody/GB30846165>"

PREFIXES = f"""
PREFIX wfd:  <{CP}def/water-framework-directive/>
PREFIX wbc:  <{CP}def/waterbody-classification/>
PREFIX rff:  <{CP}def/reason-for-failure/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX dct:  <http://purl.org/dc/terms/>
"""

# Every catchment-scoped query starts here. The FILTER is not optional.
SCOPE = f"?wb wfd:inOperationalCatchment {OC} . FILTER(?wb != {STANNON})"


def rows(sparql, *vars_):
    r = query(REPO, PREFIXES + sparql)["results"]["bindings"]
    return [tuple(b.get(v, {}).get("value", "") for v in vars_) for b in r]


def count(sparql):
    return int(rows(sparql, "n")[0][0])


CHECKS = [
    ("waterbodies", 19,
     f"SELECT (COUNT(DISTINCT ?wb) AS ?n) WHERE {{ {SCOPE} }}"),
    ("classification records", 5852,
     f"""SELECT (COUNT(DISTINCT ?c) AS ?n) WHERE {{ {SCOPE}
         ?c wfd:waterBody ?wb ; a wbc:Classification . }}"""),
    ("distinct classification items", 74,
     f"""SELECT (COUNT(DISTINCT ?i) AS ?n) WHERE {{ {SCOPE}
         ?c wfd:waterBody ?wb ; a wbc:Classification ; wbc:classificationItem ?i . }}"""),
    ("distinct classification years", 10,
     f"""SELECT (COUNT(DISTINCT ?y) AS ?n) WHERE {{ {SCOPE}
         ?c wfd:waterBody ?wb ; a wbc:Classification ; wbc:classificationYear ?y . }}"""),
    ("cycle-3 RNAGs (CSV says 93 -- graph has 2 more, ISSUES.md §2)", 95,
     f"""SELECT (COUNT(DISTINCT ?x) AS ?n) WHERE {{ {SCOPE}
         ?x wfd:waterBody ?wb ; a rff:ReasonForFailure ; wfd:cycle <{CP}data/cycle/3> . }}"""),
    ("RNAGs with no nationalSWMIheader (CSV says 56)", 57,
     f"""SELECT (COUNT(DISTINCT ?x) AS ?n) WHERE {{ {SCOPE}
         ?x wfd:waterBody ?wb ; a rff:ReasonForFailure ; wfd:cycle <{CP}data/cycle/3> .
         FILTER NOT EXISTS {{ ?x rff:nationalSWMIheader ?h }} }}"""),
    ("nitrogen/nitrate classification items (none in this catchment)", 0,
     f"""SELECT (COUNT(DISTINCT ?i) AS ?n) WHERE {{ {SCOPE}
         ?c wfd:waterBody ?wb ; wbc:classificationItem ?i . ?i rdfs:label ?l .
         FILTER(CONTAINS(LCASE(STR(?l)), "nitr")) }}"""),
    ("waterbodies whose designation CHANGED between versions", 3,
     f"""SELECT (COUNT(DISTINCT ?wb) AS ?n) WHERE {{ {SCOPE}
         ?wb dct:hasVersion ?v1, ?v2 .
         ?v1 wfd:hydromorphologicalDesignation ?d1 .
         ?v2 wfd:hydromorphologicalDesignation ?d2 .
         FILTER(?d1 != ?d2) }}"""),
]

# The published cross-table. The strongest end-to-end check available: it exercises
# RNAG -> classification -> status -> concept-label resolution in one query and has a
# known-correct answer verified against both the CDE website and the CSV.
CROSSTAB = f"""SELECT ?sector ?swmi (COUNT(*) AS ?n) WHERE {{
  SELECT DISTINCT ?sector ?swmi ?wb ?status ?p3 WHERE {{
    {SCOPE}
    ?x wfd:waterBody ?wb ; a rff:ReasonForFailure ; wfd:cycle <{CP}data/cycle/3> ;
       rff:nationalSWMIheader ?swmiL ; rff:category ?cat ;
       rff:pressureTier3 ?p3L ; wbc:classification ?cl .
    ?cat rdfs:label ?sectorL .
    ?cl wbc:classificationValue ?sv . ?sv rdfs:label ?statusL .
    # STR() is load-bearing: labels are language-tagged, and IN() against plain
    # strings matches nothing while looking exactly like "no failing water bodies".
    BIND(STR(?statusL) AS ?status) BIND(STR(?sectorL) AS ?sector)
    BIND(STR(?swmiL) AS ?swmi)     BIND(STR(?p3L) AS ?p3)
    FILTER(?status IN ("Bad","Poor","Moderate","Fail","Does Not Support Good"))
  }} }} GROUP BY ?sector ?swmi"""


def main():
    print(f"Validating against {REPO}\n")
    ok = True
    for name, expected, sparql in CHECKS:
        got = count(sparql)
        agree = got == expected
        ok &= agree
        print(f"  [{'OK  ' if agree else 'DIFF'}] {name}: {got} (expected {expected})")

    cells = rows(CROSSTAB, "sector", "swmi", "n")
    total = sum(int(n) for _, _, n in cells)
    agree = len(cells) == 8 and total == 29
    ok &= agree
    print(f"  [{'OK  ' if agree else 'DIFF'}] cross-table: {len(cells)} cells, "
          f"total {total} (expected 8 cells, total 29)")

    print("\n" + ("ALL CHECKS PASS" if ok else "DISAGREEMENTS -- see [DIFF] above"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
