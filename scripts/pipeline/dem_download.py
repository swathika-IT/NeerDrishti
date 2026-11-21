"""Download SRTM GL1 30 m for the Telangana bounding box from OpenTopography. Key from env only."""
from __future__ import annotations
import os
from pathlib import Path
from .common import ROOT, make_session

URL = "https://portal.opentopography.org/API/globaldem"
BBOX = dict(south=15.8, north=19.9, west=77.2, east=81.3)

def download(out: Path | None = None, force=False) -> Path:
    key = os.environ.get("OPENTOPOGRAPHY_API_KEY")
    if not key:
        raise RuntimeError("Set OPENTOPOGRAPHY_API_KEY (free key from https://opentopography.org/). Never commit it.")
    out = out or ROOT / "data" / "raw" / "dem" / "telangana_srtm_30m.tif"
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists() and not force:
        print(f"[dem] exists, skipping: {out}"); return out
    s = make_session()
    with s.get(URL, params=dict(demtype="SRTMGL1", outputFormat="GTiff", API_Key=key, **BBOX), stream=True, timeout=600) as r:
        if r.status_code != 200 or "tiff" not in r.headers.get("Content-Type", "").lower() and "octet" not in r.headers.get("Content-Type", "").lower():
            raise RuntimeError(f"OpenTopography HTTP {r.status_code}: {r.text[:200]}")
        tmp = out.with_suffix(".part")
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(1 << 20): f.write(chunk)
    tmp.replace(out)
    return out
