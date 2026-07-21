# SFI dataset — scope

The Sustainable Farming Incentive (SFI) options for the **Poole Harbour Rivers** catchment — an
annotation layer showing where at-source, diffuse-pollution farming measures are in place. Built
by `sfi_to_db.py` (spatial clip + aggregate into `sfi.duckdb`) → ontop (`sfi.obda`) → `../sfi.ttl`.

```
python ttl/sfi/sfi_to_db.py
./ontop/ontop materialize --mapping ttl/sfi/sfi.obda --properties ontop/duckdb.properties \
    --output ttl/sfi/sfi_raw.ttl --format turtle \
  && rdfpipe -i turtle -o turtle ttl/sfi/sfi_raw.ttl > ttl/sfi.ttl
```

`sfi.ttl` also carries **one node per drawn parcel** (`option_parcel` table in `sfi_to_db.py`,
`SFIParcels` mapping in `sfi.obda`), each with its own area (ha) or length (m). This is what lets an
extent question scoped to a sub-catchment be exact rather than apportioned from the per-option summed
total (which errs by ~25% on a single water body). The parcels come out of the same `ontop
materialize` as everything else — no separate step.

## How the scope was whittled down (for convenience)

- **Clipped to the catchment.** The source SFI geojson is a national, drawn-polygon dataset. The
  shredder loads the Poole Harbour operational-catchment boundary, dissolves it, and keeps only
  options whose geometry is `ST_Within` it (DuckDB `spatial`). Everything outside Poole Harbour is
  dropped.
- **Aggregated to one row per option.** The raw file has **one row per drawn point**, so a single
  option (`app_id` + `option_code`) spans many rows. The pipeline collapses these to **one row per
  option**: the points are collected into a single `MULTIPOINT` geometry and the measured
  quantities (`area` / `mtl` / `units`) are **summed**. This keeps the graph to ~one node per real
  option instead of thousands of point rows.
- **Geometry pre-serialised to WKT text** and quantities cast to concrete `DECIMAL`/`BIGINT` so
  ontop renders plain numbers (no scientific notation) and needs no spatial extension on its JDBC
  connection.
- **Concept scheme from the option-details workbook (+ PDF fallback).** The option-code vocabulary
  is a SKOS scheme with a `broader` concept per option-code letter-group. The richer, canonical
  source is `raw_datasets/SFI Option details.xlsx` (the expanded, C-prefixed SFI offer): each
  concept carries `skos:definition`, a `defra-farming:duration`, a `defra-farming:paymentRate`, and
  an `rdfs:comment` rolling up the human-authored guidance (aim / purpose / where / what / when /
  evidence / advice) verbatim — we deliberately do **not** split those into related concept schemes.
  For the older SFI 2023 / pilot codes that appear in the catchment data but are absent from the
  workbook, `Sustainable Farming Incentive_Data_Notes_v1_0.pdf` (pdfplumber) still supplies a bare
  `skos:definition` + `broader`. The workbook wins on any code present in both.

- **Payment modelled with QUDT; option cost computed.** Each concept's rate is a
  `defra-farming:PaymentRate` — `qudt:numericValue` (the £ amount) with `qudt:unit` a QUDT currency
  (GBP) and `defra-farming:perQuantity` the extent it's paid per (e.g. 100 `unit:M`, or 1 `unit:HA`).
  Each in-catchment option is then valued with `defra-farming:annualPayment` (a `qudt:QuantityValue`
  in GBP): `extent × amount ÷ per-amount`, taking the option's summed length (metres) for a
  per-100-metres rate and summed area (hectares) for a per-hectare rate. e.g. option `1805262/CHRW3`
  at 12,900 m against £10 per 100 m → **£1,290**.

- **Pollutant impact modelled with QUDT; option and application impact computed.** The Farmscoper
  sheet of `raw_datasets/Scheme details.xlsx` holds one row per **FARMSCOPER treatment** (an ADAS-
  modelled mitigation measure) with its modelled annual change in pollutant loss **per hectare**, and
  a concatenated `Scheme Actions` list naming the scheme actions that enact it, each tagged with its
  scheme — e.g. `OFDB-0087,OFDB-0088,AB3 (CS),AHW3 (SFI)`. We take only the `(SFI)`-tagged tokens and
  hang the treatment's figures on the matching SFI concept. **41 of the 62 SFI codes named by the
  sheet carry values** (the rest are modelled with no quantified effect); all 62 already exist in the
  scheme. Values are **negative = a reduction** in pollutant loss.

  Each concept gets a `defra-farming:pollutantImpactRate` per pollutant — a
  `defra-farming:PollutantImpactRate` with `qudt:numericValue` and `qudt:unit unit:KiloGM-PER-HA-YR`,
  a `defra-farming:substance`, and a `defra-farming:impactNote` naming the FARMSCOPER treatment it
  came from. Each in-catchment option and each application then gets a
  `defra-farming:annualPollutantImpact` (a `qudt:QuantityValue` in `unit:KiloGM-PER-YR`):
  **option = summed area (ha) × the rate**, **application = sum of its options**. e.g. option
  `1929500/CSAM2` ("Establish cover crops in the autumn") over 213.39 ha at −24.4915 kg N/ha/yr →
  **−5,226 kg N/yr**.

- **The pollutants are the store's own substances.** The columns bind to the *same* `skos:Concept`s
  the water-quality side of the store monitors, so an option's modelled impact and a sampling point's
  observations are joinable rather than merely adjacent:

  | Farmscoper column | Substance concept | prefLabel |
  |---|---|---|
  | `Kg Nitrate Ha-1 Yr-1` | `water-regulation:substance/9686` | Nitrogen, Total as N |
  | `Kg P Ha-1 Yr-1` | `water-regulation:substance/0348` | Phosphorus, Total as P |
  | `Kg Z Ha-1 Yr-1` | — | **not shredded — see `TODO.md`** |

  The sheet's third column is **deliberately absent from the graph**. Read literally it is zinc, but
  its magnitudes are physically impossible for zinc and it tracks the phosphorus column at a
  near-constant ~870:1 — the sediment-to-particulate-P ratio. It is most likely FARMSCOPER's
  **sediment** output under a wrong header, but that is unconfirmed, so the store says nothing about
  it rather than asserting a substance it cannot stand behind.

Result: ~1,115 options across the catchment; 41 concepts carry impact rates, 272 options and 160
applications carry a computed impact.

## Data warnings

- **Payment text is captured, not interpreted.** A rate's `defra-farming:paymentNote` holds the
  source *More_pay_info* verbatim (e.g. "for both sides of an eligible hedgerow per year", or extra
  per-agreement top-ups like "and £97 per SFI agreement per year"). The computed
  `defra-farming:annualPayment` applies **only the base rate × extent** — it does not act on any of
  that qualifying text. So the figure is indicative, not a payable amount: it ignores per-side
  hedgerow doubling, minimum/whole-agreement supplements, and any per-year framing.
- **Only per-hectare and per-100-metres rates are costed.** Other pay units in the source
  (per square metre, per plot, per tonne, per-assessment, and the multi-clause hectarage-recipe
  variants) keep their verbatim `PaymentRate` but get **no** `perQuantity` and therefore **no**
  computed `annualPayment`. Their duration cells can also be free text (e.g. the organic-conversion
  "1 year … maximum of 2 consecutive years"), kept verbatim.
- **Concept scheme covers the expanded offer.** Payment/comment/duration enrichment only exists for
  the workbook's C-prefixed codes; older SFI 2023 / pilot codes in the catchment get definition +
  `broader` only (from the PDF).

- **⚠️ What `Kg … Ha-1 Yr-1` means is NOT yet validated — see `TODO.md`.** We read the headers
  literally ("kilograms per hectare per year") and the graph acts on that reading: the applied impact
  is the option's **summed area × the rate**. If the denominator is not the treated area — e.g. if
  FARMSCOPER quotes per hectare of the *whole modelled farm* — then the concept rates still stand
  (they are verbatim) but every computed `annualPollutantImpact` is wrong. Treat those figures as
  indicative of scale and ranking, not as reportable kg. Also unvalidated: whether the figure is loss
  at the field edge or load delivered to water — only the latter is comparable to what a sampling
  point observes.

- **Nitrogen, not nitrate.** The source column is headed `Kg Nitrate Ha-1 Yr-1`, but the store's
  substance vocabulary has **no nitrate concept** — the monitored nitrogen determinand is 9686
  "Nitrogen, Total as N", so that is what the figure binds to. FARMSCOPER reports nitrate loss as
  kg of N, so the units are consistent, but the bound concept is *total* nitrogen and the source
  figure is a *nitrate* loss: they are not the same measurand.

- **Impacts are modelled, not measured, and are per-hectare.** The figures are FARMSCOPER model
  output for a treatment applied to a hectare, multiplied by the option's mapped extent. They carry
  none of the model's own context (soil type, rainfall, farm system), and options measured in metres
  or units (e.g. hedgerow actions) have no hectarage to multiply, so they get **no** applied impact —
  the rate stays on the concept only. An SFI code is expected to be named by exactly one FARMSCOPER
  treatment; the shredder raises if that ever stops being true rather than silently picking a row.

## Notes

- SFI options are **not linked to a substance** — they are a whole-catchment annotation layer and
  do not respond to substance filtering in the app.
- Regenerable intermediates (`sfi.duckdb`, `sfi_raw.ttl`) are gitignored; the whole database is a
  drop/replace rebuild from the raw datasets, so just re-run the script.
