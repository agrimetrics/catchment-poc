## 1. `location_linking.py`

Input Data:
- WQE Observational Data: `raw_datasets/poole_harbour_rivers_observations_2020-2026.csv`
- Discharge and Permit Data: `raw_datasets/consents_active.csv`

Output Data:
  - `output_data/location_linking/sampling_point_to_permit_all.csv`
    - Contains all sampling point to permit matches with confidence scores
  - `output_data/location_linking/sampling_point_to_permit_filtered.csv`
    - Filters out matches where confidence score is below 50

Logic:
- Uses WQE Observational Data and reduces it to sampling points
  - Converts lat/long into easting and northings

- Finds candidate discharge points for each sampling point 
  - Establishes discharge points within a fixed radius search (spatial proximity via KDTree) for each sampling point

- Selects the most relevant discharge point per sampling point
  - Computes a fuzzy match score between:
    - `samplingPoint.prefLabel` (WQE Observational Data)
    - `DISCHARGE_SITE_NAME` (Discharge and Permit Data)
  - Ranks candidates by similarity score
  - Selects the highest scoring match as the representative link

Purpose of the script
  - Establishes a link between sampling points and environmental permits
  - Acknowledges that multiple permits may apply to a single sampling point
  - For this proof of concept, only one permit is selected per sampling point


## 2. `filter_determinands.py`

Input Data:
- Determinands: `raw_datasets/determinands.csv`
- Discharge and Permit data specific to our obsevational data: `output_data/location_linking/sampling_point_to_permit_filtered.csv`
- WQE Observational Data: `raw_datasets/poole_harbour_rivers_observations_2020-2026.csv`

Output Data:
- Filtered Determinands: `output_data/filter_determinands/filtered_determinands.csv`
- Filtered Determinands in long format: `output_data/filter_determinands/filtered_determinands_long.csv`

Logic:
- Filters the full determinands dataset to only the permits identified in `output_data/location_linking/sampling_point_to_permit_filtered.csv`
- Filters the full determinands dataset to only the determinands identified in `raw_datasets/poole_harbour_rivers_observations_2020-2026.csv`

Purpose of the script
- Filters the large determinands dataset to make it specific to our sampling points and determinands in our observational data.
- Produces a long format for determinands

## 3. shape_observational_data.py

Purpose of the script
- Gets the observational data into a shape whereby each observation can be evaluated against the permit rules