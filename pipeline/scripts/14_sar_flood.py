"""Phase T.2 — Observed flood extent from Sentinel-1 (Copernicus GFM).

Copernicus Emergency Management Service runs the Sentinel-1 change-detection
flood mapping operationally for the whole planet and publishes the result
through EODC's STAC API — open, no account, no key. This script queries the
tiles intersecting Thailand for the last N hours, keeps only the ones that
actually contain flood pixels, and writes a small GeoJSON the webapp can
overlay as its own layer:

  public/data/sar_flood.pmtiles       — z6-z12 raster tile pyramid (drawn)
  public/data/sar_flood.geojson       — same extent as polygons (analysis)
  public/data/sar_flood_meta.json     — coverage summary for the UI

The webapp draws the tiles, not the polygons. Vectorising a 20 m mask and
simplifying it enough to ship left visibly faceted outlines; a single
nationwide PNG traded that for 220 m blocks bigger than the floods they
described. A pyramid keeps ~36 m detail where the map is zoomed in while
the client only ever fetches the handful of tiles on screen.

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
# Web Mercator tile pyramid. A single nationwide PNG forces one resolution
# on every zoom: coarse enough to decode (220 m) turned every flood into a
# block far bigger than itself. Tiles let the fine detail exist without the
# client ever holding the whole country in memory.
#   z12 ≈ 36 m/px at Thailand's latitude — close to the 20 m source.
#   z6  ≈ 2.3 km/px — the whole country in a handful of tiles.
TILE_MAX_Z = 12
TILE_MIN_Z = 6
TILE_PX = 256
# Cyan, matching the layer's colour in the UI. Alpha carries how much of
# the cell is actually under water, so sparse flooding reads faint instead
# of pretending to fill the cell.
RASTER_RGB = (34, 211, 238)
TILE_ALPHA_MAX = 210
TILE_ALPHA_MIN = 70  # any flood at all stays visible when zoomed out
WEB_MERCATOR_HALF = 20037508.342789244
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


def zxy_to_tileid(z: int, x: int, y: int) -> int:
    """PMTiles tile id (Hilbert curve order); inverse of tileid_to_zxy."""
    acc = 0
    for tz in range(z):
        acc += (1 << tz) * (1 << tz)
    n = 1 << z
    d = 0
    tx, ty = x, y
    s = n >> 1
    while s > 0:
        rx = 1 if (tx & s) > 0 else 0
        ry = 1 if (ty & s) > 0 else 0
        d += s * s * ((3 * rx) ^ ry)
        if ry == 0:
            if rx == 1:
                tx = s - 1 - tx
                ty = s - 1 - ty
            tx, ty = ty, tx
        s >>= 1
    return acc + d


def lonlat_to_tile(lon: float, lat: float, z: int) -> tuple[int, int]:
    n = 1 << z
    x = int((lon + 180.0) / 360.0 * n)
    lat_r = math.radians(max(-85.05112878, min(85.05112878, lat)))
    y = int((1.0 - math.log(math.tan(lat_r) + 1 / math.cos(lat_r)) / math.pi) / 2.0 * n)
    return max(0, min(n - 1, x)), max(0, min(n - 1, y))


def tile_block_transform(x0: int, y0: int, z: int):
    """Affine transform (EPSG:3857) for a block of tiles starting at x0,y0."""
    from rasterio.transform import from_origin

    span = 2 * WEB_MERCATOR_HALF / (1 << z)
    res = span / TILE_PX
    return from_origin(-WEB_MERCATOR_HALF + x0 * span, WEB_MERCATOR_HALF - y0 * span, res, res)


def accumulate_tiles(flooded: np.ndarray, ds, tiles: dict[tuple[int, int], np.ndarray]) -> None:
    """Reproject one GFM tile's mask into the z12 tiles it covers.

    Coverage, not presence: the mask is scaled to 0-255 and averaged, so a
    cell only half under water ends up half-strength rather than solid."""
    from rasterio.transform import array_bounds
    from rasterio.warp import Resampling, reproject, transform_bounds
    from rasterio.windows import Window
    from rasterio.windows import transform as window_transform

    # Flooding occupies a small part of a 15000x15000 tile. Reprojecting the
    # whole thing cost ~40 s per tile; cropping to the flooded extent first
    # cuts that to a few seconds without changing the result.
    ys, xs = np.nonzero(flooded)
    if ys.size == 0:
        return
    r0, r1 = int(ys.min()), int(ys.max()) + 1
    c0, c1 = int(xs.min()), int(xs.max()) + 1
    sub = flooded[r0:r1, c0:c1]
    sub_tr = window_transform(Window(c0, r0, c1 - c0, r1 - r0), ds.transform)
    sub_bounds = array_bounds(r1 - r0, c1 - c0, sub_tr)

    w, s_, e, n = transform_bounds(ds.crs, "EPSG:4326", *sub_bounds, densify_pts=21)
    x0, y0 = lonlat_to_tile(w, n, TILE_MAX_Z)  # north-west corner
    x1, y1 = lonlat_to_tile(e, s_, TILE_MAX_Z)  # south-east corner
    nx, ny = x1 - x0 + 1, y1 - y0 + 1
    if nx <= 0 or ny <= 0 or nx * ny > 4096:  # sanity guard on absurd extents
        return
    dst = np.zeros((ny * TILE_PX, nx * TILE_PX), dtype="uint8")
    reproject(
        source=(sub.astype("uint8") * 255),
        destination=dst,
        src_transform=sub_tr,
        src_crs=ds.crs,
        dst_transform=tile_block_transform(x0, y0, TILE_MAX_Z),
        dst_crs="EPSG:3857",
        resampling=Resampling.average,
        src_nodata=0,
        dst_nodata=0,
    )
    for ty in range(ny):
        rows = dst[ty * TILE_PX : (ty + 1) * TILE_PX]
        if not rows.any():
            continue
        for tx in range(nx):
            cell = rows[:, tx * TILE_PX : (tx + 1) * TILE_PX]
            if not cell.any():
                continue
            key = (x0 + tx, y0 + ty)
            prev = tiles.get(key)
            tiles[key] = cell.copy() if prev is None else np.maximum(prev, cell)


def build_pyramid(
    finest: dict[tuple[int, int], np.ndarray],
) -> dict[int, dict[tuple[int, int], np.ndarray]]:
    """Fold the finest zoom upwards by 2x2 area averaging."""
    levels: dict[int, dict[tuple[int, int], np.ndarray]] = {TILE_MAX_Z: finest}
    for z in range(TILE_MAX_Z - 1, TILE_MIN_Z - 1, -1):
        child = levels[z + 1]
        parent: dict[tuple[int, int], np.ndarray] = {}
        for (cx, cy), arr in child.items():
            px, py = cx >> 1, cy >> 1
            buf = parent.get((px, py))
            if buf is None:
                buf = np.zeros((TILE_PX, TILE_PX), dtype="uint8")
                parent[(px, py)] = buf
            # Each child occupies one quadrant of the parent, halved in size.
            small = (
                arr.reshape(TILE_PX // 2, 2, TILE_PX // 2, 2).mean(axis=(1, 3))
            ).astype("uint8")
            oy = (cy & 1) * (TILE_PX // 2)
            ox = (cx & 1) * (TILE_PX // 2)
            np.maximum(
                buf[oy : oy + TILE_PX // 2, ox : ox + TILE_PX // 2],
                small,
                out=buf[oy : oy + TILE_PX // 2, ox : ox + TILE_PX // 2],
            )
        levels[z] = parent
    return levels


def encode_tile_png(coverage: np.ndarray) -> bytes:
    """Coverage 0-255 → cyan RGBA PNG bytes."""
    import io

    from PIL import Image

    rgba = np.zeros((TILE_PX, TILE_PX, 4), dtype="uint8")
    hit = coverage > 0
    rgba[..., 0][hit] = RASTER_RGB[0]
    rgba[..., 1][hit] = RASTER_RGB[1]
    rgba[..., 2][hit] = RASTER_RGB[2]
    alpha = np.zeros_like(coverage, dtype="float32")
    alpha[hit] = TILE_ALPHA_MIN + coverage[hit].astype("float32") / 255.0 * (
        TILE_ALPHA_MAX - TILE_ALPHA_MIN
    )
    rgba[..., 3] = np.clip(alpha, 0, 255).astype("uint8")
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def write_pmtiles(
    levels: dict[int, dict[tuple[int, int], np.ndarray]],
    out_path: Path,
    bounds: tuple[float, float, float, float],
) -> tuple[int, int]:
    """Pack the pyramid into one PMTiles archive.

    One file rather than thousands keeps the repo sane across twice-daily
    cron runs, and the client still fetches only the tiles it displays via
    HTTP range requests."""
    from pmtiles.tile import Compression, TileType
    from pmtiles.writer import Writer

    entries: list[tuple[int, bytes]] = []
    for z in sorted(levels):
        for (x, y), cov in levels[z].items():
            entries.append((zxy_to_tileid(z, x, y), encode_tile_png(cov)))
    entries.sort(key=lambda t: t[0])

    out_path.parent.mkdir(parents=True, exist_ok=True)
    w, s_, e, n = bounds
    with open(out_path, "wb") as f:
        writer = Writer(f)
        for tid, data in entries:
            writer.write_tile(tid, data)
        writer.finalize(
            {
                "tile_type": TileType.PNG,
                "tile_compression": Compression.NONE,
                "min_zoom": TILE_MIN_Z,
                "max_zoom": TILE_MAX_Z,
                "min_lon_e7": int(w * 1e7),
                "min_lat_e7": int(s_ * 1e7),
                "max_lon_e7": int(e * 1e7),
                "max_lat_e7": int(n * 1e7),
                "center_zoom": TILE_MIN_Z,
                "center_lon_e7": int((w + e) / 2 * 1e7),
                "center_lat_e7": int((s_ + n) / 2 * 1e7),
            },
            {
                "attribution": "Copernicus EMS Global Flood Monitoring (Sentinel-1)",
                "name": "Observed flood extent",
            },
        )
    return len(entries), out_path.stat().st_size


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
    tiles: dict[tuple[int, int], np.ndarray] | None = None,
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
        if tiles is not None:
            accumulate_tiles(flooded, ds, tiles)
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

    rw, rs, re_, rn = country_bounds
    tiles: dict[tuple[int, int], np.ndarray] = {}
    click.echo(f"[tiles] accumulating z{TILE_MAX_Z} tiles (~36 m/px)")
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
                water_ds, tiles,
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

    # Tile pyramid — what the webapp actually draws.
    pm_out = PUBLIC_DATA / "sar_flood.pmtiles"
    tile_count = 0
    pm_bytes = 0
    if tiles:
        levels = build_pyramid(tiles)
        per_level = ", ".join(f"z{z}:{len(levels[z])}" for z in sorted(levels))
        click.echo(f"[tiles] {per_level}")
        tile_count, pm_bytes = write_pmtiles(levels, pm_out, (rw, rs, re_, rn))
        click.echo(f"[tiles] {pm_out.name} {tile_count:,} tiles, {pm_bytes / 1024:.0f} KB")
    else:
        click.echo("[tiles] no flooded tiles — archive not written")

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
                "tiles": {
                    "file": "sar_flood.pmtiles",
                    "min_zoom": TILE_MIN_Z,
                    "max_zoom": TILE_MAX_Z,
                    "count": tile_count,
                    "bytes": pm_bytes,
                    "bbox": [rw, rs, re_, rn],
                },
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
