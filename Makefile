run:
	python merge_observational_data.py
	python location_linking.py
	python filter_determinands.py
	python shape_observational_data.py