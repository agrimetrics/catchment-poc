# Catchment dataset — scope and status

Water body classifications and challenges (RNAGs) for the **Poole Harbour Rivers** operational
catchment (`3367`), sourced from the Environment Agency's Catchment Data Explorer.

**Status: extracted and delivered.** `../catchment.ttl` holds **51,525 triples** and is loaded by the
app (`app/server.py`, `GRAPHS`). The extraction is a **one-shot** — it has been run, its output is
committed, and it does not need running again unless the source changes.

```
python ttl/catchment/verify_catchment.py       # assert the delivered graph (run this first, offline)

# Re-checking or re-extraction. Only if the source changes, and only from a machine that can
# reach the internal source. Endpoint and credentials come from the environment:
#   CDE_SPARQL_ENDPOINT, CDE_SPARQL_USER, CDE_SPARQL_PASSWORD, CDE_REPOSITORY
python ttl/catchment/validate_csv_claims.py    # re-check findings against the source
python ttl/catchment/catchment_construct.py
rdfpipe -i turtle -o turtle ttl/catchment/catchment_raw.ttl > ttl/catchment.ttl
```

| File | What it is |
| --- | --- |
| [PLAN.md](PLAN.md) | Source analysis, ontology map, validation results |
| [ISSUES.md](ISSUES.md) | Defects in the source data and model — **read before writing queries** |
| [TODO.md](TODO.md) | What remains (UI, and reporting defects upstream) |
| `catchment_construct.py` | The one-shot extraction. Five CONSTRUCTs → `catchment_raw.ttl` |
| `verify_catchment.py` | Asserts the delivered graph offline, in pyoxigraph |
| `sparql_client.py` | Authenticated SPARQL client; endpoint and credentials from the environment |
| `validate_csv_claims.py` | Diffs the CSV-derived findings against the source |
| `catchment_raw.ttl` | Committed CONSTRUCT output — the source is not public, so the build must run offline |

## What was extracted

Source URIs kept verbatim; all 10 classification years; all 95 RNAGs including the 2 the published CSV
omits; Stannon Lake excluded.

| Component | Triples | Contents |
| --- | --- | --- |
| Waterbodies | 449 | 19 bodies, versions, designations, 38 WKT geometries |
| Catchment context | 9 | OC 3367 → management catchment → river basin district |
| Classifications | 48,631 | 5,852 records, 74 items, 2009–2022, 3 cycles |
| RNAGs | 1,606 | 95 cycle-3 challenges with full certainty triples |
| Concepts | 830 | 158 referenced SKOS concepts with labels and scheme membership |

Geometry is in the source graph, so **no GeoJSON merge was needed**: each waterbody carries a
`Catchment` POLYGON and a `RiverLine` MULTILINESTRING as `geo:asWKT`, ready for the map layer.

`verify_catchment.py` asserts all of the above plus the published cross-table (8 cells, total 29)
against the local file. All pass.

## What the app does with it

**Waterbody Catchments** is a **dropdown** in the **Water** super-box at the top of the page (beside
"the regulated world" and "the measured world", styled exactly like the Substance and Option-type
filters) — a sub-catchment is the unit you pick a world to look *at*, so it lives with the worlds, not
down in the Designations legend with SSSI / SAC / SPA. Picking a named catchment draws and focuses it;
"All sub-catchments" draws every outline; "None" clears them.

The side panel is a **tabbed** component that works like a browser's tabs — up to four, one per
category, that **persist across all three views** and stay switchable:

| Tab | Opened by | Contents |
| --- | --- | --- |
| **Chart: SFI Application** | selecting an agreement (farming) | cost pie / count bars / modelled removals |
| **Chart: Substance @ Point** | clicking a determinand at a sampling point | the observation time-series |
| **Catchment: Challenges** | selecting a waterbody catchment | designation history, classification history (one row per year × headline item, coloured pills), and the challenges listed individually |
| **Catchment: SFI Summary** | selecting a waterbody catchment | that sub-catchment's SFI as cost pie / count table (parcels · exact per-action extent · apportioned payment) / modelled removals |

A catchment selection opens the last two together (Challenges active by default); each tab closes with
its own ✕, and closing either catchment tab clears the selection (both go). The measured view also
carries a whole-catchment challenges cross-table below the map, scoped to the selected water body when
there is one; clicking a cell highlights the water bodies behind it. Code: `loadWaterbodies`,
`buildWaterbodySelect`, the tab core (`renderTabs` / `tabList` / `renderActiveTabBody`),
`waterbodyPanel`, `renderSfiCatchmentChart`, `wbCrosstab`, `wbHighlight` in `app/app.js`.

Two numbers there are worth knowing before reading the table. The published Catchment Data Explorer
cross-table totals **29**; this one totals **63**, because 57 of the 95 challenges carry no national
challenge heading and the published table simply omits them. They appear here in an explicit
*(not attributed)* row rather than being dropped. And all 95 belong to **cycle 3** — cycles 1 and 2
published no RNAGs for this catchment, so challenges cannot be compared across cycles at all. The
classification history can, and does.

## Where the data comes from

**Not from the public website.** The Catchment Data Explorer looks like a linked-data application and
serves no RDF: `.ttl`, `.rdf`, `.json` and every RDF `Accept` header all return `text/html` with HTTP
**200** — not 406, not 404 — so a content-negotiation probe that trusts the status code reports success
and hands back a web page. `/sparql` 404s, and the `so/` URIs the graph stores 404 too when pasted
verbatim. The published surface is CSV, GeoJSON and shapefile.

It is a working web app, though — each water body **does** have a human-readable page, at its `/so/`-less
https URL (`https://environment.data.gov.uk/catchment-planning/WaterBody/{id}`); the app links to it (see
`cdePageUrl`, and TODO.md §4). "No RDF" is the accurate claim; "the URIs don't resolve to anything" was
not, and is corrected there. This was probed via content negotiation; see PLAN.md §1.

The real source is an internal SPARQL endpoint, not publicly reachable. `sparql_client.py` reads its
location and credentials from the environment (`CDE_SPARQL_ENDPOINT`, `CDE_SPARQL_USER`,
`CDE_SPARQL_PASSWORD`, `CDE_REPOSITORY`) — nothing about the deployment is committed. The credential is
never written to disk, never placed in `argv`, never echoed, and stripped from exception messages
(`requests` will otherwise put the `Authorization` header into an exception repr).

The national dataset is large: ~2M `qb:Observation`, 14,864 waterbodies, 37,509 RNAGs. Both
classifications and RNAGs are **RDF Data Cube**, already reified with dimensions modelled — so the
modelling work this repository would normally do upstream has largely been done for us.

## What was established

**The `so/` URIs resolve internally.** `cp:so/WaterBody/{id}` and `cp:so/OperationalCatchment/3367` are
the real subject URIs. Nothing needs minting — which is a departure from the rest of this repository,
where entities carry `example.com` URIs. See TODO.md for why that matters.

**29 SKOS concept schemes already exist.** Including `aOrHMConceptScheme` (natural / artificial /
heavily modified), `swmiScheme`, `businessCategorySectorScheme`, `activityScheme`, `pressureScheme`,
`wbClassificationItemScheme`. **Do not author any vocabulary for this dataset.** An earlier version of
the plan proposed building these by hand; that work is unnecessary.

**The published cross-table's counting rule was recovered and then confirmed.** The Challenges table at
`…/3367/rnags` is not a row count. It is distinct `(waterbody, classificationStatus, pressureTier3)`,
filtered to statuses below good, grouped by business sector × `nationalSWMIheader`. Reverse-engineered
from HTML first, then verified against RDF: all 8 populated cells and the total of 29, exact.

**Every CSV-derived claim was re-validated against the graph** (PLAN.md §6). Classification records
(5,852), distinct items (74), the 10-year span and 3 cycles all match exactly. Nitrate really is absent
from this catchment — the Challenges → nutrients link is **phosphorus only**, which matters because the
app runs a paired nitrogen-and-phosphorus story and the missing half must be stated rather than rendered
as an empty panel.

## What the CSVs got wrong

The published CSVs are accurate but **not a faithful export**. Two complete cycle-3 RNAGs exist in the
source graph and are absent from `rnags.csv` (95 vs 93). More importantly, the CSV reports only the
*current* version of a waterbody, which concealed the most interesting fact in the dataset:

> The natural / artificial / heavily-modified designation is **not constant here**. It attaches to the
> *versioned* waterbody, and three rivers — Sydling Water, Frome Dorset (Upper) and Piddle (Lower) —
> were **heavily modified at v1** and became "not designated artificial or heavily modified" at v2.

From CSV alone this scheme looked degenerate: one value across 19 waterbodies, useless for the
demonstrator. It is degenerate *in the latest cycle only*. Over time it moves, and the graph can say
when. That is the difference between "nothing to show" and three stretches of river being reclassified
as substantially natural in character.

This is also why versioning is load-bearing rather than a detail: read the designation off the base
waterbody URI and you get **nothing**; read it without pinning a version and rows triple.

## Scope

Deliberately one catchment, consistent with the rest of this repository. `3367` covers 19 waterbodies —
all rivers, ~2019 cycle 3 for the current picture, with classification history back to 2009.

A twentieth waterbody, **Stannon Lake**, is returned by the obvious catchment query and does not belong
here. It is a source data defect, not a scope decision — see [ISSUES.md](ISSUES.md#1). Every
catchment-scoped query in this folder must exclude it until Defra confirm which membership is wrong.

## A note on method

Four separate queries in this investigation returned confident, wrong answers before being caught, and
one wrong conclusion was written into the plan and had to be retracted (the designation was declared
absent from the source graph; it is fully modelled, with 9,933 links nationally). The causes were narrow
queries, not bad data: filtering on `skos:inScheme` when the WFD vocabularies use only `skos:topConceptOf`;
assuming concepts are typed `skos:Concept`; and comparing language-tagged literals against plain strings,
which returns zero rows that look exactly like "no data".

The lesson worth carrying: **a plausible near-miss that returns zero is not evidence of absence.** The
dead `wfd:heavilyModified` property returned zero and made the false conclusion feel confirmed. Query
idioms that avoid each of these are recorded in PLAN.md §6 and should be used rather than rediscovered.
