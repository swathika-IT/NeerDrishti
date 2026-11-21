"""Open-Meteo historical archive + forecast ingestion (all 33 districts, district centroids).

PROVENANCE: Open-Meteo values are gridded MODEL / reanalysis output, not station observations. The archive's exact underlying
model is whatever Open-Meteo reports for the request; we store the returned grid lat/lon/elevation and a model_note.
Verify the model against https://open-meteo.com/en/docs/historical-weather-api before labelling it ERA5 / ERA5-Land.
"""
from __future__ import annotations
import time
from collections import defaultdict
from datetime import date, timedelta
from .common import db, make_session, register_dataset, IngestionRun, utc_now, to_float
from .districts import all_ids, centroid

ARCHIVE = "https://archive-api.open-meteo.com/v1/archive"
FORECAST = "https://api.open-meteo.com/v1/forecast"
ARCHIVE_ID, FORECAST_ID = "openmeteo_archive_daily", "openmeteo_forecast"
DAILY = "precipitation_sum,rain_sum,precipitation_hours,temperature_2m_max,temperature_2m_min"
CUR = "temperature_2m,relative_humidity_2m,precipitation,weather_code"
HOURLY = "temperature_2m,precipitation,relative_humidity_2m,rain,weather_code,pressure_msl,precipitation_probability"
MODEL_NOTE = "Open-Meteo archive (model identity as returned by API; verify before calling it ERA5/ERA5-Land)"

def _session():
    s = make_session()
    try:  # optional 1-hour cache for forecast calls
        import requests_cache
        return requests_cache.CachedSession(".cache/openmeteo", expire_after=3600, backend="sqlite")
    except Exception:
        return s

def _as_list(obj):
    return obj if isinstance(obj, list) else [obj]

def _at(arr, i):
    return None if arr is None or i >= len(arr) else to_float(arr[i])

def parse_archive(resp, district_ids, retrieved_at, hourly_rh: dict | None = None) -> list[tuple]:
    rows = []
    for did, loc in zip(district_ids, _as_list(resp)):
        d = loc.get("daily") or {}
        times = d.get("time") or []
        for i, day in enumerate(times):
            rh = (hourly_rh or {}).get((did, day))
            rows.append((did, day, _at(d.get("precipitation_sum"), i), _at(d.get("rain_sum"), i),
                         _at(d.get("precipitation_hours"), i), _at(d.get("temperature_2m_max"), i),
                         _at(d.get("temperature_2m_min"), i), rh, MODEL_NOTE,
                         loc.get("latitude"), loc.get("longitude"), loc.get("elevation"), retrieved_at, ARCHIVE_ID, "HISTORICAL"))
    return rows

def daily_mean_rh(resp, district_ids, min_hours=18) -> dict:
    out = {}
    for did, loc in zip(district_ids, _as_list(resp)):
        h = loc.get("hourly") or {}
        buckets = defaultdict(list)
        for t, v in zip(h.get("time") or [], h.get("relative_humidity_2m") or []):
            if v is not None:
                buckets[t[:10]].append(v)
        for day, vals in buckets.items():
            if len(vals) >= min_hours:
                out[(did, day)] = round(sum(vals) / len(vals), 1)
    return out

def parse_forecast(resp, district_ids, retrieved_at):
    cur_rows, hr_rows = [], []
    for did, loc in zip(district_ids, _as_list(resp)):
        c = loc.get("current") or {}
        if c.get("time"):
            cur_rows.append((did, c["time"] + "Z" if not c["time"].endswith("Z") else c["time"], retrieved_at,
                             to_float(c.get("temperature_2m")), to_float(c.get("relative_humidity_2m")),
                             to_float(c.get("precipitation")), c.get("weather_code"), FORECAST_ID, "FORECAST"))
        h = loc.get("hourly") or {}
        for i, t in enumerate(h.get("time") or []):
            hr_rows.append((did, t + "Z" if not t.endswith("Z") else t, retrieved_at,
                            _at(h.get("temperature_2m"), i), _at(h.get("precipitation"), i), _at(h.get("rain"), i),
                            _at(h.get("relative_humidity_2m"), i), (h.get("weather_code") or [None] * (i + 1))[i],
                            _at(h.get("pressure_msl"), i), _at(h.get("precipitation_probability"), i), FORECAST_ID, "FORECAST"))
    return cur_rows, hr_rows

def _coords(ids):
    return ",".join(str(centroid(i)[0]) for i in ids), ",".join(str(centroid(i)[1]) for i in ids)

def _get(s, url, params):
    r = s.get(url, params=params, timeout=90)
    if r.status_code != 200 or "json" not in r.headers.get("Content-Type", ""):
        raise RuntimeError(f"Open-Meteo HTTP {r.status_code}: {r.text[:200]}")
    body = r.json()
    if isinstance(body, dict) and body.get("error"):
        raise RuntimeError(f"Open-Meteo error: {body.get('reason')}")
    return body

def register(con):
    register_dataset(con, ARCHIVE_ID, "Open-Meteo Historical Weather (daily)", "Open-Meteo", "weather", ARCHIVE, None,
                     "HISTORICAL", "Open-Meteo data licence (CC BY 4.0, non-commercial free tier); check current terms",
                     "33 district centroids", 0, MODEL_NOTE)
    register_dataset(con, FORECAST_ID, "Open-Meteo Forecast (current + hourly)", "Open-Meteo", "weather", FORECAST, None,
                     "FORECAST", "Open-Meteo data licence; check current terms", "33 district centroids", 0,
                     "Modelled values. 'current' is model output, not a station observation.")

def ingest_archive(start="2023-01-01", end=None, chunk=5, with_humidity=False, session=None, con=None):
    s, own = session or _session(), con is None
    con = con or db(); register(con)
    end = end or (date.today() - timedelta(days=3)).isoformat()   # archive lags real time by a few days
    ids, total = all_ids(), 0
    with IngestionRun(con, ARCHIVE_ID, {"start": start, "end": end, "humidity": with_humidity}) as run:
        for k in range(0, len(ids), chunk):
            part = ids[k:k + chunk]
            lat, lon = _coords(part)
            base = dict(latitude=lat, longitude=lon, start_date=start, end_date=end, daily=DAILY, timezone="Asia/Kolkata")
            resp = _get(s, ARCHIVE, base)
            rh = {}
            if with_humidity:
                y0, y1 = int(start[:4]), int(end[:4])
                for y in range(y0, y1 + 1):
                    hr = _get(s, ARCHIVE, dict(latitude=lat, longitude=lon, timezone="Asia/Kolkata", hourly="relative_humidity_2m",
                                               start_date=max(start, f"{y}-01-01"), end_date=min(end, f"{y}-12-31")))
                    rh.update(daily_mean_rh(hr, part)); time.sleep(1)
            rows = parse_archive(resp, part, utc_now(), rh)
            run.fetched += len(rows)
            before = con.total_changes
            con.executemany("""INSERT INTO weather_historical_daily(district_id,obs_date,precipitation_sum_mm,rain_sum_mm,precipitation_hours,
                temp_max_c,temp_min_c,relative_humidity_mean_pct,model_note,grid_lat,grid_lon,grid_elevation_m,retrieved_at,source_id,data_status)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(district_id,obs_date,source_id) DO UPDATE SET precipitation_sum_mm=excluded.precipitation_sum_mm,
                rain_sum_mm=excluded.rain_sum_mm, precipitation_hours=excluded.precipitation_hours, temp_max_c=excluded.temp_max_c,
                temp_min_c=excluded.temp_min_c, relative_humidity_mean_pct=COALESCE(excluded.relative_humidity_mean_pct, relative_humidity_mean_pct),
                retrieved_at=excluded.retrieved_at""", rows)
            run.inserted += con.total_changes - before; con.commit(); time.sleep(1)
    if own: con.close()
    return run.fetched

def ingest_forecast(session=None, con=None):
    s, own = session or _session(), con is None
    con = con or db(); register(con)
    ids = all_ids(); lat, lon = _coords(ids)
    with IngestionRun(con, FORECAST_ID, {}) as run:
        resp = _get(s, FORECAST, dict(latitude=lat, longitude=lon, current=CUR, hourly=HOURLY, past_days=1, forecast_days=7, timezone="UTC"))
        cur, hr = parse_forecast(resp, ids, utc_now())
        run.fetched = len(cur) + len(hr); before = con.total_changes
        con.executemany("INSERT OR REPLACE INTO weather_current(district_id,observed_at,retrieved_at,temperature_c,relative_humidity_pct,precipitation_mm,weather_code,source_id,data_status) VALUES(?,?,?,?,?,?,?,?,?)", cur)
        con.executemany("INSERT OR REPLACE INTO weather_forecast_hourly(district_id,valid_at,retrieved_at,temperature_c,precipitation_mm,rain_mm,relative_humidity_pct,weather_code,pressure_msl_hpa,precip_probability_pct,source_id,data_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", hr)
        run.inserted = con.total_changes - before; con.commit()
    if own: con.close()
    return run.fetched
