"""Phase T.4 — Widen the published grid to the whole country.

The static susceptibility layer now covers Thailand, but the grid the
frontend reads still spans only the northern AOI, so the risk hexes stop
at the old bounding box. Rebuilding the grid outright needs thousands of
Open-Meteo calls; this instead keeps every rain value already fetched and
fills the new area with `null`, which the frontend reads as "no weather
data here yet" (static hexes draw, live and wetness hexes do not).

The daily cron then refills the nulls on its next successful run.

  public/data/wetness_grid.json   — rewritten in place, same schema

Run:
  uv run python scripts/16_expand_grid.py
  uv run python scripts/16_expand_grid.py --step 0.15
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import click
import numpy as np
import rasterio
from shapely.geometry import shape

REPO_ROOT = Path(__file__).resolve().parents[1]
BOUNDARY = REPO_ROOT / "data" / "aoi" / "thailand_boundary.geojson"
SUSC = REPO_ROOT / "data" / "output" / "susceptibility_thailand.tif"
GRID = REPO_ROOT.parent / "public" / "data" / "wetness_grid.json"


@click.command()
@click.option("--step", default=0.15, type=float, help="Grid step in degrees")
def main(step: float) -> None:
    for p in (BOUNDARY, SUSC, GRID):
        if not p.exists():
            raise SystemExit(f"missing {p}")

    old = json.loads(GRID.read_text())
    ow, os_, oe, on = old["grid_bbox"]
    ocols, orows = old["cols"], old["rows"]
    click.echo(f"[old] {orows}x{ocols} over {ow:.2f},{os_:.2f} → {oe:.2f},{on:.2f}")

    b = shape(json.loads(BOUNDARY.read_text())["geometry"]).bounds
    lons = np.arange(np.floor(b[0] / step) * step, b[2] + step, step)
    lats = np.arange(np.floor(b[1] / step) * step, b[3] + step, step)
    cols, rows = len(lons), len(lats)
    click.echo(f"[new] {rows}x{cols} = {rows * cols} points over Thailand")

    # Row 0 is the north edge, matching the GeoTIFF convention the old grid uses.
    flat_lats = [float(lat) for lat in lats[::-1] for _ in lons]
    flat_lons = [float(lon) for _ in lats for lon in lons]

    def old_index(lat: float, lon: float) -> int | None:
        """Index of this point in the old grid, if it falls inside it."""
        if not (ow - 1e-6 <= lon <= oe + 1e-6 and os_ - 1e-6 <= lat <= on + 1e-6):
            return None
        c = int(round((lon - ow) / step))
        r = int(round((on - lat) / step))
        if 0 <= r < orows and 0 <= c < ocols:
            return r * ocols + c
        return None

    old_rain = old["rain_7d_mm"]
    old_now = old["precip_now_mm_per_hr"]
    rain: list[float | None] = []
    now: list[float | None] = []
    carried = 0
    for lat, lon in zip(flat_lats, flat_lons):
        i = old_index(lat, lon)
        if i is None:
            rain.append(None)
            now.append(None)
        else:
            rain.append(old_rain[i])
            now.append(old_now[i])
            carried += 1
    click.echo(f"[carry] {carried} point(s) keep their existing rain values")

    with rasterio.open(SUSC) as ds:
        samples = list(ds.sample(list(zip(flat_lons, flat_lats)), indexes=1))
    raw = np.array([s[0] if np.isfinite(s[0]) else np.nan for s in samples])
    valid = np.isfinite(raw)
    if not valid.any():
        raise SystemExit("susceptibility raster returned no valid samples")
    low = float(np.quantile(raw[valid], 0.02))
    high = float(np.quantile(raw[valid], 0.98))
    normed = np.clip((raw - low) / max(high - low, 1e-9), 0, 1)
    normed[~valid] = 0.0
    click.echo(f"[susc] norm 2-98 pct = [{low:.3f}, {high:.3f}]; "
               f"{int((normed > 0.02).sum())} point(s) inside the country")

    payload = dict(old)
    payload.update(
        {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "extent": "thailand",
            "static_source": SUSC.name,
            "grid_bbox": [float(lons[0]), float(lats[0]), float(lons[-1]), float(lats[-1])],
            "bbox": [float(b[0]), float(b[1]), float(b[2]), float(b[3])],
            "rows": rows,
            "cols": cols,
            "step_deg": step,
            "static_norm_low": low,
            "static_norm_high": high,
            "static_norm": [round(float(v), 4) for v in normed],
            "rain_7d_mm": rain,
            "precip_now_mm_per_hr": now,
            "rain_coverage": {
                "points_with_rain": carried,
                "points_total": rows * cols,
                "note": "nulls are outside the last successful Open-Meteo fetch",
            },
        }
    )
    GRID.write_text(json.dumps(payload))
    click.echo(f"[write] {GRID.name}  {GRID.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
