# Data Completeness Report

Live view: Engineer View → Playground → *Data completeness matrix* (`/api/data/completeness`, static + rainfall inputs) and `/api/pipeline/completeness` (33 districts × 7 ingested datasets).

Honest baseline at delivery: 33/33 district records exist; **0** pipeline datasets ingested; static risk inputs are 15 expert priors + 84 proxy-derived values and **0** dataset-backed values; rainfall is SIMULATED unless the app can reach Open-Meteo; hydrological stations are simulated reference profiles; reservoir, soil-moisture and IMD hourly station data are UNAVAILABLE.
Regenerate this report from the API after your first full ingestion. NWDP rainfall covers only the districts present in that resource (your script listed 21 names); the pipeline reports which of the 33 are missing instead of assuming coverage.
