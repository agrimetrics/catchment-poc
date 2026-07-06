# WINEP TODO — remaining proposed-limit curation

## What the parser now does

`winep_to_db.py` interprets each proposed-limit cell using the **column header**
(which fixes substance / unit / statistic) **and the cell contents** (values, inline
analytes, tiers). Of 268 proposed limits:

- **196 structured** — a `ProposedLimit` with one or more `qudt:QuantityValue` bounds,
  each with its `iop:hasStatisticalModifier`. Tiers are modelled as multiple bounds, e.g.
  `Fe 4mg/l 95%ile 8mg/l Max.` → Iron with a 95th-percentile bound (4 mg/l) and a maximum
  bound (8 mg/l).
- **67 carried-over** — `CarriedOverLimit` + `continuesCondition` → the in-force condition.
- **5 uninterpreted** — kept verbatim as `reg:limitStatement` (see below).

## The 5 that remain uninterpreted

| Cell          | Why                                                 | Fix                                                       |
| ------------- | --------------------------------------------------- | --------------------------------------------------------- |
| `TBC` ×4      | genuinely undecided at source                       | none — stays a statement until the permit is confirmed    |
| `0.20kg/d` ×1 | a **mass-load** limit (kg/day), not a concentration | add a load unit + model load limits (different dimension) |

## Interpretive assumptions worth a review

The parser makes deterministic but *interpretive* choices — confirm these are right:

- **Generic chemical analyte.** The `Proposed_Chemical_*` columns name a parameter *family*,
  not a determinand, so those limits use `wr:substance/chemical`
  ("Priority chemical substance (unspecified)"). The specific analyte should be resolved
  from `Driver_Code_*` / `DrWPA_Substances_addressed_by_Action` — the biggest remaining
  enrichment (~18 limits).
- **`upper-tier` statistic.** The second value in `8 UT 30`, and `(upper tier)` annotations,
  are tagged with a bespoke `upper-tier` modifier. If "upper tier" means a specific
  percentile in permitting terms, remap it.
- **`Max` → maximum (absolute / 100%ile).** Assumed an absolute not-to-exceed.
- **Seasonality dropped.** `S=Summer/W=Winter` markers are ignored, consistent with the
  regulation pipeline (which abstracted `MONTH_FROM..MONTH_TO = 1..12`).

## Multiple proposed limits per (permit, substance) — competing drivers

A permit can be the target of several actions, and more than one may propose a limit for the
**same substance**. This is faithful to source, **not** a shredder bug: the values come from
different regulatory **drivers**, each proposing independently. The permit ends up carrying the
**most stringent**, not all of them.

Worked example — permit **401050** (Dorchester WRC), from the raw dataset:

| Action | Driver | Phosphorus | Nitrogen | Completion |
| ------ | ------ | ---------- | -------- | ---------- |
| 08WW102104 P & N Removal | `HD_IMP_NN` (Habitats Directive – nutrient neutrality) | 0.25 mg/l | 10 mg/l | 2030-03-31 |
| 08WW102201 P Permit (UWWTR) | `U_IMP2` (Urban Waste Water Treatment Regs) | 2 mg/l | — | 2030-05-13 |
| 08WW102200 N Permit (UWWTR) | `U_IMP1` (UWWTR) | — | 15 mg/l | 2030-03-31 |

The Habitats Directive values (0.25 P / 10 N) are tighter **and** complete earlier, so the UWWTR
backstop (2 P / 15 N) is already superseded — they are alternatives, not a phased sequence.

**Scope:** 12 (permit, substance) pairs have >1 proposed limit, but **7 are the generic
`wr:substance/chemical` placeholder** (several real analytes lumped as one "chemical" — the
unresolved-analyte gap above, so multiples there are expected). The genuine competing-driver
cases are only **401050 (N, P, Fe)** and **401747 (P, Fe)** — the Poole permits hit by both a
Habitats Directive and a UWWTR driver.

**Interpretation to add:** capture each proposed limit's **driver** (`Driver_Code_Primary`, not
currently shredded) so alternatives are distinguishable, and derive an **effective** proposed
limit per (permit, substance) = the most stringent (min value at a comparable statistic; cross-
statistic comparison — e.g. annual-average vs 95%ile — needs a rule). The app currently lists all
proposals, which reads as concurrent limits and is misleading. Options weighed in-app: collapse to
the effective limit, or show all with a Driver column.

## Upgrade path for edge cases

The determinism principle still holds: any future refinement that needs human judgement
(resolving a chemical analyte, deciding a load-limit's unit) goes through a **committed
`winep_overrides.csv`** that the shredder left-joins — the interpretation happens once, is
reviewed, and becomes version-controlled data, so the pipeline stays reproducible. Find the
limits still needing attention with:

```sparql
SELECT ?l ?stmt WHERE {
  ?l a reg:ProposedLimit ; reg:limitStatement ?stmt .
  FILTER NOT EXISTS { ?l reg:upperBound|reg:lowerBound ?b }
}
```

## Why `limitStatement` is still permanent

Even at 5 remaining, the escape hatch is a permanent part of the model, not a staging area —
some source text encodes a "limit" no parser could ever structure:

```turtle
wr:action/08WW102104/limit/0067 a reg:ProposedLimit ;
    reg:regulatedProperty wr:substance/0067 ;                 # 0067 = "Transparency" (fittingly)
    reg:limitStatement "Dry flow limits during England away match days exceed the number of the starting forward's number in hectolitres per hour" ;
    core:hasApplicability wr:action/08WW102104#applicability .
```

There is no `(value, unit, statistic)` hiding in that sentence. It is a valid, in-graph,
applicability-bearing limit that will *never* be structured — which is exactly what
`reg:limitStatement` is for.
