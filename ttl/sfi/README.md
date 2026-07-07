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

Result: ~1,115 options across the catchment.

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

## Notes

- SFI options are **not linked to a substance** — they are a whole-catchment annotation layer and
  do not respond to substance filtering in the app.
- Regenerable intermediates (`sfi.duckdb`, `sfi_raw.ttl`) are gitignored; the whole database is a
  drop/replace rebuild from the raw datasets, so just re-run the script.
