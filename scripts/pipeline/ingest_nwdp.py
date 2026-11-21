"""Ingest NWDP/NWIC telemetry into SQLite: rainfall, groundwater, river level; inspect reservoirs.

Design rules
 * Field names are discovered from the resource schema (pick_field); a schema report is always written.
 * Missing/invalid values stay NULL; a real 0 stays 0.
 * District names are normalised to canonical ids; unmatched names are kept raw, id NULL, and reported.
 * Re-running is idempotent (UNIQUE constraints + INSERT OR IGNORE) and incremental (newest-first, stops at the
   newest already-stored timestamp).
 * Nothing is labelled LIVE: telemetry freshness is computed from observed_at at read time.
"""
from __future__ import annotations
import json
from collections import Counter
from .common import db, register_dataset, IngestionRun, utc_now, to_float, write_quality_report, ROOT
from .districts import normalize_district
from .nwdp import CkanClient, pick_field, parse_ts

RESOURCES = {
    "nwdp_rainfall_telangana_sw": dict(resource_id="afe7a84b-dc63-4172-8a7f-cadf49403b46", kind="rainfall",
                                       agency="Telangana SW", name="NWDP Telangana hourly telemetry rainfall"),
    "nwdp_groundwater_telangana_gw": dict(resource_id="ce37832e-2783-423f-90e2-ab40eaa32ed1", kind="groundwater",
                                          agency="Telangana GW", name="NWDP Telangana 6-hourly groundwater level telemetry"),
    "nwdp_river_godavari": dict(resource_id="102af52d-5654-4823-b4e6-99c96bec91d0", kind="river",
                                agency=None, name="NWDP Godavari river water-level telemetry"),
    "nwdp_river_krishna": dict(resource_id="b3ab306b-5625-4b6a-b2bd-8f429dab98cc", kind="river",
                               agency=None, name="NWDP Krishna river water-level telemetry"),
    "nwdp_reservoir_candidate_a": dict(resource_id="2aaf4f3c-7f3c-4c3b-986a-60edb610548a", kind="reservoir",
                                       agency=None, name="NWDP reservoir candidate A (identity UNVERIFIED)"),
    "nwdp_reservoir_candidate_b": dict(resource_id="b255a41d-969d-449b-ba1f-b8a3b8f31fb9", kind="reservoir",
                                       agency=None, name="NWDP reservoir candidate B (identity UNVERIFIED)"),
}
ENDPOINT = "https://nwdp.nwic.gov.in/api/3/action/datastore_search"
LICENCE_NOTE = "NWDP/NWIC open-data portal terms apply. Verify licence on the resource page before redistribution."

def register_all(con):
    for did, r in RESOURCES.items():
        register_dataset(con, did, r["name"], "NWDP / NWIC (Government of India)", r["kind"], ENDPOINT,
                         r["resource_id"], "UNVERIFIED", LICENCE_NOTE, None, 0,
                         "Schema discovered at ingestion; see data/quality_reports/")

# ---- schema ---------------------------------------------------------------------------------
def discover_schema(kind: str, field_ids: list[str]) -> dict:
    p = lambda *n, **k: pick_field(field_ids, *n, **k)
    district = p("district", exclude=("lgd", "code"))
    common = dict(station=p("station", exclude=("code", "id")) or p("station"), district=district,
                  time=p("acquisition") or p("time") or p("date"))
    if kind == "rainfall":
        return {**common, "value": p("rainfall") or p("rain"), "lat": p("lat"), "lon": p("lon")}
    if kind == "groundwater":
        return {**common, "value": p("groundwater", "level") or p("water", "level") or p("level"),
                "lat": p("lat"), "lon": p("lon")}
    if kind == "river":
        return {**common, "value": p("water", "level", exclude=("rate", "change")) or p("level", exclude=("rate", "change")),
                "lgd": p("lgd"), "river": p("river", exclude=("water", "level", "telemetry", "basin")), "basin": p("basin"), "tributary": p("tributary"),
                "lat": p("lat"), "lon": p("lon"), "msl": p("mean", "sea") or p("msl"), "zero_gauge": p("zero", "gauge")}
    raise ValueError(kind)

def _filters(fields: list[str], agency: str | None) -> dict | None:
    if not agency:
        return None
    f = pick_field(fields, "agency")
    return {f: agency} if f else None

def _last_ts(con, table: str, source_id: str) -> str | None:
    row = con.execute(f"SELECT MAX(observed_at) m FROM {table} WHERE source_id=?", (source_id,)).fetchone()
    return row["m"] if row else None

# ---- row mappers ----------------------------------------------------------------------------
def _common(rec, sch):
    raw_d = rec.get(sch["district"]) if sch.get("district") else None
    return dict(station=(str(rec.get(sch["station"])).strip() if sch.get("station") and rec.get(sch["station"]) else None),
                district_raw=raw_d, district_id=normalize_district(raw_d), ts=parse_ts(rec.get(sch["time"])) if sch.get("time") else None,
                lat=to_float(rec.get(sch["lat"])) if sch.get("lat") else None,
                lon=to_float(rec.get(sch["lon"])) if sch.get("lon") else None)

def _flag_coords(lat, lon):
    if lat is None or lon is None:
        return None
    return "OK" if (15.5 <= lat <= 20.0 and 77.0 <= lon <= 81.8) else "COORD_OUTSIDE_TELANGANA_BOX"

def ingest(dataset_id: str, client: CkanClient | None = None, max_records: int | None = None, con=None) -> dict:
    cfg = RESOURCES[dataset_id]
    kind = cfg["kind"]
    if kind == "reservoir":
        raise ValueError("Reservoir resources are inspect-only until identity is verified (see inspect_reservoir).")
    client = client or CkanClient()
    own = con is None
    con = con or db()
    register_all(con)
    desc = client.describe(cfg["resource_id"])
    fields = [f["id"] for f in desc["fields"]]
    sch = discover_schema(kind, fields)
    missing = [k for k in ("station", "time", "value") if not sch.get(k)]
    report = {"dataset_id": dataset_id, "resource_id": cfg["resource_id"], "total_records_reported": desc["total"],
              "fields": desc["fields"], "discovered_mapping": sch, "missing_required": missing,
              "unit_hint": [f for f in fields if "(mm)" in f or "(meter)" in f or "(m)" in f.lower()],
              "generated_at": utc_now()}
    if missing:
        report["status"] = "SCHEMA_MISMATCH"
        write_quality_report(f"schema_{dataset_id}", report)
        raise RuntimeError(f"{dataset_id}: could not discover required fields {missing}. See quality report.")

    table = {"rainfall": "rainfall_station_observations", "groundwater": "groundwater_observations",
             "river": "river_level_observations"}[kind]
    last = _last_ts(con, table, dataset_id)
    sort = f"{sch['time']} desc"
    filters = _filters(fields, cfg["agency"])
    unmatched, flags = Counter(), Counter()
    now = utc_now()
    with IngestionRun(con, dataset_id, {"max_records": max_records, "since": last, "filters": filters}) as run:
        for rec in client.iter_records(cfg["resource_id"], filters=filters, max_records=max_records, sort=sort):
            run.fetched += 1
            c = _common(rec, sch)
            if not c["station"] or not c["ts"]:
                run.rejected += 1; flags["REJECT_NO_STATION_OR_TIME"] += 1; continue
            if last and c["ts"] <= last:
                break  # incremental: everything older is already stored
            val = to_float(rec.get(sch["value"]))
            q = _flag_coords(c["lat"], c["lon"]) or "OK"
            if c["district_raw"] and not c["district_id"]:
                unmatched[str(c["district_raw"])] += 1
            if kind == "rainfall" and val is not None:
                if val < 0: val, q = None, "NEGATIVE_RAINFALL_REJECTED"
                elif val > 300: q = "IMPLAUSIBLE_GT_300MM_PER_HOUR"
            if val is None and q == "OK":
                q = "VALUE_MISSING"
            flags[q] += 1
            before = con.total_changes
            if kind == "rainfall":
                con.execute("INSERT OR IGNORE INTO rainfall_station_observations(station_name,district_id,district_raw,latitude,longitude,observed_at,rainfall_mm,source_id,retrieved_at,quality_flag) VALUES(?,?,?,?,?,?,?,?,?,?)",
                            (c["station"], c["district_id"], c["district_raw"], c["lat"], c["lon"], c["ts"], val, dataset_id, now, q))
            elif kind == "groundwater":
                con.execute("INSERT OR IGNORE INTO groundwater_observations(station_name,district_id,district_raw,latitude,longitude,observed_at,groundwater_level_m,datum_note,source_id,retrieved_at,quality_flag) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                            (c["station"], c["district_id"], c["district_raw"], c["lat"], c["lon"], c["ts"], val,
                             "Reference datum not stated in resource fields (bgl vs amsl unverified)", dataset_id, now, q))
            else:
                g = lambda k: rec.get(sch[k]) if sch.get(k) else None
                con.execute("INSERT OR IGNORE INTO river_level_observations(station_name,district_id,district_raw,district_lgd,river,basin,tributary,latitude,longitude,msl_m,zero_gauge_m,observed_at,water_level_m,source_id,retrieved_at,quality_flag) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                            (c["station"], c["district_id"], c["district_raw"], g("lgd"), g("river"), g("basin"), g("tributary"),
                             c["lat"], c["lon"], to_float(g("msl")), to_float(g("zero_gauge")), c["ts"], val, dataset_id, now, q))
            run.inserted += con.total_changes - before
        con.commit()
    report.update(status="OK", records_fetched=run.fetched, records_inserted=run.inserted, records_rejected=run.rejected,
                  unmatched_district_names=dict(unmatched), quality_flag_counts=dict(flags))
    write_quality_report(f"ingest_{dataset_id}", report)
    if own:
        con.close()
    return report

# ---- reservoirs: inspect first, ingest only after the user verifies identity -----------------
HINTS = {"inflow": ("inflow",), "outflow": ("outflow",), "discharge": ("discharge",), "storage": ("storage", "volume", "live"),
         "water_level": ("level", "elevation", "frl"), "capacity": ("capacity", "gross")}

def inspect_reservoir(dataset_id: str, client: CkanClient | None = None) -> dict:
    cfg = RESOURCES[dataset_id]
    client = client or CkanClient()
    desc = client.describe(cfg["resource_id"])
    ids = [f["id"] for f in desc["fields"]]
    caps = {k: [f for f in ids if any(h in f.lower() for h in hs)] for k, hs in HINTS.items()}
    name_like = [f for f in ids if any(x in f.lower() for x in ("dam", "reservoir", "project", "station", "name"))]
    names = Counter()
    for rec in desc["sample"]:
        for f in name_like:
            if rec.get(f): names[(f, str(rec[f]))] += 1
    rep = {"dataset_id": dataset_id, "resource_id": cfg["resource_id"], "total_records_reported": desc["total"],
           "fields": desc["fields"], "capability_hints": caps, "identity_columns": name_like,
           "sample_identity_values": [{"field": k[0], "value": k[1]} for k in names],
           "verdict": "IDENTITY_UNVERIFIED: a human must confirm the reservoir name before ingestion",
           "how_to_verify": "Open the resource page on nwdp.nwic.gov.in, confirm the dam/station name, then add an entry to data/metadata/reservoir_resources.json",
           "generated_at": utc_now()}
    write_quality_report(f"reservoir_inspect_{dataset_id}", rep)
    return rep

def ingest_reservoir_verified(dataset_id: str, client: CkanClient | None = None, con=None, max_records: int | None = None) -> dict:
    """Only runs for resources the user has verified in data/metadata/reservoir_resources.json."""
    path = ROOT / "data" / "metadata" / "reservoir_resources.json"
    if not path.exists():
        raise RuntimeError("data/metadata/reservoir_resources.json not found: reservoir identity is unverified.")
    cfgs = json.loads(path.read_text())
    cfg = next((c for c in cfgs if c.get("dataset_id") == dataset_id and c.get("verified") is True), None)
    if not cfg:
        raise RuntimeError(f"{dataset_id} is not marked verified:true in reservoir_resources.json")
    fm = cfg["field_map"]  # {"name":..., "time":..., "inflow":..., "outflow":..., "storage":..., "water_level":..., "capacity":...}
    client = client or CkanClient()
    own = con is None
    con = con or db()
    now = utc_now()
    with IngestionRun(con, dataset_id, {"verified_reservoir": cfg["reservoir_name"]}) as run:
        for rec in client.iter_records(RESOURCES[dataset_id]["resource_id"], max_records=max_records):
            run.fetched += 1
            ts = parse_ts(rec.get(fm["time"]))
            if not ts:
                run.rejected += 1; continue
            g = lambda k: to_float(rec.get(fm[k])) if fm.get(k) else None
            before = con.total_changes
            con.execute("INSERT OR IGNORE INTO reservoir_observations(reservoir_name,district_id,river,observed_at,inflow,outflow,storage,water_level,capacity,units_json,identity_verified,source_id,retrieved_at,quality_flag) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (cfg["reservoir_name"], normalize_district(cfg.get("district")), cfg.get("river"), ts, g("inflow"), g("outflow"),
                         g("storage"), g("water_level"), g("capacity"), json.dumps(cfg.get("units", {})), 1, dataset_id, now, "OK"))
            run.inserted += con.total_changes - before
        con.commit()
    if own: con.close()
    return {"dataset_id": dataset_id, "fetched": run.fetched, "inserted": run.inserted}
