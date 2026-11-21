"""DEM -> district terrain & hydrological features.

Method (documented in GEOSPATIAL_PROCESSING.md):
 1. Reproject the DEM to UTM 44N (EPSG:32644) so cell size is metric.
 2. Slope/aspect: Horn (1981) 3x3 finite differences (numpy), degrees.
 3. Hydrological conditioning with pysheds: fill pits -> fill depressions -> resolve flats.
 4. Flow direction D8, flow accumulation (cells), stream network = accumulation >= threshold (default 1 km^2 contributing area).
 5. TWI = ln(a / tan(beta)), a = contributing area per unit contour width (accumulation*cell area / cell size),
    tan(beta) floored at tan(0.1 deg) to avoid division by zero on flats.
 6. Zonal statistics per district polygon (rasterstats), drainage density = stream length / district area.
Statuses are 'ESTIMATED' (DEM-derived, not measured). Flow routing across district edges uses the whole-state DEM, not clipped tiles.
"""
from __future__ import annotations
import math, tempfile
from pathlib import Path
import numpy as np
# pysheds 0.5 still calls np.in1d, which NumPy 2.x removed. np.isin is the documented replacement.
if not hasattr(np, "in1d"):
    np.in1d = np.isin  # type: ignore[attr-defined]
import geopandas as gpd
import rasterio
from rasterio.warp import calculate_default_transform, reproject, Resampling
from .common import db, utc_now, write_quality_report, register_dataset

UTM = "EPSG:32644"
LOW_SLOPE_DEG = 2.0   # reporting parameter only (stored with the result); NOT a universal flood threshold

def reproject_dem(src_path: Path, dst_path: Path, resolution: float | None = None) -> Path:
    with rasterio.open(src_path) as src:
        if src.crs is None:
            raise RuntimeError("DEM has no CRS")
        t, w, h = calculate_default_transform(src.crs, UTM, src.width, src.height, *src.bounds, resolution=resolution)
        prof = src.profile.copy(); nod = src.nodata if src.nodata is not None else -32768
        prof.pop("blockxsize", None); prof.pop("blockysize", None); prof.pop("tiled", None)
        prof.update(crs=UTM, transform=t, width=w, height=h, nodata=nod, dtype="float32", compress="deflate")
        with rasterio.open(dst_path, "w", **prof) as dst:
            reproject(rasterio.band(src, 1), rasterio.band(dst, 1), src_nodata=nod, dst_nodata=nod,
                      dst_transform=t, dst_crs=UTM, resampling=Resampling.bilinear)
    return dst_path

def slope_aspect(z: np.ndarray, cell: float, nodata_mask: np.ndarray):
    zz = np.where(nodata_mask, np.nan, z).astype("float64")
    p = np.pad(zz, 1, mode="edge")
    a, b, c = p[:-2, :-2], p[:-2, 1:-1], p[:-2, 2:]
    d, f = p[1:-1, :-2], p[1:-1, 2:]
    g, h, i = p[2:, :-2], p[2:, 1:-1], p[2:, 2:]
    dzdx = ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * cell)
    dzdy = ((g + 2 * h + i) - (a + 2 * b + c)) / (8 * cell)
    slope = np.degrees(np.arctan(np.hypot(dzdx, dzdy)))
    aspect = (np.degrees(np.arctan2(dzdy, -dzdx)) + 360) % 360
    return slope, aspect

def hydro_rasters(dem_utm: Path, stream_km2: float = 1.0):
    from pysheds.grid import Grid
    grid = Grid.from_raster(str(dem_utm)); dem = grid.read_raster(str(dem_utm))
    pit = grid.fill_pits(dem); flooded = grid.fill_depressions(pit); inflated = grid.resolve_flats(flooded)
    fdir = grid.flowdir(inflated); acc = grid.accumulation(fdir)
    return grid, np.asarray(inflated), np.asarray(fdir), np.asarray(acc, dtype="float64")

def compute_district_features(dem_path: str | Path, boundaries_geojson: str | Path, stream_km2: float = 1.0,
                              resolution: float | None = None, con=None, dem_source="SRTMGL1 30 m (OpenTopography)") -> dict:
    dem_path = Path(dem_path)
    tmp = Path(tempfile.mkdtemp()) / "dem_utm.tif"
    reproject_dem(dem_path, tmp, resolution)
    with rasterio.open(tmp) as r:
        z = r.read(1).astype("float64"); nod = r.nodata; tr = r.transform; cell = abs(tr.a)
        mask = (z == nod) | ~np.isfinite(z)
    slope, aspect = slope_aspect(z, cell, mask)
    grid, cond, fdir, acc = hydro_rasters(tmp)
    acc = np.where(mask, np.nan, acc)
    cell_area = cell * cell
    thresh_cells = (stream_km2 * 1e6) / cell_area
    stream = (acc >= thresh_cells)
    tanb = np.tan(np.radians(np.maximum(slope, 0.1)))
    twi = np.log((acc * cell_area / cell) / tanb)
    gdf = gpd.read_file(boundaries_geojson).to_crs(UTM)
    from rasterstats import zonal_stats
    aff = tr
    def zs(arr, stats): return zonal_stats(gdf, np.where(np.isfinite(arr), arr, np.nan), affine=aff, nodata=np.nan, stats=stats, all_touched=False)
    zel = zs(np.where(mask, np.nan, z), ["min", "mean", "median", "max", "percentile_10"])
    zsl = zs(slope, ["mean", "percentile_90"])
    zac = zs(acc, ["mean", "percentile_90"])
    ztw = zs(twi, ["mean"])
    low = zs((slope < LOW_SLOPE_DEG).astype("float64") + np.where(np.isfinite(slope), 0, np.nan), ["mean"])
    strm = zs(stream.astype("float64") + np.where(mask, np.nan, 0), ["sum", "count"])
    own, con = con is None, con or db()
    register_dataset(con, "dem_srtm_30m", "SRTM GL1 30 m DEM", "OpenTopography / NASA SRTM", "dem",
                     "https://portal.opentopography.org/API/globaldem", None, "ESTIMATED", "Public domain (NASA SRTM); OpenTopography API key terms apply", "Telangana bbox", 0)
    now, out = utc_now(), []
    method = (f"Horn slope; pysheds fill_pits+fill_depressions+resolve_flats; D8; streams=acc>={stream_km2} km2; "
              f"TWI=ln(a/tan(beta)), slope floor 0.1 deg; UTM44N; low-slope<{LOW_SLOPE_DEG} deg (report-only)")
    for i, row in gdf.iterrows():
        did = row["district_id"]; area_km2 = row.geometry.area / 1e6
        n_stream = (strm[i]["sum"] or 0); stream_len_km = n_stream * cell / 1000.0   # cell-count length proxy (see doc)
        vals = (did, zel[i]["min"], zel[i]["percentile_10"], zel[i]["mean"], zel[i]["median"], zel[i]["max"],
                zsl[i]["mean"], zsl[i]["percentile_90"], (low[i]["mean"] or 0) * 100 if low[i]["mean"] is not None else None, LOW_SLOPE_DEG,
                zac[i]["mean"], zac[i]["percentile_90"], stream_len_km / area_km2 if area_km2 else None, ztw[i]["mean"], method, dem_source, now, "ESTIMATED")
        con.execute("INSERT OR REPLACE INTO district_terrain_features VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", vals); out.append(vals)
    con.commit()
    if own: con.close()
    rep = {"districts": len(out), "cell_size_m": cell, "method": method, "generated_at": now,
           "note": "drainage density uses stream-cell count x cell size (overestimates diagonal D8 links by up to ~41%); treat as relative."}
    write_quality_report("terrain", rep)
    return rep
