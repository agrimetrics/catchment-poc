"""Clip the three national conservation-designation layers (SSSI, SAC, SPA) to the Poole Harbour
catchment and emit two products:

  1. ttl/designations.ttl        — the RDF graph (GeoSPARQL features), for the triplestore. This is
                                    the portable, RDF-native representation that GraphDB can index and
                                    run spatial queries against (see ttl/designations/README.md).
  2. app/{sssi,sac,spa}.geojson  — small clipped GeoJSON the current frontend still fetches to draw
                                    the legend/map underlays (unchanged display path).

Unlike the other pipelines this one is geometry-centric, so it goes straight geopandas → WKT → RDF
(rdflib) rather than DuckDB → ontop; there is nothing relational to shred. Re-run after changing the
raw datasets:

    python ttl/designations/designations_to_ttl.py
"""

from pathlib import Path

import geopandas as gpd
from rdflib import Graph, Literal, Namespace, RDF, RDFS, URIRef
from rdflib.namespace import SKOS

HERE = Path(__file__).resolve().parent          # ttl/designations
ROOT = HERE.parents[1]                           # repository root
RAW = ROOT / "raw_datasets"
APP = ROOT / "app"

NATURE = Namespace("http://example.com/nature/")                             # site instances + concepts
DEFRA_NATURE = Namespace("http://environment.data.gov.uk/ontology/nature/")  # ProtectedSite class (ontology-work)
CORE = Namespace("http://environment.data.gov.uk/ontology/core/")            # hasClassification
GEO = Namespace("http://www.opengis.net/ont/geosparql#")
CRS84 = "http://www.opengis.net/def/crs/OGC/1.3/CRS84"                       # WGS84 lon/lat

# Buffer the catchment so conservation sites straddling the boundary are kept whole.
catchment = gpd.read_file(RAW / "poole_harbour_rivers_operational_catchment.geojson").to_crs(4326)
clip = catchment.union_all().buffer(0.03)  # ~3 km in degrees at this latitude

# (source file, name column, code column, designation key, display GeoJSON name).
LAYERS = [
    ("Sites_of_Special_Scientific_Interest_England.geojson", "name", "ref_code", "sssi", "sssi.geojson"),
    ("Special_Areas_of_Conservation_England.geojson", "sac_name", "sac_code", "sac", "sac.geojson"),
    ("Special_Protection_Areas_England.geojson", "spa_name", "spa_code", "spa", "spa.geojson"),
]
# The RDF keeps near-full geometry fidelity (~2 m) for accurate spatial queries; the display GeoJSON
# stays coarse (~30 m) for a light browser payload.
RDF_SIMPLIFY = 0.00002
DISPLAY_SIMPLIFY = 0.0003

g = Graph()
# NATURE (http://example.com/nature/) is the instance namespace and DEFRA_NATURE
# (http://environment.data.gov.uk/ontology/nature/) is the ontology — different layers, so only the
# ontology term (ProtectedSite) gets a bound prefix; site/concept IRIs carry a slash and serialise in
# full anyway.
g.bind("defra-nature", DEFRA_NATURE)
g.bind("core", CORE)
g.bind("geo", GEO)
g.bind("skos", SKOS)
# Bake in the designation-type codelist (reference data curated in raw_datasets) so the graph is
# self-contained; each site classifies to one of these concepts.
g.parse(RAW / "designation_types.ttl", format="turtle")

for fname, namecol, codecol, key, out in LAYERS:
    src = gpd.read_file(RAW / fname).to_crs(4326)
    src = src[src.intersects(clip)].copy()
    src["name"] = src[namecol]
    src["code"] = src[codecol].astype(str)
    # one feature per named site (a site may be a multipart geometry)
    site = src.dissolve(by="name", as_index=False, aggfunc={"code": "first"})[["name", "code", "geometry"]]

    # RDF: near-full fidelity, CRS84 WKT. ProtectedSite ⊆ core:Site ⊆ geo:Feature, so the site is a
    # GeoSPARQL feature by subsumption; the designation type is a classification (a codelist concept).
    concept = NATURE[f"designation/{key.upper()}"]
    for _, r in site.iterrows():
        s = NATURE[f"{key}/{r['code']}"]
        geom = URIRef(f"{s}#geometry")
        g.add((s, RDF.type, DEFRA_NATURE.ProtectedSite))
        g.add((s, CORE.hasClassification, concept))
        g.add((s, SKOS.notation, Literal(r["code"])))
        g.add((s, RDFS.label, Literal(r["name"])))
        g.add((s, GEO.hasGeometry, geom))
        g.add((geom, RDF.type, GEO.Geometry))
        wkt = f"<{CRS84}> {r['geometry'].simplify(RDF_SIMPLIFY).wkt}"
        g.add((geom, GEO.asWKT, Literal(wkt, datatype=GEO.wktLiteral)))

    # Display GeoJSON: coarse, unchanged path the frontend still uses.
    disp = site.copy()
    disp["geometry"] = disp.geometry.simplify(DISPLAY_SIMPLIFY)
    (APP / out).unlink(missing_ok=True)
    disp[["name", "geometry"]].to_file(APP / out, driver="GeoJSON")
    print(f"{key}: {len(site)} sites -> RDF + {out} ({(APP / out).stat().st_size // 1024} KB display)")

out_ttl = ROOT / "ttl" / "designations.ttl"
g.serialize(destination=out_ttl, format="turtle")
print(f"ttl/designations.ttl: {len(g)} triples")
