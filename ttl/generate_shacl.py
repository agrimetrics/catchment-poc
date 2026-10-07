"""Infer SHACL shapes for each committed graph in ttl/ using sheXer, unify each shape's own
IRI with its sh:targetClass (see unify_shape_and_class_iris -- required for Sparnatural's
generated queries to match real data, not just cosmetic), prune the sh:path rdf:type
discriminator shapes sheXer adds per class, then label every remaining predicate and target
class with an rdfs:label -- so a shape-driven UI (e.g. Sparnatural) gets a clean,
human-labelled picker that actually returns results, instead of raw IRIs, a "type" field on
every entity, and queries that silently match nothing.

Also writes ttl/<dataset>.sparnatural.shacl.ttl for the five DEFRA-modelled datasets (see
SPARNATURAL_GRAPHS/write_sparnatural_config) -- a further-curated subset of the full shapes,
restricted to the DEFRA ontology's own vocabulary. The full shapes above mix in every
vocabulary sheXer observed in the data (SKOS, GeoSPARQL, QUDT, SOSA, the EA's own external
catchment-planning terms, ad hoc CSV-shredding properties with no ontology home), which is a
fine validation artifact but an unusable query-builder config -- a picker spanning every
vocabulary in the source data, not the DEFRA domain model, fails to be useful.

sheXer mines shapes from the instance data itself (no ontology consulted), so the
shape *structure* describes what the graph *actually contains* -- useful as a validation
starting point, but review before treating it as a normative constraint set (e.g.
sh:minCount / sh:maxCount reflect observed cardinality, not modelled cardinality).

Pruning sh:path rdf:type: sheXer emits one of these per (shape, class) pair it saw in the
data, asserting via sh:in which class(es) that rdf:type value takes. This is redundant for
validation -- sh:targetClass already restricts which nodes a NodeShape validates, so an
instance is only in scope because it already has that rdf:type -- and it is actively bad
for a query-builder UI, which would otherwise offer "type" as a pickable property on every
single entity. Dropped here, not just filtered at the Sparnatural config layer, so the
files stay useful as plain SHACL too.

Label sourcing, in priority order (most authoritative first), applied to BOTH predicates
(sh:path) and target classes (sh:targetClass):
  1. Self-asserted: the term already carries an rdfs:label in the committed graph itself
     (e.g. an obda mapping that materialises `wr:judgedOnUndatedVersion rdfs:label "..."`
     alongside the data it describes).
  2. The DEFRA ontology: rdfs:label on the class/property in the sibling ontology-work repo
     (defra-core-ontology.ttl, defra-regulation.ttl, defra-water.ttl, defra-farming.ttl,
     defra-nature.ttl).
  3. RESEARCHED: a small hand-curated map for terms with no ontology home -- ad hoc
     `http://example.com/...` properties minted directly in an obda mapping for a shredded
     CSV column, plus standard external vocab classes/properties (skos, geosparql, qudt,
     sosa, i-adopt, ...) whose label is sourced from their own published spec, not ours to
     maintain in ontology-work. Sourced from the project's own documentation of those
     columns (ttl/sfi/Sustainable Farming Incentive_Data_Notes_v1_0.pdf,
     ttl/regulation/README.md, ttl/breaches/breaches.obda comments) or the external vocab's
     spec -- not invented.
  4. Mechanically derived: split the IRI's local name into words as a last resort (mainly
     the EA's own `catchment-planning/def/...` terms, which 404 on dereference so no
     upstream label is reachable).

Usage: poetry run python ttl/generate_shacl.py
"""

import re
from pathlib import Path

import rdflib
from shexer.consts import SHACL_TURTLE, TURTLE
from shexer.shaper import Shaper

TTL_DIR = Path(__file__).parent
ONTOLOGY_WORK_DIR = TTL_DIR.parent.parent / "ontology-work"
ONTOLOGY_FILES = [
    "defra-core-ontology.ttl",
    "defra-regulation.ttl",
    "defra-water.ttl",
    "defra-farming.ttl",
    "defra-nature.ttl",
]

GRAPHS = ["breaches", "catchment", "designations", "regulation", "sfi", "winep"]

# ttl/*.shacl.ttl (above) is the full sheXer-mined shape set for every graph -- a useful general
# validation artifact, but NOT what Sparnatural's picker should be built from: it includes every
# vocabulary sheXer observed in the instance data (SKOS, GeoSPARQL, QUDT, SOSA, OWL/DCTerms
# plumbing, the EA's own external catchment-planning terms, ad hoc CSV-shredding properties with
# no ontology home at all), which is "a general graph across all domains" rather than the DEFRA
# model -- unusable as a query-builder config. SPARNATURAL_GRAPHS below is the curated subset:
# only the datasets and vocabulary that actually come from the DEFRA ontology.
SPARNATURAL_GRAPHS = ["breaches", "designations", "regulation", "sfi", "winep"]  # catchment.ttl
# excluded entirely: it deliberately keeps the EA's OWN external catchment-planning vocabulary
# verbatim (see ttl/catchment/README.md), not DEFRA's -- none of it was "provided".

DEFRA_NAMESPACES = (
    "http://environment.data.gov.uk/ontology/core/",
    "http://environment.data.gov.uk/ontology/regulation/",
    "http://environment.data.gov.uk/ontology/water/",
    "http://environment.data.gov.uk/ontology/farming/",
    "http://environment.data.gov.uk/ontology/nature/",
)

# External classes the DEFRA ontology files formally reference -- via rdfs:range, rdfs:domain or
# rdfs:subClassOf on an actual DEFRA class/property, not merely mentioned in an rdfs:comment (e.g.
# defra-nature.ttl's comment prose about geo:hasGeometry doesn't count; defra-core:Site
# rdfs:subClassOf geo:Feature does). Verified against the ontology files themselves, not assumed --
# see the "ontology-declared only" scoping decision this implements. A kept external class still
# loses every one of its OWN properties under this rule (e.g. QuantityValue keeps no path to
# qudt:numericValue/qudt:unit, since those predicates aren't DEFRA namespace and aren't themselves
# declared by a DEFRA axiom) -- it remains pickable as a class/filter, not further explorable.
SPARNATURAL_EXTERNAL_CLASSES = {
    "http://qudt.org/schema/qudt/Quantity",           # defra-reg:Limit rdfs:subClassOf
    "http://qudt.org/schema/qudt/QuantityValue",       # range of upperBound/lowerBound/annualPayment/...
    "http://www.opengis.net/ont/geosparql#Feature",    # defra-core:Site rdfs:subClassOf
    "http://www.w3.org/2004/02/skos/core#Concept",     # range of hasClassification/documentType; domain of paymentRate
    "http://www.w3.org/2004/02/skos/core#ConceptScheme",  # defra-core:IdentifierScheme rdfs:subClassOf
    "http://www.w3.org/ns/sosa/ObservableProperty",    # range of regulatedProperty
    "http://www.w3.org/ns/sosa/Observation",           # range of evidencedByObservation
    "http://www.w3.org/ns/sosa/FeatureOfInterest",     # range of monitoredAt
    "http://purl.org/dc/terms/PeriodOfTime",           # defra-core:ApplicabilityPeriod rdfs:subClassOf
}

SH = rdflib.Namespace("http://www.w3.org/ns/shacl#")
RDFS = rdflib.RDFS

# Tier 3: no ontology defines these -- researched from the project's own docs (see module
# docstring). Update this map, not the ontology-work repo, if a term's provenance is only
# "we found it described in a data-notes PDF."
RESEARCHED_LABELS = {
    "http://example.com/farming/refYear": "application year",
    "http://example.com/farming/scheme": "SFI scheme strand",
    "http://example.com/farming/applicationType": "scheme strand",
    "http://example.com/farming/area": "total area",
    "http://example.com/farming/mtl": "total length",
    "http://example.com/farming/units": "units",
    "http://example.com/farming/uom_desc": "unit of measure",
    "http://example.com/farming/opt_year": "option year",
    "http://example.com/farming/schememodule": "scheme module",
    "http://example.com/water-regulation/crs": "CRS",
    "http://example.com/water-regulation/gridReferenceLevel": "grid reference level",
    "http://example.com/water-regulation/samplingPointType": "sampling point type",
    "http://example.com/water-regulation/samplingPointStatus": "sampling point status",
    "http://example.com/water-regulation/appliesFromMonth": "applies from month",
    "http://example.com/water-regulation/appliesToMonth": "applies to month",
    # genuine defra-farming ontology gap: these ARE our own vocab, just never labeled there.
    # Matched to the label style of their already-labeled siblings (annualPayment -> "annual
    # payment", paymentNote -> "payment note", ...).
    "http://environment.data.gov.uk/ontology/farming/annualPollutantImpact": "annual pollutant impact",
    "http://environment.data.gov.uk/ontology/farming/impactNote": "impact note",
    "http://environment.data.gov.uk/ontology/farming/pollutantImpactRate": "pollutant impact rate",
    "http://environment.data.gov.uk/ontology/farming/substance": "substance",
    # Standard external vocabularies, sourced from their own published specs rather than
    # this project's ontology -- kept here (not tier 2) because they aren't ours to maintain.
    "http://www.w3.org/1999/02/22-rdf-syntax-ns#type": "type",
    "http://www.w3.org/2000/01/rdf-schema#label": "label",
    "http://www.w3.org/2000/01/rdf-schema#comment": "comment",
    "http://www.w3.org/2002/07/owl#sameAs": "same as",
    "http://www.w3.org/2004/02/skos/core#prefLabel": "preferred label",
    "http://www.w3.org/2004/02/skos/core#altLabel": "alternative label",
    "http://www.w3.org/2004/02/skos/core#broader": "has broader",
    "http://www.w3.org/2004/02/skos/core#definition": "definition",
    "http://www.w3.org/2004/02/skos/core#exactMatch": "has exact match",
    "http://www.w3.org/2004/02/skos/core#inScheme": "is in scheme",
    "http://www.w3.org/2004/02/skos/core#notation": "notation",
    "http://www.w3.org/2004/02/skos/core#topConceptOf": "is top concept in scheme",
    "http://purl.org/dc/terms/description": "Description",
    "http://purl.org/dc/terms/hasVersion": "Has Version",
    "http://purl.org/dc/terms/source": "Source",
    "http://purl.org/linked-data/version#currentVersion": "current version",
    "http://qudt.org/schema/qudt/numericValue": "numeric value",
    "http://qudt.org/schema/qudt/unit": "unit",
    "http://www.opengis.net/ont/geosparql#asWKT": "as WKT",
    "http://www.opengis.net/ont/geosparql#hasGeometry": "has geometry",
    "http://www.opengis.net/ont/geosparql#hasDefaultGeometry": "has default geometry",
    "http://www.opengis.net/ont/geosparql#sfWithin": "within",
    "http://www.w3.org/ns/sosa/hasFeatureOfInterest": "has feature of interest",
    "https://w3id.org/iadopt/ont/hasStatisticalModifier": "has statistical modifier",
    # Two known acronym-boundary cases the mechanical humanizer below gets wrong
    # ("SWIMheader" -> splits before the run of caps, not after it).
    "http://environment.data.gov.uk/catchment-planning/def/reason-for-failure/nationalSWMIheader": "National SWMI Header",
    "http://environment.data.gov.uk/catchment-planning/def/reason-for-failure/pressureTier3": "Pressure Tier 3",
    # --- classes (sh:targetClass) below this line ---
    # genuine defra-farming ontology gap, same as its labeled sibling farming:PaymentRate ->
    # "Payment Rate".
    "http://environment.data.gov.uk/ontology/farming/PollutantImpactRate": "Pollutant Impact Rate",
    # Standard external vocabulary classes, sourced from their own published specs.
    "http://www.w3.org/2004/02/skos/core#Concept": "Concept",
    "http://www.w3.org/2004/02/skos/core#ConceptScheme": "Concept Scheme",
    "http://www.opengis.net/ont/geosparql#Feature": "Feature",
    "http://www.opengis.net/ont/geosparql#Geometry": "Geometry",
    "http://qudt.org/schema/qudt/QuantityValue": "Quantity Value",
    "http://qudt.org/schema/qudt/Unit": "Unit",
    "http://www.w3.org/ns/sosa/FeatureOfInterest": "Feature of Interest",
    "http://www.w3.org/ns/sosa/ObservableProperty": "Observable Property",
    "http://www.w3.org/ns/sosa/Observation": "Observation",
    "https://w3id.org/iadopt/ont/StatisticalModifier": "Statistical Modifier",
    "http://purl.org/linked-data/version#Version": "Version",
}

_ACRONYMS = {"swmi": "SWMI", "uid": "UID", "crs": "CRS"}


def humanize(local_name: str) -> str:
    s = local_name.replace("_", " ").replace("-", " ")
    s = re.sub(r"(?<!^)(?<![A-Z0-9 ])(?=[A-Z])", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    words = [_ACRONYMS.get(w.lower(), w) for w in s.split(" ")]
    out = " ".join(words)
    return out[0].upper() + out[1:] if out else out


def load_ontology_labels() -> dict[str, str]:
    if not ONTOLOGY_WORK_DIR.exists():
        print(f"warning: sibling ontology-work repo not found at {ONTOLOGY_WORK_DIR}; "
              "DEFRA-ontology-sourced labels will fall back to researched/derived ones")
        return {}
    g = rdflib.Graph()
    for f in ONTOLOGY_FILES:
        g.parse(ONTOLOGY_WORK_DIR / f, format="turtle")
    return {str(s): str(label) for s, label in g.subject_objects(RDFS.label)}


def _label_terms(g: rdflib.Graph, terms: set, source_graph: rdflib.Graph, ontology_labels: dict[str, str]) -> int:
    added = 0
    for term in terms:
        t_uri = rdflib.URIRef(term)
        if (t_uri, RDFS.label, None) in g:
            continue  # sheXer occasionally surfaces an existing label as instance data

        self_asserted = list(source_graph.objects(t_uri, RDFS.label))
        if self_asserted:
            label = str(self_asserted[0])
        elif term in ontology_labels:
            label = ontology_labels[term]
        elif term in RESEARCHED_LABELS:
            label = RESEARCHED_LABELS[term]
        else:
            label = humanize(term.rsplit("/", 1)[-1].rsplit("#", 1)[-1])

        g.add((t_uri, RDFS.label, rdflib.Literal(label, lang="en")))
        added += 1
    return added


def unify_shape_and_class_iris(shapes_path: Path) -> None:
    """Rewrite each NodeShape's own subject IRI to be its sh:targetClass IRI.

    sheXer mints a synthetic shape identifier for every shape under its own
    `shapes_namespace` (default `http://weso.es/shapes/<LocalName>`), distinct from the real
    ontology class named by sh:targetClass. Sparnatural's query generator turns out to build
    its `rdf:type` triple pattern from the SHAPE's own subject IRI, not sh:targetClass -- so
    left as sheXer emits them, every generated query asks for `rdf:type
    <http://weso.es/shapes/PermitDocument>`, which matches nothing in the real graph (real
    instances are typed `defra-reg:PermitDocument`). Making the shape's subject IRI and its
    target class IRI the same resource (`defra-reg:PermitDocument a sh:NodeShape ;
    sh:targetClass defra-reg:PermitDocument`) is the standard SHACL "class as its own shape"
    idiom, and is what makes Sparnatural's generated queries actually match data.
    """
    g = rdflib.Graph()
    g.parse(shapes_path, format="turtle")

    rename = {shape: cls for shape, cls in g.subject_objects(SH.targetClass) if shape != cls}
    for old_iri, new_iri in rename.items():
        for s, p, o in list(g.triples((old_iri, None, None))):
            g.remove((s, p, o))
            g.add((new_iri, p, o))
        for s, p, o in list(g.triples((None, None, old_iri))):
            g.remove((s, p, o))
            g.add((s, p, new_iri))

    g.serialize(destination=str(shapes_path), format="turtle")
    print(f"  unified {len(rename)} shape/class IRI pairs")


def prune_type_shapes(shapes_path: Path) -> None:
    g = rdflib.Graph()
    g.parse(shapes_path, format="turtle")

    type_shapes = set(g.subjects(SH.path, rdflib.RDF.type))
    removed = 0
    for node_shape in set(g.subjects(SH.property, None)):
        for prop_shape in list(g.objects(node_shape, SH.property)):
            if prop_shape in type_shapes:
                g.remove((node_shape, SH.property, prop_shape))
                for triple in list(g.triples((prop_shape, None, None))):
                    g.remove(triple)
                removed += 1

    g.serialize(destination=str(shapes_path), format="turtle")
    print(f"  pruned {removed} rdf:type property shapes")


def label_shapes(shapes_path: Path, source_graph_path: Path, ontology_labels: dict[str, str]) -> None:
    g = rdflib.Graph()
    g.parse(shapes_path, format="turtle")
    source_graph = rdflib.Graph()
    source_graph.parse(source_graph_path, format="turtle")

    predicates = {str(p) for p in g.objects(None, SH.path)}
    classes = {str(c) for c in g.objects(None, SH.targetClass)}

    p_added = _label_terms(g, predicates, source_graph, ontology_labels)
    c_added = _label_terms(g, classes, source_graph, ontology_labels)

    g.serialize(destination=str(shapes_path), format="turtle")
    print(f"  labeled {p_added}/{len(predicates)} predicates, {c_added}/{len(classes)} target classes")


def _is_defra(iri: str) -> bool:
    return any(iri.startswith(ns) for ns in DEFRA_NAMESPACES)


def write_sparnatural_config(full_shapes_path: Path, curated_path: Path) -> None:
    """Filter an already-built ttl/<dataset>.shacl.ttl down to DEFRA-ontology-scoped vocabulary
    only, for Sparnatural's picker. See SPARNATURAL_EXTERNAL_CLASSES for what "DEFRA-scoped" means
    and why it's not just "DEFRA namespace" -- the ontology deliberately reuses a handful of
    external classes, and dropping those too would make e.g. Limit unreachable as a concept at all.
    """
    g = rdflib.Graph()
    g.parse(full_shapes_path, format="turtle")

    kept_classes = {
        cls for cls in g.objects(None, SH.targetClass)
        if _is_defra(str(cls)) or str(cls) in SPARNATURAL_EXTERNAL_CLASSES
    }
    dropped_classes = {cls for cls in g.objects(None, SH.targetClass) if cls not in kept_classes}

    removed_props = 0
    for node_shape in set(g.subjects(SH.property, None)):
        for prop_shape in list(g.objects(node_shape, SH.property)):
            path = g.value(prop_shape, SH.path)
            node = g.value(prop_shape, SH.node)
            out_of_scope = path is not None and not _is_defra(str(path))
            dangling = node is not None and node in dropped_classes
            if out_of_scope or dangling:
                g.remove((node_shape, SH.property, prop_shape))
                for triple in list(g.triples((prop_shape, None, None))):
                    g.remove(triple)
                removed_props += 1

    for node_shape in list(g.subjects(rdflib.RDF.type, SH.NodeShape)):
        cls = g.value(node_shape, SH.targetClass)
        if cls is not None and cls not in kept_classes:
            for triple in list(g.triples((node_shape, None, None))):
                g.remove(triple)

    g.serialize(destination=str(curated_path), format="turtle")
    n_classes = len(kept_classes)
    print(f"  {curated_path.name}: kept {n_classes} classes ({len(dropped_classes)} dropped), "
          f"removed {removed_props} out-of-scope/dangling property shapes")


def main() -> None:
    ontology_labels = load_ontology_labels()

    for name in GRAPHS:
        input_path = TTL_DIR / f"{name}.ttl"
        output_path = TTL_DIR / f"{name}.shacl.ttl"
        print(f"{input_path} -> {output_path}")

        shaper = Shaper(
            graph_file_input=str(input_path),
            input_format=TURTLE,
            all_classes_mode=True,
        )
        shaper.shex_graph(output_file=str(output_path), output_format=SHACL_TURTLE)
        unify_shape_and_class_iris(output_path)
        prune_type_shapes(output_path)
        label_shapes(output_path, input_path, ontology_labels)

        if name in SPARNATURAL_GRAPHS:
            curated_path = TTL_DIR / f"{name}.sparnatural.shacl.ttl"
            write_sparnatural_config(output_path, curated_path)


if __name__ == "__main__":
    main()
