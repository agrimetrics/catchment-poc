# catchment-poc

## Introduction
Exploratory data analysis of the Poole Harbour Rivers operational catchment area.

## Data sources
- Operational Catchment GeoJSON for Poole Harbour: `raw_datasets/poole_harbour_rivers_operational_catchment.geojson`
    - Obtained from https://environment.data.gov.uk/catchment-planning/OperationalCatchment/3367
- Water Quality Observational Data for Poole Harbour Rivers between 2020-2026: `poole_harbour_rivers_water_quality_observations_2020_2026_combined.csv`
    - Obtained from https://environment.data.gov.uk/water-quality/downloads multi-year data has been concatenated together with `raw_datasets/merge_observational_data.py`
- Consented Discharges to Controlled Waters with Conditions
    - Obtained from https://www.data.gov.uk/dataset/55b8eaa8-60df-48a8-929a-060891b7a109/consented-discharges-to-controlled-waters-with-conditions1
        - Discharge and Permit Data: `raw_datasets/access_database_csv_files/consents_active.csv`
        - Permit rules: `raw_datasets/access_database_csv_files/determinands.csv`
        - Effluents: `raw_datasets/access_database_csv_files/effluents.csv`
- PR24 Water Industry National Environment Programme (WINEP Actions/Drivers): `raw_datasets/PR24 WINEP National Dataset.xlsx`
    - Obtained from https://environment.data.gov.uk/dataset/39b11ea0-3cfa-4cbb-b3a1-b5950019f169
- Sustainable Farming Initiatives GeoJSON for Poole Harbour: `raw_datasets/poole_harbour_rivers_sustainable_farming_initiatives.geojson`
    - Obtained from https://environment.data.gov.uk/explore/58cc85ab-a955-4b37-9c42-eee8532cbd01
- Sites of Special Scientific Interest England: `raw_datasets/Sites_of_Special_Scientific_Interest_England.geojson`
    - Obtained from https://environment.data.gov.uk/dataset/ba8dc201-66ef-4983-9d46-7378af21027e
- Special Protection Areas England: `raw_datasets/Special_Protection_Areas_England.geojson`
    - Obtained from https://environment.data.gov.uk/dataset/4c660eee-887e-4c8b-91e5-d84b4c1078ac
- Special Areas of Conservation England: `raw_datasets/Special_Areas_of_Conservation_England.geojson`
    - Obtained from https://environment.data.gov.uk/dataset/6ecea2a1-5d2e-4f53-ba1f-690f4046ed1c

# Using the interactive map
You can run the interactive map without running the code, to do this `cd` into the `output_data` directory and run `python -m http.server 8000` then navigate to `http://localhost:8000/map.html` to view the interactive map

# Running the code
- `poetry install --no-root`
- `eval $(poetry env activate)`
- Run `python link_data.py` which links the data together and saves the output data in the `output_data` folder. The final dataframe which stores observations, their permits and evaluates the observation against the min/max permit rules is the `output_data/observations_with_permits_and_rules.csv` file.
- Run `python generate_map.py` which generates the map and saves it as a html file in `output_data/map.html`. It can take a minute or so to generate this map due to how many different datasets and data points are on the map.

**Notes on the `output_data/observations_with_permits_and_rules.csv` dataset**
- The `ROW_PASS_STATUS` column is a purely row based TRUE/FALSE on whether the row passes or not.
- The `OBSERVATION_PASS_STATUS` column answers the question: For a given (observation id, PERMIT_NUMBER, PERMIT_VERSION, determinand.notation) did the observation pass or not, this is a logical `AND` operation on the `ROW_PASS_STATUS` values in this grouping. So this answers for a given observation, permit_number, permit_version, determinand_notation does the observation pass, it checks by doing an AND operation across this combinations varying rows which may have different outlet_number, effluent_number, month_from or month_to values.

# Ontop
Ontop is used to map our datasets into RDF.

### SFI (Sustainable Farming Incentives) dataset into RDF
From the root folder of this repository you can run the following command which generates RDF data for the Sustainable Farming Incentives dataset for Poole Harbour. The output turtle data is stored in `ttl/sfi.ttl`.The duckdb file is stored in `ttl/sfi/sfi.duckdb`, this duckdb file is generated using `ttl/sfi/sfi_to_db.py`.
```
./ontop/ontop materialize \
  --mapping ttl/sfi/sfi.obda \
  --properties ontop/duckdb.properties \
  --output ttl/sfi/sfi_raw.ttl \
  --format turtle && \
rdfpipe -i turtle -o turtle ttl/sfi/sfi_raw.ttl > ttl/sfi.ttl
```
# Three-Ways app (map + tables over a triplestore)

`app/` is a static web app that reads the RDF via SPARQL — the same "federated data
layer" pattern of loading the Turtle graphs into an Oxigraph store and querying it.
`app/server.py` loads `ttl/regulation.ttl`, `ttl/winep.ttl` and `ttl/sfi.ttl` into an
in-memory [pyoxigraph](https://pyoxigraph.readthedocs.io/) store and serves, from one
origin, both a SPARQL endpoint at `/sparql` and the static frontend (Leaflet map +
tables).

```
poetry install --no-root
eval $(poetry env activate)
python app/server.py          # then open http://localhost:8000
```

The page always shows the catchment map with tables beneath it, and offers four views:

- **Show me the breaches** — condition breaches as *periods* (a run of consecutive failing
  observations with no passing result in between). A breach is **current** when its period is
  still open — nothing has passed since it began — otherwise it is a **past** breach with a
  start and end; a lone failure is a period whose start and end are the same day. Each links out
  to the Water Quality Explorer sampling point.
- **Solving for a substance** — pick a substance (defaults to Ammoniacal Nitrogen, `0111`);
  the map and tables show its in-force permit limits and the WINEP actions proposing future
  limits.
- **What Wessex Water is up to** — the WINEP actions (all `08WW…` = Wessex Water) with
  completion dates and their proposed / continued limits.
- **Overall** — everything, plus the SFI farming layer (an annotation layer that does not
  respond to substance filtering).

Geometry notes: regulation discharge points carry WGS84 lon/lat, SFI options carry WGS84,
and WINEP action sites carry EPSG:27700 (British National Grid) which the frontend reprojects
with proj4. The discharge-point geometry is asserted on the discharge point we own (a
`#geography` fragment), sourced from the coordinates of the sampling point it is `monitoredAt`;
the `environment.data.gov.uk` sampling point itself is left as a bare `geo:Feature`.

# License
Unless stated otherwise, the codebase in this repository is released under the MIT License.

Copyright (c) 2026 Crown Copyright (Government Digital Service)

The documentation and any other non-code content in this repository is licensed under the Open Government Licence v3.0, except where otherwise stated.

Contains public sector information licensed under the Open Government Licence v3.0.