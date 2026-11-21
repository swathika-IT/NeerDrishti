"""Canonical Telangana district catalogue + name normalisation.

Source of truth: data/telangana_districts.json (33 districts, canonical district_id).
Unknown names return None. They are never guessed; callers must record the reject.
"""
from __future__ import annotations
import json, re
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CATALOG_PATH = ROOT / "data" / "telangana_districts.json"

# Alias keys are normalised (lowercase alphanumerics only). Values are canonical district_ids.
# "warangalurban"/"warangalrural" are the pre-2021 names: Warangal Urban became Hanumakonda,
# Warangal Rural became Warangal. Mapping them is a documented historical-name decision.
ALIASES = {
    "medchalmalkajgiri": "medchal_malkajgiri", "medchal": "medchal_malkajgiri", "malkajgiri": "medchal_malkajgiri",
    "rangareddy": "ranga_reddy", "rangareddi": "ranga_reddy",
    "jayashankarbhoopalpally": "jayashankar_bhupalpally", "jayashankar": "jayashankar_bhupalpally",
    "jayashankarbhupalapally": "jayashankar_bhupalpally",
    "kumurambheemasifabad": "kumuram_bheem_asifabad", "komarambheem": "kumuram_bheem_asifabad",
    "komarambheemasifabad": "kumuram_bheem_asifabad", "asifabad": "kumuram_bheem_asifabad",
    "bhadradri": "bhadradri_kothagudem", "kothagudem": "bhadradri_kothagudem",
    "bhadradrikothagudem": "bhadradri_kothagudem",
    "yadadri": "yadadri_bhuvanagiri", "bhongir": "yadadri_bhuvanagiri", "yadadribhongir": "yadadri_bhuvanagiri",
    "gadwal": "jogulamba_gadwal", "jogulambagadwal": "jogulamba_gadwal",
    "sircilla": "rajanna_sircilla", "rajannasircilla": "rajanna_sircilla",
    "hanamkonda": "hanumakonda", "warangalurban": "hanumakonda", "warangalrural": "warangal",
    "mahbubnagar": "mahabubnagar", "mahbubabad": "mahabubabad",
    "nagarkurnool": "nagarkurnool", "jangoan": "jangaon", "kamareddi": "kamareddy",
    "peddapalle": "peddapalli", "sangareddi": "sangareddy", "karimnagar": "karimnagar",
}

def _key(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())

@lru_cache(maxsize=1)
def catalog() -> dict[str, dict]:
    rows = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    return {r["district_id"]: r for r in rows}

@lru_cache(maxsize=1)
def _index() -> dict[str, str]:
    idx: dict[str, str] = {}
    for did, r in catalog().items():
        idx[_key(r["district_name"])] = did
        idx[_key(did)] = did
    for alias, did in ALIASES.items():
        if did in catalog():
            idx.setdefault(alias, did)
    return idx

def normalize_district(raw: str | None) -> str | None:
    """Return the canonical district_id, or None if the name cannot be matched exactly."""
    if raw is None:
        return None
    return _index().get(_key(str(raw)))

def all_ids() -> list[str]:
    return sorted(catalog())

def centroid(district_id: str) -> tuple[float, float]:
    r = catalog()[district_id]
    return float(r["latitude"]), float(r["longitude"])
