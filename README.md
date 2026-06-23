# Demonstrator-PoC

## Data sources:
- WQE Observational Data for Poole Harbour Rivers between 2020-2026: `raw_datasets/poole_harbour_rivers_observations_2020-2026.csv`
- Consented Discharges to Controlled Waters with Conditions
  - Discharge and Permit Data: `raw_datasets/consents_active.csv`
  - Permit rules for each determinand: `raw_data/determinands.csv`

## Output Data
The final output dataset which evaluates observations against permit rules is stored in `output_data/shape_observational_data/observation_evaluation.csv`

## Scripts
These scripts need to be run in order, these scripts can be run individually or you can run `make run` which runs each script consecutively.

### 1. `location_linking.py`

**Input Data**
- WQE Observational Data: `raw_datasets/poole_harbour_rivers_observations_2020-2026.csv`
- Discharge and Permit Data: `raw_datasets/consents_active.csv`

**Output Data**
  - `output_data/location_linking/sampling_point_to_permit_all.csv`
    - Contains all sampling point to permit matches with confidence scores
  - `output_data/location_linking/sampling_point_to_permit_filtered.csv`
    - Filters out matches where confidence score is below 50

**Logic**
- Uses WQE Observational Data and reduces it to sampling points
  - Converts lat/long into easting and northings

- Finds candidate discharge points for each sampling point 
  - Establishes discharge points within a fixed radius search (spatial proximity via KDTree) for each sampling point

- Selects the most relevant discharge point per sampling point
  - Computes a fuzzy match score between:
    - `samplingPoint.prefLabel` (WQE Observational Data)
    - `DISCHARGE_SITE_NAME` (Discharge and Permit Data)
  - Ranks candidates by first by fuzzy match score then by permit version
  - Selects the best candidate

**Purpose of the script**
  - Establishes a link between WQE sampling points and environmental permits
  - Acknowledges that multiple permits may apply to a single sampling point, for this proof of concept, only one permit is selected per sampling point


### 2. `filter_determinands.py`

**Input Data**
- Determinands: `raw_datasets/determinands.csv`
- Discharge and Permit data specific to our observational data: `output_data/location_linking/sampling_point_to_permit_filtered.csv`
- WQE Observational Data: `raw_datasets/poole_harbour_rivers_observations_2020-2026.csv`

**Output Data**
- Filtered Determinands: `output_data/filter_determinands/filtered_determinands.csv`
- Filtered Determinands in long format: `output_data/filter_determinands/filtered_determinands_long.csv`

**Logic**
- Filters the full determinands dataset to only the permits identified in `output_data/location_linking/sampling_point_to_permit_filtered.csv`
- Filters the full determinands dataset to only the determinands identified in `raw_datasets/poole_harbour_rivers_observations_2020-2026.csv`

**Purpose of the script**
- Filters the large determinands dataset to make it specific to our sampling points and determinands in our observational data.
- Produces a long format for determinands and their associated rules

### 3. `shape_observational_data.py`

**Input Data**
- WQE Observational Data: `raw_datasets/poole_harbour_rivers_observations_2020-2026.csv`
- Map between sampling point and permit: `output_data/location_linking/sampling_point_to_permit_filtered.csv`
- Determinands (in long format): `output_data/filter_determinands/filtered_determinands_long.csv`

**Output Data**
- Observation Evaluation (contains all observations and whether they pass/fail against permit rules): `output_data/shape_observational_data/observation_evaluation.csv`

**Logic**
- Starting with the raw observational data add the applicable permit and their rules
- For observation evaluate the observation result based on the rule dictated by its permit

**Purpose of the script**
- Gets the observational data into a shape whereby each observation can be evaluated against the permit rules

**Note**
- The `row_pass_status` column in `observation_evaluation.csv` is a purely row based TRUE/FALSE on whether the row passes or not.
- The `observation_pass_status` column answers the question: For a given (observation id, PERMIT_NUMBER, PERMIT_VERSION, determinand.notation) did the observation pass or not, this is a logical `AND` operation on the `row_pass_status` values in this grouping.

## Assumptions
- Even though we use 5 years of observational data, we only assess sampling points against `active` permits, and the latest versions of the permits
