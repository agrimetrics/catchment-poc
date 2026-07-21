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

Shipped in `app/app.js` (`loadWaterbodies`, `buildWaterbodySelect`, the tab core `renderTabs` /
`tabList` / `renderActiveTabBody`, `waterbodyPanel`, `renderSfiCatchmentChart`, `wbCrosstab`,
`wbHighlight`) and `app/style.css`. **Waterbody Catchments** is a **dropdown** in the **Water**
super-box at the top (beside the regulated/measured worlds, styled like Substance / Option type),
*moved out of* the Designations legend — a sub-catchment is what you choose a world to view, not a
conservation overlay. "All sub-catchments" draws every outline, a named one draws and focuses it,
"None" clears them.

The side panel is a **browser-style tabbed** component — up to four tabs (one per category) that
persist across all three views and stay switchable: **Chart: SFI Application** (cost pie / count /
removals), **Chart: Substance @ Point** (the time-series), **Catchment: Challenges** (designation +
classification history, pivoted to one row per year × headline item with coloured pills, + the
challenges listed individually), and **Catchment: SFI Summary** (the sub-catchment's SFI as cost pie /
count table / modelled removals). Selecting a catchment opens the last two together; the SFI breakdown
is a tab in every view now, not a section folded into the challenges panel. The measured view carries
the whole-catchment challenges cross-table, scoped to
the selected water body when there is one, and clicking a cell highlights the water bodies behind it.

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
- **The panel hid the legend** (copied from the time-series chart, which collapses it). When the
  Waterbodies control still lived in the legend, that hid the control itself, so you had to close a
  panel to pick the next body. The panel still leaves the legend up (for the base-map, designation and
  SFI-group keys), and the picker has since become a dropdown in the Water box that is always visible.

- **Query shape, not data volume, was the performance problem.** `Q.wbRnags` with its three OPTIONALs
  written *above* the required `classificationValue` join took **30 seconds** over 51k triples and
  stalled the layer behind it. Moving the OPTIONALs below the required patterns takes it to ~0.01s.
- **`#chart` needed `min-width: 0`.** A flex item's default `min-width: auto` is min-content, which
  beats `flex-basis`, so the wide classification table grew the panel past its 44% and squeezed the
  map to a sliver.

Still worth doing here: the panel shows four headline classification items of 74, chosen by hand.

## 4. The graph URI 404s, but the page exists — link to the page (**DONE in the UI**)

`catchment.ttl` keeps real EA URIs
(`http://environment.data.gov.uk/catchment-planning/so/WaterBody/GB108044010130`) because re-minting
would orphan the 29 SKOS schemes it reuses. Pasted verbatim that `/so/` URI **404s**.

But the water body is not un-findable, and an earlier version of this note wrongly said so. The
Catchment Data Explorer serves a **human-readable page** for it — the same URI with the `/so/` dropped
and forced to https:
`https://environment.data.gov.uk/catchment-planning/WaterBody/GB108044010130` → **200**, "Devils Brook".
It is a web page, not RDF (the site still publishes none).

The water body panel now derives that URL (`cdePageUrl` in `app/app.js`) and links to it, with a
tooltip noting it is a page rather than linked data and that the graph's own `/so/` URI 404s.

**Upstream:** the mismatch — the identifier the graph uses (`/so/…`) is not the one the page lives at —
is for Defra to reconcile. Recorded here so the derived-URL workaround is understood as a workaround.
