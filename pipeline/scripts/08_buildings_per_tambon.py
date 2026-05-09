"""Phase 1.8 — Count Google Open Buildings per ตำบล for the exposure metric.

Streams the Open Buildings v3 polygon CSVs that intersect the AOI, filters
each row by lat/lon to the AOI bbox + confidence ≥ 0.7, then runs a
single spatial join against the 663 northern-Thailand tambon polygons via
a Shapely STRtree.

Why not full rasterize → reproject → zonal stats? Buildings are inherently
points (we want counts), and STRtree on 663 polygons + 5 M points is
~10 sec, much faster than a 100 m raster pipeline.

Outputs:
  public/data/buildings_per_tambon.json
    {
      generated_at, source, conf_threshold,
      "tambon": [ { GID_3, count, sum_area_m2 }, ... ]
    }
  Updates village_risk.geojson + village_risk_table.csv with `buildings`
  and `building_area_km2` columns.

Run:
  uv run python scripts/08_buildings_per_tambon.py
"""

from __future__ import annotations

import csv
import gzip
import io
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import click
import geopandas as gpd
import numpy as np
import requests
from shapely import wkt
from shapely.geometry import Point, box
from shapely.strtree import STRtree
from tqdm import tqdm

REPO_ROOT = Path(__file__).resolve().parents[1]
GEO_PATH = REPO_ROOT / "data" / "output" / "village_risk.geojson"
TABLE_PATH = REPO_ROOT / "data" / "output" / "village_risk_table.csv"
BBOX_PATH = REPO_ROOT / "data" / "aoi" / "aoi_bbox.json"
BUILD_DIR = REPO_ROOT / "data" / "buildings"
BUILD_DIR.mkdir(parents=True, exist_ok=True)
PUBLIC_DATA = REPO_ROOT.parent / "public" / "data"
PUBLIC_DATA.mkdir(parents=True, exist_ok=True)
OUT_JSON = PUBLIC_DATA / "buildings_per_tambon.json"

THRESHOLDS_URL = "https://storage.googleapis.com/open-buildings-data/v3/score_thresholds_s2_level_4.csv"
POLYGONS_URL_TPL = "https://storage.googleapis.com/open-buildings-data/v3/polygons_s2_level_4_gzip/{token}_buildings.csv.gz"

MIN_CONF = 0.70


def find_intersecting_tokens(aoi_box) -> list[str]:
    click.echo("[index] downloading S2 cell index...")
    r = requests.get(THRESHOLDS_URL, timeout=60)
    r.raise_for_status()
    tokens = []
    for row in csv.DictReader(io.StringIO(r.text)):
        try:
            poly = wkt.loads(row["geometry"])
        except Exception:
            continue
        if poly.intersects(aoi_box):
            tokens.append(row["s2_token"])
    return tokens


def download_polygons(token: str) -> Path:
    dest = BUILD_DIR / f"{token}_buildings.csv.gz"
    if dest.exists() and dest.stat().st_size > 1_000_000:
        click.echo(f"[cache] {token}: {dest.stat().st_size / 1e6:.0f} MB")
        return dest
    url = POLYGONS_URL_TPL.format(token=token)
    click.echo(f"[download] {token}: {url}")
    with requests.get(url, stream=True, timeout=900) as r:
        r.raise_for_status()
        total = int(r.headers.get("content-length", 0))
        with dest.open("wb") as f, tqdm(
            total=total, unit="B", unit_scale=True, desc=token
        ) as bar:
            for chunk in r.iter_content(chunk_size=1 << 18):
                if chunk:
                    f.write(chunk)
                    bar.update(len(chunk))
    return dest


def stream_assign(
    gz_path: Path,
    bbox: tuple[float, float, float, float],
    polys: list,
    tree: STRtree,
    counts: np.ndarray,
    areas: np.ndarray,
) -> tuple[int, int]:
    """Stream gz CSV, filter by bbox + confidence, assign each building to a tambon."""
    minx, miny, maxx, maxy = bbox
    n_in = 0
    n_assigned = 0
    with gzip.open(gz_path, "rt", encoding="utf-8", newline="") as f:
        reader = csv.reader(f)
        header = next(reader)
        i_lat = header.index("latitude")
        i_lon = header.index("longitude")
        i_conf = header.index("confidence")
        i_area = header.index("area_in_meters")
        bar = tqdm(reader, desc=f"{gz_path.stem[:8]}", unit_scale=True)
        for row in bar:
            try:
                lat = float(row[i_lat])
                lon = float(row[i_lon])
                conf = float(row[i_conf])
            except (ValueError, IndexError):
                continue
            if conf < MIN_CONF:
                continue
            if not (miny <= lat <= maxy and minx <= lon <= maxx):
                continue
            n_in += 1
            pt = Point(lon, lat)
            # STRtree returns candidate indices; verify with contains.
            cand_idx = tree.query(pt)
            for idx in cand_idx:
                if polys[idx].contains(pt):
                    counts[idx] += 1
                    try:
                        areas[idx] += float(row[i_area])
                    except (ValueError, IndexError):
                        pass
                    n_assigned += 1
                    break
    return n_in, n_assigned


@click.command()
def main() -> None:
    if not GEO_PATH.exists():
        raise SystemExit(f"missing {GEO_PATH} — run 05_village_risk.py first")
    if not BBOX_PATH.exists():
        raise SystemExit(f"missing {BBOX_PATH}")

    bbox = json.loads(BBOX_PATH.read_text())
    aoi = box(bbox["minx"], bbox["miny"], bbox["maxx"], bbox["maxy"])

    tokens = find_intersecting_tokens(aoi)
    click.echo(f"[index] {len(tokens)} S2 cells intersect AOI: {tokens}")

    click.echo(f"[load] {GEO_PATH.name}")
    gdf = gpd.read_file(GEO_PATH).to_crs("EPSG:4326")
    click.echo(f"[load] {len(gdf)} tambon")

    polys = list(gdf.geometry)
    tree = STRtree(polys)
    counts = np.zeros(len(gdf), dtype=np.int64)
    areas = np.zeros(len(gdf), dtype=np.float64)

    bbox_t = (bbox["minx"], bbox["miny"], bbox["maxx"], bbox["maxy"])
    total_in = 0
    total_assigned = 0
    for token in tokens:
        gz = download_polygons(token)
        n_in, n_assigned = stream_assign(gz, bbox_t, polys, tree, counts, areas)
        total_in += n_in
        total_assigned += n_assigned
        click.echo(f"  {token}: {n_in:,} in bbox → {n_assigned:,} assigned to tambon")

    click.echo(
        f"\n[total] {total_in:,} buildings in bbox, {total_assigned:,} mapped to tambon "
        f"({100*total_assigned/max(total_in,1):.1f}%)"
    )

    # Build per-tambon list
    per_tambon = []
    for i, row in gdf.iterrows():
        per_tambon.append({
            "GID_3": str(row.GID_3),
            "buildings": int(counts[i]),
            "building_area_m2": int(areas[i]),
        })
    OUT_JSON.write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "Google Open Buildings v3 (polygons_s2_level_4)",
        "conf_threshold": MIN_CONF,
        "total_buildings": int(counts.sum()),
        "tambon": per_tambon,
    }, indent=2, ensure_ascii=False))
    click.echo(f"[write] {OUT_JSON.name}")

    # Annotate village_risk.geojson + table with buildings count.
    gdf["buildings"] = counts
    gdf["building_area_km2"] = (areas / 1e6).round(3)
    gdf.to_file(GEO_PATH, driver="GeoJSON")
    click.echo(f"[update] {GEO_PATH.name} (added buildings, building_area_km2)")

    import pandas as pd
    if TABLE_PATH.exists():
        df = pd.read_csv(TABLE_PATH)
        df = df.merge(
            gdf[["GID_3", "buildings", "building_area_km2"]],
            on="GID_3",
            how="left",
        )
        df.to_csv(TABLE_PATH, index=False)
        click.echo(f"[update] {TABLE_PATH.name}")

    # Re-export geojson into public/data so the frontend picks up the new fields.
    public_geo = PUBLIC_DATA / "village_risk.geojson"
    public_table = PUBLIC_DATA / "village_risk_table.csv"
    gdf.to_file(public_geo, driver="GeoJSON")
    click.echo(f"[update] {public_geo}")
    if TABLE_PATH.exists():
        import shutil
        shutil.copy(TABLE_PATH, public_table)

    # Quick stats by province
    summary = gdf.groupby("NAME_1")["buildings"].agg(["count", "sum", "median", "max"]).astype(int)
    click.echo("\n=== buildings per tambon, by province ===")
    print(summary.to_string())


if __name__ == "__main__":
    sys.exit(main())
