"""Phase T.5 — 7-day rainfall for the whole country, from CHIRPS.

Open-Meteo meters by location-hours, so a nationwide grid burns its free
tier in one run and then returns 429 for the rest of the day — which is
how the map's rain data ended up frozen. CHIRPS publishes daily rainfall
as a single global GeoTIFF per day: no account, no quota, one download
per day covers every grid point at 0.05° (~5.6 km), finer than the grid
itself.

  https://data.chc.ucsb.edu/products/CHIRPS-2.0/prelim/global_daily/

Preliminary files land ~2-4 days behind, so the 7-day window this builds
ends at the most recent available day rather than today. That is the
right trade for the wetness term (7-day soil-moisture context), while the
live trigger keeps coming from HII stations and radar, which are current.

Fills `rain_7d_mm` in public/data/wetness_grid.json, leaving
`precip_now_mm_per_hr` and everything else untouched.

Run:
  uv run python scripts/17_rain_chirps.py
  uv run python scripts/17_rain_chirps.py --days 7 --max-lag 6
"""

from __future__ import annotations

import gzip
import json
import shutil
import ssl
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import click
import numpy as np
import rasterio

REPO_ROOT = Path(__file__).resolve().parents[1]
CACHE = REPO_ROOT / "data" / "chirps"
GRID = REPO_ROOT.parent / "public" / "data" / "wetness_grid.json"
BASE = "https://data.chc.ucsb.edu/products/CHIRPS-2.0/prelim/global_daily/tifs/p05"
UA = "flashflood-risk-intelligence (github.com/SitthisakMoukomla)"

try:
    import certifi

    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except Exception:  # pragma: no cover
    SSL_CTX = ssl.create_default_context()


def fetch_day(d: date) -> Path | None:
    """Download one CHIRPS day, or None when it is not published yet."""
    CACHE.mkdir(parents=True, exist_ok=True)
    tif = CACHE / f"chirps-{d:%Y%m%d}.tif"
    if tif.exists():
        return tif
    url = f"{BASE}/{d:%Y}/chirps-v2.0.{d:%Y.%m.%d}.tif.gz"
    gz = tif.with_suffix(".tif.gz")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=300, context=SSL_CTX) as r, open(gz, "wb") as f:
            shutil.copyfileobj(r, f)
    except Exception:
        gz.unlink(missing_ok=True)
        return None
    with gzip.open(gz, "rb") as src, open(tif, "wb") as dst:
        shutil.copyfileobj(src, dst)
    gz.unlink(missing_ok=True)
    return tif


@click.command()
@click.option("--days", default=7, type=int, help="Length of the accumulation window")
@click.option(
    "--max-lag",
    default=8,
    type=int,
    help="How many days back to look for the newest published file",
)
def main(days: int, max_lag: int) -> None:
    if not GRID.exists():
        raise SystemExit(f"missing {GRID}")
    grid = json.loads(GRID.read_text())
    rows, cols = grid["rows"], grid["cols"]
    w, s, e, n = grid["grid_bbox"]
    lons = np.linspace(w, e, cols)
    lats = np.linspace(n, s, rows)  # row 0 = north, matching the grid's layout
    pts = [(float(lon), float(lat)) for lat in lats for lon in lons]
    click.echo(f"[grid] {rows}x{cols} = {len(pts)} points")

    # Walk back from today until a published day turns up, then take the
    # `days` days ending there.
    today = datetime.now(timezone.utc).date()
    newest = None
    for lag in range(1, max_lag + 1):
        d = today - timedelta(days=lag)
        if fetch_day(d):
            newest = d
            break
    if newest is None:
        raise SystemExit(f"no CHIRPS file published in the last {max_lag} days")
    click.echo(f"[chirps] newest published day: {newest} (lag {(today - newest).days}d)")

    total = np.zeros(len(pts), dtype="float64")
    used = 0
    for i in range(days):
        d = newest - timedelta(days=i)
        tif = fetch_day(d)
        if tif is None:
            click.echo(f"  {d}: not published — skipped")
            continue
        with rasterio.open(tif) as ds:
            vals = np.array([v[0] for v in ds.sample(pts, indexes=1)], dtype="float64")
        vals = np.where(vals < 0, 0.0, vals)  # CHIRPS uses -9999 for no data
        total += vals
        used += 1
        click.echo(f"  {d}: mean {np.nanmean(vals):5.1f} mm  max {np.nanmax(vals):6.1f} mm")
    if used == 0:
        raise SystemExit("no CHIRPS days could be read")
    if used < days:
        click.echo(f"[warn] window covers {used}/{days} days")

    grid["rain_7d_mm"] = [round(float(v), 2) for v in total]
    grid["rain_source"] = (
        f"CHIRPS v2.0 preliminary daily, {used}-day sum ending {newest.isoformat()}"
    )
    grid["rain_window_end"] = newest.isoformat()
    grid["generated_at"] = datetime.now(timezone.utc).isoformat()
    grid.pop("rain_coverage", None)
    GRID.write_text(json.dumps(grid))

    arr = total
    click.echo(
        f"[write] {GRID.name}: rain_7d_mm median {np.median(arr):.1f} mm, "
        f"mean {arr.mean():.1f}, max {arr.max():.1f}, ≥40mm at {(arr >= 40).mean() * 100:.0f}% of points"
    )


if __name__ == "__main__":
    main()
