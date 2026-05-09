"""Phase 1.9 — Rasterize 5.6 M Open Buildings to a density PNG overlay.

We already have a per-tambon count from script 08, but the user wants a
*visual* "where the houses are" layer. Polygon outlines won't scale for
5.6 M footprints, so we bin centroids into a fine raster (~1 km cells)
and bake an orange-red density ramp into a translucent PNG.

Inputs:
  data/buildings/313_buildings.csv.gz  (cached by 08_buildings_per_tambon.py)
  data/buildings/30d_buildings.csv.gz
  data/aoi/aoi_bbox.json               (AOI bbox)

Output:
  public/data/buildings_density.png        (RGBA PNG, alpha-masked outside AOI)
  public/data/buildings_density_meta.json  (bbox + scale)

Run:
  uv run python scripts/09_buildings_density.py
  uv run python scripts/09_buildings_density.py --step 0.005   # ~500 m cells
"""

from __future__ import annotations

import csv
import gzip
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import click
import numpy as np
from PIL import Image
from tqdm import tqdm

REPO_ROOT = Path(__file__).resolve().parents[1]
BBOX_PATH = REPO_ROOT / "data" / "aoi" / "aoi_bbox.json"
BUILD_DIR = REPO_ROOT / "data" / "buildings"
PUBLIC_DATA = REPO_ROOT.parent / "public" / "data"
PUBLIC_DATA.mkdir(parents=True, exist_ok=True)
PNG_OUT = PUBLIC_DATA / "buildings_density.png"
META_OUT = PUBLIC_DATA / "buildings_density_meta.json"

MIN_CONF = 0.70


def stream_centroids(gz_path: Path, bbox: tuple[float, float, float, float]) -> tuple[np.ndarray, np.ndarray]:
    minx, miny, maxx, maxy = bbox
    lats = []
    lons = []
    with gzip.open(gz_path, "rt", encoding="utf-8", newline="") as f:
        reader = csv.reader(f)
        header = next(reader)
        i_lat = header.index("latitude")
        i_lon = header.index("longitude")
        i_conf = header.index("confidence")
        bar = tqdm(reader, desc=gz_path.stem[:8], unit_scale=True, smoothing=0.05)
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
            lats.append(lat)
            lons.append(lon)
    return np.asarray(lats, dtype=np.float64), np.asarray(lons, dtype=np.float64)


@click.command()
@click.option("--step", default=0.01, type=float, help="Grid cell size in degrees (~1 km)")
@click.option(
    "--ramp",
    default="orange",
    type=click.Choice(["orange", "magma"]),
    help="Color ramp",
)
def main(step: float, ramp: str) -> None:
    if not BBOX_PATH.exists():
        raise SystemExit("missing aoi_bbox.json")
    bbox_d = json.loads(BBOX_PATH.read_text())
    bbox = (bbox_d["minx"], bbox_d["miny"], bbox_d["maxx"], bbox_d["maxy"])
    minx, miny, maxx, maxy = bbox
    nx = int(np.ceil((maxx - minx) / step))
    ny = int(np.ceil((maxy - miny) / step))
    click.echo(f"[grid] {ny} × {nx} cells at {step}° (~{step*111000:.0f} m)")

    cells = sorted(BUILD_DIR.glob("*_buildings.csv.gz"))
    if not cells:
        raise SystemExit(f"no cached gz files in {BUILD_DIR}")
    click.echo(f"[in] streaming {len(cells)} cell file(s): {[c.name for c in cells]}")

    counts = np.zeros((ny, nx), dtype=np.int32)
    total = 0
    for gz in cells:
        lats, lons = stream_centroids(gz, bbox)
        click.echo(f"  {gz.stem}: {len(lats):,} buildings in bbox")
        h, _, _ = np.histogram2d(
            lons, lats,
            bins=[
                np.linspace(minx, minx + nx * step, nx + 1),
                np.linspace(miny, miny + ny * step, ny + 1),
            ],
        )
        # h is (cols, rows) bottom-up; transpose + flip to (rows, cols) top-down
        counts += np.flipud(h.T).astype(np.int32)
        total += len(lats)

    click.echo(f"[total] {total:,} buildings; non-zero cells {(counts>0).sum():,}/{counts.size:,}")

    # Log-scale normalisation: density spans many orders of magnitude.
    log_counts = np.log1p(counts.astype(np.float32))
    p5 = float(np.quantile(log_counts[counts > 0], 0.05)) if (counts > 0).any() else 0.0
    p98 = float(np.quantile(log_counts[counts > 0], 0.98)) if (counts > 0).any() else 1.0
    click.echo(f"[norm] log1p p5/p98 = {p5:.2f} / {p98:.2f}")
    t = np.clip((log_counts - p5) / max(p98 - p5, 1e-9), 0, 1)

    if ramp == "magma":
        # Approx magma: black → purple → red → orange → yellow
        STOPS = [
            (0.0, (0, 0, 4)),
            (0.25, (60, 15, 110)),
            (0.5, (180, 60, 90)),
            (0.75, (250, 130, 60)),
            (1.0, (252, 255, 164)),
        ]
    else:
        # Warm orange ramp on dark teal: settlements glow without hiding the basemap
        STOPS = [
            (0.0, (255, 235, 200)),
            (0.35, (253, 174, 97)),
            (0.7, (215, 48, 39)),
            (1.0, (130, 8, 8)),
        ]

    rgb = np.zeros(t.shape + (3,), dtype=np.float32)
    for i in range(len(STOPS) - 1):
        s0, c0 = STOPS[i]
        s1, c1 = STOPS[i + 1]
        m = (t >= s0) & (t <= s1)
        f = (t - s0) / max(s1 - s0, 1e-9)
        for ch in range(3):
            rgb[..., ch] = np.where(m, c0[ch] + f * (c1[ch] - c0[ch]), rgb[..., ch])
    rgb = np.clip(rgb, 0, 255).astype(np.uint8)

    # Alpha: hide empty cells; ramp up with density. Use sqrt for smoother edges.
    alpha = np.where(counts > 0, np.clip(80 + 175 * np.sqrt(t), 0, 255), 0).astype(np.uint8)

    rgba = np.dstack([rgb, alpha])
    Image.fromarray(rgba, "RGBA").save(PNG_OUT, optimize=True)
    click.echo(f"[write] {PNG_OUT.name}  {nx}x{ny}  {PNG_OUT.stat().st_size/1024:.1f} KB")

    META_OUT.write_text(
        json.dumps(
            {
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "source": "Google Open Buildings v3 — confidence ≥ 0.7 centroids",
                "bbox": [minx, miny, maxx + nx * 0, maxy + ny * 0],  # bbox closes at minx+nx*step etc but step keeps grid
                "grid_bbox": [minx, miny, minx + nx * step, miny + ny * step],
                "rows": ny,
                "cols": nx,
                "step_deg": step,
                "total_buildings": int(total),
                "log_norm_p5": p5,
                "log_norm_p98": p98,
                "ramp": ramp,
            },
            indent=2,
            ensure_ascii=False,
        )
    )
    click.echo(f"[write] {META_OUT.name}")


if __name__ == "__main__":
    sys.exit(main())
