# Hydrological Features

Computed by `scripts/pipeline/features.py` only from stored observations; each feature is NULL when its inputs are missing.

| Feature | Definition | Guards |
|---|---|---|
| `river_rise_1h_m`, `river_rise_3h_m` | latest level minus the reading whose **actual** age is closest to 1 h / 3 h, accepted only within ±0.5 h / ±0.75 h; district value = max over stations | irregular telemetry intervals handled; the rate always divides by the real elapsed time; null readings are ignored |
| `latest_river_level_m` | level of the station with the most recent valid reading | station-level values are available at `/api/telemetry/river` |
| `station_rain_24h_mm` | per station: sum of valid hourly values in the last 24 h, needs ≥12 valid readings, flag `OK`; district = max over stations | missing hours are not zeros; flagged values excluded |
| `groundwater_latest_m`, `groundwater_change_7d_m` | mean of each station's latest level; mean change vs the reading ~7 days earlier (±1 day) | datum unverified; never combined with river level |
| `data_status` | `LIVE` ≤3 h, `STALE` ≤72 h, `HISTORICAL` older, `UNAVAILABLE` none | computed from the newest observation, never assumed |

**Not implemented yet** (blocked on verified data): reservoir inflow–outflow and storage change (identity unverified), danger-level comparison (no verified danger levels in the NWDP fields), rainfall–runoff lag estimation (needs overlapping rainfall and level series), soil moisture. These stay UNAVAILABLE in the app.
The operational five-factor risk engine and its weights are **unchanged**. New features are supplementary evidence only; changing weights requires your approval and a backtest.
