import folium
from folium.plugins import MarkerCluster
import pandas as pd
import geopandas as gpd

# ======================================================================
# Map initialisation
# ======================================================================
m = folium.Map(location=[50.7536, -2.3543], zoom_start=11)  # Approximate centre of dorset
folium.TileLayer(
    tiles="https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attr="© OpenStreetMap contributors",
    name="OpenStreetMap",
    control=True,
    referrerPolicy="no-referrer-when-downgrade"
).add_to(m)

# ======================================================================
# Operational Catchment
# ======================================================================
operational_catchment = gpd.read_file("raw_datasets/poole_harbour_rivers_operational_catchment.geojson")
folium.GeoJson(
    operational_catchment,
    name="Poole Harbour Rivers (Operational Catchment) - All",
    show=False,
    style_function=lambda feature: {
        "fillColor": "blue",
        "color": "black",
        "weight": 2,
        "fillOpacity": 0.4,
    },
).add_to(m)

# Add GeoJSON layer for boundary operational catchment
operational_catchment_dissolved = operational_catchment.dissolve()
folium.GeoJson(
    operational_catchment_dissolved,
    name="Poole Harbour Rivers (Operational Catchment) - Boundary",
    style_function=lambda feature: {
        "fillColor": "blue",
        "color": "black",
        "weight": 2,
        "fillOpacity": 0.4,
    },
).add_to(m)

# ======================================================================
# WQE Sampling Points
# ======================================================================
sampling_points = pd.read_csv("output_data/observations_with_permits_and_rules.csv")
# True only if all observations for a sampling point passed
sampling_points["SAMPLING_POINT_PASS_STATUS"] = (
    sampling_points.groupby("samplingPoint.notation")["ROW_PASS_STATUS"]
    .transform("all")
)

unique_sampling_points = sampling_points.drop_duplicates(
    subset="samplingPoint.notation",
    keep="first"
)
points_gdf = gpd.GeoDataFrame(
    unique_sampling_points,
    geometry=gpd.points_from_xy(unique_sampling_points["samplingPoint.longitude"], unique_sampling_points["samplingPoint.latitude"]),
    crs="EPSG:4326"
)
joined = gpd.sjoin(
    points_gdf,
    operational_catchment_dissolved,
    how="inner",
    predicate="within"
)

sampling_point_group=folium.FeatureGroup("Water quality sampling points from observational data between 2020-2026 that have permits with min and/or max rules").add_to(m)

for _, row in joined.iterrows():

    sampling_point_popup_dataframe = pd.DataFrame({
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
    
    sampling_point_popup_dataframe.columns = ["Field", "Value"]
    
    sampling_point_html = sampling_point_popup_dataframe.to_html(
        index=False,
        classes="table table-striped table-hover table-condensed table-responsive"
    )
    if row["SAMPLING_POINT_PASS_STATUS"] == True:
        pass_fail_colour = "green"
    else:
        pass_fail_colour = "red"

    folium.Marker(
            location=[row["samplingPoint.latitude"], row["samplingPoint.longitude"]],
            popup=folium.Popup(sampling_point_html),
            icon=folium.Icon(icon="square", prefix="fa",icon_color="white",color=pass_fail_colour)
        ).add_to(sampling_point_group)
    
# ======================================================================
# WINEP Actions
# ======================================================================
winep = pd.read_excel("raw_datasets/PR24 WINEP National Dataset.xlsx", sheet_name="PR24 WINEP National Data")
# Remove rows where either easting or northing is missing
winep = winep.dropna(subset=["Easting", "Northing"])

winep_gdf = gpd.GeoDataFrame(
    winep,
    geometry=gpd.points_from_xy(winep["Easting"], winep["Northing"]),
    crs="EPSG:27700"  
)
winep_gdf = winep_gdf.to_crs(epsg=4326)
winep_for_poole = gpd.sjoin(winep_gdf, operational_catchment_dissolved, how="inner", predicate="within")
winep_group=folium.FeatureGroup("WINEP Actions (PR24)",show=False).add_to(m)
for _, row in winep_for_poole.iterrows():

    winep_popup_dataframe = pd.DataFrame({
    "Water_Company": [row["Water_Company"]],
    "Action_Name":[row["Action_Name"]],
    "Unique_ID": [row["Unique_ID"]],
    "AMP_Period":[row["AMP_Period"]],
    "Action_Description":[row["Action_Description"]],
    "Completion_Date": [row["Completion_Date"]],
    "Driver_Code_Primary":[row["Driver_Code_Primary"]],
    "Action_Categorisation_Aim":[row["Action_Categorisation_Aim"]],
    "Action_Categorisation_Group":[row["Action_Categorisation_Group"]],
    "Action_Categorisation_Type":[row["Action_Categorisation_Type"]]
}).T.reset_index()
    
    winep_popup_dataframe.columns = ["Field", "Value"]
    
    winep_html = winep_popup_dataframe.to_html(
        index=False,
        classes="table table-striped table-hover table-condensed table-responsive"
    )
    
    folium.Marker(
            location=[row.geometry.y, row.geometry.x],
            popup=folium.Popup(winep_html),
            icon=folium.Icon(icon="fa-play fa-rotate-270", prefix="fa",icon_color="white",color="blue")
        ).add_to(winep_group)



# ======================================================================
# SFI (Sustainable Farming Initiatives) - Clustered Markers
# ======================================================================
sfi = gpd.read_file("raw_datasets/poole_harbour_rivers_sustainable_farming_initiatives.geojson")
sfi = gpd.sjoin(sfi, operational_catchment_dissolved, how="inner", predicate="within")
sfi["option_code_category"] = (
    sfi["option_code"]
    .astype(str)
    .str.extract(r"([A-Za-z]+)")[0]
    .str.replace(r"^C", "", regex=True)
)

top10 = sfi["option_code_category"].value_counts().head(10)
option_code_category_descriptions = {
    "HRW": "Hedgerows",
    "SAM": "Soil management",
    "LIG": "Grassland nutrient management",
    "IPM": "Pest management",
    "PRF": "Nutrient application and weed control methods",
    "AHL": "Arable and horticultural land",
    "NUM": "Nutrient management and legumes",
    "SOH": "Soil health",
    "SP": "Supplementary management options",
    "GRH": "Grassland habitat management",
}

for category in top10.index:
    sfi_category = sfi[sfi["option_code_category"] == category]
    description = option_code_category_descriptions.get(category)
    if description:
        layer_name = f"{category} ({description}) - {len(sfi_category)} data points"
    else:
        layer_name = f"{category} - {len(sfi_category)} data points"

    group = folium.FeatureGroup(
        name=layer_name,
        show=False,
    ).add_to(m)
    cluster = MarkerCluster().add_to(group)

    for _, row in sfi_category.iterrows():
        sfi_popup_dataframe = pd.DataFrame({
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

        sfi_popup_dataframe.columns = ["Field", "Value"]

        sfi_html = sfi_popup_dataframe.to_html(
            index=False,
            classes="table table-striped table-hover table-condensed table-responsive"
        )

        folium.Marker(
            location=[row.geometry.y, row.geometry.x],
            popup=folium.Popup(sfi_html, max_width=500),
            icon=folium.Icon(color="blue"),
        ).add_to(cluster)

# ======================================================================
# SSSI (Sites of Special Scientific Interest)
# ======================================================================

sssi = gpd.read_file("raw_datasets/Sites_of_Special_Scientific_Interest_England.geojson")
sssi = gpd.sjoin(sssi, operational_catchment_dissolved, how="inner", predicate="within")

folium.GeoJson(
    sssi,
    name="SSSI (Sites of Special Scientific Interest)",
    show=False,
    style_function=lambda feature: {
        "fillColor": "green",
        "color": "darkgreen",
        "weight": 1,
        "fillOpacity": 0.5,
    },
    popup=folium.GeoJsonPopup(
    fields=["name_left"],  
    aliases=["Name:"]
    ),
).add_to(m)

# ======================================================================
# SPA (Special Protection Areas)
# ======================================================================
spa = gpd.read_file("raw_datasets/Special_Protection_Areas_England.geojson")
spa = gpd.sjoin(spa, operational_catchment_dissolved, how="inner", predicate="within")

folium.GeoJson(
    spa,
    name="SPA (Special Protection Areas)",
    show=False,
    style_function=lambda feature: {
        "fillColor": "green",
        "color": "darkgreen",
        "weight": 1,
        "fillOpacity": 0.5,
    },
    popup=folium.GeoJsonPopup(
    fields=["spa_name"],  
    aliases=["Name:"]
    ),
).add_to(m)

# ======================================================================
# SAC (Special Areas of Conservation)
# ======================================================================
sac = gpd.read_file("raw_datasets/Special_Areas_of_Conservation_England.geojson")
sac = gpd.sjoin(sac, operational_catchment_dissolved, how="inner", predicate="within")

folium.GeoJson(
    sac,
    name="SAC (Special Areas of Conservation)",
    show=False,
    style_function=lambda feature: {
        "fillColor": "green",
        "color": "darkgreen",
        "weight": 1,
        "fillOpacity": 0.5,
    },
    popup=folium.GeoJsonPopup(
    fields=["sac_name"],  
    aliases=["Name:"]
    ),
).add_to(m)

# ======================================================================
# This should always be last
# ======================================================================
folium.LayerControl().add_to(m)
m.save("output_data/map.html")