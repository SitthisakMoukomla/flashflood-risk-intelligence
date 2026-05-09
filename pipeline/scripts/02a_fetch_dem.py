"""Phase 1.2a — Fetch Copernicus DEM 30m tiles for the AOI bbox.

Source: AWS Open Data — `s3://copernicus-dem-30m` (public, no auth).
Anonymous HTTPS endpoint:
  https://copernicus-dem-30m.s3.amazonaws.com/
    Copernicus_DSM_COG_10_N{NN}_00_E{EEE}_00_DEM/
    Copernicus_DSM_COG_10_N{NN}_00_E{EEE}_00_DEM.tif

Tile naming: integer-degree southwest corner, padded to 2/3 digits.

Run:
  uv run python scripts/02a_fetch_dem.py             # full AOI from aoi_bbox.json
  uv run python scripts/02a_fetch_dem.py --pilot     # only N19_E098 (~Pai test tile)
"""

from __future__ import annotations

import json
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import click
import requests
from tqdm import tqdm

REPO_ROOT = Path(__file__).resolve().parents[1]
BBOX_PATH = REPO_ROOT / "data" / "aoi" / "aoi_bbox.json"
DEM_DIR = REPO_ROOT / "data" / "dem"
DEM_DIR.mkdir(parents=True, exist_ok=True)

BASE_URL = "https://copernicus-dem-30m.s3.amazonaws.com"


def tile_url(lat: int, lon: int) -> tuple[str, str]:
    name = f"Copernicus_DSM_COG_10_N{lat:02d}_00_E{lon:03d}_00_DEM"
    return name, f"{BASE_URL}/{name}/{name}.tif"


def needed_tiles(bbox: dict) -> list[tuple[int, int]]:
    """Integer-degree tile SW corners covering bbox."""
    import math

    lat_min = math.floor(bbox["miny"])
    lat_max = math.ceil(bbox["maxy"])  # exclusive upper
    lon_min = math.floor(bbox["minx"])
    lon_max = math.ceil(bbox["maxx"])
    return [
        (lat, lon)
        for lat in range(lat_min, lat_max)
        for lon in range(lon_min, lon_max)
    ]


def download_tile(lat: int, lon: int, force: bool = False) -> tuple[str, Path, int]:
    name, url = tile_url(lat, lon)
    dest = DEM_DIR / f"{name}.tif"
    if dest.exists() and not force:
        return name, dest, dest.stat().st_size
    with requests.get(url, stream=True, timeout=120) as r:
        if r.status_code == 404:
            # ocean/no-data tile — skip silently
            return name, dest, -404
        r.raise_for_status()
        with dest.open("wb") as f:
            for chunk in r.iter_content(chunk_size=1 << 16):
                if chunk:
                    f.write(chunk)
    return name, dest, dest.stat().st_size


@click.command()
@click.option("--pilot", is_flag=True, help="Only fetch N19_E098 (Pai test tile)")
@click.option("--workers", default=4, type=int, help="Parallel downloads")
def main(pilot: bool, workers: int) -> None:
    if pilot:
        tiles = [(19, 98)]
        click.echo("[mode] pilot — single tile N19_E098")
    else:
        bbox = json.loads(BBOX_PATH.read_text())
        tiles = needed_tiles(bbox)
        click.echo(f"[mode] full AOI — {len(tiles)} tiles for bbox {bbox['minx']:.2f},{bbox['miny']:.2f},{bbox['maxx']:.2f},{bbox['maxy']:.2f}")

    have, miss, total_bytes = 0, 0, 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(download_tile, lat, lon): (lat, lon) for lat, lon in tiles}
        for fut in tqdm(as_completed(futs), total=len(futs), desc="dem"):
            lat, lon = futs[fut]
            try:
                name, dest, size = fut.result()
            except Exception as e:
                click.echo(f"  FAIL N{lat:02d}_E{lon:03d}: {e}", err=True)
                miss += 1
                continue
            if size == -404:
                miss += 1
            else:
                have += 1
                total_bytes += size
    click.echo(f"\nfetched: {have} tiles, {total_bytes / 1e6:.1f} MB; missing/ocean: {miss}")
    if have == 0:
        sys.exit(2)


if __name__ == "__main__":
    main()
