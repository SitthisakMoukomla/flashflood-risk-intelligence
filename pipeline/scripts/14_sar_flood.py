"""Phase T.2 — Observed flood extent from Sentinel-1 (Copernicus GFM).

Copernicus Emergency Management Service runs the Sentinel-1 change-detection
flood mapping operationally for the whole planet and publishes the result
through EODC's STAC API — open, no account, no key. This script queries the
tiles intersecting Thailand for the last N hours, keeps only the ones that
actually contain flood pixels, and writes a small GeoJSON the webapp can
overlay as its own layer:

  public/data/sar_flood.png           — flood mask as an RGBA overlay
  public/data/sar_flood.geojson       — same extent as polygons (analysis)
  public/data/sar_flood_meta.json     — coverage summary for the UI

The webapp draws the PNG, not the polygons: vectorising 20 m pixels and
simplifying them to keep the payload sane left visibly faceted edges, and
the raster has none while being an order of magnitude smaller.

The GFM ensemble raster is uint8 in an Equi7Grid projection:
  0   = not flooded (observed)
  1   = flooded
  255 = no observation / outside the swath

A single Sentinel-1 pass only covers a strip, so a short window leaves most
of the country unobserved. The default window is therefore a week: every
pass in the last 7 days is composited, and where the same ground is seen
more than once only the most recent observation is kept (so a receding
flood is not double-drawn against its own earlier extent).

Run:
  uv run python scripts/14_sar_flood.py                  # last 7 days
  uv run python scripts/14_sar_flood.py --hours 48 --max-tiles 60
"""

from __future__ import annotations

import json
import math
import ssl
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import click
import numpy as np
import rasterio
from rasterio.features import shapes as rio_shapes
from rasterio.warp import transform_geom
from shapely.geometry import mapping, shape
from shapely.prepared import prep
from shapely.strtree import STRtree

REPO_ROOT = Path(__file__).resolve().parents[1]
PUBLIC_DATA = REPO_ROOT.parent / "public" / "data"

STAC_SEARCH = "https://stac.eodc.eu/api/v1/search"
# Thailand bbox (west, south, east, north) with a small margin.
THAILAND_BBOX = [97.2, 5.5, 105.8, 20.6]
FLOOD_ASSET = "ensemble_flood_extent"
# GFM tiles straddle the borders — everything is clipped to Thailand so the
# reported area is Thailand's, not the region's.
BOUNDARY_PATH = REPO_ROOT / "data" / "aoi" / "thailand_boundary.geojson"
GADM_ZIP = REPO_ROOT / "data" / "aoi" / "gadm41_THA_3.json.zip"

# JRC Global Surface Water (v1.4, 2021) seasonality: months per year a
# pixel holds water, 0-12. Open data, no account.
JRC_BASE = "https://storage.googleapis.com/global-surface-water/downloads2021/seasonality"
JRC_CACHE = REPO_ROOT / "data" / "jrc" / "seasonality_thailand.tif"
# GFM removes permanent water using its own monthly reference mask, but
# river bends, reservoir margins and other ground that holds water most of
# the year still come through, and drawing those as "flood" is misleading.
# JRC seasonality counts months per year a pixel holds water; anything at
# or above this is treated as water, not flooding, and is erased from the
# flood mask *before* vectorising — masking whole polygons instead would
# leave the river inside a large polygon untouched.
WATER_MONTHS = 6
# Overlay grid. 0.002° ≈ 220 m: coarse enough that the whole country is a
# 32 MP mask the browser can decode without strain, fine enough that the
# 2 ha floor above still occupies a pixel.
RASTER_RES_DEG = 0.002
# Cyan, matching the layer's colour in the UI.
RASTER_RGB = (34, 211, 238)
RASTER_ALPHA = 165
JRC_RES_DEG = 0.001  # ~110 m — fine enough to cut a river out of a 20 m mask
UA = "flashflood-risk-intelligence (github.com/SitthisakMoukomla)"

try:  # certifi is present via rasterio's deps; fall back to system store.
    import certifi

    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except Exception:  # pragma: no cover
    SSL_CTX = ssl.create_default_context()


def stac_search(hours: int, page_limit: int = 100) -> list[dict]:
    """All GFM items intersecting Thailand within the last `hours`."""
    end = datetime.now(timezone.utc)
    start = end - timedelta(hours=hours)
    body = {
        "collections": ["GFM"],
        "bbox": THAILAND_BBOX,
        "datetime": f"{start:%Y-%m-%dT%H:%M:%SZ}/{end:%Y-%m-%dT%H:%M:%SZ}",
        "limit": page_limit,
    }
    items: list[dict] = []
    seen: set[str] = set()
    while True:
        req = urllib.request.Request(
            STAC_SEARCH,
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json", "User-Agent": UA},
        )
        with urllib.request.urlopen(req, context=SSL_CTX, timeout=120) as r:
            page = json.load(r)
        feats = page.get("features", [])
        fresh = [f for f in feats if f["id"] not in seen]
        for f in fresh:
            seen.add(f["id"])
        items.extend(fresh)
        # STAC paging: follow the POST "next" link's body token when present.
        nxt = next(
            (l for l in page.get("links", []) if l.get("rel") == "next" and l.get("method") == "POST"),
            None,
        )
        if not nxt or not fresh:
            break
        body = {**body, **(nxt.get("body") or {})}
    return items


def build_boundary() -> None:
    """Dissolve GADM level-3 tambon into one country outline (cached on disk)."""
    import zipfile

    from shapely.ops import unary_union

    if not GADM_ZIP.exists():
        raise SystemExit(f"missing {GADM_ZIP} — cannot build the Thailand outline")
    with zipfile.ZipFile(GADM_ZIP) as z:
        fc = json.loads(z.read(z.namelist()[0]))
    country = unary_union([shape(f["geometry"]).buffer(0) for f in fc["features"]])
    # 0.005° ≈ 550 m: enough to thin the tambon staircase without moving the
    # Mekong border, where a lot of the observed flooding actually sits.
    simple = country.simplify(0.005, preserve_topology=True)
    BOUNDARY_PATH.write_text(
        json.dumps(
            {
                "type": "Feature",
                "properties": {"name": "Thailand", "source": "GADM 4.1 level-3 dissolved"},
                "geometry": mapping(simple),
            }
        )
    )
    click.echo(f"[boundary] built {BOUNDARY_PATH.name} from {len(fc['features'])} tambon")


def build_water_reference(bounds: tuple[float, float, float, float]) -> None:
    """Mosaic the JRC seasonality tiles covering Thailand into one cached
    raster, decimated to ~200 m — enough to tell a river bend from a
    flooded field, small enough to hold in memory."""
    from rasterio.merge import merge as rio_merge

    w, s_, e, n = bounds
    parts = []
    for lon in range(int(math.floor(w / 10) * 10), int(math.ceil(e / 10) * 10), 10):
        for lat in range(int(math.ceil(s_ / 10) * 10), int(math.ceil(n / 10) * 10) + 10, 10):
            name = f"seasonality_{abs(lon)}{'E' if lon >= 0 else 'W'}_{abs(lat)}{'N' if lat >= 0 else 'S'}v1_4_2021.tif"
            url = f"/vsicurl/{JRC_BASE}/{name}"
            try:
                ds = rasterio.open(url)
            except Exception:
                continue
            parts.append(ds)
    if not parts:
        raise SystemExit("could not open any JRC seasonality tile")
    click.echo(f"[water] mosaicking {len(parts)} JRC tile(s) at ~{JRC_RES_DEG * 111000:.0f} m")
    mosaic, transform = rio_merge(parts, bounds=(w, s_, e, n), res=JRC_RES_DEG)
    for ds in parts:
        ds.close()
    JRC_CACHE.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(
        JRC_CACHE,
        "w",
        driver="GTiff",
        height=mosaic.shape[1],
        width=mosaic.shape[2],
        count=1,
        dtype=mosaic.dtype,
        crs="EPSG:4326",
        transform=transform,
        compress="lzw",
        tiled=True,
    ) as dst:
        dst.write(mosaic[0], 1)
    click.echo(f"[water] cached {JRC_CACHE.name} {mosaic.shape[2]}x{mosaic.shape[1]}")


def load_water_reference(bounds: tuple[float, float, float, float]):
    if not JRC_CACHE.exists():
        build_water_reference(bounds)
    ds = rasterio.open(JRC_CACHE)
    return ds.read(1), ds.transform, ds


def load_thailand() -> object:
    if not BOUNDARY_PATH.exists():
        build_boundary()
    geom = shape(json.loads(BOUNDARY_PATH.read_text())["geometry"])
    return prep(geom)


def accumulate_mask(
    flooded: np.ndarray, ds, acc: np.ndarray, acc_transform
) -> None:
    """Burn one tile's flood mask into the nationwide overlay grid."""
    from rasterio.warp import Resampling, reproject

    patch = np.zeros(acc.shape, dtype="uint8")
    reproject(
        source=flooded.astype("uint8"),
        destination=patch,
        src_transform=ds.transform,
        src_crs=ds.crs,
        dst_transform=acc_transform,
        dst_crs="EPSG:4326",
        resampling=Resampling.max,  # keep a flooded pixel visible when downsampling
        src_nodata=0,
        dst_nodata=0,
    )
    np.maximum(acc, patch, out=acc)


def erase_water(flooded: np.ndarray, ds, water_ds) -> tuple[np.ndarray, int]:
    """Remove pixels that normally hold water from a tile's flood mask."""
    from rasterio.warp import Resampling, reproject

    water_on_tile = np.zeros(flooded.shape, dtype="uint8")
    reproject(
        source=rasterio.band(water_ds, 1),
        destination=water_on_tile,
        src_transform=water_ds.transform,
        src_crs=water_ds.crs,
        dst_transform=ds.transform,
        dst_crs=ds.crs,
        resampling=Resampling.max,  # keep water if any sub-pixel is water
        src_nodata=255,
        dst_nodata=0,
    )
    is_water = (water_on_tile >= WATER_MONTHS) & (water_on_tile <= 12)
    removed = int((flooded & is_water).sum())
    return flooded & ~is_water, removed


def tile_flood_polygons(
    href: str,
    min_pixels: int,
    min_poly_px: int,
    simplify_m: float,
    thailand,
    water_ds,
    acc: np.ndarray | None = None,
    acc_transform=None,
) -> tuple[list[dict], float, int, int]:
    """Flooded blobs of one GFM tile as WGS84 polygons, clipped to Thailand.

    Speckle control mirrors the UN-SPIDER recipe: drop blobs smaller than
    `min_poly_px` connected pixels, simplify the staircase edges in projected
    metres, then keep only what touches Thailand. Returns the polygons, their
    area in m² (measured in the projected grid, before reprojection), and the
    raw flooded-pixel count of the tile."""
    px_area = 400.0  # 20 m grid
    with rasterio.open(f"/vsicurl/{href}") as ds:
        band = ds.read(1)
        flooded = band == 1
        raw_count = int(flooded.sum())
        if raw_count < min_pixels:
            return [], 0.0, raw_count, 0
        flooded, water_px = erase_water(flooded, ds, water_ds)
        if int(flooded.sum()) < min_pixels:
            return [], 0.0, raw_count, water_px
        if acc is not None:
            accumulate_mask(flooded, ds, acc, acc_transform)
        mask = flooded.astype(np.uint8)
        min_area = min_poly_px * px_area
        geoms: list[dict] = []
        kept_area = 0.0
        for geom, val in rio_shapes(mask, mask=flooded, transform=ds.transform):
            if val != 1:
                continue
            poly = shape(geom)
            area_m2 = poly.area
            if area_m2 < min_area:
                continue
            poly = poly.simplify(simplify_m, preserve_topology=True)
            if poly.is_empty:
                continue
            wgs = transform_geom(ds.crs, "EPSG:4326", mapping(poly), precision=4)
            if not thailand.intersects(shape(wgs)):
                continue
            geoms.append(wgs)
            kept_area += area_m2
    return geoms, kept_area, raw_count, water_px


@click.command()
@click.option("--hours", default=168, type=int, help="Look-back window in hours (default 7 days)")
@click.option(
    "--min-pixels",
    default=25,
    type=int,
    help="Skip tiles with fewer flooded pixels than this (speckle guard)",
)
@click.option("--max-tiles", default=320, type=int, help="Safety cap on tiles downloaded")
@click.option(
    "--min-poly-px",
    default=50,
    type=int,
    help="Drop flood blobs smaller than this many connected 20 m pixels (50 = 2 ha)",
)
@click.option(
    "--simplify-m", default=60.0, type=float, help="Polygon simplify tolerance in metres"
)
def main(hours: int, min_pixels: int, max_tiles: int, min_poly_px: int, simplify_m: float) -> None:
    items = stac_search(hours)
    click.echo(f"[stac] {len(items)} GFM item(s) over Thailand in the last {hours} h")
    if not items:
        click.echo("[stac] nothing to do")
        return

    items.sort(key=lambda f: f["properties"].get("datetime", ""), reverse=True)
    capped = len(items) > max_tiles
    if len(items) > max_tiles:
        click.echo(f"[cap] downloading the {max_tiles} most recent of {len(items)} tiles")
        items = items[:max_tiles]

    thailand = load_thailand()
    country_bounds = shape(json.loads(BOUNDARY_PATH.read_text())["geometry"]).bounds
    _, _, water_ds = load_water_reference(country_bounds)

    from rasterio.transform import from_origin

    rw, rs, re_, rn = country_bounds
    acc_w = int(math.ceil((re_ - rw) / RASTER_RES_DEG))
    acc_h = int(math.ceil((rn - rs) / RASTER_RES_DEG))
    acc = np.zeros((acc_h, acc_w), dtype="uint8")
    acc_transform = from_origin(rw, rn, RASTER_RES_DEG, RASTER_RES_DEG)
    click.echo(f"[raster] overlay grid {acc_w}x{acc_h} @ {RASTER_RES_DEG}°")
    total_water_px = 0
    features: list[dict] = []
    total_area_m2 = 0.0
    tiles_with_flood = 0
    latest_obs: str | None = None
    oldest_obs: str | None = None

    for i, item in enumerate(items, start=1):
        asset = item.get("assets", {}).get(FLOOD_ASSET)
        if not asset or not asset.get("href"):
            continue
        obs = item["properties"].get("datetime")
        try:
            geoms, area_m2, raw_px, water_px = tile_flood_polygons(
                asset["href"], min_pixels, min_poly_px, simplify_m, thailand,
                water_ds, acc, acc_transform,
            )
            total_water_px += water_px
        except Exception as e:  # a single bad tile must not kill the run
            click.echo(f"  [{i}/{len(items)}] {item['id']}: SKIP ({type(e).__name__})")
            continue
        latest_obs = max(latest_obs or obs, obs) if obs else latest_obs
        oldest_obs = min(oldest_obs or obs, obs) if obs else oldest_obs
        if not geoms:
            continue
        tiles_with_flood += 1
        total_area_m2 += area_m2
        # rio_shapes already yields disjoint blobs — no union needed.
        for g in geoms:
            features.append(
                {
                    "type": "Feature",
                    "geometry": g,
                    "properties": {"observed_at": obs, "tile": item["id"]},
                }
            )
        click.echo(
            f"  [{i}/{len(items)}] {item['id']}: {raw_px} px in tile "
            f"(−{water_px} on standing water) → {len(geoms)} polygon(s) in TH "
            f"({area_m2 / 1e6:.1f} km²)"
        )

    # Report the area of the polygons actually published (post-composite),
    # not the raw pixel count of everything downloaded.
    published_m2 = 0.0
    for f in features:
        g = shape(f["geometry"])
        published_m2 += g.area * (111_320.0**2) * math.cos(math.radians(g.centroid.y))
    area_km2 = published_m2 / 1e6
    area_rai = published_m2 / 1600
    click.echo(
        f"[area] downloaded {total_area_m2 / 1e6:.0f} km² of raw flood pixels → "
        f"{area_km2:.0f} km² published after compositing"
    )

    # Composite: newest first, drop a polygon whose ground is already
    # covered by a more recent pass. Same flood seen twice in a week should
    # read as one area at its latest observed extent, not as two.
    if features:
        before = len(features)
        features.sort(key=lambda f: f["properties"]["observed_at"] or "", reverse=True)
        kept: list[dict] = []
        kept_geoms: list[object] = []
        tree: STRtree | None = None
        rebuild_at = 0
        for f in features:
            g = shape(f["geometry"])
            if not g.is_valid:
                g = g.buffer(0)
            if kept_geoms:
                if tree is None or len(kept_geoms) >= rebuild_at:
                    tree = STRtree(kept_geoms)
                    rebuild_at = len(kept_geoms) + 200
                covered = 0.0
                for idx in tree.query(g):
                    inter = g.intersection(kept_geoms[idx])
                    if not inter.is_empty:
                        covered += inter.area
                    if covered >= g.area * 0.6:
                        break
                if g.area > 0 and covered >= g.area * 0.6:
                    continue
            kept.append(f)
            kept_geoms.append(g)
        features = kept
        click.echo(f"[composite] {before} → {len(features)} polygon(s) after de-overlapping passes")

    # A capped run that found nothing is a partial view, not evidence that the
    # flooding is over — never let it wipe a good file.
    if capped and not features and (PUBLIC_DATA / "sar_flood.geojson").exists():
        click.echo("[skip] capped run produced no polygons — keeping the existing file")
        return

    PUBLIC_DATA.mkdir(parents=True, exist_ok=True)
    geo_out = PUBLIC_DATA / "sar_flood.geojson"
    meta_out = PUBLIC_DATA / "sar_flood_meta.json"
    geo_out.write_text(
        json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False)
    )
    meta_out.write_text(
        json.dumps(
            {
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "source": "Copernicus EMS Global Flood Monitoring (Sentinel-1), via EODC STAC",
                "window_hours": hours,
                "composite": "latest observation wins where passes overlap",
                "tiles_seen": len(items),
                "tiles_with_flood": tiles_with_flood,
                "polygons": len(features),
                "clipped_to": "Thailand (GADM 4.1 level-3 dissolved)",
                "water_filter": (
                    f"pixels on JRC GSW seasonality ≥{WATER_MONTHS} months/yr erased "
                    "before vectorising"
                ),
                "water_pixels_erased": total_water_px,
                "flood_area_km2": round(area_km2, 2),
                "flood_area_rai": round(area_rai),
                "latest_observation": latest_obs,
                "oldest_observation": oldest_obs,
                "pixel_size_m": 20,
                "raster": {
                    "file": "sar_flood.png",
                    "bbox": [
                        rw,
                        rn - acc_h * RASTER_RES_DEG,
                        rw + acc_w * RASTER_RES_DEG,
                        rn,
                    ],
                    "width": acc_w,
                    "height": acc_h,
                    "res_deg": RASTER_RES_DEG,
                },
            },
            indent=2,
            ensure_ascii=False,
        )
    )
    # Overlay PNG — what the webapp actually draws.
    png_out = PUBLIC_DATA / "sar_flood.png"
    rgba = np.zeros((acc.shape[0], acc.shape[1], 4), dtype="uint8")
    hit = acc > 0
    rgba[..., 0][hit] = RASTER_RGB[0]
    rgba[..., 1][hit] = RASTER_RGB[1]
    rgba[..., 2][hit] = RASTER_RGB[2]
    rgba[..., 3][hit] = RASTER_ALPHA
    try:
        from PIL import Image

        Image.fromarray(rgba, "RGBA").save(png_out, optimize=True)
        click.echo(
            f"[raster] {png_out.name} {acc.shape[1]}x{acc.shape[0]} "
            f"{png_out.stat().st_size / 1024:.0f} KB, {int(hit.sum()):,} lit pixels"
        )
    except ImportError:
        click.echo("[raster] Pillow missing — PNG not written", err=True)

    size_kb = geo_out.stat().st_size / 1024
    click.echo(
        f"[write] {geo_out.name} {len(features)} polygon(s), {size_kb:.1f} KB — "
        f"{area_km2:.1f} km² ({area_rai:,.0f} ไร่) across {tiles_with_flood} tile(s)"
    )
    click.echo(f"[write] {meta_out.name}  latest observation {latest_obs}")


if __name__ == "__main__":
    main()
