"""Pipeline tests. All fixtures are SYNTHETIC and only exercise parsing/validation logic. They are not data."""
import json
from datetime import datetime, timezone
import numpy as np, pytest
from scripts.pipeline.districts import catalog, normalize_district, ALIASES, all_ids
from scripts.pipeline import nwdp, ingest_nwdp as N, openmeteo as O, features as F

# ---------------- districts ----------------
def test_catalog_has_33_and_every_name_round_trips():
    assert len(catalog()) == 33
    for did, r in catalog().items():
        assert normalize_district(r["district_name"]) == did
        assert normalize_district(did) == did

def test_every_alias_target_exists_and_unknown_is_none():
    assert all(t in catalog() for t in ALIASES.values()), [a for a, t in ALIASES.items() if t not in catalog()]
    assert normalize_district("Atlantis") is None and normalize_district(None) is None and normalize_district("") is None
    assert normalize_district("Warangal Urban") == "hanumakonda" and normalize_district("Rangareddy") == "ranga_reddy"

# ---------------- CKAN client ----------------
class Resp:
    def __init__(s, body, ctype="application/json", code=200): s._b, s.headers, s.status_code, s.text = body, {"Content-Type": ctype}, code, json.dumps(body)[:100] if not isinstance(body, str) else body
    def json(s): return s._b
class FakeSession:
    def __init__(s, pages): s.pages, s.calls = pages, []
    def get(s, url, params=None, timeout=0):
        s.calls.append(params); i = params.get("offset", 0) // max(1, params["limit"]); return s.pages[min(i, len(s.pages) - 1)]

def test_ckan_paginates_until_total():
    f = [{"id": "a"}]
    pages = [Resp({"success": True, "result": {"fields": f, "records": [{"a": 1}, {"a": 2}], "total": 3}}),
             Resp({"success": True, "result": {"fields": f, "records": [{"a": 3}], "total": 3}})]
    c = nwdp.CkanClient(session=FakeSession(pages), pause=0)
    assert [r["a"] for r in c.iter_records("rid", page=2)] == [1, 2, 3]

def test_ckan_rejects_html_response():
    c = nwdp.CkanClient(session=FakeSession([Resp("<html>blocked</html>", ctype="text/html")]), pause=0)
    with pytest.raises(nwdp.CkanError, match="expected JSON"): c.describe("rid")

def test_ckan_api_failure_raises():
    c = nwdp.CkanClient(session=FakeSession([Resp({"success": False, "error": {"message": "nope"}})]), pause=0)
    with pytest.raises(nwdp.CkanError): c.describe("rid")

def test_timestamp_assumed_ist_converted_to_utc():
    assert nwdp.parse_ts("2026-11-18 12:00:00") == "2026-11-18T06:30:00Z"
    assert nwdp.parse_ts("garbage") is None and nwdp.parse_ts("") is None

def test_river_schema_discovery_from_described_fields():
    fields = ["Station", "District", "District LGD Code", "River", "Basin", "Tributary", "Latitude", "Longitude",
              "Mean Sea Level", "Zero Gauge", "Data Acquisition Time", "River Water Level Telemetry (meter)"]
    s = N.discover_schema("river", fields)
    assert s["station"] == "Station" and s["district"] == "District" and s["lgd"] == "District LGD Code"
    assert s["value"] == "River Water Level Telemetry (meter)" and s["time"] == "Data Acquisition Time" and s["zero_gauge"] == "Zero Gauge"

# ---------------- ingestion ----------------
class FakeClient:
    def __init__(s, fields, records): s.fields, s.records = fields, records
    def describe(s, rid): return {"resource_id": rid, "total": len(s.records), "fields": [{"id": f, "type": "text"} for f in s.fields], "sample": s.records[:5]}
    def iter_records(s, rid, filters=None, page=1000, max_records=None, sort=None):
        key = [f for f in s.fields if "acquisition" in f.lower()][0]
        yield from sorted(s.records, key=lambda r: r[key], reverse=True)   # newest first, as sort= asks for

RAIN_FIELDS = ["Agency", "District", "Station", "Data Acquisition Time", "Telemetry Hourly Rainfall (mm)"]
def rain(station, ts, v, district="Nirmal"): return {"Agency": "Telangana SW", "District": district, "Station": station, "Data Acquisition Time": ts, "Telemetry Hourly Rainfall (mm)": v}

def test_rainfall_zero_vs_missing_negative_duplicates_and_unmatched(con):
    recs = [rain("S1", "2026-11-18 10:00:00", "0"), rain("S1", "2026-11-18 11:00:00", ""), rain("S1", "2026-11-18 12:00:00", "-5"),
            rain("S1", "2026-11-18 13:00:00", "12.5"), rain("S2", "2026-11-18 13:00:00", "400", district="Atlantis"),
            rain("", "2026-11-18 14:00:00", "1"), rain("S1", "bad-time", "1")]
    rep = N.ingest("nwdp_rainfall_telangana_sw", client=FakeClient(RAIN_FIELDS, recs), con=con)
    rows = {(r["station_name"], r["observed_at"]): r for r in con.execute("SELECT * FROM rainfall_station_observations")}
    assert rows[("S1", "2026-11-18T04:30:00Z")]["rainfall_mm"] == 0.0                       # genuine zero kept
    assert rows[("S1", "2026-11-18T05:30:00Z")]["rainfall_mm"] is None and rows[("S1", "2026-11-18T05:30:00Z")]["quality_flag"] == "VALUE_MISSING"
    assert rows[("S1", "2026-11-18T06:30:00Z")]["rainfall_mm"] is None and "NEGATIVE" in rows[("S1", "2026-11-18T06:30:00Z")]["quality_flag"]
    assert rows[("S1", "2026-11-18T07:30:00Z")]["rainfall_mm"] == 12.5
    bad = rows[("S2", "2026-11-18T07:30:00Z")]
    assert bad["district_id"] is None and bad["district_raw"] == "Atlantis" and "IMPLAUSIBLE" in bad["quality_flag"]
    assert rep["unmatched_district_names"] == {"Atlantis": 1} and rep["records_rejected"] == 2
    assert con.execute("SELECT status FROM ingestion_runs ORDER BY run_id DESC").fetchone()[0] == "PARTIAL"

def test_rerun_is_idempotent_and_incremental(con):
    recs = [rain("S1", "2026-11-18 10:00:00", "1"), rain("S1", "2026-11-18 11:00:00", "2")]
    N.ingest("nwdp_rainfall_telangana_sw", client=FakeClient(RAIN_FIELDS, recs), con=con)
    rep2 = N.ingest("nwdp_rainfall_telangana_sw", client=FakeClient(RAIN_FIELDS, recs), con=con)
    assert con.execute("SELECT COUNT(*) FROM rainfall_station_observations").fetchone()[0] == 2 and rep2["records_inserted"] == 0
    recs.append(rain("S1", "2026-11-18 12:00:00", "3"))
    assert N.ingest("nwdp_rainfall_telangana_sw", client=FakeClient(RAIN_FIELDS, recs), con=con)["records_inserted"] == 1

def test_schema_mismatch_fails_loudly_and_writes_report(con):
    with pytest.raises(RuntimeError, match="could not discover"):
        N.ingest("nwdp_rainfall_telangana_sw", client=FakeClient(["foo", "bar"], [{"foo": 1, "bar": 2}]), con=con)

def test_reservoir_is_inspect_only_until_verified(con):
    with pytest.raises(ValueError): N.ingest("nwdp_reservoir_candidate_a", client=FakeClient([], []), con=con)
    with pytest.raises(RuntimeError, match="unverified"): N.ingest_reservoir_verified("nwdp_reservoir_candidate_a", con=con)
    c = FakeClient(["Dam Name", "Inflow (cusecs)", "Outflow (cusecs)", "Data Acquisition Time"], [{"Dam Name": "X", "Inflow (cusecs)": "1", "Outflow (cusecs)": "2", "Data Acquisition Time": "2026-11-18 10:00:00"}])
    rep = N.inspect_reservoir("nwdp_reservoir_candidate_a", client=c)
    assert rep["verdict"].startswith("IDENTITY_UNVERIFIED") and rep["capability_hints"]["inflow"] == ["Inflow (cusecs)"]

# ---------------- river rise ----------------
def test_river_rise_uses_actual_elapsed_time_on_irregular_intervals():
    r = [("2026-11-18T06:00:00Z", 10.0), ("2026-11-18T08:30:00Z", 10.9), ("2026-11-18T09:00:00Z", 11.2)]
    one = F.river_rise(r, 1, 0.5)            # closest to 1h ago is 08:30 (0.5h gap): within tolerance
    assert one == {"rise_m": 0.3, "rate_m_per_h": 0.6, "dt_h": 0.5}
    three = F.river_rise(r, 3, 0.75)         # 06:00 is exactly 3h ago
    assert three["rise_m"] == 1.2 and three["rate_m_per_h"] == 0.4
    assert F.river_rise([("2026-11-18T06:00:00Z", 10.0), ("2026-11-18T09:00:00Z", None)], 3) is None  # null never treated as 0
    assert F.river_rise([("2026-11-18T08:00:00Z", 1.0), ("2026-11-18T09:00:00Z", 2.0)], 6) is None     # no comparison reading in tolerance

# ---------------- Open-Meteo ----------------
def test_archive_parse_keeps_nulls_and_grid_provenance():
    resp = [{"latitude": 19.1, "longitude": 79.5, "elevation": 301.0, "daily": {"time": ["2024-07-01", "2024-07-02"], "precipitation_sum": [0.0, None], "rain_sum": [0.0, None],
            "precipitation_hours": [0, None], "temperature_2m_max": [31.2, None], "temperature_2m_min": [24.0, None]}}]
    rows = O.parse_archive(resp, ["adilabad"], "2026-11-20T00:00:00Z")
    assert rows[0][2] == 0.0 and rows[1][2] is None and rows[0][9:12] == (19.1, 79.5, 301.0) and rows[0][-1] == "HISTORICAL"

def test_daily_humidity_requires_enough_hours():
    full = {"hourly": {"time": [f"2024-07-01T{h:02d}:00" for h in range(24)] + ["2024-07-02T00:00"], "relative_humidity_2m": [80] * 24 + [50]}}
    out = O.daily_mean_rh(full, ["adilabad"])
    assert out == {("adilabad", "2024-07-01"): 80.0}      # 2024-07-02 has 1 hour only -> not reported

def test_forecast_parse_marks_modelled_current_as_forecast():
    resp = {"current": {"time": "2026-11-20T06:00", "temperature_2m": 28.1, "relative_humidity_2m": 60, "precipitation": 0.0, "weather_code": 1},
            "hourly": {"time": ["2026-11-20T06:00", "2026-11-20T07:00"], "precipitation": [0.2, None], "temperature_2m": [28, 29], "rain": [0.2, None],
                       "relative_humidity_2m": [60, 61], "weather_code": [1, 2], "pressure_msl": [1008, 1007.5], "precipitation_probability": [20, None]}}
    cur, hr = O.parse_forecast(resp, ["adilabad"], "2026-11-20T06:05:00Z")
    assert cur[0][-1] == "FORECAST" and cur[0][5] == 0.0 and hr[1][4] is None and hr[0][1].endswith("Z")

# ---------------- feature layer ----------------
def test_hydrology_features_status_and_completeness(con):
    now = datetime(2026, 11, 18, 12, 0, tzinfo=timezone.utc)
    for ts, v in [("2026-11-18T09:00:00Z", 100.0), ("2026-11-18T11:00:00Z", 100.6), ("2026-11-18T11:30:00Z", 100.9)]:
        con.execute("INSERT INTO river_level_observations(station_name,district_id,river,observed_at,water_level_m,source_id,retrieved_at) VALUES('Bhadrachalam','bhadradri_kothagudem','Godavari',?,?, 'x','t')", (ts, v))
    for h in range(24):
        con.execute("INSERT INTO rainfall_station_observations(station_name,district_id,observed_at,rainfall_mm,source_id,retrieved_at) VALUES('R1','nirmal',?,?, 'x','t')",
                    (f"2026-11-18T{h:02d}:00:00Z" if h < 12 else f"2026-11-17T{h:02d}:00:00Z", 2.0 if h % 2 else 0.0))
    F.build_hydrology_features(con, as_of=now); F.build_completeness(con)
    b = con.execute("SELECT * FROM district_hydrology_features WHERE district_id='bhadradri_kothagudem'").fetchone()
    assert b["data_status"] == "LIVE" and b["river_rise_3h_m"] == 0.9 and b["latest_river_level_m"] == 100.9
    n = con.execute("SELECT * FROM district_hydrology_features WHERE district_id='nirmal'").fetchone()
    assert n["station_rain_24h_mm"] == 24.0 and n["n_rain_stations"] == 1
    a = con.execute("SELECT * FROM district_hydrology_features WHERE district_id='adilabad'").fetchone()
    assert a["data_status"] == "UNAVAILABLE" and a["station_rain_24h_mm"] is None and a["latest_river_level_m"] is None   # missing != 0
    assert con.execute("SELECT COUNT(*) FROM district_data_completeness").fetchone()[0] == 33 * 7
    assert con.execute("SELECT status FROM district_data_completeness WHERE district_id='nirmal' AND dataset_id='station_rainfall'").fetchone()[0] == "AVAILABLE"
    assert con.execute("SELECT status FROM district_data_completeness WHERE district_id='nirmal' AND dataset_id='reservoir'").fetchone()[0] == "MISSING"

def test_freshness_labels():
    now = datetime(2026, 11, 18, 12, 0, tzinfo=timezone.utc)
    assert F.freshness_status("2026-11-18T10:00:00Z", now) == "LIVE" and F.freshness_status("2026-11-17T12:00:00Z", now) == "STALE"
    assert F.freshness_status("2026-10-01T00:00:00Z", now) == "HISTORICAL" and F.freshness_status(None, now) == "UNAVAILABLE"


def test_field_matching_prefers_the_short_exact_column_regardless_of_order():
    """Regression: 'river' must map to the River column, not 'River Water Level Telemetry (meter)'."""
    fields = ["District", "Station", "River Water Level Telemetry (meter)", "River", "Basin", "Data Acquisition Time"]
    s = N.discover_schema("river", fields)
    assert s["river"] == "River" and s["value"] == "River Water Level Telemetry (meter)" and s["basin"] == "Basin"
    assert N.discover_schema("river", list(reversed(fields)))["river"] == "River"
    assert nwdp.pick_field(["Station Code", "Station"], "station", exclude=("code",)) == "Station"
    assert nwdp.pick_field(["a", "b"], "river") is None
