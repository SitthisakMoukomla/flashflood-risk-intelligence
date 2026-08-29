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
import time
from datetime import datetime, timezone
from pathlib import Path

import click
import numpy as np
import rasterio
import requests
from tqdm import tqdm

REPO_ROOT = Path(__file__).resolve().parents[1]
BBOX_PATH = REPO_ROOT / "data" / "aoi" / "aoi_bbox.json"
BOUNDARY_PATH = REPO_ROOT / "data" / "aoi" / "thailand_boundary.geojson"
SUSC_NORTH = REPO_ROOT / "data" / "output" / "susceptibility.tif"
SUSC_THAILAND = REPO_ROOT / "data" / "output" / "susceptibility_thailand.tif"
PUBLIC_DATA = REPO_ROOT.parent / "public" / "data"
PUBLIC_DATA.mkdir(parents=True, exist_ok=True)
OUT_PATH = PUBLIC_DATA / "wetness_grid.json"

OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
# Open-Meteo's free tier meters by location-hours, not by HTTP request, so
# a 150-point batch spends 150 units at once. ~600 units/minute is the
# ceiling before it starts returning 429, hence 15 s between batches.
THROTTLE_S = 15.0
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
@click.option("--batch", default=150, type=int, help="Points per Open-Meteo request")
@click.option(
    "--extent",
    type=click.Choice(["thailand", "north"]),
    default="thailand",
    help="Grid coverage; 'thailand' needs susceptibility_thailand.tif",
)
def main(step: float, batch: int, extent: str) -> None:
    if extent == "thailand":
        if not BOUNDARY_PATH.exists():
            click.echo(f"ERROR: {BOUNDARY_PATH} missing — run 14_sar_flood.py once", err=True)
            sys.exit(2)
        from shapely.geometry import shape

        b = shape(json.loads(BOUNDARY_PATH.read_text())["geometry"]).bounds
        bbox = {"minx": b[0], "miny": b[1], "maxx": b[2], "maxy": b[3]}
        susc_path = SUSC_THAILAND
    else:
        if not BBOX_PATH.exists():
            click.echo(f"ERROR: {BBOX_PATH} missing — run 01_aoi_mask.py first", err=True)
            sys.exit(2)
        bbox = json.loads(BBOX_PATH.read_text())
        susc_path = SUSC_NORTH
    # The susceptibility raster is a build artefact and stays out of git, so
    # CI never has it. static_norm does not change between refreshes anyway —
    # reuse the published values and only re-fetch the weather.
    reuse_static = not susc_path.exists()
    if reuse_static:
        if not OUT_PATH.exists():
            click.echo(
                f"ERROR: {susc_path} missing and no published grid to reuse — "
                "build the raster first",
                err=True,
            )
            sys.exit(2)
        click.echo(f"[susc] {susc_path.name} absent — reusing static_norm from {OUT_PATH.name}")
    click.echo(f"[extent] {extent} — static layer {susc_path.name}")

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
    failed = 0
    for i, (blat, blon) in enumerate(tqdm(batches, desc="open-meteo")):
        # Open-Meteo throttles a nationwide grid partway through, and a
        # silently-zeroed batch is worse than a slow one: it reads as "no
        # rain here" on the map. Pace the calls and retry with backoff.
        if i:
            time.sleep(THROTTLE_S)
        r7 = pn = None
        for attempt in range(4):
            try:
                r7, pn = fetch_batch(blat, blon)
                break
            except Exception as e:
                wait = 20.0 * (2**attempt)
                if attempt == 3:
                    click.echo(f"  ! batch {i} failed after retries: {e}", err=True)
                else:
                    time.sleep(wait)
        if r7 is None or pn is None:
            failed += 1
            r7 = [float("nan")] * len(blat)
            pn = [float("nan")] * len(blat)
        rain_7d_all.extend(r7)
        precip_now_all.extend(pn)
    if failed:
        click.echo(f"  ! {failed}/{len(batches)} batch(es) unrecoverable — written as null", err=True)

    # Sample the GEE static susceptibility raster at every grid point so the
    # frontend can compute live risk per cell without re-loading the COG.
    static_norm: list[float] = []
    static_low = 0.0
    static_high = 1.0
    if reuse_static:
        prev = json.loads(OUT_PATH.read_text())
        prev_static = prev.get("static_norm") or []
        if len(prev_static) != len(flat_lats):
            click.echo(
                f"ERROR: published grid has {len(prev_static)} points but this run has "
                f"{len(flat_lats)} — refusing to pair mismatched grids",
                err=True,
            )
            sys.exit(2)
        static_norm = prev_static
        static_low = float(prev.get("static_norm_low", 0.0))
        static_high = float(prev.get("static_norm_high", 1.0))
    elif susc_path.exists():
        click.echo(f"[susc] sampling {susc_path.name} at {len(flat_lats)} grid points")
        with rasterio.open(susc_path) as ds:
            coords = list(zip(flat_lons, flat_lats))
            samples = list(ds.sample(coords, indexes=1))
            raw = np.array([s[0] if np.isfinite(s[0]) else float("nan") for s in samples])
        valid = np.isfinite(raw)
        if valid.any():
            static_low = float(np.quantile(raw[valid], 0.02))
            static_high = float(np.quantile(raw[valid], 0.98))
            click.echo(f"[susc] norm range 2-98 pct = [{static_low:.3f}, {static_high:.3f}]")
            denom = max(static_high - static_low, 1e-9)
            normed = np.clip((raw - static_low) / denom, 0, 1)
            normed[~valid] = 0
            static_norm = [round(float(v), 4) for v in normed]
        else:
            static_norm = [0.0] * len(flat_lats)
    else:
        click.echo(f"[susc] {susc_path.name} missing — static_norm filled with zeros")
        static_norm = [0.0] * len(flat_lats)

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "Open-Meteo Forecast API (past_days=7 daily + hourly precipitation)",
        "extent": extent,
        "static_source": susc_path.name,
        "bbox": [bbox["minx"], bbox["miny"], bbox["maxx"], bbox["maxy"]],
        "grid_bbox": [float(lons[0]), float(lats[0]), float(lons[-1]), float(lats[-1])],
        "rows": rows,
        "cols": cols,
        "step_deg": step,
        "wetness_norm_cap_mm": WETNESS_NORM_CAP_MM,
        "precip_now_norm_cap_mm_per_hr": PRECIP_NOW_NORM_CAP,
        "static_norm_low": static_low,
        "static_norm_high": static_high,
        "rain_7d_mm": [None if v != v else round(v, 2) for v in rain_7d_all],
        "precip_now_mm_per_hr": [None if v != v else round(v, 2) for v in precip_now_all],
        "static_norm": static_norm,
    }
    good = sum(1 for v in rain_7d_all if v == v)
    if good < 0.9 * len(rain_7d_all):
        click.echo(
            f"ERROR: only {good}/{len(rain_7d_all)} points fetched — refusing to "
            "overwrite the published grid with a mostly-empty one",
            err=True,
        )
        sys.exit(3)
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
