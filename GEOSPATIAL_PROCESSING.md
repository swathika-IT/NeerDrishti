# Geospatial Processing

## Boundaries (`scripts/pipeline/boundaries.py`)
Reads the source GeoJSON (never modified), reports its columns and CRS, **refuses a file with no CRS**, reprojects to EPSG:4326, filters Telangana using the discovered state column (or a bounding-box fallback that is flagged for visual verification), finds the district-name column, normalises names to canonical `district_id`s (aliases in `districts.py`; unknown names are reported, never guessed), repairs invalid geometry with `make_valid`, dissolves duplicate parts, simplifies (0.0005°, topology preserved) and writes `data/processed/geographic/telangana_districts.geojson` with `district_id`, `district_name`. `data/quality_reports/boundaries.json` states `all_33_present` and lists missing ids.

## DEM terrain (`terrain.py`)
1. Reproject to UTM 44N (EPSG:32644).
2. Slope/aspect: Horn (1981) 3×3 finite differences. *Verified against the analytic slope of a tilted plane in tests.*
3. Hydrological conditioning with **pysheds**: fill pits → fill depressions → resolve flats.
4. D8 flow direction; flow accumulation (cells); stream network = accumulation ≥ threshold (default 1 km² contributing area).
5. TWI = ln(a / tanβ), a = accumulation × cell area / cell width; slope floored at 0.1° to avoid division by zero on flats.
6. Zonal statistics per district (`rasterstats`). Flow routing uses the whole-state DEM, not clipped tiles.

Limitations: drainage density uses stream-cell count × cell size (D8 diagonal links are under-measured, so treat as **relative**); `low_slope_pct` uses a reporting threshold (2°) that is stored with the result and is **not** a flood threshold; SRTM is a surface model (buildings/vegetation) and has voids; the terrain features are `ESTIMATED`. The pipeline is tested only on synthetic rasters. Run it on the real DEM and inspect the outputs before using them.
