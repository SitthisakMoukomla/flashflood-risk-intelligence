"""Phase 1.6 — Fetch 7-day antecedent rainfall per tambon centroid.

Uses Open-Meteo Forecast API with `past_days=7` (free, no key) to get the
last 7 days of precipitation at each ตำบล centroid. The result is the
wetness/soil-moisture proxy for the dynamic trigger overlay.

SCS-CN style interpretation:
  - 0–13 mm in 5 days  → AMC I (dry)
  - 13–28 mm           → AMC II (avg, dormant) / 36–53 mm growing
  - >28 mm dormant / >53 mm growing → AMC III (wet)
  We use a continuous 0..1 normalization at 80 mm cap (tropical AMC III).

Output:
  public/data/wetness_7d.json
    {
      "generated_at": "2026-05-09T...",
      "window_days": 7,
      "norm_cap_mm": 80,
      "tambon": [
        { "GID_3": "...", "rain_7d_mm": 12.4, "wetness_norm": 0.155 },
        ...
      ]
    }

Run:
  uv run python scripts/06_wetness.py
"""

from __future__ import annotations

import json
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

import click
import geopandas as gpd
import requests
from tqdm import tqdm

REPO_ROOT = Path(__file__).resolve().parents[1]
GEO_PATH = REPO_ROOT / "data" / "output" / "village_risk.geojson"
PUBLIC_DATA = REPO_ROOT.parent / "public" / "data"
PUBLIC_DATA.mkdir(parents=True, exist_ok=True)
OUT_PATH = PUBLIC_DATA / "wetness_7d.json"

OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
WINDOW_DAYS = 7
NORM_CAP_MM = 80.0  # AMC III equivalent for tropical antecedent rain


def fetch_one(gid: str, lat: float, lon: float) -> tuple[str, float | None]:
    params = {
        "latitude": round(lat, 4),
        "longitude": round(lon, 4),
        "daily": "precipitation_sum",
        "past_days": WINDOW_DAYS,
        "forecast_days": 1,
        "timezone": "Asia/Bangkok",
    }
    try:
        r = requests.get(OPEN_METEO_URL, params=params, timeout=30)
        r.raise_for_status()
        data = r.json()
        # past 7 days = elements 0..6, today = element 7
        rain = data.get("daily", {}).get("precipitation_sum", [])
        past = [v for v in rain[:WINDOW_DAYS] if v is not None]
        if not past:
            return gid, None
        return gid, float(sum(past))
    except Exception:
        return gid, None


@click.command()
@click.option("--workers", default=8, type=int, help="Parallel HTTP requests")
@click.option("--limit", default=0, type=int, help="Limit to first N tambon (for smoke test)")
def main(workers: int, limit: int) -> None:
    if not GEO_PATH.exists():
        click.echo(f"ERROR: {GEO_PATH} not found — run 05_village_risk.py first", err=True)
        sys.exit(2)

    click.echo(f"[load] {GEO_PATH.name}")
    gdf = gpd.read_file(GEO_PATH)
    # Use representative_point() to ensure it falls inside the polygon (centroid can be outside for crescent shapes)
    pts = gdf.set_geometry(gdf.geometry.representative_point())
    click.echo(f"[load] {len(pts)} tambon centroids in 9 northern provinces")

    if limit:
        pts = pts.head(limit)
        click.echo(f"[limit] processing first {len(pts)} only")

    targets = [
        (row.GID_3, row.geometry.y, row.geometry.x)
        for _, row in pts.iterrows()
        if row.geometry is not None
    ]

    results: dict[str, float | None] = {}
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(fetch_one, gid, lat, lon): gid for gid, lat, lon in targets}
        for fut in tqdm(as_completed(futs), total=len(futs), desc="open-meteo"):
            gid, mm = fut.result()
            results[gid] = mm

    ok = [v for v in results.values() if v is not None]
    miss = [k for k, v in results.items() if v is None]
    click.echo(
        f"\n[done] {len(ok)} ตำบล with rain data, {len(miss)} failed"
        f"\n  rain_7d_mm: min={min(ok):.1f}  median={sorted(ok)[len(ok)//2]:.1f}  max={max(ok):.1f}"
    )

    out = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "window_days": WINDOW_DAYS,
        "norm_cap_mm": NORM_CAP_MM,
        "source": "Open-Meteo Forecast API (past_days=7)",
        "tambon": [
            {
                "GID_3": gid,
                "rain_7d_mm": round(mm, 2),
                "wetness_norm": round(min(mm / NORM_CAP_MM, 1.0), 4),
            }
            for gid, mm in sorted(results.items())
            if mm is not None
        ],
    }
    OUT_PATH.write_text(json.dumps(out, indent=2, ensure_ascii=False))
    click.echo(f"[write] {OUT_PATH}  ({OUT_PATH.stat().st_size/1024:.1f} KB)")

    # Quick distribution by province (join with geojson)
    df = gdf[["GID_3", "NAME_1"]].copy()
    df["rain_7d_mm"] = df["GID_3"].map(results)
    summary = df.dropna(subset=["rain_7d_mm"]).groupby("NAME_1")["rain_7d_mm"].agg(["count", "mean", "max"]).round(1)
    click.echo("\n=== rain_7d_mm by province ===")
    print(summary.to_string())


if __name__ == "__main__":
    main()
