import folium
import pandas as pd
import geopandas as gpd

geojson_data = gpd.read_file("raw_datasets/poole_harbour_rivers_operational_catchment.geojson")

m = folium.Map(location=[50.7536, -2.3543], zoom_start=11)  # Approximate centre of dorset

folium.TileLayer(
    tiles="https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attr="© OpenStreetMap contributors",
    name="OpenStreetMap",
    control=True,
    referrerPolicy="no-referrer-when-downgrade"
).add_to(m)

# Add GeoJSON layer for operational catchment
folium.GeoJson(
    geojson_data,
    name="Poole Harbour Rivers (Operational Catchment) - All",
    show=False,
    style_function=lambda feature: {
        "fillColor": "blue",
        "color": "black",
        "weight": 2,
        "fillOpacity": 0.4,
    },
).add_to(m)

geojson_data_dissolved = geojson_data.dissolve()

# Add GeoJSON layer for operational catchment
folium.GeoJson(
    geojson_data_dissolved,
    name="Poole Harbour Rivers (Operational Catchment) - Boundary",
    style_function=lambda feature: {
        "fillColor": "blue",
        "color": "black",
        "weight": 2,
        "fillOpacity": 0.4,
    },
).add_to(m)

# Add water quality sampling points 
sampling_points = pd.read_csv("output_data/observations_with_permits_and_rules.csv")
unique_sampling_points = sampling_points.drop_duplicates(subset="samplingPoint.notation", keep="first")
points_gdf = gpd.GeoDataFrame(
    unique_sampling_points,
    geometry=gpd.points_from_xy(unique_sampling_points["samplingPoint.longitude"], unique_sampling_points["samplingPoint.latitude"]),
    crs="EPSG:4326"
)
joined = gpd.sjoin(
    points_gdf,
    geojson_data_dissolved,
    how="inner",
    predicate="within"
)

sampling_point_group=folium.FeatureGroup("Water quality sampling points from observational data between 2020-2026 that have permits with min and/or max rules").add_to(m)

for _, row in joined.iterrows():

    popup_dataframe = pd.DataFrame({
    "samplingPoint.notation": [row["samplingPoint.notation"]],
    "samplingPoint.prefLabel": [row["samplingPoint.prefLabel"]],
    "samplingPoint.latitude": [row["samplingPoint.latitude"]],
    "samplingPoint.longitude": [row["samplingPoint.longitude"]],
    "samplingPoint.region": [row["samplingPoint.region"]],
    "samplingPoint.area": [row["samplingPoint.area"]],
    "samplingPoint.subArea": [row["samplingPoint.subArea"]],
    "samplingPoint.samplingPointStatus": [row["samplingPoint.samplingPointStatus"]],
    "samplingPoint.samplingPointType": [row["samplingPoint.samplingPointType"]]
}).T.reset_index()
    
    popup_dataframe.columns = ["Field", "Value"]
    
    html = popup_dataframe.to_html(
        index=False,
        classes="table table-striped table-hover table-condensed table-responsive"
    )

    folium.Marker(
        location=[row["samplingPoint.latitude"], row["samplingPoint.longitude"]],
        popup=folium.Popup(html),
        icon=folium.Icon(color="green")
    ).add_to(sampling_point_group)

# Sustainable Farming Initiatives
# Load the GeoJSON
sfi = gpd.read_file("raw_datasets/poole_harbour_rivers_sustainable_farming_initiatives.geojson")
sfi = gpd.sjoin(sfi, geojson_data_dissolved, how="inner", predicate="within")
#top_3 = sfi["option_code"].value_counts().head(3)
#print(top_3)

#SAM1 option_code layer
sfi_sam1 = sfi[(sfi["option_code"] == "SAM1")]
sfi_sam1_group=folium.FeatureGroup("SFI SAM1 (Assess soil, produce a soil management plan, and test soil organic matter) - 1927 data points",show=False).add_to(m)
for _, row in sfi_sam1.iterrows():
    popup_dataframe = pd.DataFrame({
        "Application ID": [row["app_id"]],
        "Reference Year": [row["ref_year"]],
        "Contract Start": [row["contract_start"]],
        "Contract End": [row["contract_end"]],
        "Scheme": [row["scheme"]],
        "Application Type": [row["application_type"]],
        "Option Code": [row["option_code"]],
        "Area": [row["area"]],
        "MTL": [row["mtl"]],
        "Units": [row["units"]],
        "Unit of Measure": [row["uom_desc"]],
        "Option Year": [row["opt_year"]],
        "Scheme Module": [row["schememodule"]],
    }).T.reset_index()
    popup_dataframe.columns = ["Field", "Value"]
    html = popup_dataframe.to_html(
        index=False,
        classes="table table-striped table-hover table-condensed table-responsive"
    )
    folium.Marker(
        location=[row.geometry.y, row.geometry.x],
        popup=folium.Popup(html, max_width=500),
        icon=folium.Icon(color="blue")
    ).add_to(sfi_sam1_group)


#CSAM1 option_code layer
sfi_csam1 = sfi[(sfi["option_code"] == "CSAM1")]
sfi_csam1_group=folium.FeatureGroup("SFI CSAM1 (Assess soil, test soil organic matter and produce a soil management plan) - 1484 data points",show=False).add_to(m)
for _, row in sfi_csam1.iterrows():
    popup_dataframe = pd.DataFrame({
        "Application ID": [row["app_id"]],
        "Reference Year": [row["ref_year"]],
        "Contract Start": [row["contract_start"]],
        "Contract End": [row["contract_end"]],
        "Scheme": [row["scheme"]],
        "Application Type": [row["application_type"]],
        "Option Code": [row["option_code"]],
        "Area": [row["area"]],
        "MTL": [row["mtl"]],
        "Units": [row["units"]],
        "Unit of Measure": [row["uom_desc"]],
        "Option Year": [row["opt_year"]],
        "Scheme Module": [row["schememodule"]],
    }).T.reset_index()
    popup_dataframe.columns = ["Field", "Value"]
    html = popup_dataframe.to_html(
        index=False,
        classes="table table-striped table-hover table-condensed table-responsive"
    )
    folium.Marker(
        location=[row.geometry.y, row.geometry.x],
        popup=folium.Popup(html, max_width=500),
        icon=folium.Icon(color="blue")
    ).add_to(sfi_csam1_group)

#HRW1 option_code layer
sfi_hrw1 = sfi[(sfi["option_code"] == "HRW1")]
sfi_hrw1_group=folium.FeatureGroup("SFI HRW1 (Assess and record hedgerow condition) - 993 data points",show=False).add_to(m)
for _, row in sfi_hrw1.iterrows():
    popup_dataframe = pd.DataFrame({
        "Application ID": [row["app_id"]],
        "Reference Year": [row["ref_year"]],
        "Contract Start": [row["contract_start"]],
        "Contract End": [row["contract_end"]],
        "Scheme": [row["scheme"]],
        "Application Type": [row["application_type"]],
        "Option Code": [row["option_code"]],
        "Area": [row["area"]],
        "MTL": [row["mtl"]],
        "Units": [row["units"]],
        "Unit of Measure": [row["uom_desc"]],
        "Option Year": [row["opt_year"]],
        "Scheme Module": [row["schememodule"]],
    }).T.reset_index()
    popup_dataframe.columns = ["Field", "Value"]
    html = popup_dataframe.to_html(
        index=False,
        classes="table table-striped table-hover table-condensed table-responsive"
    )
    folium.Marker(
        location=[row.geometry.y, row.geometry.x],
        popup=folium.Popup(html, max_width=500),
        icon=folium.Icon(color="blue")
    ).add_to(sfi_hrw1_group)

folium.LayerControl().add_to(m)
m.save("output_data/map.html")