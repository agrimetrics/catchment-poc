"""Extract the Poole Harbour Rivers subgraph from the source CDE dataset. Run once.

    CDE_SPARQL_ENDPOINT=... CDE_SPARQL_USER=... CDE_SPARQL_PASSWORD=... \\
        CDE_REPOSITORY=... python ttl/catchment/catchment_construct.py

Writes `catchment_raw.ttl` (committed -- the source is not publicly reachable, so the build
must be able to run offline afterwards; same reasoning as compliance_observations.csv in
ttl/breaches). Canonicalise into the delivered graph with:

    rdfpipe -i turtle -o turtle ttl/catchment/catchment_raw.ttl > ttl/catchment.ttl

Design decisions, all confirmed before writing (see TODO.md §1):

  * Source URIs are kept VERBATIM. No re-minting to example.com. This preserves the join
    back to CDE and lets us reuse the 29 SKOS schemes that already exist rather than
    authoring vocabularies. Consequence to state wherever a user meets these URIs: they
    look authoritative and they do NOT dereference -- environment.data.gov.uk serves no
    RDF and 404s on every one of them.
  * All 10 classification years, all 3 cycles. The history is what makes the
    hydromorphological designation change legible.
  * All 95 cycle-3 RNAGs, including the 2 the published CSV omits (ISSUES.md §2). The
    graph is authoritative. Neither affects the cross-table.
  * Stannon Lake is excluded everywhere (ISSUES.md §1).
"""

import os
import subprocess
import sys
from pathlib import Path

from sparql_client import construct

REPO = os.environ.get("CDE_REPOSITORY", "")
CP = "http://environment.data.gov.uk/catchment-planning/"
OC = f"<{CP}so/OperationalCatchment/3367>"
STANNON = f"<{CP}so/WaterBody/GB30846165>"
OUT = Path(__file__).parent / "catchment_raw.ttl"

P = f"""
PREFIX wfd:  <{CP}def/water-framework-directive/>
PREFIX wbc:  <{CP}def/waterbody-classification/>
PREFIX rff:  <{CP}def/reason-for-failure/>
PREFIX cls:  <{CP}def/classification/>
PREFIX geo:  <http://www.opengis.net/ont/geosparql#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX dct:  <http://purl.org/dc/terms/>
PREFIX ver:  <http://purl.org/linked-data/version#>
PREFIX qb:   <http://purl.org/linked-data/cube#>
"""

# Not optional. A Cornish lake is asserted into this Dorset catchment, and it is the only
# Lake and the only heavily-modified body here -- so including it does not merely add a row,
# it falsifies both "all rivers" and "nothing designated". ISSUES.md §1.
SCOPE = f"?wb wfd:inOperationalCatchment {OC} . FILTER(?wb != {STANNON})"

# Types are materialised by a reasoner into blank-node OWL restriction classes, and
# everything is dual-typed under INSPIRE as well. Keep only real catchment-planning IRIs.
REAL_TYPE = ('FILTER(isIRI(?type) && !STRSTARTS(STR(?type), "node") && '
             f'STRSTARTS(STR(?type), "{CP}def/"))')

QUERIES = {}

# --- 1. Waterbodies, versions, designations, geometry -------------------------------
# Versions are NOT flattened. Three rivers changed hydromorphological designation between
# v1 and v2; collapsing to the current version destroys the most interesting fact here.
# Waterbodies carry no rdfs:label -- the name is on the version, and versions disagree on
# case ("CERNE" vs "Cerne"), so labels are carried but must never be joined on. ISSUES.md §8.
QUERIES["waterbodies"] = f"""{P}
CONSTRUCT {{
  ?wb a ?type ; skos:notation ?note ;
      wfd:inOperationalCatchment ?oc ;
      dct:hasVersion ?v ; ver:currentVersion ?cur ;
      geo:hasGeometry ?g .
  ?v a ver:Version ; rdfs:label ?vlabel ;
     wfd:hydromorphologicalDesignation ?des .
  ?des a wfd:HydromorphologicalDesignation ; rdfs:label ?deslabel ;
       rdfs:comment ?descomment ; skos:topConceptOf ?desscheme .
  ?g a ?gtype ; geo:asWKT ?wkt .
}} WHERE {{
  {SCOPE}
  ?wb wfd:inOperationalCatchment ?oc ; skos:notation ?note ; a ?type .
  {REAL_TYPE}
  OPTIONAL {{ ?wb ver:currentVersion ?cur }}
  OPTIONAL {{ ?wb geo:hasGeometry ?g . ?g geo:asWKT ?wkt . OPTIONAL {{ ?g a ?gtype . FILTER(isIRI(?gtype) && !STRSTARTS(STR(?gtype), "node")) }} }}
  OPTIONAL {{
    ?wb dct:hasVersion ?v .
    OPTIONAL {{ ?v rdfs:label ?vlabel }}
    OPTIONAL {{
      ?v wfd:hydromorphologicalDesignation ?des .
      OPTIONAL {{ ?des rdfs:label ?deslabel }}
      OPTIONAL {{ ?des rdfs:comment ?descomment }}
      OPTIONAL {{ ?des skos:topConceptOf ?desscheme }}
    }}
  }}
}}"""

# --- 2. Catchment context ----------------------------------------------------------
QUERIES["catchment"] = f"""{P}
CONSTRUCT {{
  ?oc a ?type ; rdfs:label ?label ; skos:notation ?note ;
      wfd:inManagementCatchment ?mc ; wfd:inRiverBasinDistrict ?rbd .
  ?mc rdfs:label ?mclabel . ?rbd rdfs:label ?rbdlabel .
}} WHERE {{
  BIND({OC} AS ?oc)
  ?oc a ?type ; rdfs:label ?label ; skos:notation ?note . {REAL_TYPE}
  OPTIONAL {{ ?oc wfd:inManagementCatchment ?mc . OPTIONAL {{ ?mc rdfs:label ?mclabel }} }}
  OPTIONAL {{ ?oc wfd:inRiverBasinDistrict ?rbd . OPTIONAL {{ ?rbd rdfs:label ?rbdlabel }} }}
}}"""

# --- 3. Classifications -------------------------------------------------------------
# `a wbc:Classification` is load-bearing. Without it ClassificationObservation and
# ObjectiveOutcome come too: 5,852 -> 6,631, with objective years 2027/2040/2063 arriving
# as though they were observations. ISSUES.md / PLAN.md §6.
QUERIES["classifications"] = f"""{P}
CONSTRUCT {{
  ?c a wbc:Classification ;
     wfd:waterBody ?wb ;
     wbc:classificationItem ?item ;
     wbc:classificationYear ?year ;
     wfd:cycle ?cycle ;
     wbc:classificationValue ?value ;
     wbc:classificationCertainty ?certainty ;
     wbc:classificationDeteriorationType ?deterioration ;
     wbc:classificationUid ?uid ;
     wbc:reasonForFailure ?rff ;
     wbc:problem ?problem .
  ?cycle rdfs:label ?cyclelabel .
}} WHERE {{
  {SCOPE}
  ?c wfd:waterBody ?wb ; a wbc:Classification ;
     wbc:classificationItem ?item ; wbc:classificationYear ?year .
  OPTIONAL {{ ?c wfd:cycle ?cycle . OPTIONAL {{ ?cycle rdfs:label ?cyclelabel }} }}
  OPTIONAL {{ ?c wbc:classificationValue ?value }}
  OPTIONAL {{ ?c wbc:classificationCertainty ?certainty }}
  OPTIONAL {{ ?c wbc:classificationDeteriorationType ?deterioration }}
  OPTIONAL {{ ?c wbc:classificationUid ?uid }}
  OPTIONAL {{ ?c wbc:reasonForFailure ?rff }}
  OPTIONAL {{ ?c wbc:problem ?problem }}
}}"""

# --- 4. RNAGs (challenges) ----------------------------------------------------------
# Links by wfd:waterBody. rff:waterBody does not exist and returns zero rows silently.
# nationalSWMIheader is a bare literal with no concept behind it -- carried as-is. Inventing
# URIs for the seven headings would manufacture identity the source does not have, and would
# make the 57 headerless records look like resolution failures. ISSUES.md §3.
QUERIES["rnags"] = f"""{P}
CONSTRUCT {{
  ?x a rff:ReasonForFailure ;
     wfd:waterBody ?wb ;
     wfd:cycle ?cycle ;
     wbc:classificationItem ?item ;
     wbc:classificationYear ?year ;
     wbc:classification ?cl ;
     rff:category ?cat ; rff:categoryCertainty ?catcert ;
     rff:businessSector ?sector ;
     rff:activity ?activity ; rff:activityCertainty ?actcert ;
     rff:swmi ?swmi ; rff:swmiCertainty ?swmicert ;
     rff:pressureTier3 ?p3 ;
     rff:apportionment ?apportionment ;
     rff:reasonForFailureType ?rfftype ;
     rff:problem ?problem ;
     rff:nationalSWMIheader ?header .
}} WHERE {{
  {SCOPE}
  ?x wfd:waterBody ?wb ; a rff:ReasonForFailure .
  OPTIONAL {{ ?x wfd:cycle ?cycle }}
  OPTIONAL {{ ?x wbc:classificationItem ?item }}
  OPTIONAL {{ ?x wbc:classificationYear ?year }}
  OPTIONAL {{ ?x wbc:classification ?cl }}
  OPTIONAL {{ ?x rff:category ?cat }}
  OPTIONAL {{ ?x rff:categoryCertainty ?catcert }}
  OPTIONAL {{ ?x rff:businessSector ?sector }}
  OPTIONAL {{ ?x rff:activity ?activity }}
  OPTIONAL {{ ?x rff:activityCertainty ?actcert }}
  OPTIONAL {{ ?x rff:swmi ?swmi }}
  OPTIONAL {{ ?x rff:swmiCertainty ?swmicert }}
  OPTIONAL {{ ?x rff:pressureTier3 ?p3 }}
  OPTIONAL {{ ?x rff:apportionment ?apportionment }}
  OPTIONAL {{ ?x rff:reasonForFailureType ?rfftype }}
  OPTIONAL {{ ?x rff:problem ?problem }}
  OPTIONAL {{ ?x rff:nationalSWMIheader ?header }}
}}"""

# --- 5. Concepts actually referenced --------------------------------------------------
# Referenced concepts only, not whole schemes: measureTierScheme alone holds 249 concepts
# and nothing here uses them. Scheme membership is taken via BOTH skos:inScheme and
# skos:topConceptOf -- the WFD vocabularies use only the latter, and querying one predicate
# is what caused the retracted "designation is absent" conclusion. ISSUES.md §4.
QUERIES["concepts"] = f"""{P}
CONSTRUCT {{
  ?concept a skos:Concept ; skos:prefLabel ?pref ; rdfs:label ?label ;
           skos:notation ?notation ; rdfs:comment ?comment ;
           skos:inScheme ?scheme ; skos:topConceptOf ?topscheme .
}} WHERE {{
  {{
    SELECT DISTINCT ?concept WHERE {{
      {SCOPE}
      {{ ?c wfd:waterBody ?wb ; a wbc:Classification .
         ?c ?anyp ?concept . FILTER(isIRI(?concept) && STRSTARTS(STR(?concept), "{CP}def/")) }}
      UNION
      {{ ?x wfd:waterBody ?wb ; a rff:ReasonForFailure .
         ?x ?anyp ?concept . FILTER(isIRI(?concept) && STRSTARTS(STR(?concept), "{CP}def/")) }}
    }}
  }}
  OPTIONAL {{ ?concept skos:prefLabel ?pref }}
  OPTIONAL {{ ?concept rdfs:label ?label }}
  OPTIONAL {{ ?concept skos:notation ?notation }}
  OPTIONAL {{ ?concept rdfs:comment ?comment }}
  OPTIONAL {{ ?concept skos:inScheme ?scheme }}
  OPTIONAL {{ ?concept skos:topConceptOf ?topscheme }}
}}"""


def main():
    parts, counts = [], {}
    for name, sparql in QUERIES.items():
        print(f"  CONSTRUCT {name} ...", end="", flush=True)
        nt = construct(REPO, sparql)
        n = sum(1 for line in nt.splitlines() if line.strip() and not line.startswith("#"))
        counts[name] = n
        parts.append(nt)
        print(f" {n:,} triples")

    import rdflib
    g = rdflib.Graph()
    g.parse(data="\n".join(parts), format="nt")
    for pfx, uri in [("wfd", f"{CP}def/water-framework-directive/"),
                     ("wbc", f"{CP}def/waterbody-classification/"),
                     ("rff", f"{CP}def/reason-for-failure/"),
                     ("cls", f"{CP}def/classification/"),
                     ("cpso", f"{CP}so/"), ("cpdata", f"{CP}data/"),
                     ("geo", "http://www.opengis.net/ont/geosparql#"),
                     ("ver", "http://purl.org/linked-data/version#")]:
        g.bind(pfx, uri)

    g.serialize(destination=OUT, format="turtle")
    print(f"\n  deduplicated: {sum(counts.values()):,} -> {len(g):,} triples")
    print(f"  wrote {OUT} ({OUT.stat().st_size / 1024:.0f} KB)")
    return g


if __name__ == "__main__":
    main()
