# Deployment Guide

## Local
```
npm ci
cp .env.example .env          # edit; never commit .env
npm run bootstrap             # creates schema + applies migrations (idempotent)
npm run build:features        # regenerates data/district_features.json (optional)
npm run dev                   # or: npm run build && npm start
```
Requires Node ≥ 22.5 (`node:sqlite`). Ollama is optional: `ollama pull llama3.2:3b`.

## Render (verified locally in production mode; **not deployed by me**)
1. Push to `main` of `ykavya613/NeerDrishti_login` (**after rotating the leaked SMTP password and purging it from history**).
2. Render → New → Blueprint → select the repo (`render.yaml`).
3. Set `APP_BASE_URL` and `CORS_ALLOWED_ORIGINS` to your Render URL.
4. Health check path: `/api/health/ready`. Start command `npm start` bootstraps the DB first.
5. **SQLite persistence:** the blueprint mounts a 1 GB disk at `/var/data` (paid plan required). On a free plan data resets on each deploy — fine for a demo, not for real reports. Alternative if you later need scale: managed Postgres (a real migration, not done here).
6. **AI on Render:** `localhost` Ollama is unreachable. Either leave AI unconfigured (deterministic fallback keeps working) or set `OPENAI_COMPATIBLE_BASE_URL/API_KEY/MODEL` to a hosted provider such as Groq (key = your own; may incur cost).
7. Keep `NOTIFICATION_DRY_RUN=true`, `NOTIFICATION_LIVE_SEND_ENABLED=false`, `AUTH_DEV_EXPOSE_TOKENS=false`.
8. After deploy verify: `/api/health/ready` → ready; `/api/districts?slim=1` → 33 districts; sign-up/login; submit a report.

Hosted LLM comparison (to run with real keys): local Ollama = free, private, slow on CPU, weak Telugu; Groq/Together = fast, usually better multilingual, per-token cost/free tier limits, data leaves your server. The validator makes either safe.
