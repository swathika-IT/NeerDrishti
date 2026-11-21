import sqlite3, sys
from pathlib import Path
import pytest
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from scripts.pipeline.districts import catalog

@pytest.fixture()
def con(tmp_path, monkeypatch):
    """Fresh SQLite DB: districts table + migration 004 (the only schema the pipeline needs)."""
    c = sqlite3.connect(tmp_path / "t.db"); c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys=ON")
    c.execute("CREATE TABLE districts(district_id TEXT PRIMARY KEY, district_name TEXT NOT NULL UNIQUE, monitoring_category TEXT, region_zone TEXT, data_source_mode TEXT, data_confidence TEXT)")
    for d in catalog().values():
        c.execute("INSERT INTO districts VALUES(?,?,?,?,?,?)", (d["district_id"], d["district_name"], d["monitoring_category"], d["region_zone"], d["data_source_mode"], d["data_confidence"]))
    c.executescript((ROOT / "migrations" / "004_data_pipeline.sql").read_text())
    monkeypatch.setattr("scripts.pipeline.common.ROOT", tmp_path)   # keep quality reports out of the repo
    (tmp_path / "data" / "quality_reports").mkdir(parents=True)
    (tmp_path / "data" / "metadata").mkdir(parents=True)
    monkeypatch.setattr("scripts.pipeline.ingest_nwdp.ROOT", tmp_path)
    yield c
    c.close()
