# Pending work (needs your machine, keys or decisions)

1. **Rotate the Gmail App Password** that was in the old `.env.example`; purge it from Git history.
2. **Merge check:** my archive lacked the notification-preview UI and some defects you described (WhatsApp segment counts, duplicate DRY_RUN rows) — your local copy is ahead. Diff before copying files over. `NotificationSimulator.tsx` + `preview.ts` are standalone and can replace your preview UI.
3. **Run the data pipeline** (DATA_INGESTION_GUIDE.md). Send me the generated `data/quality_reports/*.json` and I will fix mapping/units issues and wire the features into more screens.
4. **Verify reservoir identity** and create `data/metadata/reservoir_resources.json`.
5. **District boundaries:** run `boundaries` on `District_NWIC.geojson`; confirm all 33 districts (the map shows polygons automatically once the file exists).
6. **OpenTopography key** → `dem-download`, then `terrain --resolution 90`, then 30 m.
7. **Basemap:** choose a provider you are authorised to use (MapTiler/Stadia/etc.) and set `MAP_TILE_URL` (+ attribution). Until then the local fallback is used.
8. **Historical flood events 2015–2025** — the largest remaining gap; the 25 % flood-history factor is still 15 expert priors + 84 proxy values.
9. **Duplicate DRY_RUN records:** run `npm run db:audit-notifications` (read-only) on your DB and send the output before any cleanup.
10. **AI provider:** only Ollama (default) or an OpenAI-compatible endpoint exist. Set `LLM_*` env vars for a hosted provider and test; native-speaker review of Telugu/Hindi text.
11. **Not built yet:** frontend charts for NWDP rainfall/groundwater/river/reservoir trends and the Home/Live Dashboard/Situation Fusion data cards (APIs exist; UI wiring pending first real data); Playground lag analysis (needs overlapping rainfall + level series); backtesting of extra features; WhatsApp/SMS live sending (locked by design); GPM/soil-moisture/LULC/population datasets; deployment to Render.
