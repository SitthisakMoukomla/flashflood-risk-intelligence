"""Phase T.3 — Nationwide static flash-flood susceptibility, without GEE.

The northern raster came out of Earth Engine, which is capped by a monthly
compute quota. This rebuilds the same idea from open data that needs no
account and no quota, so the whole country can be (re)generated at will:

  HydroSHEDS v1 15 arc-second (~450 m), hydrologically conditioned:
    hyd_as_dem_15s  — void-filled elevation
    hyd_as_acc_15s  — flow accumulation (upstream cell count)
  Copernicus DEM 90 m (AWS Open Data, no auth) — slope only

Terrain and hydrology come at different resolutions on purpose. Flow
accumulation needs a hydrologically conditioned DEM and is stable at
450 m, but slope is not: measured on 450 m cells Thailand's median slope
collapses to 0.7°, because a hillside shorter than the cell averages
away. Slope is therefore computed on 90 m Copernicus tiles and then
aggregated (mean) onto the 450 m grid, which preserves the relief the
susceptibility formula depends on.

Weights keep the Earth Engine formula's shape. Its EVI (0.13) and burned
area (0.10) terms need Earthdata credentials, so they are dropped and the
remaining weights renormalised — recorded in the output metadata rather
than quietly rebalanced:

  TWI 0.24 → 0.312   slope 0.18 → 0.234   dist-to-stream 0.18 → 0.234
  elevation 0.12 → 0.156   built-up 0.05 → 0.065

Outputs:
  data/output/susceptibility_thailand.tif   — band 1 SUSCEPTIBILITY (0-1)
  data/output/susceptibility_thailand.json  — provenance + weights

Run:
  uv run python scripts/15_susceptibility_thailand.py
  uv run python scripts/15_susceptibility_thailand.py --skip-builtup
"""

from __future__ import annotations

import json
import math
import shutil
import ssl
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import click
import numpy as np
import rasterio
from rasterio.mask import mask as rio_mask
from scipy import ndimage
from shapely.geometry import mapping, shape

REPO_ROOT = Path(__file__).resolve().parents[1]
CACHE = REPO_ROOT / "data" / "hydrosheds"
OUT_TIF = REPO_ROOT / "data" / "output" / "susceptibility_thailand.tif"
OUT_META = REPO_ROOT / "data" / "output" / "susceptibility_thailand.json"
BOUNDARY = REPO_ROOT / "data" / "aoi" / "thailand_boundary.geojson"

HYDROSHEDS = {
    "dem": "https://data.hydrosheds.org/file/hydrosheds-v1-dem/hyd_as_dem_15s.zip",
    "acc": "https://data.hydrosheds.org/file/hydrosheds-v1-acc/hyd_as_acc_15s.zip",
}
COP_DEM_BASE = "https://copernicus-dem-90m.s3.amazonaws.com"
COP_CACHE = REPO_ROOT / "data" / "dem90"

# Same normalisation ranges as the Earth Engine script.
NORM = {
    "dem": (0.0, 2500.0, True),  # low ground → higher risk
    "slope": (0.0, 45.0, False),
    "twi": (5.0, 20.0, False),
    "dist": (0.0, 3000.0, True),  # near a stream → higher risk
}
WEIGHTS = {"twi": 0.312, "slope": 0.234, "dist": 0.234, "dem": 0.156, "built": 0.065}

# A cell draining more than this much upstream area counts as a channel.
# Expressed as km² so it does not silently change meaning if the grid
# resolution does. 25 km² on this 450 m grid puts ~6% of land cells in a
# channel and reproduces the Earth Engine run's value distribution most
# closely; the EE script's 1 km² was tuned for 90 m MERIT cells, and
# applying it here would call a quarter of the country "stream".
STREAM_DRAINAGE_KM2 = 25.0

# HydroSHEDS returns 403 to requests without a User-Agent.
UA = "flashflood-risk-intelligence (github.com/SitthisakMoukomla)"

try:  # certifi ships with the pipeline's deps; fall back to the system store
    import certifi

    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except Exception:  # pragma: no cover
    SSL_CTX = ssl.create_default_context()


def fetch(name: str, url: str) -> Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    tif = next(CACHE.glob(f"hyd_as_{name}_15s*.tif"), None)
    if tif:
        click.echo(f"[cache] {tif.name}")
        return tif
    zip_path = CACHE / f"hyd_as_{name}_15s.zip"
    if not zip_path.exists():
        click.echo(f"[fetch] {url}")
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=900, context=SSL_CTX) as r, open(
            zip_path, "wb"
        ) as f:
            shutil.copyfileobj(r, f)
    with zipfile.ZipFile(zip_path) as z:
        members = [m for m in z.namelist() if m.endswith(".tif")]
        if not members:
            raise SystemExit(f"no .tif inside {zip_path.name}")
        z.extract(members[0], CACHE)
    got = CACHE / members[0]
    final = CACHE / Path(members[0]).name
    if got != final:
        got.rename(final)
    click.echo(f"[unzip] {final.name}")
    return final


def cop_tile_url(lat: int, lon: int) -> tuple[str, str]:
    ns = "N" if lat >= 0 else "S"
    ew = "E" if lon >= 0 else "W"
    name = f"Copernicus_DSM_COG_30_{ns}{abs(lat):02d}_00_{ew}{abs(lon):03d}_00_DEM"
    return name, f"{COP_DEM_BASE}/{name}/{name}.tif"


def fetch_cop_dem(bounds: tuple[float, float, float, float]) -> list[Path]:
    """1° Copernicus DEM tiles covering bounds; skips tiles that 404 (sea)."""
    COP_CACHE.mkdir(parents=True, exist_ok=True)
    w, s_, e, n = bounds
    paths: list[Path] = []
    wanted = [
        (lat, lon)
        for lat in range(math.floor(s_), math.ceil(n))
        for lon in range(math.floor(w), math.ceil(e))
    ]
    for i, (lat, lon) in enumerate(wanted, start=1):
        name, url = cop_tile_url(lat, lon)
        dest = COP_CACHE / f"{name}.tif"
        if dest.exists():
            paths.append(dest)
            continue
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=300, context=SSL_CTX) as r, open(
                dest, "wb"
            ) as f:
                shutil.copyfileobj(r, f)
            paths.append(dest)
        except Exception:
            dest.unlink(missing_ok=True)  # ocean tile — nothing published
        if i % 20 == 0:
            click.echo(f"  [dem90] {i}/{len(wanted)} tiles checked, {len(paths)} present")
    click.echo(f"[dem90] {len(paths)} tile(s) covering the AOI")
    return paths


def slope_from_cop_dem(paths: list[Path], profile: dict) -> np.ndarray:
    """Horn slope at 90 m, mean-aggregated onto the 450 m working grid."""
    from rasterio.warp import Resampling, reproject

    acc_sum = np.zeros((profile["height"], profile["width"]), dtype="float64")
    acc_cnt = np.zeros_like(acc_sum)
    for i, p in enumerate(paths, start=1):
        with rasterio.open(p) as ds:
            elev = ds.read(1).astype("float32")
            nod = ds.nodata
            ok = np.isfinite(elev) if nod is None else (elev != nod) & np.isfinite(elev)
            elev = np.where(ok, elev, 0.0)
            tt = ds.transform
            lat_c = tt.f + (ds.height / 2) * tt.e
            dy = abs(tt.e) * 111_320.0
            dx = abs(tt.a) * 111_320.0 * math.cos(math.radians(lat_c))
            sl = horn_slope_deg(elev, dx, dy)
            sl = np.where(ok, sl, np.nan)

            tile_slope = np.full((profile["height"], profile["width"]), np.nan, dtype="float32")
            tile_count = np.zeros((profile["height"], profile["width"]), dtype="float32")
            reproject(
                source=sl,
                destination=tile_slope,
                src_transform=tt,
                src_crs=ds.crs,
                dst_transform=profile["transform"],
                dst_crs=ds.crs,
                resampling=Resampling.average,
                src_nodata=np.nan,
                dst_nodata=np.nan,
            )
            reproject(
                source=ok.astype("float32"),
                destination=tile_count,
                src_transform=tt,
                src_crs=ds.crs,
                dst_transform=profile["transform"],
                dst_crs=ds.crs,
                resampling=Resampling.average,
                src_nodata=0.0,
                dst_nodata=0.0,
            )
        m = np.isfinite(tile_slope) & (tile_count > 0)
        acc_sum[m] += tile_slope[m] * tile_count[m]
        acc_cnt[m] += tile_count[m]
        if i % 20 == 0:
            click.echo(f"  [slope] {i}/{len(paths)} tiles")
    out = np.divide(acc_sum, acc_cnt, out=np.zeros_like(acc_sum), where=acc_cnt > 0)
    return out.astype("float32")


def clip(path: Path, geom) -> tuple[np.ndarray, np.ndarray, dict]:
    """Clip to the AOI and return (values, valid mask, profile).

    HydroSHEDS marks sea and voids with the dtype maximum (32767 for the
    int16 DEM, 4294967295 for the uint32 accumulation). Those are not
    small negative sentinels, so they have to be compared against the
    band's declared nodata or they sail straight into the statistics.
    """
    with rasterio.open(path) as ds:
        arr, transform = rio_mask(ds, [mapping(geom)], crop=True, filled=True, nodata=ds.nodata)
        nodata = ds.nodata
        profile = ds.profile | {
            "height": arr.shape[1],
            "width": arr.shape[2],
            "transform": transform,
        }
    band = arr[0]
    valid = np.isfinite(band.astype("float64"))
    if nodata is not None:
        valid &= band != nodata
    return band, valid, profile


def norm(a: np.ndarray, key: str) -> np.ndarray:
    lo, hi, invert = NORM[key]
    x = np.clip((a - lo) / (hi - lo), 0.0, 1.0)
    return 1.0 - x if invert else x


def horn_slope_deg(elev: np.ndarray, dx: float, dy: float) -> np.ndarray:
    """Horn (1981) slope, the same estimator 02b_terrain_score.py uses."""
    kx = np.array([[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]], dtype="float32") / (8.0 * dx)
    ky = np.array([[-1, -2, -1], [0, 0, 0], [1, 2, 1]], dtype="float32") / (8.0 * dy)
    gx = ndimage.convolve(elev, kx, mode="nearest")
    gy = ndimage.convolve(elev, ky, mode="nearest")
    return np.degrees(np.arctan(np.hypot(gx, gy)))


@click.command()
@click.option("--skip-builtup", is_flag=True, help="Omit the WorldCover built-up term")
def main(skip_builtup: bool) -> None:
    if not BOUNDARY.exists():
        raise SystemExit(f"missing {BOUNDARY} — run 14_sar_flood.py once to build it")
    country = shape(json.loads(BOUNDARY.read_text())["geometry"])

    dem_path = fetch("dem", HYDROSHEDS["dem"])
    acc_path = fetch("acc", HYDROSHEDS["acc"])

    dem, dem_valid, profile = clip(dem_path, country)
    acc, acc_valid, _ = clip(acc_path, country)
    valid = dem_valid & acc_valid
    click.echo(
        f"[clip] {profile['width']}x{profile['height']} cells @ 15 arc-sec — "
        f"{valid.sum():,} valid land cells ({valid.mean() * 100:.1f}% of the box)"
    )
    dem_f = np.where(valid, dem, 0).astype("float32")

    # Cell size in metres at the AOI's mid-latitude (15 arc-sec ≈ 460 m).
    t = profile["transform"]
    lat_mid = t.f + (profile["height"] / 2) * t.e
    dy_m = abs(t.e) * 111_320.0
    dx_m = abs(t.a) * 111_320.0 * math.cos(math.radians(lat_mid))
    cell_area = dx_m * dy_m
    click.echo(f"[grid] cell ≈ {dx_m:.0f} x {dy_m:.0f} m at lat {lat_mid:.1f}")

    bounds = rasterio.transform.array_bounds(
        profile["height"], profile["width"], profile["transform"]
    )
    cop_paths = fetch_cop_dem((bounds[0], bounds[1], bounds[2], bounds[3]))
    if cop_paths:
        slope = slope_from_cop_dem(cop_paths, profile)
        slope_src = "Copernicus DEM 90 m, Horn slope aggregated to 450 m"
    else:  # pragma: no cover — only if AWS is unreachable
        slope = horn_slope_deg(dem_f, dx_m, dy_m)
        slope_src = "HydroSHEDS 15 arc-sec (fallback — flattens relief)"
    click.echo(
        f"[slope] {slope_src}; p50/p90/p98 = "
        f"{np.percentile(slope[valid], [50, 90, 98]).round(2)}"
    )

    # TWI = ln( upslope area per contour length / tan(slope) )
    acc_cells = np.where(valid & (acc > 0), acc, 0).astype("float32")
    upslope_area = (acc_cells + 1.0) * cell_area / dx_m
    tan_beta = np.maximum(np.tan(np.radians(slope)), 0.001)
    twi = np.log(upslope_area / tan_beta)

    # Distance to the nearest channel, in metres.
    stream_cells = max(1.0, STREAM_DRAINAGE_KM2 * 1e6 / cell_area)
    stream = acc_cells >= stream_cells
    click.echo(
        f"[stream] acc >= {stream_cells:.0f} cells ({STREAM_DRAINAGE_KM2} km²) → "
        f"{stream[valid].mean() * 100:.1f}% of land cells are channels"
    )
    if stream.any():
        dist_cells = ndimage.distance_transform_edt(~stream, sampling=(dy_m, dx_m))
    else:  # pragma: no cover — Thailand always has channels
        dist_cells = np.full(dem_f.shape, NORM["dist"][1], dtype="float32")

    hazard = (
        norm(twi, "twi") * WEIGHTS["twi"]
        + norm(slope, "slope") * WEIGHTS["slope"]
        + norm(dist_cells, "dist") * WEIGHTS["dist"]
        + norm(dem_f, "dem") * WEIGHTS["dem"]
    )
    weight_sum = WEIGHTS["twi"] + WEIGHTS["slope"] + WEIGHTS["dist"] + WEIGHTS["dem"]
    built_used = False
    if not skip_builtup:
        click.echo("[builtup] skipped — WorldCover aggregation not wired yet")
    # Renormalise so the published values still span 0-1 with whatever
    # terms actually contributed.
    hazard = hazard / weight_sum
    hazard = np.where(valid, hazard, np.nan).astype("float32")

    OUT_TIF.parent.mkdir(parents=True, exist_ok=True)
    profile.update(
        driver="GTiff",
        dtype="float32",
        count=1,
        nodata=float("nan"),
        compress="lzw",
        tiled=True,
        blockxsize=512,
        blockysize=512,
        BIGTIFF="IF_SAFER",
    )
    with rasterio.open(OUT_TIF, "w", **profile) as dst:
        dst.write(hazard, 1)
        dst.set_band_description(1, "SUSCEPTIBILITY")

    v = hazard[np.isfinite(hazard)]
    pct = np.percentile(v, [2, 25, 50, 75, 98])
    OUT_META.write_text(
        json.dumps(
            {
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "sources": {
                    "elevation_flow": "HydroSHEDS v1 15 arc-sec (hyd_as_dem_15s, hyd_as_acc_15s)",
                    "slope": slope_src,
                    "built_up": "not included" if not built_used else "ESA WorldCover 2021 v200",
                },
                "weights": {k: v for k, v in WEIGHTS.items() if k != "built" or built_used},
                "dropped_terms": {
                    "evi": "MODIS MOD13Q1 needs Earthdata credentials",
                    "burned_area": "MODIS MCD64A1 needs Earthdata credentials",
                    "built_up": None if built_used else "not wired yet",
                },
                "stream_threshold_km2": STREAM_DRAINAGE_KM2,
                "cell_size_m": [round(dx_m), round(dy_m)],
                "percentiles": {
                    "p2": float(pct[0]),
                    "p25": float(pct[1]),
                    "p50": float(pct[2]),
                    "p75": float(pct[3]),
                    "p98": float(pct[4]),
                },
            },
            indent=2,
            ensure_ascii=False,
        )
    )
    size_mb = OUT_TIF.stat().st_size / 1e6
    click.echo(f"[write] {OUT_TIF.name}  {profile['width']}x{profile['height']}  {size_mb:.1f} MB")
    click.echo(f"[stats] p2/p50/p98 = {pct[0]:.3f} / {pct[2]:.3f} / {pct[4]:.3f}")


if __name__ == "__main__":
    main()
