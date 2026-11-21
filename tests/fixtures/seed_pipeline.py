"""SYNTHETIC seed used only by tests/pipeline_contract.test.ts to verify the Python->SQLite->Node contract."""
import os, sys
from datetime import datetime, timedelta, timezone
sys.path.insert(0, os.getcwd())
from scripts.pipeline import ingest_nwdp as N, openmeteo as O, features as F
from scripts.pipeline.common import db

class Fake:
    def __init__(s, fields, recs): s.f, s.r = fields, recs
    def describe(s, rid): return {"resource_id": rid, "total": len(s.r), "fields": [{"id": x, "type": "text"} for x in s.f], "sample": s.r[:5]}
    def iter_records(s, rid, filters=None, page=1000, max_records=None, sort=None):
        k = [f for f in s.f if "acquisition" in f.lower()][0]; yield from sorted(s.r, key=lambda r: r[k], reverse=True)

ist = lambda dt: (dt + timedelta(hours=5, minutes=30)).strftime("%Y-%m-%d %H:%M:%S")
now = datetime.now(timezone.utc).replace(microsecond=0)
con = db()
RF = ["District", "Station", "Data Acquisition Time", "River Water Level Telemetry (meter)", "River", "Latitude", "Longitude"]
fresh = [{"District": "Bhadradri Kothagudem", "Station": "SYN-Bhadrachalam", "River": "Godavari", "Latitude": "17.67", "Longitude": "80.88",
          "Data Acquisition Time": ist(now - timedelta(minutes=m)), "River Water Level Telemetry (meter)": str(40 + (180 - m) / 60)} for m in (180, 120, 60, 30, 0)]
old = [{"District": "Nirmal", "Station": "SYN-OldGauge", "River": "Godavari", "Latitude": "19.1", "Longitude": "78.3",
        "Data Acquisition Time": ist(now - timedelta(days=40)), "River Water Level Telemetry (meter)": "5.5"}]
N.ingest("nwdp_river_godavari", client=Fake(RF, fresh + old), con=con)
O.register(con)
H = ["2025-07-01", "2025-07-02"]
resp = [{"latitude": 19.1, "longitude": 79.5, "elevation": 300.0, "daily": {"time": H, "precipitation_sum": [0.0, None], "rain_sum": [0.0, None], "precipitation_hours": [0, None], "temperature_2m_max": [30, None], "temperature_2m_min": [22, None]}}]
rows = O.parse_archive(resp, ["adilabad"], "2026-11-20T00:00:00Z")
con.executemany("INSERT INTO weather_historical_daily VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows); con.commit()
F.build_hydrology_features(con); F.build_completeness(con)
print("seeded")
