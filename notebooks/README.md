# Appendix C evidence notebooks

One notebook per dataset, each evidencing the data-quality observations recorded in **Appendix C** of
the demonstrator report. Every claim in the appendix has a section here that loads the source and prints
the actual records behind it — so a reader never has to reconcile a statement to the data by hand.

| notebook                                                               | appendix section | dataset                                                         |
| ---------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------- |
| [01_consented_discharges_pro.ipynb](01_consented_discharges_pro.ipynb) | C.1              | Consented Discharges to Controlled Waters with Conditions (PRO) |
| [02_water_quality_archive.ipynb](02_water_quality_archive.ipynb)       | C.2              | EA Water Quality Archive (observations and compliance samples)  |
| [03_winep.ipynb](03_winep.ipynb)                                       | C.3              | PR24 WINEP National Dataset                                     |
| [04_catchment_data_explorer.ipynb](04_catchment_data_explorer.ipynb)   | C.4              | Catchment Data Explorer                                         |
| [05_designations.ipynb](05_designations.ipynb)                         | C.5              | SSSI / SAC / SPA designation layers                             |
| [06_sfi.ipynb](06_sfi.ipynb)                                           | C.6              | Sustainable Farming Incentive                                   |

## Running them

```
poetry install
poetry run jupyter lab notebooks/
```

Each notebook finds the repository root itself, so it runs from any working directory. They read only
committed inputs — `raw_datasets/`, `ttl/*.ttl` and the committed fetch caches — and write nothing.

Two notebooks make live HTTP requests, both to public endpoints, and both degrade gracefully when
offline (they print the recorded result instead):

- **02** dereferences one sampling point at `environment.data.gov.uk/water-quality`, to show that the
  archive returns type and status as blank nodes, and fetches the unusual-weather waiver on one sample.
- **04** probes the Catchment Data Explorer's content negotiation and downloads `rnags.csv`, to show
  what the published CSV omits.

Notebooks are committed **with their outputs**, so the evidence is readable without running anything.

## The one pre-computed input

`sweep_waivers.py` sweeps all 161 sampling points for unusual-weather waiver observations (determinands
4838 and 4448) and writes `data/weather_waivers.csv`, which notebook 02 reads. It is 322 requests and
takes several minutes, so it is committed output rather than an inline cell:

```
python notebooks/sweep_waivers.py
```

It reports failed requests in its output rather than returning an empty frame, which matters: the
archive caps `limit` at 250 and answers **422** above it rather than clamping, so an over-large page
size makes every request fail while looking exactly like "no waivers exist".

## A note on the figures

Every figure quoted in Appendix C is recomputed here from the source at run time, so these notebooks are
the authority for it. The per-dataset `ttl/*/README.md` files quote figures from the build that produced
them and are not recomputed; where the two disagree, take the notebook.
