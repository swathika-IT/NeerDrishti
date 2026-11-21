"""Command line: python -m scripts.pipeline.cli <command> [options]"""
import argparse, json, sys
from . import ingest_nwdp as N, openmeteo as O, features as F, boundaries as B, terrain as T, dem_download as D
from .common import db

def main(argv=None):
    p = argparse.ArgumentParser(prog="neerdrishti-pipeline"); sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("registry")
    for c in ("inspect-nwdp",):
        s = sub.add_parser(c); s.add_argument("dataset", choices=list(N.RESOURCES))
    s = sub.add_parser("nwdp"); s.add_argument("dataset", choices=[k for k, v in N.RESOURCES.items() if v["kind"] != "reservoir"]); s.add_argument("--max", type=int)
    s = sub.add_parser("reservoir"); s.add_argument("dataset", choices=[k for k, v in N.RESOURCES.items() if v["kind"] == "reservoir"])
    s = sub.add_parser("archive"); s.add_argument("--start", default="2023-01-01"); s.add_argument("--end"); s.add_argument("--humidity", action="store_true")
    sub.add_parser("forecast")
    s = sub.add_parser("boundaries"); s.add_argument("source")
    sub.add_parser("dem-download")
    s = sub.add_parser("terrain"); s.add_argument("--dem", default="data/raw/dem/telangana_srtm_30m.tif")
    s.add_argument("--boundaries", default="data/processed/geographic/telangana_districts.geojson"); s.add_argument("--resolution", type=float)
    sub.add_parser("features")
    a = p.parse_args(argv)
    if a.cmd == "registry":
        con = db(); N.register_all(con); O.register(con); print("registered")
    elif a.cmd == "inspect-nwdp":
        from .nwdp import CkanClient
        c = CkanClient(); d = c.describe(N.RESOURCES[a.dataset]["resource_id"]); print(json.dumps(d, indent=2, default=str)[:4000])
        if N.RESOURCES[a.dataset]["kind"] == "reservoir": N.inspect_reservoir(a.dataset)
    elif a.cmd == "nwdp": print(json.dumps(N.ingest(a.dataset, max_records=a.max), indent=2, default=str))
    elif a.cmd == "reservoir": print(N.ingest_reservoir_verified(a.dataset))
    elif a.cmd == "archive": print("rows fetched:", O.ingest_archive(a.start, a.end, with_humidity=a.humidity))
    elif a.cmd == "forecast": print("rows fetched:", O.ingest_forecast())
    elif a.cmd == "boundaries": print(json.dumps(B.process(a.source), indent=2))
    elif a.cmd == "dem-download": print(D.download())
    elif a.cmd == "terrain": print(json.dumps(T.compute_district_features(a.dem, a.boundaries, resolution=a.resolution), indent=2))
    elif a.cmd == "features": print("hydrology rows:", F.build_hydrology_features(), "completeness rows:", F.build_completeness())

if __name__ == "__main__":
    sys.exit(main())
