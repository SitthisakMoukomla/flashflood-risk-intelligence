"""Phase 1.6 (gridded) — Continuous wetness + live precip raster from Open-Meteo.

Replaces the per-tambon point fetch with a regular geographic grid so the
soil-moisture proxy looks like a *continuous field*, not an administrative
choropleth.

For each grid point we fetch:
  - rain_7d_mm  : sum of past 7 days precipitation        (soil-moisture proxy)
  - precip_now  : forecast precipitation in next hour     (live trigger)

Open-Meteo accepts comma-separated lat/lon up to ~1000 points per request,
so a 0.15° grid over the AOI bbox (~600 points) fits in a single call.

Output: public/data/wetness_grid.json
  {
    "generated_at": "...",
    "bbox": [minx, miny, maxx, maxy],
    "rows": <int>, "cols": <int>, "step_deg": 0.15,
    "rain_7d_mm":  [ <rows*cols floats, row-major top-to-bottom> ],
    "precip_now_mm_per_hr": [ ... ],
    "wetness_norm_cap_mm": 80,
    "precip_now_norm_cap_mm_per_hr": 5
  }

Run:
  uv run python scripts/06_wetness_grid.py
  uv run python scripts/06_wetness_grid.py --step 0.1
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import click
import numpy as np
import requests
from tqdm import tqdm

REPO_ROOT = Path(__file__).resolve().parents[1]
BBOX_PATH = REPO_ROOT / "data" / "aoi" / "aoi_bbox.json"
PUBLIC_DATA = REPO_ROOT.parent / "public" / "data"
PUBLIC_DATA.mkdir(parents=True, exist_ok=True)
OUT_PATH = PUBLIC_DATA / "wetness_grid.json"

OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
WETNESS_NORM_CAP_MM = 80.0
PRECIP_NOW_NORM_CAP = 5.0  # mm/hr — moderate rain → "trigger" maxed


def build_grid(bbox: dict, step: float) -> tuple[np.ndarray, np.ndarray, int, int]:
    minx, maxx = bbox["minx"], bbox["maxx"]
    miny, maxy = bbox["miny"], bbox["maxy"]
    # Snap to step grid lines
    lons = np.arange(np.floor(minx / step) * step, maxx + step, step)
    lats = np.arange(np.floor(miny / step) * step, maxy + step, step)
    cols = len(lons)
    rows = len(lats)
    return lats, lons, rows, cols


def chunked(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i : i + n]


def fetch_batch(lats: list[float], lons: list[float]) -> tuple[list[float], list[float]]:
    """Single Open-Meteo request for many points. Returns (rain_7d, precip_now) lists."""
    params = {
        "latitude": ",".join(f"{x:.4f}" for x in lats),
        "longitude": ",".join(f"{x:.4f}" for x in lons),
        "daily": "precipitation_sum",
        "hourly": "precipitation",
        "past_days": 7,
        "forecast_days": 1,
        "timezone": "Asia/Bangkok",
    }
    r = requests.get(OPEN_METEO_URL, params=params, timeout=120)
    r.raise_for_status()
    payload = r.json()
    # Open-Meteo returns a list when multiple points are queried
    items = payload if isinstance(payload, list) else [payload]
    if len(items) != len(lats):
        raise RuntimeError(f"got {len(items)} items, expected {len(lats)}")

    rain_7d, precip_now = [], []
    for item in items:
        daily = item.get("daily", {}).get("precipitation_sum", [])
        past_days = [v for v in daily[:7] if v is not None]
        rain_7d.append(float(sum(past_days)) if past_days else 0.0)

        # Find current-hour precipitation: hourly array with current time index.
        hourly = item.get("hourly", {})
        times = hourly.get("time", [])
        precip = hourly.get("precipitation", [])
        if not times or not precip:
            precip_now.append(0.0)
            continue
        # Pick the hour whose timestamp string matches "now" (Asia/Bangkok ISO format YYYY-MM-DDTHH:MM).
        now = datetime.now(timezone.utc).astimezone()
        target = now.strftime("%Y-%m-%dT%H:00")
        # Find first hourly entry >= target hour
        idx = next(
            (i for i, t in enumerate(times) if t >= target),
            len(times) - 1 if times else -1,
        )
        if idx < 0 or idx >= len(precip):
            precip_now.append(0.0)
        else:
            precip_now.append(float(precip[idx] or 0.0))
    return rain_7d, precip_now


@click.command()
@click.option("--step", default=0.15, type=float, help="Grid step in degrees (0.1 ≈ 11 km)")
@click.option("--batch", default=400, type=int, help="Points per Open-Meteo request")
def main(step: float, batch: int) -> None:
    if not BBOX_PATH.exists():
        click.echo(f"ERROR: {BBOX_PATH} missing — run 01_aoi_mask.py first", err=True)
        sys.exit(2)
    bbox = json.loads(BBOX_PATH.read_text())

    lats, lons, rows, cols = build_grid(bbox, step)
    click.echo(f"[grid] step={step}° → {rows} rows × {cols} cols = {rows*cols} points")
    click.echo(
        f"[grid] bbox lat {lats[0]:.3f}..{lats[-1]:.3f}, lon {lons[0]:.3f}..{lons[-1]:.3f}"
    )

    # Build flat lat/lon lists in row-major (top to bottom, west to east).
    flat_lats: list[float] = []
    flat_lons: list[float] = []
    for lat in lats[::-1]:  # reverse so row 0 = top (north) — matches GeoTIFF convention
        for lon in lons:
            flat_lats.append(float(lat))
            flat_lons.append(float(lon))

    rain_7d_all: list[float] = []
    precip_now_all: list[float] = []
    batches = list(zip(list(chunked(flat_lats, batch)), list(chunked(flat_lons, batch))))
    for blat, blon in tqdm(batches, desc="open-meteo"):
        try:
            r7, pn = fetch_batch(blat, blon)
        except Exception as e:
            click.echo(f"  ! batch failed: {e}", err=True)
            r7 = [0.0] * len(blat)
            pn = [0.0] * len(blat)
        rain_7d_all.extend(r7)
        precip_now_all.extend(pn)

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "Open-Meteo Forecast API (past_days=7 daily + hourly precipitation)",
        "bbox": [bbox["minx"], bbox["miny"], bbox["maxx"], bbox["maxy"]],
        "grid_bbox": [float(lons[0]), float(lats[0]), float(lons[-1]), float(lats[-1])],
        "rows": rows,
        "cols": cols,
        "step_deg": step,
        "wetness_norm_cap_mm": WETNESS_NORM_CAP_MM,
        "precip_now_norm_cap_mm_per_hr": PRECIP_NOW_NORM_CAP,
        "rain_7d_mm": [round(v, 2) for v in rain_7d_all],
        "precip_now_mm_per_hr": [round(v, 2) for v in precip_now_all],
    }
    OUT_PATH.write_text(json.dumps(payload))
    click.echo(f"\n[write] {OUT_PATH}  ({OUT_PATH.stat().st_size/1024:.1f} KB)")

    arr_rain = np.array(rain_7d_all)
    arr_now = np.array(precip_now_all)
    click.echo(
        f"[rain_7d]  min={arr_rain.min():.1f}  median={np.median(arr_rain):.1f}  "
        f"max={arr_rain.max():.1f}  pct≥40={(arr_rain >= 40).mean()*100:.0f}%"
    )
    click.echo(
        f"[precip_now] min={arr_now.min():.2f}  median={np.median(arr_now):.2f}  "
        f"max={arr_now.max():.2f}  pct>0={(arr_now > 0).mean()*100:.0f}%"
    )


if __name__ == "__main__":
    main()
