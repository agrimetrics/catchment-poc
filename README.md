# demonstrator-poc

## Data sources:
- WQE Observational Data for Poole Harbour Rivers between 2020-2026: `poole_harbour_rivers_water_quality_observations_2020_2026_combined.csv`
    - Obtained from https://environment.data.gov.uk/water-quality/downloads and merged multi-year data together with `raw_datasets/merge_observational_data.py`
- Consented Discharges to Controlled Waters with Conditions
    - Obtained from https://www.data.gov.uk/dataset/55b8eaa8-60df-48a8-929a-060891b7a109/consented-discharges-to-controlled-waters-with-conditions1
        - Discharge and Permit Data: `raw_datasets/access_database_csv_files/consents_active.csv`
        - Permit rules: `raw_datasets/access_database_csv_files/determinands.csv`
        - Effluents: `raw_datasets/access_database_csv_files/effluents.csv`
- Operational Catchment GeoJSON for Poole Harbour: `raw_datasets/poole_harbour_rivers_operational_catchment.geojson`
    - Obtained from https://environment.data.gov.uk/catchment-planning/OperationalCatchment/3367
- Sustainable Farming Initiatives GeoJSON for Poole Harbour: `raw_datasets/poole_harbour_rivers_sustainable_farming_initiatives.geojson`
    - Obtained from https://environment.data.gov.uk/explore/58cc85ab-a955-4b37-9c42-eee8532cbd01

# Demo
`cd` into the `output_data` directory and run `python -m http.server 8000` then navigate to `http://localhost:8000/map.html` to view the interactive map

# Running the code
- `python -m venv .venv`
- `source .venv/bin/activate`
- `pip install -r requirements.txt`
- Run `python link_data.py` which links the data together and saves the output data in the `output_data` folder. The final dataframe which stores observations, their permits and evaluates the observation against the min/max permit rules is the `output_data/observations_with_permits_and_rules.csv` file.
- Run `python generate_map.py` which generates a map using the `output_data/observations_with_permits_and_rules.csv` dataset, this saves the map as a html file in `output_data/map.html`

**Notes on the `output_data/observations_with_permits_and_rules.csv` dataset**
- The `ROW_PASS_STATUS` column is a purely row based TRUE/FALSE on whether the row passes or not.
- The `OBSERVATION_PASS_STATUS` column answers the question: For a given (observation id, PERMIT_NUMBER, PERMIT_VERSION, determinand.notation) did the observation pass or not, this is a logical `AND` operation on the `ROW_PASS_STATUS` values in this grouping. So this answers for a given observation, permit_number, permit_version, determinand_notation does the observation pass, it checks by doing an AND operation across this combinations varying rows which may have different outlet_number, effluent_number, month_from or month_to values.
