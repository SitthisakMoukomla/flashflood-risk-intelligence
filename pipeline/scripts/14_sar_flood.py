"""Phase T.2 — Observed flood extent from Sentinel-1 (Copernicus GFM).

Copernicus Emergency Management Service runs the Sentinel-1 change-detection
flood mapping operationally for the whole planet and publishes the result
through EODC's STAC API — open, no account, no key. This script queries the
tiles intersecting Thailand for the last N hours, keeps only the ones that
actually contain flood pixels, and writes a small GeoJSON the webapp can
overlay as its own layer:

  public/data/sar_flood.geojson       — flood polygons (WGS84) + per-tile timestamps
  public/data/sar_flood_meta.json     — coverage summary for the UI

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
# GFM already removes permanent water. What it keeps includes ground that
# is under water most years anyway — river bends, reservoir margins, wet
# paddy — and calling that "flood" is misleading. Drop a polygon when most
# of it sits on ground that normally holds water this much of the year.
SEASONAL_MONTHS = 9
SEASONAL_MAX_FRACTION = 0.6
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
    click.echo(f"[water] mosaicking {len(parts)} JRC tile(s) at ~200 m")
    mosaic, transform = rio_merge(parts, bounds=(w, s_, e, n), res=0.002)
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


def tile_flood_polygons(
    href: str, min_pixels: int, min_poly_px: int, simplify_m: float, thailand
) -> tuple[list[dict], float, int]:
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
            return [], 0.0, raw_count
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
    return geoms, kept_area, raw_count


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
            geoms, area_m2, raw_px = tile_flood_polygons(
                asset["href"], min_pixels, min_poly_px, simplify_m, thailand
            )
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
            f"  [{i}/{len(items)}] {item['id']}: {raw_px} px in tile → "
            f"{len(geoms)} polygon(s) in TH ({area_m2 / 1e6:.1f} km²)"
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

    # Drop polygons that sit on ground which normally holds water anyway.
    if features:
        from rasterio.features import geometry_mask
        from rasterio.windows import from_bounds as win_from_bounds

        b = shape(json.loads(BOUNDARY_PATH.read_text())["geometry"]).bounds
        water, water_tr, water_ds = load_water_reference(b)
        before = len(features)
        kept2: list[dict] = []
        dropped_area = 0.0
        for f in features:
            g = shape(f["geometry"])
            try:
                win = win_from_bounds(*g.bounds, transform=water_tr)
                r0, r1 = int(max(0, win.row_off)), int(min(water.shape[0], win.row_off + win.height + 1))
                c0, c1 = int(max(0, win.col_off)), int(min(water.shape[1], win.col_off + win.width + 1))
                sub = water[r0:r1, c0:c1]
                if sub.size == 0:
                    kept2.append(f)
                    continue
                sub_tr = rasterio.windows.transform(
                    rasterio.windows.Window(c0, r0, c1 - c0, r1 - r0), water_tr
                )
                m = geometry_mask([g], out_shape=sub.shape, transform=sub_tr, invert=True)
                vals = sub[m]
                if vals.size == 0:
                    # Polygon smaller than a 200 m cell — judge by its centre.
                    vals = sub[(sub.shape[0] // 2) : (sub.shape[0] // 2) + 1, (sub.shape[1] // 2) : (sub.shape[1] // 2) + 1].ravel()
                if vals.size and (vals >= SEASONAL_MONTHS).mean() >= SEASONAL_MAX_FRACTION:
                    dropped_area += g.area * (111_320.0**2) * math.cos(math.radians(g.centroid.y))
                    continue
            except Exception:
                pass  # a polygon we cannot judge stays in
            kept2.append(f)
        water_ds.close()
        features = kept2
        click.echo(
            f"[water] {before} → {len(features)} polygon(s) after dropping ground that "
            f"normally holds water ≥{SEASONAL_MONTHS} months/yr "
            f"({dropped_area / 1e6:.0f} km² removed)"
        )

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
                    f"dropped polygons ≥{int(SEASONAL_MAX_FRACTION * 100)}% covered by JRC GSW "
                    f"seasonality ≥{SEASONAL_MONTHS} months/yr"
                ),
                "flood_area_km2": round(area_km2, 2),
                "flood_area_rai": round(area_rai),
                "latest_observation": latest_obs,
                "oldest_observation": oldest_obs,
                "pixel_size_m": 20,
            },
            indent=2,
            ensure_ascii=False,
        )
    )
    size_kb = geo_out.stat().st_size / 1024
    click.echo(
        f"[write] {geo_out.name} {len(features)} polygon(s), {size_kb:.1f} KB — "
        f"{area_km2:.1f} km² ({area_rai:,.0f} ไร่) across {tiles_with_flood} tile(s)"
    )
    click.echo(f"[write] {meta_out.name}  latest observation {latest_obs}")


if __name__ == "__main__":
    main()
