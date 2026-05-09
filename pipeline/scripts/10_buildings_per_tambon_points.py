"""Phase 1.10 — Per-tambon building FOOTPRINTS for the zoom-in vector layer.

The 1 km density PNG (script 09) is a fine overview but turns into a blurry
blob once the user zooms past z=12. This pipeline extracts every Open
Buildings v3 polygon that falls inside each of the 663 northern tambon and
writes a tiny per-tambon JSON containing actual building footprints.

Output:
  public/data/buildings_pts/{GID_3}.json
    [
      [[lng, lat], [lng, lat], ...],   // polygon 1 (3-8 vertices typical)
      [[lng, lat], ...],               // polygon 2
      ...
    ]
  public/data/buildings_pts/index.json    (per-tambon counts + file size)

Format trade-offs:
  - Compact array of [lng, lat] arrays (no Feature wrapping) — ~50% smaller
    than full GeoJSON FeatureCollection.
  - 6-decimal precision (~10 cm) — well below building dimensions.
  - Per tambon: ~30 KB to ~1 MB. Total directory ~150 MB.

Run:
  uv run python scripts/10_buildings_per_tambon_points.py
"""

from __future__ import annotations

import csv
import gzip
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import click
import geopandas as gpd
import numpy as np
from shapely import wkt
from shapely.geometry import Point
from shapely.strtree import STRtree
from tqdm import tqdm

REPO_ROOT = Path(__file__).resolve().parents[1]
GEO_PATH = REPO_ROOT / "data" / "output" / "village_risk.geojson"
BBOX_PATH = REPO_ROOT / "data" / "aoi" / "aoi_bbox.json"
BUILD_DIR = REPO_ROOT / "data" / "buildings"
PUBLIC_PTS = REPO_ROOT.parent / "public" / "data" / "buildings_pts"
PUBLIC_PTS.mkdir(parents=True, exist_ok=True)
INDEX_OUT = PUBLIC_PTS / "index.json"

MIN_CONF = 0.80
MIN_AREA_M2 = 20.0  # drop tiny shed-sized polygons that turn into 1-pixel noise


def stream_assign(
    gz_path: Path,
    bbox: tuple[float, float, float, float],
    polys: list,
    tree: STRtree,
    per_tambon: list[list[list[tuple[float, float]]]],
) -> tuple[int, int]:
    """Stream a single Open Buildings cell and bucket each polygon footprint
    into the enclosing tambon (using its centroid for the spatial join)."""
    minx, miny, maxx, maxy = bbox
    n_in = 0
    n_assigned = 0
    with gzip.open(gz_path, "rt", encoding="utf-8", newline="") as f:
        reader = csv.reader(f)
        header = next(reader)
        i_lat = header.index("latitude")
        i_lon = header.index("longitude")
        i_conf = header.index("confidence")
        i_geom = header.index("geometry")
        i_area = header.index("area_in_meters")
        bar = tqdm(reader, desc=gz_path.stem[:8], unit_scale=True, smoothing=0.05)
        for row in bar:
            try:
                lat = float(row[i_lat])
                lon = float(row[i_lon])
                conf = float(row[i_conf])
                area = float(row[i_area])
            except (ValueError, IndexError):
                continue
            if conf < MIN_CONF:
                continue
            if area < MIN_AREA_M2:
                continue
            if not (miny <= lat <= maxy and minx <= lon <= maxx):
                continue
            n_in += 1
            pt = Point(lon, lat)
            tambon_idx = -1
            for idx in tree.query(pt):
                if polys[idx].contains(pt):
                    tambon_idx = int(idx)
                    break
            if tambon_idx < 0:
                continue
            try:
                shape = wkt.loads(row[i_geom])
                # Open Buildings polygons are simple POLYGON (no holes).
                ring = list(shape.exterior.coords)
                # Drop the closing duplicate vertex; round to 6 decimals.
                # 5 decimals = ~1 m precision; visually identical to 6 at z<=18.
                ring_compact = [
                    [round(x, 5), round(y, 5)] for x, y in ring[:-1]
                ]
                per_tambon[tambon_idx].append(ring_compact)
                n_assigned += 1
            except Exception:
                # Bad WKT — fall back to a tiny square around the centroid.
                d = 0.00005  # ~5 m
                per_tambon[tambon_idx].append(
                    [
                        [round(lon - d, 5), round(lat - d, 5)],
                        [round(lon + d, 5), round(lat - d, 5)],
                        [round(lon + d, 5), round(lat + d, 5)],
                        [round(lon - d, 5), round(lat + d, 5)],
                    ]
                )
                n_assigned += 1
    return n_in, n_assigned


@click.command()
def main() -> None:
    if not GEO_PATH.exists():
        raise SystemExit(f"missing {GEO_PATH}")
    bbox_d = json.loads(BBOX_PATH.read_text())
    bbox = (bbox_d["minx"], bbox_d["miny"], bbox_d["maxx"], bbox_d["maxy"])

    click.echo(f"[load] {GEO_PATH.name}")
    gdf = gpd.read_file(GEO_PATH).to_crs("EPSG:4326")
    click.echo(f"[load] {len(gdf)} tambon")
    polys = list(gdf.geometry)
    tree = STRtree(polys)
    per_tambon: list[list[tuple[float, float]]] = [[] for _ in polys]

    cells = sorted(BUILD_DIR.glob("*_buildings.csv.gz"))
    if not cells:
        raise SystemExit(f"no cached gz files in {BUILD_DIR}")
    click.echo(f"[in] streaming {len(cells)} cell file(s)")

    total_in = 0
    total_assigned = 0
    for gz in cells:
        n_in, n_assigned = stream_assign(gz, bbox, polys, tree, per_tambon)
        total_in += n_in
        total_assigned += n_assigned
        click.echo(f"  {gz.stem}: {n_in:,} in bbox → {n_assigned:,} assigned")

    click.echo(
        f"\n[total] {total_in:,} buildings in bbox, "
        f"{total_assigned:,} mapped to tambon "
        f"({100 * total_assigned / max(total_in, 1):.1f}%)"
    )

    # Write per-tambon files
    index = []
    for i, row in tqdm(gdf.iterrows(), total=len(gdf), desc="write"):
        gid = str(row.GID_3)
        pts = per_tambon[i]
        path = PUBLIC_PTS / f"{gid}.json"
        if pts:
            path.write_text(json.dumps(pts, separators=(",", ":")))
            size = path.stat().st_size
        else:
            # No buildings — write an empty array (consistent fetch)
            path.write_text("[]")
            size = path.stat().st_size
        index.append({
            "GID_3": gid,
            "NAME_3": str(row.NAME_3),
            "n": len(pts),
            "kb": round(size / 1024, 1),
        })

    total_files = sum(1 for i in index if i["n"] > 0)
    total_kb = sum(i["kb"] for i in index)
    INDEX_OUT.write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "n_tambon": len(index),
        "with_buildings": total_files,
        "total_buildings": int(total_assigned),
        "total_kb": round(total_kb, 1),
        "tambon": index,
    }, ensure_ascii=False, separators=(",", ":")))
    click.echo(
        f"\n[index] {total_files} tambon with buildings, total payload {total_kb/1024:.1f} MB"
    )

    # Top-10 largest tambon by building count
    top = sorted(index, key=lambda x: -x["n"])[:10]
    click.echo("\n=== top-10 by building count ===")
    for r in top:
        click.echo(f"  {r['NAME_3']:20s} {r['n']:>7,}  ({r['kb']:>6.1f} KB)")


if __name__ == "__main__":
    sys.exit(main())
