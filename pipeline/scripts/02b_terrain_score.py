"""Phase 1.2b — Compute terrain susceptibility from DEM.

Outputs the static terrain component of the seasonal flash-flood
susceptibility map.

Inputs:
  data/dem/Copernicus_DSM_COG_10_*.tif  — DEM tiles from 02a_fetch_dem.py
  data/aoi/aoi_north_thailand.geojson   — AOI polygon

Process:
  1. Mosaic DEM tiles to a single raster.
  2. Clip to AOI polygon.
  3. Hydrology conditioning (fill pits, fill depressions, resolve flats).
  4. D8 flow direction + flow accumulation (pysheds).
  5. Slope (Horn 1981, in degrees).
  6. TWI = ln( (a + 1) / tan(beta + eps) ) where a = flow_acc cells, beta = slope in radians.
  7. Normalize slope and TWI to 0-1, weighted-sum to terrain_score 0-40.

Outputs:
  data/output/dem_aoi.tif         — clipped DEM
  data/output/slope.tif           — slope in degrees
  data/output/flow_accumulation.tif
  data/output/twi.tif             — Topographic Wetness Index
  data/output/terrain_score.tif   — composite 0-40 (the deliverable)

Run:
  uv run python scripts/02b_terrain_score.py --pilot
  uv run python scripts/02b_terrain_score.py            # full AOI
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import click
import geopandas as gpd
import numpy as np
import rasterio

# pysheds 0.5 references np.in1d (removed in NumPy 2.0). Restore as alias for np.isin.
if not hasattr(np, "in1d"):
    np.in1d = np.isin  # type: ignore[attr-defined]

from pysheds.grid import Grid  # noqa: E402  (after monkey-patch)
from rasterio.merge import merge as rio_merge
from rasterio.mask import mask as rio_mask
from rasterio.warp import Resampling

REPO_ROOT = Path(__file__).resolve().parents[1]
DEM_DIR = REPO_ROOT / "data" / "dem"
AOI_PATH = REPO_ROOT / "data" / "aoi" / "aoi_north_thailand.geojson"
OUT_DIR = REPO_ROOT / "data" / "output"
OUT_DIR.mkdir(parents=True, exist_ok=True)


def mosaic_dem(pilot: bool) -> Path:
    if pilot:
        tiles = [DEM_DIR / "Copernicus_DSM_COG_10_N19_00_E098_00_DEM.tif"]
    else:
        tiles = sorted(DEM_DIR.glob("Copernicus_DSM_COG_10_*.tif"))
    if not tiles:
        raise SystemExit("no DEM tiles in data/dem/. Run 02a_fetch_dem.py first.")
    click.echo(f"[mosaic] {len(tiles)} tile(s)")

    srcs = [rasterio.open(p) for p in tiles]
    arr, transform = rio_merge(srcs)
    profile = srcs[0].profile.copy()
    profile.update(
        driver="GTiff",
        height=arr.shape[1],
        width=arr.shape[2],
        transform=transform,
        compress="deflate",
        predictor=2,
        tiled=True,
    )
    for s in srcs:
        s.close()
    out = OUT_DIR / ("dem_pilot.tif" if pilot else "dem_mosaic.tif")
    with rasterio.open(out, "w", **profile) as dst:
        dst.write(arr)
    click.echo(f"[mosaic] {out.name} {arr.shape[1]}x{arr.shape[2]} {arr.dtype}")
    return out


def clip_to_aoi(dem_path: Path, pilot: bool) -> Path:
    if pilot:
        # Skip AOI clip for pilot — use the single tile as-is.
        return dem_path
    click.echo("[clip] to AOI polygon")
    aoi = gpd.read_file(AOI_PATH).to_crs("EPSG:4326")
    geoms = [g.__geo_interface__ for g in aoi.geometry]
    with rasterio.open(dem_path) as src:
        arr, transform = rio_mask(src, geoms, crop=True, nodata=-32768)
        profile = src.profile.copy()
    profile.update(
        height=arr.shape[1],
        width=arr.shape[2],
        transform=transform,
        nodata=-32768,
        compress="deflate",
        predictor=2,
        tiled=True,
    )
    out = OUT_DIR / "dem_aoi.tif"
    with rasterio.open(out, "w", **profile) as dst:
        dst.write(arr)
    click.echo(f"[clip] {out.name} {arr.shape[1]}x{arr.shape[2]}")
    return out


def horn_slope_deg(elev: np.ndarray, dx_m: float, dy_m: float) -> np.ndarray:
    """Horn (1981) slope in degrees on a regular grid.

    dx_m, dy_m: cell size in meters (lon, lat).
    """
    z = elev.astype(np.float64)
    # 3x3 neighborhood gradients
    z_pad = np.pad(z, 1, mode="edge")
    a = z_pad[:-2, :-2]; b = z_pad[:-2, 1:-1]; c = z_pad[:-2, 2:]
    d = z_pad[1:-1, :-2]; f = z_pad[1:-1, 2:]
    g = z_pad[2:, :-2]; h = z_pad[2:, 1:-1]; i = z_pad[2:, 2:]
    dz_dx = ((c + 2 * f + i) - (a + 2 * d + g)) / (8.0 * dx_m)
    dz_dy = ((g + 2 * h + i) - (a + 2 * b + c)) / (8.0 * dy_m)
    rise = np.sqrt(dz_dx ** 2 + dz_dy ** 2)
    return np.degrees(np.arctan(rise))


def cell_size_meters(transform, lat_center: float) -> tuple[float, float]:
    """Approximate cell size in meters at given latitude for an EPSG:4326 grid."""
    deg_x = abs(transform.a)
    deg_y = abs(transform.e)
    m_per_deg_lat = 111_320.0
    m_per_deg_lon = 111_320.0 * np.cos(np.radians(lat_center))
    return deg_x * m_per_deg_lon, deg_y * m_per_deg_lat


def compute_slope(dem_path: Path, out_path: Path) -> Path:
    click.echo("[slope] Horn 1981")
    with rasterio.open(dem_path) as src:
        elev = src.read(1).astype(np.float32)
        nodata = src.nodata
        transform = src.transform
        bounds = src.bounds
        profile = src.profile.copy()
    lat_center = (bounds.bottom + bounds.top) / 2.0
    dx_m, dy_m = cell_size_meters(transform, lat_center)
    click.echo(f"  cell size at center lat {lat_center:.2f}: dx={dx_m:.1f}m dy={dy_m:.1f}m")
    slope = horn_slope_deg(elev, dx_m, dy_m).astype(np.float32)
    if nodata is not None:
        slope[elev == nodata] = -9999
    profile.update(dtype="float32", nodata=-9999, compress="deflate", predictor=2, tiled=True)
    with rasterio.open(out_path, "w", **profile) as dst:
        dst.write(slope, 1)
    click.echo(f"  {out_path.name}  range {slope[slope != -9999].min():.2f}-{slope[slope != -9999].max():.2f} deg")
    return out_path


def compute_flow_accumulation(dem_path: Path, out_path: Path) -> Path:
    click.echo("[hydrology] pysheds: fill pits → fill depressions → resolve flats → fdir → accumulation")
    grid = Grid.from_raster(str(dem_path))
    dem = grid.read_raster(str(dem_path))
    pit_filled = grid.fill_pits(dem)
    flooded = grid.fill_depressions(pit_filled)
    inflated = grid.resolve_flats(flooded)
    fdir = grid.flowdir(inflated)
    acc = grid.accumulation(fdir)
    grid.to_raster(
        acc,
        str(out_path),
        dtype="float32",
        compress="deflate",
        predictor=2,
        tiled=True,
    )
    click.echo(f"  {out_path.name}  max accumulation: {float(np.asarray(acc).max()):.0f} cells")
    return out_path


def compute_twi(slope_path: Path, acc_path: Path, out_path: Path) -> Path:
    click.echo("[twi] ln((a+1) / tan(beta+eps))")
    with rasterio.open(slope_path) as s:
        slope_deg = s.read(1)
        slope_nodata = s.nodata
        profile = s.profile.copy()
    with rasterio.open(acc_path) as a:
        acc = a.read(1)
    valid = (slope_deg != slope_nodata) & np.isfinite(acc)
    beta = np.radians(np.clip(slope_deg, 0.01, 89.0))  # avoid tan(0) and tan(90)
    a = np.maximum(acc, 0)
    twi = np.log((a + 1.0) / np.tan(beta))
    twi = twi.astype(np.float32)
    twi[~valid] = -9999
    profile.update(dtype="float32", nodata=-9999, compress="deflate", predictor=2, tiled=True)
    with rasterio.open(out_path, "w", **profile) as dst:
        dst.write(twi, 1)
    valid_twi = twi[valid]
    click.echo(f"  {out_path.name}  range {valid_twi.min():.2f} to {valid_twi.max():.2f}")
    return out_path


def composite_terrain_score(
    slope_path: Path,
    twi_path: Path,
    out_path: Path,
    w_slope: float = 0.5,
    w_twi: float = 0.5,
    target_max: float = 40.0,
) -> Path:
    """Combine slope and TWI into a single 0..target_max raster.

    Per-raster percentile normalization (clip to 5th-95th) → 0-1, then
    weighted average × target_max.

    This is honest about what "score" means: a relative ranking inside the
    AOI, not a calibrated probability.
    """
    click.echo(f"[composite] terrain_score = {w_slope}*slope_norm + {w_twi}*twi_norm × {target_max}")
    with rasterio.open(slope_path) as s:
        slope = s.read(1)
        s_nd = s.nodata
        profile = s.profile.copy()
    with rasterio.open(twi_path) as t:
        twi = t.read(1)
        t_nd = t.nodata
    valid = (slope != s_nd) & (twi != t_nd) & np.isfinite(slope) & np.isfinite(twi)

    def norm01(arr: np.ndarray, mask: np.ndarray) -> np.ndarray:
        lo, hi = np.percentile(arr[mask], [5, 95])
        out = np.clip((arr - lo) / max(hi - lo, 1e-9), 0.0, 1.0)
        return out

    sn = norm01(slope, valid)
    tn = norm01(twi, valid)
    score = (w_slope * sn + w_twi * tn) * target_max
    score = score.astype(np.float32)
    score[~valid] = -9999
    profile.update(dtype="float32", nodata=-9999, compress="deflate", predictor=2, tiled=True)
    with rasterio.open(out_path, "w", **profile) as dst:
        dst.write(score, 1)
    valid_score = score[valid]
    click.echo(
        f"  {out_path.name}  min/median/max = "
        f"{valid_score.min():.2f} / {np.median(valid_score):.2f} / {valid_score.max():.2f}"
    )
    return out_path


@click.command()
@click.option("--pilot", is_flag=True, help="Use only N19_E098 tile (Pai test)")
def main(pilot: bool) -> None:
    suffix = "_pilot" if pilot else ""
    dem_mosaic = mosaic_dem(pilot)
    dem_aoi = clip_to_aoi(dem_mosaic, pilot)
    slope = compute_slope(dem_aoi, OUT_DIR / f"slope{suffix}.tif")
    acc = compute_flow_accumulation(dem_aoi, OUT_DIR / f"flow_accumulation{suffix}.tif")
    twi = compute_twi(slope, acc, OUT_DIR / f"twi{suffix}.tif")
    composite_terrain_score(slope, twi, OUT_DIR / f"terrain_score{suffix}.tif")
    click.echo("\n=== Phase 1.2 complete ===")
    click.echo(f"primary deliverable: {OUT_DIR / f'terrain_score{suffix}.tif'}")


if __name__ == "__main__":
    main()
