# demonstrator-poc

## Data sources:
- Operational Catchment GeoJSON for Poole Harbour: `raw_datasets/poole_harbour_rivers_operational_catchment.geojson`
    - Obtained from https://environment.data.gov.uk/catchment-planning/OperationalCatchment/3367
- WQE Observational Data for Poole Harbour Rivers between 2020-2026: `poole_harbour_rivers_water_quality_observations_2020_2026_combined.csv`
    - Obtained from https://environment.data.gov.uk/water-quality/downloads and merged multi-year data together with `raw_datasets/merge_observational_data.py`
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

# Demo
`cd` into the `output_data` directory and run `python -m http.server 8000` then navigate to `http://localhost:8000/map.html` to view the interactive map

# Running the code
- `poetry install --no-root`
- `eval $(poetry env activate)`
- Run `python link_data.py` which links the data together and saves the output data in the `output_data` folder. The final dataframe which stores observations, their permits and evaluates the observation against the min/max permit rules is the `output_data/observations_with_permits_and_rules.csv` file.
- Run `python generate_map.py` which generates a map using the `output_data/observations_with_permits_and_rules.csv` dataset, this saves the map as a html file in `output_data/map.html`. It can take a minute or so to generate this map due to how many data points are on the map.

**Notes on the `output_data/observations_with_permits_and_rules.csv` dataset**
- The `ROW_PASS_STATUS` column is a purely row based TRUE/FALSE on whether the row passes or not.
- The `OBSERVATION_PASS_STATUS` column answers the question: For a given (observation id, PERMIT_NUMBER, PERMIT_VERSION, determinand.notation) did the observation pass or not, this is a logical `AND` operation on the `ROW_PASS_STATUS` values in this grouping. So this answers for a given observation, permit_number, permit_version, determinand_notation does the observation pass, it checks by doing an AND operation across this combinations varying rows which may have different outlet_number, effluent_number, month_from or month_to values.

# License
Unless stated otherwise, the codebase in this repository is released under the MIT License.

Copyright (c) 2026 Crown Copyright (Government Digital Service)

The documentation and any other non-code content in this repository is licensed under the Open Government Licence v3.0, except where otherwise stated.

Contains public sector information licensed under the Open Government Licence v3.0.