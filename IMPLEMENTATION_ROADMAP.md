# Implementation Roadmap

✅ done in this delivery · ⏭ next (needs input noted) · 🔒 needs your approval/credentials

## Critical fixes
- ✅ Fresh-DB bootstrap (D5); `npm start` now bootstraps then serves.
- ✅ Secret removed from `.env.example` (D1) — 🔒 **you must rotate the App Password**.
- ✅ Truthful live/simulated labels (D6).
- ⏭ Decide default public scenario (D10).

## Data pipeline
- ✅ `data/district_features.json` + provenance + `npm run build:features`; CSV override hook `data/raw/district_features_override.csv`.
- ✅ `/api/data/completeness` (observed / estimated / imputed / simulated / missing).
- ⏭ Import 2015–2025 flood events (NDMA/SDMA/news-verified) → replaces `flood_history` priors.
- ⏭ District boundaries (33, post-2019) → polygon map + spatial joins. Verify Mulugu & Narayanpet are present.
- ⏭ DEM (Copernicus GLO-30 / SRTM) → elevation & slope per district (zonal stats, ~1 GB raw; ~1 MB processed).
- ⏭ HydroSHEDS rivers/basins → river proximity, drainage density.
- 🔒 CWC/India-WRIS station series → real river levels and the lag study.

## UI/UX
- ✅ Simple View (search, 4 required labels, rainfall threshold bar, factor bars, NOW/+3H…+24H outlook, read-aloud, EN/TE/HI, reduced-motion).
- ✅ Engineer View toggle; jargon replaced on visible labels; nav relaid.
- ⏭ Redesign Live Dashboard / Situation Fusion / Alert Center in Simple language where relevant.
- ⏭ Local, optimized illustration assets (original SVGs are best for licensing).
- ⏭ Real water-level gauge once station data is real (never plot a risk score as a level).

## AI
- ✅ Verbatim system prompt, compact context, T=0.2, retry, timeout, number-whitelist validator, banned-phrase check, ≤90 words, 112 line, deterministic en/te/hi fallback.
- ⏭ Point `AIAssistantView` chat at the same validator.
- ⏭ Hosted-provider comparison with real keys (Groq/Together are drop-in via 3 env vars).
- ⏭ Native-speaker review of Telugu/Hindi strings.

## Authentication & roles
- ✅ Existing JWT/session/RBAC retained and tested (14 auth + 19 hardening tests).
- ⏭ Move rate limiting to a shared store if running >1 instance.

## Alerts
- ✅ DRY_RUN workflow intact.
- 🔒 Twilio WhatsApp-sandbox/SMS provider: **not implemented on purpose** — it cannot be tested without your credentials, and live-sending is a safety-critical path. Plan: allow-listed test numbers, ADMIN-only, explicit consent record, confirm step, delivery status only from provider callback.

## Data Science Playground
- ✅ Weight explorer (normalised, non-negative, before/after, rank movement, drift check vs server).
- ✅ Correlation matrix (clearly labelled structural, exposes the proxy artefact).
- ✅ Completeness matrix.
- ⛔ Lag analysis blocked until observed rainfall/discharge series exist.
- ⏭ Rainfall–flood and runoff correlations once D4 data is loaded.

## Testing / Deployment
- ✅ 137 tests; Playwright screenshots; production-mode boot verified.
- ✅ `render.yaml`, health check, persistent disk strategy.
- 🔒 Actual Render deployment & verification (needs your Render account; disks need a paid plan).
