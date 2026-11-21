"""Derived hydrological features + data-completeness matrix (computed only from stored observations)."""
from __future__ import annotations
from datetime import datetime, timedelta, timezone
from .common import db, utc_now
from .districts import all_ids

def _dt(s): return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)

def river_rise(readings, hours: float, tol_h: float = 0.5):
    """readings: [(iso_ts, level_m|None)] sorted ascending. Returns dict(rise_m, rate_m_per_h, dt_h) or None.
    The comparison reading is the one whose age is closest to `hours`, accepted only if within +/- tol_h.
    The rate always uses the ACTUAL elapsed time, so irregular telemetry intervals are handled correctly."""
    pts = [(_dt(t), v) for t, v in readings if v is not None]
    if len(pts) < 2: return None
    t0, v0 = pts[-1]
    best = None
    for t, v in pts[:-1]:
        gap = (t0 - t).total_seconds() / 3600
        err = abs(gap - hours)
        if err <= tol_h and (best is None or err < best[0]): best = (err, gap, v)
    if not best: return None
    _, gap, v = best
    return {"rise_m": round(v0 - v, 3), "rate_m_per_h": round((v0 - v) / gap, 3), "dt_h": round(gap, 2)}

def freshness_status(last_obs: str | None, as_of: datetime) -> str:
    if not last_obs: return "UNAVAILABLE"
    age = (as_of - _dt(last_obs)).total_seconds() / 3600
    return "LIVE" if age <= 3 else "STALE" if age <= 72 else "HISTORICAL"

def build_hydrology_features(con=None, as_of: datetime | None = None) -> int:
    own, con = con is None, con or db()
    as_of = as_of or datetime.now(timezone.utc)
    iso = as_of.strftime("%Y-%m-%dT%H:%M:%SZ"); n = 0
    for did in all_ids():
        riv = con.execute("SELECT station_name, observed_at, water_level_m FROM river_level_observations WHERE district_id=? AND observed_at<=? AND observed_at>=? ORDER BY station_name, observed_at",
                          (did, iso, (as_of - timedelta(hours=12)).strftime("%Y-%m-%dT%H:%M:%SZ"))).fetchall()
        by = {}
        for r in riv: by.setdefault(r["station_name"], []).append((r["observed_at"], r["water_level_m"]))
        latest = max(((s[-1][0], s[-1][1]) for s in by.values() if s[-1][1] is not None), default=None)
        r1 = [x["rise_m"] for x in (river_rise(s, 1, 0.5) for s in by.values()) if x]
        r3 = [x["rise_m"] for x in (river_rise(s, 3, 0.75) for s in by.values()) if x]
        rain = con.execute("SELECT station_name, COUNT(rainfall_mm) n, SUM(rainfall_mm) s FROM rainfall_station_observations WHERE district_id=? AND observed_at>? AND observed_at<=? AND quality_flag='OK' GROUP BY station_name",
                           (did, (as_of - timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%SZ"), iso)).fetchall()
        rain_ok = [r["s"] for r in rain if r["n"] >= 12]   # need >=12 valid hourly readings
        gw = con.execute("SELECT station_name, observed_at, groundwater_level_m FROM groundwater_observations WHERE district_id=? AND groundwater_level_m IS NOT NULL AND observed_at<=? ORDER BY station_name, observed_at", (did, iso)).fetchall()
        gws = {}
        for g in gw: gws.setdefault(g["station_name"], []).append((g["observed_at"], g["groundwater_level_m"]))
        gw_latest = [s[-1][1] for s in gws.values()]
        chg = []
        for s in gws.values():
            t0 = _dt(s[-1][0]); ref = [(abs((t0 - _dt(t)).total_seconds() / 86400 - 7), v) for t, v in s[:-1]]
            ref = [x for x in ref if x[0] <= 1]
            if ref: chg.append(s[-1][1] - min(ref)[1])
        last_obs = max([x for x in [latest[0] if latest else None] + [s[-1][0] for s in gws.values()]
                        + [r["observed_at"] for r in con.execute("SELECT observed_at FROM rainfall_station_observations WHERE district_id=? AND observed_at<=? ORDER BY observed_at DESC LIMIT 1", (did, iso))] if x], default=None)
        status = freshness_status(last_obs, as_of)
        con.execute("""INSERT OR REPLACE INTO district_hydrology_features(district_id,as_of,n_river_stations,latest_river_level_m,latest_river_observed_at,river_rise_1h_m,river_rise_3h_m,
            n_rain_stations,station_rain_24h_mm,groundwater_latest_m,groundwater_change_7d_m,data_status,computed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (did, iso, len(by), latest[1] if latest else None, latest[0] if latest else None, max(r1) if r1 else None, max(r3) if r3 else None,
             len(rain), max(rain_ok) if rain_ok else None, round(sum(gw_latest) / len(gw_latest), 3) if gw_latest else None,
             round(sum(chg) / len(chg), 3) if chg else None, status, utc_now()))
        n += 1
    con.commit()
    if own: con.close()
    return n

DATASET_TABLES = {
    "weather_historical": ("weather_historical_daily", "obs_date"), "weather_forecast": ("weather_forecast_hourly", "valid_at"),
    "station_rainfall": ("rainfall_station_observations", "observed_at"), "groundwater": ("groundwater_observations", "observed_at"),
    "river_level": ("river_level_observations", "observed_at"), "reservoir": ("reservoir_observations", "observed_at"),
}

def build_completeness(con=None) -> int:
    own, con = con is None, con or db()
    now, rows = utc_now(), 0
    for did in all_ids():
        for key, (tbl, col) in DATASET_TABLES.items():
            r = con.execute(f"SELECT COUNT(*) n, MAX({col}) m FROM {tbl} WHERE district_id=?", (did,)).fetchone()
            con.execute("INSERT OR REPLACE INTO district_data_completeness VALUES(?,?,?,?,?,?)",
                        (did, key, "AVAILABLE" if r["n"] else "MISSING", r["n"], r["m"], now)); rows += 1
        r = con.execute("SELECT 1 FROM district_terrain_features WHERE district_id=?", (did,)).fetchone()
        con.execute("INSERT OR REPLACE INTO district_data_completeness VALUES(?,?,?,?,?,?)",
                    (did, "terrain_dem", "ESTIMATED" if r else "MISSING", 1 if r else 0, None, now)); rows += 1
    con.commit()
    if own: con.close()
    return rows
