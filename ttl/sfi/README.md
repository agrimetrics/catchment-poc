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
- **Concept scheme from the data-notes PDF.** The option-code vocabulary is scraped from
  `Sustainable Farming Incentive_Data_Notes_v1_0.pdf` (pdfplumber) into a SKOS scheme, with a
  `broader` concept per option-code letter-group.

Result: ~1,115 options across the catchment.

## Notes

- SFI options are **not linked to a substance** — they are a whole-catchment annotation layer and
  do not respond to substance filtering in the app.
- Regenerable intermediates (`sfi.duckdb`, `sfi_raw.ttl`) are gitignored; the whole database is a
  drop/replace rebuild from the raw datasets, so just re-run the script.
