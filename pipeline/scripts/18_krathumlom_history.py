"""Krathum Lom municipality — 11 years of Sentinel-1 flood history.

The nationwide app works on ~36 km² hexes; the whole municipality is
13 km², one hex. Municipal staff need to know *which streets* flood, so
this rebuilds flood history at the satellite's own ~20 m resolution for
that one area, from every Copernicus GFM scene since 2015.

What the radar can and cannot see matters more here than anywhere else:
GFM excludes dense built-up land (radar echoes off walls, not water), and
over Krathum Lom that is about half the tambon. Those pixels are carried
as "not observable", never as "never flooded".

Per ~20 m pixel:
  observed   — scenes that actually imaged it and did not exclude it
  flooded    — of those, scenes that saw floodwater (GFM ensemble)
  years      — calendar years with at least one flooded scene
  excluded   — share of scenes that masked it out (urban / no sensitivity)

Outputs (public/data/krathumlom/):
  meta.json               — grid, scene counts, yearly timeline, class totals, hotspots
  flood_years.png         — overlay: colour = years flooded, stripes = not observable
  boundary.geojson        — GADM tambon outline (stand-in until the municipality's own)
  buildings_flooded.geojson — footprints inside the tambon where flooding was seen

Scene reads are cached (data/krathumlom/scenes/) so a rerun only fetches
new scenes.

Run:
  uv run python scripts/18_krathumlom_history.py
  uv run python scripts/18_krathumlom_history.py --since 2024-01-01   # smoke test
"""

from __future__ import annotations

import csv
import gzip
import io
import json
import os
import ssl
import urllib.request
import zipfile
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

import click
import numpy as np
import rasterio
import requests
from PIL import Image
from rasterio.enums import Resampling
from rasterio.features import rasterize
from rasterio.transform import from_bounds
from rasterio.vrt import WarpedVRT
from scipy import ndimage
from shapely import wkt
from shapely.geometry import box, mapping, shape
from shapely.prepared import prep

REPO_ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = REPO_ROOT.parent / "public" / "data" / "krathumlom"
CACHE_DIR = REPO_ROOT / "data" / "krathumlom" / "scenes"
BUILD_DIR = REPO_ROOT / "data" / "buildings"
GADM_ZIP = REPO_ROOT / "data" / "aoi" / "gadm41_THA_3.json.zip"

STAC_SEARCH = "https://stac.eodc.eu/api/v1/search"
THRESHOLDS_URL = "https://storage.googleapis.com/open-buildings-data/v3/score_thresholds_s2_level_4.csv"
POLYGONS_URL_TPL = "https://storage.googleapis.com/open-buildings-data/v3/polygons_s2_level_4_gzip/{token}_buildings.csv.gz"
UA = "flashflood-risk-intelligence (github.com/SitthisakMoukomla)"

# GADM identifies the tambon; the municipality's own boundary replaces it
# once they send one.
TAMBON = {"NAME_1": "NakhonPathom", "NAME_2": "SamPhran", "NAME_3": "KrathumLom"}
CONTEXT_DEG = 0.01  # ~1.1 km of surroundings around the tambon
RES_DEG = 0.0002  # ~22 m — GFM is 20 m
MIN_OBSERVED = 20  # below this a pixel's history is too thin to report
CONF_THRESHOLD = 0.7

try:
    import certifi

    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except Exception:  # pragma: no cover
    SSL_CTX = ssl.create_default_context()

os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tif")
os.environ.setdefault("GDAL_HTTP_MAX_RETRY", "3")
os.environ.setdefault("GDAL_HTTP_RETRY_DELAY", "2")


def load_tambon():
    with zipfile.ZipFile(GADM_ZIP) as z:
        fc = json.loads(z.read(z.namelist()[0]))
    for f in fc["features"]:
        p = f["properties"]
        if all(p.get(k) == v for k, v in TAMBON.items()):
            return shape(f["geometry"]), p
    raise SystemExit(f"tambon {TAMBON} not found in {GADM_ZIP.name}")


def stac_items(bbox: list[float], since: str) -> list[dict]:
    end = datetime.now(timezone.utc)
    body = {
        "collections": ["GFM"],
        "bbox": bbox,
        "datetime": f"{since}T00:00:00Z/{end:%Y-%m-%dT%H:%M:%SZ}",
        "limit": 200,
    }
    items: dict[str, dict] = {}
    while True:
        req = urllib.request.Request(
            STAC_SEARCH,
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json", "User-Agent": UA},
        )
        with urllib.request.urlopen(req, context=SSL_CTX, timeout=180) as r:
            page = json.load(r)
        fresh = [f for f in page.get("features", []) if f["id"] not in items]
        for f in fresh:
            items[f["id"]] = f
        nxt = next(
            (l for l in page.get("links", []) if l.get("rel") == "next" and l.get("method") == "POST"),
            None,
        )
        if not nxt or not fresh:
            break
        body = {**body, **(nxt.get("body") or {})}
    return sorted(items.values(), key=lambda f: f["properties"]["datetime"])


def read_on_grid(href: str, transform, width: int, height: int) -> np.ndarray:
    with rasterio.open(href) as src, WarpedVRT(
        src, crs="EPSG:4326", transform=transform, width=width, height=height, resampling=Resampling.nearest
    ) as vrt:
        return vrt.read(1)


def scene(item: dict, transform, width: int, height: int) -> tuple[str, np.ndarray | None]:
    """Cached per-scene read → uint8 codes: 0 no data, 1 excluded, 2 dry, 3 flooded."""
    path = CACHE_DIR / f"{item['id']}.npy"
    if path.exists():
        a = np.load(path)
        return item["id"], (a if a.size else None)
    flood = read_on_grid(item["assets"]["ensemble_flood_extent"]["href"], transform, width, height)
    if not (flood != 255).any():
        np.save(path, np.zeros(0, np.uint8))  # remember "does not cover the area"
        return item["id"], None
    code = np.zeros(flood.shape, np.uint8)
    code[flood == 0] = 2
    code[flood == 1] = 3
    excl_asset = item["assets"].get("exclusion_mask")
    if excl_asset:
        excl = read_on_grid(excl_asset["href"], transform, width, height)
        code[(excl == 1) & (code != 3)] = 1
    np.save(path, code)
    return item["id"], code


def find_building_tokens(aoi) -> list[str]:
    r = requests.get(THRESHOLDS_URL, timeout=60)
    r.raise_for_status()
    return [row["s2_token"] for row in csv.DictReader(io.StringIO(r.text)) if wkt.loads(row["geometry"]).intersects(aoi)]


def load_buildings(tambon) -> list[dict]:
    """Footprints inside the tambon, streamed from the Open Buildings cell(s)."""
    tokens = find_building_tokens(tambon)
    ptambon = prep(tambon)
    minx, miny, maxx, maxy = tambon.bounds
    out = []
    for token in tokens:
        path = BUILD_DIR / f"{token}_buildings.csv.gz"
        if not path.exists():
            click.echo(f"[bldg] downloading cell {token}")
            with requests.get(POLYGONS_URL_TPL.format(token=token), stream=True, timeout=600) as r:
                r.raise_for_status()
                path.parent.mkdir(parents=True, exist_ok=True)
                with open(path, "wb") as f:
                    for chunk in r.iter_content(1 << 20):
                        f.write(chunk)
        with gzip.open(path, "rt", encoding="utf-8", newline="") as f:
            reader = csv.reader(f)
            h = next(reader)
            i_lat, i_lon, i_conf, i_area, i_geom = (h.index(k) for k in ("latitude", "longitude", "confidence", "area_in_meters", "geometry"))
            for row in reader:
                lat, lon = float(row[i_lat]), float(row[i_lon])
                if not (miny <= lat <= maxy and minx <= lon <= maxx):
                    continue
                if float(row[i_conf]) < CONF_THRESHOLD:
                    continue
                g = wkt.loads(row[i_geom])
                if not ptambon.contains(g.centroid):
                    continue
                out.append({"geom": g, "lat": lat, "lon": lon, "area": float(row[i_area])})
        click.echo(f"[bldg] cell {token}: {len(out):,} buildings inside the tambon so far")
    return out


def years_of(bits: int) -> list[int]:
    return [2015 + b for b in range(32) if bits >> b & 1]


def reverse_name(lat: float, lon: float) -> str | None:
    try:
        r = requests.get(
            "https://nominatim.openstreetmap.org/reverse",
            params={"lat": f"{lat:.5f}", "lon": f"{lon:.5f}", "format": "jsonv2", "zoom": 17, "accept-language": "th"},
            headers={"User-Agent": UA},
            timeout=20,
        )
        j = r.json()
        a = j.get("address", {})
        # Street-level names only. Suburb/county names come from OSM's own
        # boundaries, which disagree with GADM here and would label a spot
        # inside Krathum Lom with a neighbouring tambon's name.
        for k in ("road", "residential", "village", "hamlet", "neighbourhood"):
            if a.get(k):
                return a[k]
        return None
    except Exception:
        return None


@click.command()
@click.option("--since", default="2015-01-01", show_default=True, help="First scene date (YYYY-MM-DD)")
@click.option("--workers", default=12, show_default=True)
def main(since: str, workers: int) -> None:
    tambon, props = load_tambon()
    tminx, tminy, tmaxx, tmaxy = tambon.bounds
    bounds = (tminx - CONTEXT_DEG, tminy - CONTEXT_DEG, tmaxx + CONTEXT_DEG, tmaxy + CONTEXT_DEG)
    width = int(round((bounds[2] - bounds[0]) / RES_DEG))
    height = int(round((bounds[3] - bounds[1]) / RES_DEG))
    transform = from_bounds(*bounds, width, height)
    inside = rasterize([(mapping(tambon), 1)], out_shape=(height, width), transform=transform, dtype="uint8").astype(bool)
    click.echo(f"[aoi] {props['NAME_3']} {tambon.area * 111.32**2 * np.cos(np.radians(tminy)):.1f} km² · grid {width}x{height} @ {RES_DEG}°")

    items = stac_items(list(bounds), since)
    click.echo(f"[stac] {len(items)} GFM item(s) since {since}")
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    codes: dict[str, np.ndarray] = {}
    done = 0
    with ThreadPoolExecutor(workers) as ex:
        futs = {ex.submit(scene, it, transform, width, height): it for it in items}
        for fut in as_completed(futs):
            done += 1
            try:
                iid, code = fut.result()
                if code is not None:
                    codes[iid] = code
            except Exception as e:  # a flaky read skips one scene, not the run
                click.echo(f"[warn] {futs[fut]['id']}: {e}", err=True)
            if done % 200 == 0:
                click.echo(f"[scenes] {done}/{len(items)} read · {len(codes)} cover the area")
    click.echo(f"[scenes] {len(codes)} of {len(items)} scenes image Krathum Lom")

    # One Sentinel-1 pass arrives as several items (swath slices); merge
    # them so a pass counts once per pixel.
    by_pass: dict[str, list[np.ndarray]] = defaultdict(list)
    date_of = {it["id"]: it["properties"]["datetime"] for it in items}
    for iid, code in codes.items():
        by_pass[date_of[iid][:13]].append(code)  # same pass = same hour

    observed = np.zeros((height, width), np.uint16)
    flooded = np.zeros((height, width), np.uint16)
    excluded = np.zeros((height, width), np.uint16)
    imaged = np.zeros((height, width), np.uint16)
    years_mask = np.zeros((height, width), np.uint32)  # bit per year since 2015
    timeline = []
    px_area_rai = (RES_DEG * 111320) * (RES_DEG * 111320 * np.cos(np.radians((tminy + tmaxy) / 2))) / 1600
    for key in sorted(by_pass):
        stack = np.stack(by_pass[key])
        code = stack.max(axis=0)  # flooded > dry > excluded > none
        year = int(key[:4])
        obs = code >= 2
        fl = code == 3
        imaged += code >= 1
        excluded += code == 1
        observed += obs
        flooded += fl
        years_mask[fl] |= np.uint32(1 << (year - 2015))
        timeline.append(
            {
                "t": key + ":00Z",
                "observed_rai": round(float((obs & inside).sum() * px_area_rai)),
                "flooded_rai": round(float((fl & inside).sum() * px_area_rai)),
            }
        )
    years = np.zeros((height, width), np.uint8)
    for b in range(32):
        years += ((years_mask >> b) & 1).astype(np.uint8)
    n_years = datetime.now(timezone.utc).year - 2015 + 1

    # Pixels the radar mostly cannot see (built-up) — never report them as dry.
    blind = (imaged > 0) & (excluded >= 0.5 * imaged)
    thin = observed < MIN_OBSERVED
    reportable = ~blind & ~thin

    # ── Overlay PNG: colour by years flooded, stripes where not observable
    classes = [(1, (254, 224, 139, 150)), (2, (253, 174, 97, 185)), (4, (244, 109, 67, 210)), (7, (165, 0, 38, 230))]
    rgba = np.zeros((height, width, 4), np.uint8)
    for min_years, colour in classes:
        rgba[reportable & (years >= min_years)] = colour
    yy, xx = np.mgrid[0:height, 0:width]
    stripes = ((xx + yy) % 6) < 2
    # Light enough that at phone zoom (where stripes blur) the basemap still reads.
    rgba[blind & stripes] = (170, 180, 190, 75)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba, "RGBA").save(OUT_DIR / "flood_years.png", optimize=True)

    # ── Buildings × history
    bldgs = load_buildings(tambon)
    feats = []
    this_year = datetime.now(timezone.utc).year
    recent_from = this_year - 2  # the last three calendar years, this one included
    recent_bits = sum(1 << (y - 2015) for y in range(recent_from, this_year + 1))
    counts = {"total": len(bldgs), "not_observable": 0, "thin": 0, "never": 0, "y1": 0, "y2_3": 0, "y4_6": 0, "y7plus": 0, "recent": 0}
    for b in bldgs:
        col = int((b["lon"] - bounds[0]) / RES_DEG)
        row = int((bounds[3] - b["lat"]) / RES_DEG)
        # Worst pixel under the footprint's 3x3 neighbourhood — a house is
        # wider than one pixel and floodwater stops at its walls.
        r0, r1, c0, c1 = max(0, row - 1), min(height, row + 2), max(0, col - 1), min(width, col + 2)
        if blind[row, col]:
            counts["not_observable"] += 1
            continue
        if thin[row, col]:
            counts["thin"] += 1
            continue
        bits = int(np.bitwise_or.reduce(years_mask[r0:r1, c0:c1], axis=None))
        ys = years_of(bits)
        y = len(ys)
        key = "never" if y == 0 else "y1" if y == 1 else "y2_3" if y <= 3 else "y4_6" if y <= 6 else "y7plus"
        counts[key] += 1
        if bits & recent_bits:
            counts["recent"] += 1
        if y >= 1:
            feats.append(
                {
                    "type": "Feature",
                    "properties": {"y": y, "ys": ys, "last": ys[-1]},
                    "geometry": mapping(b["geom"].simplify(0.000005)),
                }
            )
    (OUT_DIR / "buildings_flooded.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":")))

    # ── Hotspots: connected flooded-≥2-years areas inside the tambon
    mask = reportable & inside & (years >= 2)
    labels, n = ndimage.label(mask, structure=np.ones((3, 3)))
    spots = []
    for i in range(1, n + 1):
        region = labels == i
        px = int(region.sum())
        if px < 10:  # ~0.3 rai — speckle
            continue
        rr, cc = np.nonzero(region)
        lat = bounds[3] - (rr.mean() + 0.5) * RES_DEG
        lon = bounds[0] + (cc.mean() + 0.5) * RES_DEG
        nb = sum(
            1
            for b in bldgs
            if 0 <= int((bounds[3] - b["lat"]) / RES_DEG) < height
            and 0 <= int((b["lon"] - bounds[0]) / RES_DEG) < width
            and region[int((bounds[3] - b["lat"]) / RES_DEG), int((b["lon"] - bounds[0]) / RES_DEG)]
        )
        ys = years_of(int(np.bitwise_or.reduce(years_mask[region])))
        spots.append(
            {
                "lat": round(lat, 5),
                "lon": round(lon, 5),
                "rai": round(px * px_area_rai, 1),
                "max_years": int(years[region].max()),
                "years": ys,
                "buildings": nb,
            }
        )
    spots.sort(key=lambda s: (-s["buildings"], -s["rai"]))
    spots = spots[:12]
    for s in spots:
        s["name"] = reverse_name(s["lat"], s["lon"])

    per_year = defaultdict(lambda: {"passes": 0, "max_flooded_rai": 0})
    for t in timeline:
        y = per_year[t["t"][:4]]
        y["passes"] += 1
        y["max_flooded_rai"] = max(y["max_flooded_rai"], t["flooded_rai"])

    inside_px = int(inside.sum())
    meta = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "Copernicus EMS Global Flood Monitoring (Sentinel-1), ensemble flood extent + exclusion mask",
        "area_name": "เทศบาลเมืองกระทุ่มล้ม",
        "boundary_source": "GADM 4.1 ตำบลกระทุ่มล้ม — ใช้แทนจนกว่าจะได้ขอบเขตจริงจากเทศบาล",
        "bounds": [round(v, 6) for v in bounds],
        "res_deg": RES_DEG,
        "first_pass": timeline[0]["t"] if timeline else None,
        "last_pass": timeline[-1]["t"] if timeline else None,
        "passes": len(timeline),
        "years_span": n_years,
        "tambon_area_rai": round(inside_px * px_area_rai),
        "not_observable_share": round(float((blind & inside).sum()) / inside_px, 3),
        "flooded_ever_rai": round(float((reportable & inside & (years >= 1)).sum() * px_area_rai)),
        "flooded_2plus_years_rai": round(float((reportable & inside & (years >= 2)).sum() * px_area_rai)),
        "buildings": counts,
        "recent_from": recent_from,
        "classes": [{"min_years": m, "rgba": list(c)} for m, c in classes],
        "per_year": dict(sorted(per_year.items())),
        "timeline": timeline,
        "hotspots": spots,
    }
    (OUT_DIR / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1))
    (OUT_DIR / "boundary.geojson").write_text(
        json.dumps({"type": "Feature", "properties": {"name": "ตำบลกระทุ่มล้ม (GADM)"}, "geometry": mapping(tambon.simplify(0.00005))})
    )
    click.echo(
        f"[out] {len(timeline)} passes {meta['first_pass']} → {meta['last_pass']} · "
        f"not observable {meta['not_observable_share']:.0%} · flooded ever {meta['flooded_ever_rai']:,} rai · "
        f"buildings {counts}"
    )
    for s in spots[:6]:
        click.echo(f"  hotspot {s['name']}: {s['rai']} rai, {s['buildings']} bldg, up to {s['max_years']} yrs")


if __name__ == "__main__":
    main()
