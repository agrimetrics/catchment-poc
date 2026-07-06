# WINEP TODO — upgrading `limitStatement` proposed limits to structured bounds

## The problem

WINEP proposed-limit cells are human-authored free text. The pipeline classifies every
cell deterministically (see the header of `winep_to_db.py`), but ~82 of the 267 proposed
limits can't be turned into a structured `qudt:QuantityValue` bound by the automatic
parser, so they are emitted verbatim as `reg:limitStatement` on a `reg:ProposedLimit`.

**Nothing is lost** — those limits are fully in the graph, linked to their action and
applicability. But they're prose, so a machine can't compare an observation against them.
Two distinct reasons a cell lands in `limitStatement`:

| Category | Count | Why it's prose | Can it ever be structured? |
|---|---|---|---|
| Fe/Al tiered (`Fe 4mg/l 95%ile 8mg/l Max.`) | 35 | two substances × two tiers in one cell | **Yes** — parse into 2 bounds w/ statistics |
| Chemical clean number (`13.5`, `0.00044`) | ~18 | value is fine; the *column* doesn't name the analyte | **Yes** — once the substance is resolved (from the driver code) |
| `value UT upper` (`8 UT 30`) | 13 | base + upper-tier in one cell | **Yes** — parse into 2 bounds |
| Chemical `value (upper tier ug/l)` | 12 | value + tier annotation, analyte unnamed | **Yes** — parse + resolve substance |
| `TBC` | 4 | genuinely not yet decided | No — stays a statement until confirmed |

The first four are *interpretable in principle*; they're only prose because the automatic
parser is conservative. The real blocker is that this parsing **is not deterministic** —
it depends on human judgement (which analyte? is "Max" a 100%ile or an absolute cap?), so
it can't live inside a reproducible pipeline.

## Why we can't just parse harder in the pipeline

A pipeline must be reproducible: same inputs → same RDF, every run. Free-text
interpretation isn't — two people (or two regex revisions) will disagree on the edge
cases. Baking guesses into the shredder makes the output silently depend on whose guess
won.

## The fix (deferred): a curated overrides join

Keep the non-deterministic step **out** of the pipeline and pin its result as reviewed data:

1. The shredder writes every un-structured cell to `winep_unparsed.csv`
   (`action_id, column, raw_text`).
2. A human (optionally LLM-*assisted*, but human-*signed*) fills `winep_overrides.csv`:
   `action_id, column → substance, value, unit, statistic, tier`. **This file is committed.**
3. `winep_to_db.py` LEFT JOINs raw → overrides. A matched row is promoted from
   `uninterpreted` to `structured`; unmatched rows stay as `limitStatement`.

From the committed override file onward the pipeline is 100% deterministic. The
interpretation happened once, was reviewed, and became version-controlled data. Provenance
is preserved because the original `limitStatement` text remains the source of truth for
each override.

Find the ones still needing curation with:
```sparql
SELECT ?l ?stmt WHERE {
  ?l a reg:ProposedLimit ; reg:limitStatement ?stmt .
  FILTER NOT EXISTS { ?l reg:upperBound|reg:lowerBound ?b }
}
```

## Why `limitStatement` has to exist permanently

Not everything is upgradeable, which is the whole reason the escape hatch is in the vocab.
Some source text encodes a "limit" that no parser could ever turn into a bound —
`reg:limitStatement` captures it faithfully instead of dropping or mis-structuring it:

```turtle
wr:action/08WW102104/limit/0067 a reg:ProposedLimit ;
    reg:regulatedProperty wr:substance/0067 ;                 # 0067 = "Transparency" (fittingly)
    reg:limitStatement "Dry flow limits during England away match days exceed the starting forward's number in hectolitres per hour" ;
    core:hasApplicability wr:action/08WW102104#applicability .
```

There is no `(value, unit, statistic)` hiding in that sentence. It is a valid, in-graph,
applicability-bearing proposed limit that will *never* be structured — and that's exactly
what `limitStatement` is for. The curation backlog above shrinks over time; cells like this
one are why the property is a permanent part of the model, not a temporary staging area.
