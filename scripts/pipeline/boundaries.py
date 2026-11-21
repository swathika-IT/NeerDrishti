"""District boundaries: inspect schema, filter Telangana, normalise names, validate, export lightweight GeoJSON.

Never assumes a property named STATE/DISTRICT exists: columns are inspected and the chosen ones are reported.
The original source file is never modified.
"""
from __future__ import annotations
import json
from pathlib import Path
import geopandas as gpd
from .common import ROOT, write_quality_report, utc_now
from .districts import normalize_district, all_ids

NAME_HINTS = ("district", "dtname", "dist_name", "distname", "name")
STATE_HINTS = ("state", "st_nm", "stname", "st_name")

def _find_col(cols, hints, exclude=()):
    low = {c.lower(): c for c in cols}
    for h in hints:
        for lc, c in low.items():
            if h in lc and not any(x in lc for x in exclude):
                return c
    return None

def process(src: str | Path, out: str | Path | None = None, simplify_deg: float = 0.0005) -> dict:
    src = Path(src)
    g = gpd.read_file(src)
    rep = {"source": str(src), "n_features_in": len(g), "columns": [c for c in g.columns if c != "geometry"],
           "crs_in": str(g.crs), "generated_at": utc_now()}
    if g.crs is None:
        raise RuntimeError("Source has no CRS; refusing to guess. Set it explicitly after verifying with the provider.")
    g = g.to_crs(4326)
    scol = _find_col(g.columns, STATE_HINTS)
    if scol:
        mask = g[scol].astype(str).str.contains("telangana", case=False, na=False)
        rep.update(state_column=scol, state_values_seen=sorted(map(str, g[scol].dropna().unique()))[:60])
        g = g[mask]
    else:   # no state column: fall back to geographic filter on centroids (Telangana bounding box)
        rep["state_column"] = None
        c = g.geometry.representative_point()
        g = g[(c.y.between(15.7, 19.95)) & (c.x.between(77.2, 81.35))]
        rep["state_filter"] = "bounding-box fallback (no state column found): VERIFY visually"
    dcol = _find_col(g.columns, NAME_HINTS, exclude=("state", "st_", "sub", "tehsil", "block"))
    if not dcol:
        raise RuntimeError(f"No district-name column found. Columns: {rep['columns']}")
    rep["district_column"] = dcol
    g = g.copy()
    g["district_id"] = g[dcol].map(normalize_district)
    rep["unmatched_names"] = sorted(set(map(str, g.loc[g.district_id.isna(), dcol])))
    g = g[g.district_id.notna()]
    invalid = ~g.geometry.is_valid
    rep["invalid_geometries_repaired"] = int(invalid.sum())
    g.loc[invalid, "geometry"] = g.loc[invalid, "geometry"].make_valid()
    dup = g.district_id.duplicated(keep=False)
    rep["duplicate_district_ids"] = sorted(set(g.loc[dup, "district_id"]))
    if dup.any():   # dissolve parts belonging to the same district
        g = g.dissolve(by="district_id", as_index=False)
    missing = sorted(set(all_ids()) - set(g.district_id))
    rep.update(n_districts_matched=int(g.district_id.nunique()), missing_district_ids=missing,
               all_33_present=(len(missing) == 0 and g.district_id.nunique() == 33))
    from .districts import catalog
    g["district_name"] = g.district_id.map(lambda i: catalog()[i]["district_name"])
    g["geometry"] = g.geometry.simplify(simplify_deg, preserve_topology=True)
    out = Path(out or ROOT / "data" / "processed" / "geographic" / "telangana_districts.geojson")
    out.parent.mkdir(parents=True, exist_ok=True)
    g[["district_id", "district_name", "geometry"]].to_file(out, driver="GeoJSON")
    rep.update(output=str(out), output_kb=round(out.stat().st_size / 1024, 1))
    write_quality_report("boundaries", rep)
    return rep
