# Catchment TODO

The extraction is **done**. `../catchment.ttl` holds 51,525 triples, is loaded by the app, and
`verify_catchment.py` passes all eleven assertions including the published cross-table. See
[README.md](README.md) for what it contains and how it was built.

What follows is what remains.

---

## 1. Open questions for Defra

None of these block the UI. All of them are things we are currently guessing at, and the guesses are
recorded in [ISSUES.md](ISSUES.md) so they can be corrected rather than inherited.

**Which repository is authoritative?** The extract was taken from one of the source's
repositories/datasets on instruction ("good enough for now"). It agrees with the others we checked on
every validated count — 19 waterbodies, 5,852 classifications, 95 RNAGs — so the choice is currently
immaterial. If some of these are deployment slots, one will eventually go stale, and a graph pinned to
the wrong one drifts silently. Select the repository at extraction time via `CDE_REPOSITORY`.

**How does the CDE application scope a catchment?** It excludes Stannon Lake and it excludes two RNAGs
that exist in the graph. We reproduce the first by hard-coded exclusion and deliberately diverge on the
second. Whatever rule the application uses *is* the scoping rule; ours approximates it.

**Do classifications attach to versions or to base waterbodies?** Established for
`hydromorphologicalDesignation` (versioned). Classifications reference the base waterbody URI, which is
why the extract works — but this was observed, not confirmed as intended.

**What are the units on `characteristic_147` vs `characteristic_197`?** Both labelled "Catchment area",
values differing ~100× ([ISSUES.md §9](ISSUES.md)). Not extracted, and should not be surfaced until
answered.

## 2. Defects to report upstream

Independent of this project, and worth doing regardless:

1. **Stannon Lake** (`GB30846165`) asserts membership of both Camel (3065) and Poole Harbour Rivers
   (3367) — ~200 km apart, and the only waterbody of 14,864 nationally in two operational catchments.
2. **The CSV export drops two well-formed RNAGs** (`578245`, `578282`) that exist in the source graph.
3. **`classifcationValueScheme`** — a misspelled scheme (13 concepts) coexisting with the correctly
   spelled one (20 concepts).
4. **`wfd:heavilyModified`** — a property with zero data uses whose name and label actively mislead;
   it caused a wrong conclusion during this work.
5. **372 classifications carry two `classificationValue`s** ([ISSUES.md §13](ISSUES.md)) — always
   `supports-good` *and* `not-high`, always on Hydromorphological Supporting Elements or Morphology.
   Two axes of one judgement sharing one property; a naive join over-counts by 12%.

## 3. The UI — cross-table with click-to-highlight — **BUILT**

Shipped in `app/app.js` (`loadWaterbodies`, `waterbodyPanel`, `wbCrosstab`, `wbHighlight`) and
`app/style.css`. **Waterbodies** is a fourth category in the map's **Designations** control (with
SSSI / SAC / SPA — one heading, not a control-within-a-control), toggling the 19 catchment polygons.
Clicking a polygon opens a side panel: its designation and how that designation moved across versions;
its classification history, pivoted to one row per year × one column per headline item with coloured
status pills; and its challenges listed individually, each naming what actually failed and flagging the
ones with no national heading. The measured view carries the whole-catchment challenges cross-table,
scoped to the selected water body when there is one, and clicking a cell highlights the water bodies
behind it.

Each constraint below was a way the UI could have been silently wrong. All are handled — the note
says where, so a later change can tell it is breaking something deliberate.

- **57 of 95 RNAGs cannot appear in the cross-table.** They have no `nationalSWMIheader`, no
  `category`, or neither — including every "measures delivered, awaiting recovery" record. A table
  built from the populated cells alone asserts that 60% of this catchment's challenges do not exist.
  → `Q.wbRnags` uses OPTIONALs, and `wbCrosstab` renders an explicit `(not attributed)` row and
  column. The catchment total is **63**, against the published table's 29.
- **Nitrogen has no data here.** The Challenges→nutrients link is phosphorus-only. The app's paired
  N-and-P story must say so rather than render an empty nitrogen panel. → *still outstanding*; the
  cross-table does not claim otherwise, but no panel says it yet.
- **The designation is not constant.** Sydling Water, Frome Dorset (Upper) and Piddle (Lower) were
  heavily modified at v1 and are not designated at v2/v3. → `Q.wbVersions` reads every version and the
  panel prints the transition in full whenever the set of values has more than one member.
- **Never join on waterbody labels.** They live on versions and vary in case — `"FROME Dorset (Upper)"`
  at v1/v2, `"Frome Dorset (Upper)"` at v3. Key on `skos:notation`. → every map key, DOM `data-` value
  and selection variable in the water body code is a notation.

Four traps found while building it, all recorded where they bite:

- **A drawn, clickable layer can still be invisible.** The first attempt drew the polygons in teal at
  0.14 opacity over an already-blue catchment outline; ticking the control changed nothing a user could
  see, so there was nothing to click. Fixed with opacity/stroke that read as a layer, a pointer cursor,
  hover feedback, and a zoom-to on single-body tick.
- **The catchment outline was eating the clicks.** It sits in `overlayPane` (z 400), above the water
  bodies pane (260); while it was `interactive`, every click aimed at a water body hit the outline
  instead — and it covers all of them. Made it `interactive:false`.
- **Hover `bringToFront()` re-stacked polygons mid-gesture**, so a click opened a neighbour of the shape
  under the cursor. Only the selected polygon is raised now; the rest are stacked once, largest-behind,
  by `restackWb` so nested catchments stay clickable.
- **The panel hid the legend** (copied from the time-series chart, which collapses it). That hid the
  Waterbodies control itself, so you had to close a panel to pick the next body. The water body panel
  leaves the legend up.

- **Query shape, not data volume, was the performance problem.** `Q.wbRnags` with its three OPTIONALs
  written *above* the required `classificationValue` join took **30 seconds** over 51k triples and
  stalled the layer behind it. Moving the OPTIONALs below the required patterns takes it to ~0.01s.
- **`#chart` needed `min-width: 0`.** A flex item's default `min-width: auto` is min-content, which
  beats `flex-basis`, so the wide classification table grew the panel past its 44% and squeezed the
  map to a sliver.

Still worth doing here: the panel shows four headline classification items of 74, chosen by hand.

## 4. The URIs do not dereference — say so in the UI

`catchment.ttl` keeps real EA URIs
(`http://environment.data.gov.uk/catchment-planning/so/WaterBody/GB108044010130`) because re-minting
would orphan the 29 SKOS schemes it reuses. They look authoritative and resolvable. **They 404** — the
public site serves no RDF.

Wherever the app shows one to a user, or lets them click it, that has to be visible. A URI that looks
like a link and silently fails is the same class of defect as everything in ISSUES.md: something absent,
presented as something present.
