"""Phase 1.5 — Village-level risk ranking from GEE susceptibility raster.

Inputs:
  data/output/susceptibility.tif   — GEE export (bands: RISK [0..~0.6], CLASS [1..5])
  GADM 4.1 Thailand level 3 (subdistrict/ตำบล) — auto-downloaded

Process:
  1. Download GADM level 3 (~25MB), filter to 9 northern provinces.
  2. For each subdistrict polygon, sample the RISK raster (zonal stats).
     - mean / max / p90 / p95 RISK
     - count cells in CLASS >= 3
     - cell count + area
  3. Rescale RISK to [0..1] across the whole AOI (since the GEE
     output max is ~0.59, not 1.0).
  4. Output GeoJSON + CSV ranked by p90 risk.

Run:
  uv run python scripts/05_village_risk.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import click
import geopandas as gpd
import numpy as np
import pandas as pd
import rasterio
import requests
from rasterio.features import geometry_mask
from rasterio.windows import from_bounds
from shapely.geometry import shape
from tqdm import tqdm

REPO_ROOT = Path(__file__).resolve().parents[1]
SUSC_PATH = REPO_ROOT / "data" / "output" / "susceptibility.tif"
# Nationwide raster built locally by 15_susceptibility_thailand.py (no GEE).
SUSC_TH_PATH = REPO_ROOT / "data" / "output" / "susceptibility_thailand.tif"
ADMIN_DIR = REPO_ROOT / "data" / "aoi"
ADMIN_DIR.mkdir(parents=True, exist_ok=True)
OUT_DIR = REPO_ROOT / "data" / "output"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# GADM English province names to match the 9 northern provinces in the GEE export.
NORTHERN_PROVINCES_GADM = [
    "ChiangMai",
    "ChiangRai",
    "Lampang",
    "Lamphun",
    "MaeHongSon",
    "Nan",
    "Phayao",
    "Phrae",
    "Uttaradit",
]

GADM_L3_URL = "https://geodata.ucdavis.edu/gadm/gadm4.1/json/gadm41_THA_3.json.zip"
GADM_L3_PATH = ADMIN_DIR / "gadm41_THA_3.json.zip"


def download_gadm_level3() -> Path:
    if GADM_L3_PATH.exists() and GADM_L3_PATH.stat().st_size > 0:
        click.echo(f"[cache] {GADM_L3_PATH.name} ({GADM_L3_PATH.stat().st_size/1024:.0f} KB)")
        return GADM_L3_PATH
    click.echo(f"[download] GADM Thailand level 3 from {GADM_L3_URL}")
    with requests.get(GADM_L3_URL, stream=True, timeout=180) as r:
        r.raise_for_status()
        total = int(r.headers.get("content-length", 0))
        with GADM_L3_PATH.open("wb") as f, tqdm(
            total=total, unit="B", unit_scale=True, desc="gadm-l3"
        ) as bar:
            for chunk in r.iter_content(chunk_size=1 << 14):
                if chunk:
                    f.write(chunk)
                    bar.update(len(chunk))
    return GADM_L3_PATH


def zonal_stats_per_polygon(
    gdf: gpd.GeoDataFrame, raster_path: Path
) -> pd.DataFrame:
    """For each polygon, sample the raster band 1 (RISK) and band 2 (CLASS).

    Memory strategy: read each polygon's window only — never the full raster.
    """
    records = []
    with rasterio.open(raster_path) as ds:
        full_transform = ds.transform
        full_width, full_height = ds.width, ds.height
        rs_crs = ds.crs

        if str(gdf.crs) != str(rs_crs):
            click.echo(f"[reproject] {gdf.crs} -> {rs_crs}")
            gdf = gdf.to_crs(rs_crs)

        for _, row in tqdm(gdf.iterrows(), total=len(gdf), desc="zonal"):
            geom = row.geometry
            if geom is None or geom.is_empty:
                continue
            minx, miny, maxx, maxy = geom.bounds
            try:
                window = from_bounds(minx, miny, maxx, maxy, full_transform)
            except Exception:
                continue

            # clamp window to raster
            col_off = max(0, int(window.col_off))
            row_off = max(0, int(window.row_off))
            col_end = min(full_width, int(window.col_off + window.width) + 1)
            row_end = min(full_height, int(window.row_off + window.height) + 1)
            w_w = col_end - col_off
            w_h = row_end - row_off
            if w_w <= 0 or w_h <= 0:
                continue

            from rasterio.windows import Window
            win = Window(col_off, row_off, w_w, w_h)
            risk = ds.read(1, window=win)
            cls = ds.read(2, window=win) if ds.count >= 2 else None
            win_transform = rasterio.windows.transform(win, full_transform)

            mask = geometry_mask(
                [geom], out_shape=risk.shape, transform=win_transform, invert=True
            )
            valid = mask & np.isfinite(risk)
            if valid.sum() == 0:
                continue
            r = risk[valid]
            rec = {
                "GID_3": row.get("GID_3"),
                "NAME_3": row.get("NAME_3"),
                "NAME_2": row.get("NAME_2"),
                "NAME_1": row.get("NAME_1"),
                "TYPE_3": row.get("TYPE_3"),
                "cells": int(valid.sum()),
                "risk_mean": float(r.mean()),
                "risk_max": float(r.max()),
                "risk_p75": float(np.percentile(r, 75)),
                "risk_p90": float(np.percentile(r, 90)),
                "risk_p95": float(np.percentile(r, 95)),
            }
            if cls is not None:
                cv = cls[valid]
                rec["class_max"] = int(cv.max())
                rec["class_3plus_cells"] = int((cv >= 3).sum())
                rec["class_3plus_pct"] = float((cv >= 3).sum() / valid.sum() * 100)
            records.append(rec)

    return pd.DataFrame(records)


@click.command()
@click.option(
    "--extent",
    default="north",
    type=click.Choice(["north", "thailand"]),
    help="north = 9 provinces from the GEE raster; thailand = all 77 from the local raster",
)
def main(extent: str) -> int:
    susc_path = SUSC_TH_PATH if extent == "thailand" else SUSC_PATH
    if not susc_path.exists():
        click.echo(f"ERROR: {susc_path} not found", err=True)
        return 2

    download_gadm_level3()

    click.echo("[load] reading admin-3 polygons...")
    full = gpd.read_file(f"zip://{GADM_L3_PATH}")
    click.echo(f"[load] {len(full)} subdistricts in Thailand")

    if extent == "thailand":
        north = full.copy()  # variable name kept; every tambon in the country
        click.echo(f"[filter] {len(north)} subdistricts — whole country")
    else:
        north = full[full["NAME_1"].isin(NORTHERN_PROVINCES_GADM)].copy()
        click.echo(f"[filter] {len(north)} subdistricts in 9 northern provinces")
    if len(north) == 0:
        click.echo(
            f"ERROR: no rows matched provinces {NORTHERN_PROVINCES_GADM}", err=True
        )
        return 3

    click.echo("[zonal] computing per-subdistrict statistics...")
    df = zonal_stats_per_polygon(north, susc_path)
    click.echo(f"[zonal] {len(df)} subdistricts with valid raster coverage")

    # Rescale risk to 0..1 across the AOI (max in this export is ~0.59).
    aoi_max = df["risk_max"].max()
    aoi_min = df["risk_mean"].min()
    click.echo(
        f"[rescale] AOI risk_mean range [{aoi_min:.3f}, {df['risk_mean'].max():.3f}], "
        f"raster max = {aoi_max:.3f}"
    )
    for col in ["risk_mean", "risk_max", "risk_p75", "risk_p90", "risk_p95"]:
        df[f"{col}_norm"] = ((df[col] - aoi_min) / (aoi_max - aoi_min)).clip(0, 1)

    df = df.sort_values("risk_p90_norm", ascending=False).reset_index(drop=True)
    df.insert(0, "rank", range(1, len(df) + 1))

    csv_path = OUT_DIR / "village_risk_table.csv"
    df.to_csv(csv_path, index=False)
    click.echo(f"[write] {csv_path.name}")

    # Geo file: join stats back to polygons (only those that had coverage)
    geo = north.merge(df, on=["GID_3", "NAME_3", "NAME_2", "NAME_1", "TYPE_3"], how="inner")
    geo_path = OUT_DIR / "village_risk.geojson"
    geo.to_file(geo_path, driver="GeoJSON")
    click.echo(f"[write] {geo_path.name}  ({len(geo)} features)")

    # Top-20 preview
    click.echo("\n=== Top 20 highest-p90-risk subdistricts ===")
    cols = ["rank", "NAME_1", "NAME_2", "NAME_3", "TYPE_3", "risk_p90", "risk_p90_norm", "class_3plus_pct"]
    cols = [c for c in cols if c in df.columns]
    print(df[cols].head(20).to_string(index=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
