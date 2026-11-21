"""Shared helpers: HTTP session (TLS verification ON), SQLite access, registry/run logging."""
from __future__ import annotations
import json, os, sqlite3, time
from datetime import datetime, timezone
from pathlib import Path
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

ROOT = Path(__file__).resolve().parents[2]
DB_PATH = Path(os.environ.get("DATABASE_PATH") or ROOT / "data" / "neerdrishti.db")
UA = "NeerDrishti-DataPipeline/1.0 (academic flood-information prototype)"

def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def make_session(total_retries: int = 4, backoff: float = 1.5) -> requests.Session:
    """Session with retry/backoff. TLS verification is always on.

    If a government host has an incomplete certificate chain, set NWDP_CA_BUNDLE to a PEM file that
    contains the missing intermediate certificate. Never disable verification.
    """
    s = requests.Session()
    retry = Retry(total=total_retries, backoff_factor=backoff,
                  status_forcelist=(429, 500, 502, 503, 504), allowed_methods=("GET", "POST"),
                  respect_retry_after_header=True)
    s.mount("https://", HTTPAdapter(max_retries=retry))
    s.mount("http://", HTTPAdapter(max_retries=retry))
    s.headers.update({"User-Agent": UA})
    bundle = os.environ.get("NWDP_CA_BUNDLE")
    if bundle:
        s.verify = bundle
    return s

def db(path: Path | str | None = None) -> sqlite3.Connection:
    con = sqlite3.connect(str(path or DB_PATH), timeout=30)
    con.execute("PRAGMA foreign_keys=ON")
    con.execute("PRAGMA journal_mode=WAL")
    con.row_factory = sqlite3.Row
    return con

def register_dataset(con, dataset_id, name, provider, data_type, endpoint=None, resource_id=None,
                     default_status="UNVERIFIED", licence=None, coverage_note=None, verified=0, notes=None):
    con.execute(
        """INSERT INTO dataset_registry(dataset_id,name,provider,endpoint,resource_id,data_type,default_status,
               licence,coverage_note,verified,notes,registered_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(dataset_id) DO UPDATE SET name=excluded.name, provider=excluded.provider,
               endpoint=excluded.endpoint, resource_id=excluded.resource_id, data_type=excluded.data_type,
               licence=COALESCE(excluded.licence, dataset_registry.licence),
               coverage_note=COALESCE(excluded.coverage_note, dataset_registry.coverage_note),
               notes=COALESCE(excluded.notes, dataset_registry.notes)""",
        (dataset_id, name, provider, endpoint, resource_id, data_type, default_status, licence,
         coverage_note, verified, notes, utc_now()))
    con.commit()

class IngestionRun:
    """Context manager that records an ingestion_runs row, including failures."""
    def __init__(self, con, dataset_id, params=None):
        self.con, self.dataset_id, self.params = con, dataset_id, params or {}
        self.fetched = self.inserted = self.rejected = 0
        self.run_id = None
    def __enter__(self):
        cur = self.con.execute(
            "INSERT INTO ingestion_runs(dataset_id,started_at,status,params_json) VALUES(?,?,?,?)",
            (self.dataset_id, utc_now(), "RUNNING", json.dumps(self.params, default=str)))
        self.run_id = cur.lastrowid
        self.con.commit()
        return self
    def __exit__(self, et, ev, tb):
        status = "FAILED" if et else ("PARTIAL" if self.rejected else "SUCCESS")
        self.con.execute(
            "UPDATE ingestion_runs SET finished_at=?, status=?, records_fetched=?, records_inserted=?, "
            "records_rejected=?, error_message=? WHERE run_id=?",
            (utc_now(), status, self.fetched, self.inserted, self.rejected,
             f"{et.__name__}: {ev}" if et else None, self.run_id))
        self.con.commit()
        return False  # never swallow errors

def write_quality_report(name: str, payload: dict) -> Path:
    out = ROOT / "data" / "quality_reports"
    out.mkdir(parents=True, exist_ok=True)
    p = out / f"{name}.json"
    p.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
    return p

def to_float(v):
    """Parse a numeric value; empty/'NA'/non-numeric -> None. A real 0 stays 0.0."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return None if v != v else float(v)
    s = str(v).strip()
    if s == "" or s.lower() in {"na", "n/a", "nan", "null", "none", "-", "--"}:
        return None
    try:
        return float(s.replace(",", ""))
    except ValueError:
        return None
