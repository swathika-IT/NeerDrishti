# Data Quality Report

**Current state: no external dataset has been ingested into this delivery.** The build sandbox could not reach NWDP, Open-Meteo or OpenTopography, so there are no record counts, missingness rates or coverage figures to report, and none are invented here.

Each ingestion writes its own machine-readable report to `data/quality_reports/` (`schema_*`, `ingest_*`, `boundaries`, `terrain`, `reservoir_inspect_*`) containing: discovered field mapping, records fetched/inserted/rejected, unmatched district names, quality-flag counts and unit hints. After you run the pipeline (DATA_INGESTION_GUIDE.md), summarise those files here.

Automated checks implemented: missing/invalid timestamps (rejected), negative rainfall (set NULL + flagged), rainfall > 300 mm/h (flagged), coordinates outside the Telangana box (flagged), duplicate station readings (UNIQUE constraints), unmatched districts (kept raw, id NULL, reported), invalid geometry (repaired and counted), raster nodata (masked), HTML/non-JSON API responses (error), API failure (run marked FAILED).
Not implemented: temperature plausibility bounds, cross-source rainfall comparison (needs GPM IMERG), unit conversion (units are validated by name hint only; confirm on the portal).
