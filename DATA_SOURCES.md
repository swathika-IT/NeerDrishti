# Data Sources

Status key: **Wired** = code exists · **Verified live** = I successfully fetched it (none, sandbox had no internet) · **Needed** = dataset not in project.
Licences below are *what to check*, not confirmed — read each provider's current terms before redistribution.

## A. Currently wired in code
| Source | Used for | Status | Notes |
|---|---|---|---|
| Open-Meteo forecast/archive | 24 h & 3 h rainfall per district | Wired; **not verified live here** | Weather *model* output, not rain-gauge observation. Falls back to labelled SIMULATED scenario. Attribution shown in footer. |
| IMD CAP RSS / NDMA SACHET RSS | Official alert feed (Telangana) | Wired (`docs/IMD_CAP_FEED.md`); not verified live here | Official alerts are shown separately from NeerDrishti scores. |
| `data/hydrological_stations.json` (33 stations) | River/reservoir reference thresholds | Static reference | Observations are simulated unless a live feed is connected. |
| `data/telangana_districts.json` | District metadata, centroid, proxy score | Static prototype | `prototype_vulnerability_score` is not a measurement. |
| `data/district_features.json` | Flood-history / terrain / drainage inputs | **Prototype priors + proxies (0 of 99 values from datasets)** | Provenance per value. |
| NWDP historical rainfall | Historical baseline | Licence unverified; 0 rows loaded | See `docs/NWDP_LICENCE_VERIFICATION.md`. |

## B. Needed (with exact how-to)
| Dataset | Why | Where to look | Size | How it enters the model |
|---|---|---|---|---|
| 33-district boundaries (post-2019, incl. Mulugu, Narayanpet) | Polygon map; spatial joins | Survey of India / Telangana open data / a community GeoJSON with licence (e.g. MIT repos on GitHub — **verify 33 features and date**) | <10 MB | Map overlay; zonal statistics |
| Flood events 2015–2025 | Historical flood frequency (25% weight) | Telangana SDMA/CWC/NDMA reports, DesInventar, Dartmouth Flood Observatory (check licences) | small | `flood_history_score` per district |
| Elevation/slope | Terrain (15%) | Copernicus GLO-30 DEM or SRTM | ~1 GB raw, ~1 MB derived | zonal mean elevation & slope → `terrain_score` |
| Rivers & basins | River proximity, drainage density (10%) | HydroSHEDS / HydroRIVERS (non-commercial licence — check) | ~100 MB | distance-to-river, density → `drainage_score` |
| Land use / cover | Imperviousness/runoff | ESA WorldCover (CC BY 4.0 — verify) | ~200 MB | future feature |
| River level / reservoir series | Real gauges, lag study | CWC flood forecasting, India-WRIS (access/terms vary; may need request) | varies | hydrology module; Playground lag analysis |
| IMD gridded rainfall / GPM IMERG | Observed rainfall | IMD Pune (registration), NASA Earthdata (free login) | large | observed rainfall column |

### Plugging a real dataset in (no code change)
1. Process it to 0–100 scores per district.
2. Save `data/raw/district_features_override.csv` with columns `district_id,flood_history_score,terrain_score,drainage_score,source,license` (leave a cell empty to keep the prior).
3. `npm run build:features` → those values become `DATASET` and show as **OBSERVED** in the completeness matrix.

## C. Rules enforced by the code
Observed ≠ estimated ≠ imputed ≠ simulated (see `/api/data/completeness`). Rainfall→flood-depth conversion is never shown. Missing data is shown as missing.

## D. Pipeline datasets (code written; NOT yet downloaded or verified live)
| dataset_id | Source / identifier | Content | Verify before use |
|---|---|---|---|
| `openmeteo_archive_daily` | archive-api.open-meteo.com/v1/archive | daily precip/rain sums, precip hours, Tmax/Tmin (+ optional humidity), 33 district centroids, from 2023-01-01 | Model identity (do not call it ERA5 until confirmed); non-commercial licence terms |
| `openmeteo_forecast` | api.open-meteo.com/v1/forecast | current + 7-day hourly (temp, precip, RH, rain, code, MSLP, precip. probability) | "current" is modelled, not observed |
| `nwdp_rainfall_telangana_sw` | NWDP resource `afe7a84b-dc63-4172-8a7f-cadf49403b46` | hourly telemetry rainfall | which districts/stations exist; units; timestamp zone |
| `nwdp_groundwater_telangana_gw` | `ce37832e-2783-423f-90e2-ab40eaa32ed1` | 6-hourly groundwater level (m) | reference datum (bgl vs amsl) |
| `nwdp_river_godavari` / `nwdp_river_krishna` | `102af52d-5654-4823-b4e6-99c96bec91d0` / `b3ab306b-5625-4b6a-b2bd-8f429dab98cc` | river water-level telemetry, gauge reference | zero-gauge/MSL meaning; interval |
| `nwdp_reservoir_candidate_a/b` | `2aaf4f3c-7f3c-4c3b-986a-60edb610548a` / `b255a41d-969d-449b-ba1f-b8a3b8f31fb9` | **identity unverified** | inspect-only until `data/metadata/reservoir_resources.json` marks `verified:true` |
| `dem_srtm_30m` | OpenTopography `globaldem` SRTMGL1, bbox S15.8 N19.9 W77.2 E81.3 | DEM → terrain features | needs your API key |
| boundaries | your `District_NWIC.geojson` | 33 district polygons | all 33 present, correct vintage |

Licences: confirm each provider's current terms; the registry stores the note but it is not legal advice.

## E. Next-best additional datasets (priority)
1. **Historical flood events 2015–2025** (SDMA/NDMA/CWC reports; Sentinel-1 flood extent) — replaces the 99 prototype static values and unlocks validation/backtesting. *Highest value.*
2. HydroSHEDS/HydroRIVERS — verified river network and basins. 3. NASA GPM IMERG — cross-check rainfall (Earthdata login). 4. ERA5-Land soil moisture. 5. ESA WorldCover land cover. 6. Census/WorldPop exposure. 7. India-WRIS/CWC reservoir levels (after identity verification).

## F. Download log
Nothing downloaded in this delivery. After each download append: name · URL · coverage · period · resolution · format · licence · date · processing · path.
