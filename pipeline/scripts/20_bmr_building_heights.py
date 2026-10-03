"""Phase B.1 — Estimated low-rise (1–2 storeys) vs 3+ for every building in the Bangkok region.

Open Buildings v3 (what the map already draws) has footprints but no
height. Google's Open Buildings 2.5D Temporal dataset estimates building
height from Sentinel-2 at ~4 m effective resolution (2016–2023, CC-BY 4.0).
This joins the two: each v3 footprint gets the mean estimated height of the
2.5D pixels under it, and a storey class derived from that height.

Everything produced here is an ESTIMATE from satellite imagery, not a
survey. Google publishes no height accuracy figure; `calibrate` measures
the class agreement against OpenStreetMap buildings that carry
`building:levels`, and that agreement is reported with the data.

Steps (run in order; each caches its output under data/heights/):
  extract    6 Open Buildings CSV.gz → BMR rows (conf ≥ 0.7, inside the
             six-province outline)                     → bmr_buildings.csv.gz
  download   2.5D building_height (2023) for the BMR bbox from Earth Engine,
             as 4 m uint8 GeoTIFF tiles in UTM 47N (value = height × 2)
                                                        → tiles/*.tif
  join       mean height per footprint (rasterised ids × bincount)
                                                        → bmr_buildings_h.csv.gz
  calibrate  OSM building:levels vs estimated height → thresholds + agreement
                                                        → calibration.json
  tiles      PMTiles with {s: storey class, h: metres} + summary JSON
                                                        → output/buildings_bmr.pmtiles

Run:
  uv run --with earthengine-api python scripts/20_bmr_building_heights.py download --project ee-pythoncolab-418913
  uv run python scripts/20_bmr_building_heights.py extract
  uv run python scripts/20_bmr_building_heights.py join
"""

from __future__ import annotations

import csv
import gzip
import json
import math
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import click
import numpy as np
import requests  # certifi-backed; python.org builds' urllib has no CA store

REPO_ROOT = Path(__file__).resolve().parents[1]
BUILD_DIR = REPO_ROOT / "data" / "buildings"
HEIGHT_DIR = REPO_ROOT / "data" / "heights"
TILE_DIR = HEIGHT_DIR / "tiles"
PROVINCES = REPO_ROOT.parent / "public" / "data" / "bmr" / "provinces.geojson"

# Bangkok Metropolitan Region (6 provinces) bounding box, from GADM — the
# same box the /bmr page and its APIs use.
BBOX = (99.831, 13.425, 100.964, 14.273)  # w, s, e, n
CONF_THRESHOLD = 0.7  # same cut as the nationwide footprint archive

DATASET = "GOOGLE/Research/open-buildings-temporal/v1"
YEAR = 2023
UTM = "EPSG:32647"
PX = 4.0  # metres — the dataset's effective resolution
TILE_PX = 4800  # 19.2 km tiles — EE counts 2 B/px here, so 4800² ≈ 46 MB < its 48 MB cap


# ─── extract ──────────────────────────────────────────────────────

def _extract_one(path: Path) -> tuple[str, int, int]:
    w, s, e, n = BBOX
    out = HEIGHT_DIR / f"bmr_{path.name}"
    kept = seen = 0
    with gzip.open(path, "rt", newline="") as fin, gzip.open(out, "wt", newline="", compresslevel=3) as fout:
        r = csv.reader(fin)
        wr = csv.writer(fout)
        header = next(r)
        wr.writerow(header)
        for row in r:
            seen += 1
            # Cheap rejects before any float parsing of the geometry.
            lat = float(row[0])
            if lat < s or lat > n:
                continue
            lng = float(row[1])
            if lng < w or lng > e or float(row[3]) < CONF_THRESHOLD:
                continue
            wr.writerow(row)
            kept += 1
    return path.name, seen, kept


@click.group()
def cli() -> None:
    HEIGHT_DIR.mkdir(parents=True, exist_ok=True)
    TILE_DIR.mkdir(parents=True, exist_ok=True)


@cli.command()
def extract() -> None:
    """BMR-bbox rows from every Open Buildings CSV (parallel per file)."""
    files = sorted(BUILD_DIR.glob("*_buildings.csv.gz"))
    if not files:
        sys.exit(f"no Open Buildings CSVs in {BUILD_DIR}")
    with ProcessPoolExecutor(max_workers=len(files)) as ex:
        for name, seen, kept in ex.map(_extract_one, files):
            click.echo(f"{name}: {seen:,} rows → {kept:,} in BMR bbox")


# ─── download ─────────────────────────────────────────────────────

def _utm_bounds() -> tuple[float, float, float, float]:
    from pyproj import Transformer

    t = Transformer.from_crs("EPSG:4326", UTM, always_xy=True)
    w, s, e, n = BBOX
    xs, ys = zip(*(t.transform(x, y) for x in (w, e) for y in (s, n)))
    # Snap outward to the 4 m grid.
    return (math.floor(min(xs) / PX) * PX, math.floor(min(ys) / PX) * PX, math.ceil(max(xs) / PX) * PX, math.ceil(max(ys) / PX) * PX)


@cli.command()
@click.option("--project", required=True, help="Earth Engine cloud project")
@click.option("--only", default=None, help="download a single tile, e.g. 2_1 (smoke test)")
def download(project: str, only: str | None) -> None:
    """2.5D building_height for the BMR bbox as 4 m uint8 tiles (h × 2)."""
    import ee

    ee.Initialize(project=project)
    img = (
        ee.ImageCollection(DATASET)
        .filterDate(f"{YEAR}-01-01", f"{YEAR + 1}-01-01")
        .filterBounds(ee.Geometry.Rectangle(list(BBOX)))
        .mosaic()
        .select("building_height")
        .unmask(0)
        .multiply(2)
        .round()
        .clamp(0, 255)
        .toUint8()
    )
    x0, y0, x1, y1 = _utm_bounds()
    step = TILE_PX * PX
    nx = math.ceil((x1 - x0) / step)
    ny = math.ceil((y1 - y0) / step)
    click.echo(f"grid {nx}×{ny} tiles of {TILE_PX}px @ {PX} m")
    jobs = []
    for j in range(ny):
        for i in range(nx):
            key = f"{i}_{j}"
            if only and key != only:
                continue
            out = TILE_DIR / f"h_{key}.tif"
            if out.exists() and out.stat().st_size > 0:
                continue
            jobs.append((key, out, x0 + i * step, y1 - j * step))  # top-left corner
    click.echo(f"{len(jobs)} to fetch ({nx * ny - len(jobs)} cached)")

    def fetch(job: tuple[str, Path, float, float]) -> str:
        key, out, tx, ty = job
        url = img.getDownloadURL(
            {
                "format": "GEO_TIFF",
                "crs": UTM,
                "crs_transform": [PX, 0, tx, 0, -PX, ty],
                "dimensions": [TILE_PX, TILE_PX],
            }
        )
        # Written via a temp name so a killed run never leaves a half tile
        # that the next run would take as cached.
        r = requests.get(url, timeout=600)
        r.raise_for_status()
        tmp = out.with_suffix(".part")
        tmp.write_bytes(r.content)
        tmp.replace(out)
        return f"{key}: {len(r.content) / 1e6:.1f} MB"

    from concurrent.futures import ThreadPoolExecutor

    with ThreadPoolExecutor(max_workers=6) as ex:
        for msg in ex.map(fetch, jobs):
            click.echo(msg)


# ─── join ─────────────────────────────────────────────────────────

def wkt_polygon_ring(wkt_str: str) -> list[tuple[float, float]] | None:
    """Outer ring of a single-ring WKT POLYGON (same parser as script 17)."""
    if not wkt_str.startswith("POLYGON(("):
        return None
    body = wkt_str[9 : wkt_str.index(")")]
    ring = []
    for pair in body.split(","):
        x, y = pair.split()
        ring.append((float(x), float(y)))
    return ring if len(ring) >= 4 else None


def load_bmr_buildings() -> tuple[np.ndarray, np.ndarray, np.ndarray, list[list[tuple[float, float]]]]:
    """(lng, lat, area, rings) for footprints inside the six-province outline."""
    import shapely
    from shapely.geometry import shape

    outline = shapely.union_all([shape(f["geometry"]) for f in json.loads(PROVINCES.read_text())["features"]])
    shapely.prepare(outline)
    lng: list[float] = []
    lat: list[float] = []
    area: list[float] = []
    rings: list[list[tuple[float, float]]] = []
    for p in sorted(HEIGHT_DIR.glob("bmr_*_buildings.csv.gz")):
        with gzip.open(p, "rt", newline="") as f:
            r = csv.reader(f)
            h = next(r)
            i_lat, i_lon, i_area, i_geom = h.index("latitude"), h.index("longitude"), h.index("area_in_meters"), h.index("geometry")
            for row in r:
                ring = wkt_polygon_ring(row[i_geom])
                if ring is None:
                    continue
                lat.append(float(row[i_lat]))
                lng.append(float(row[i_lon]))
                area.append(float(row[i_area]))
                rings.append(ring)
    x, y = np.asarray(lng), np.asarray(lat)
    inside = shapely.contains_xy(outline, x, y)
    keep = np.flatnonzero(inside)
    return x[keep], y[keep], np.asarray(area)[keep], [rings[i] for i in keep]


@cli.command()
def join() -> None:
    """Mean 2.5D height under each footprint → bmr_buildings_h.csv.gz."""
    import rasterio
    from pyproj import Transformer
    from rasterio.features import rasterize

    lng, lat, area, rings = load_bmr_buildings()
    n = len(lng)
    click.echo(f"{n:,} footprints inside the BMR outline")
    t = Transformer.from_crs("EPSG:4326", UTM, always_xy=True)
    cx, cy = t.transform(lng, lat)
    hsum = np.zeros(n)
    hcnt = np.zeros(n)
    centre_h = np.full(n, np.nan)

    for tif in sorted(TILE_DIR.glob("h_*.tif")):
        with rasterio.open(tif) as ds:
            b = ds.bounds
            sel = np.flatnonzero((cx >= b.left) & (cx < b.right) & (cy > b.bottom) & (cy <= b.top))
            if sel.size == 0:
                continue
            band = ds.read(1)
            # Height at the footprint centre — the fallback for footprints
            # too small to cover a pixel centre once rasterised.
            col_f, row_f = ~ds.transform * (cx[sel], cy[sel])
            rows = np.clip(np.floor(row_f).astype(int), 0, band.shape[0] - 1)
            cols = np.clip(np.floor(col_f).astype(int), 0, band.shape[1] - 1)
            centre_h[sel] = band[rows, cols] / 2.0
            shapes = []
            for k, i in enumerate(sel):
                ux, uy = t.transform(*zip(*rings[i]))
                shapes.append(({"type": "Polygon", "coordinates": [list(zip(ux, uy))]}, k + 1))
            ids = rasterize(shapes, out_shape=band.shape, transform=ds.transform, fill=0, dtype="int32", all_touched=False)
            m = ids > 0
            vals = band[m].astype(np.float64) / 2.0
            idx = ids[m] - 1
            # Count only pixels the model calls built (h > 0): the ground
            # around a narrow footprint otherwise drags the mean down.
            pos = vals > 0
            hsum[sel] += np.bincount(idx[pos], weights=vals[pos], minlength=sel.size)
            hcnt[sel] += np.bincount(idx[pos], minlength=sel.size)
        click.echo(f"{tif.name}: {sel.size:,} footprints")

    h = np.where(hcnt > 0, hsum / np.maximum(hcnt, 1), centre_h)
    out = HEIGHT_DIR / "bmr_buildings_h.csv.gz"
    with gzip.open(out, "wt", newline="", compresslevel=6) as f:
        w = csv.writer(f)
        w.writerow(["lng", "lat", "area_m2", "h_m", "px"])
        for i in range(n):
            w.writerow([f"{lng[i]:.6f}", f"{lat[i]:.6f}", f"{area[i]:.1f}", "" if np.isnan(h[i]) else f"{h[i]:.1f}", int(hcnt[i])])
    known = ~np.isnan(h)
    click.echo(f"wrote {out.name}: height for {known.sum():,}/{n:,}; median {np.nanmedian(h):.1f} m; zero-height {(h[known] == 0).sum():,}")


# ─── calibrate ────────────────────────────────────────────────────

def load_heights() -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    lng, lat, area, h = [], [], [], []
    with gzip.open(HEIGHT_DIR / "bmr_buildings_h.csv.gz", "rt", newline="") as f:
        r = csv.reader(f)
        next(r)
        for row in r:
            lng.append(float(row[0]))
            lat.append(float(row[1]))
            area.append(float(row[2]))
            h.append(float(row[3]) if row[3] else np.nan)
    return np.asarray(lng), np.asarray(lat), np.asarray(area), np.asarray(h)


def storey_class(h: np.ndarray, t: float) -> np.ndarray:
    """0 unknown · 1 low-rise (1–2 storeys, estimated) · 2 three or more.

    Single vs two storeys is NOT separable with this height model (their
    estimated heights differ by ~1.4 m and overlap almost entirely against
    OSM), so the classes stop at low-rise vs 3+.
    """
    c = np.zeros(h.shape, dtype=np.uint8)
    known = ~np.isnan(h)
    c[known & (h < t)] = 1
    c[known & (h >= t)] = 2
    return c


@cli.command()
def calibrate() -> None:
    """Pick the low-rise/3+ height threshold against OSM building:levels."""
    from pyproj import Transformer
    from scipy.spatial import cKDTree

    raw = json.loads((HEIGHT_DIR / "osm_levels.json").read_text())
    osm = raw["elements"]
    o_lng, o_lat, o_lv = [], [], []
    for e in osm:
        c = e.get("center")
        try:
            lv = float(e["tags"]["building:levels"])
        except (KeyError, ValueError):
            continue
        if not c or lv < 1 or lv > 80 or lv != int(lv):
            continue
        o_lng.append(c["lon"])
        o_lat.append(c["lat"])
        o_lv.append(int(lv))
    lng, lat, area, h = load_heights()
    t = Transformer.from_crs("EPSG:4326", UTM, always_xy=True)
    bx, by = t.transform(lng, lat)
    ox, oy = t.transform(np.asarray(o_lng), np.asarray(o_lat))
    tree = cKDTree(np.column_stack([bx, by]))
    d, i = tree.query(np.column_stack([ox, oy]))
    # Same building: the OSM centre lies within the footprint's radius.
    ok = (d <= np.sqrt(area[i] / np.pi) + 2.0) & ~np.isnan(h[i])
    lv = np.asarray(o_lv)[ok]
    hh = h[i][ok]
    click.echo(f"OSM buildings with numeric levels: {len(o_lv):,}; matched to a footprint with height: {ok.sum():,}")
    for name, sel in (("1", lv == 1), ("2", lv == 2), ("3+", lv >= 3)):
        if sel.any():
            q = np.percentile(hh[sel], [10, 25, 50, 75, 90])
            click.echo(f"  levels {name}: n={sel.sum():,}  est. height p10/25/50/75/90 = {', '.join(f'{v:.1f}' for v in q)} m")

    truth = np.where(lv >= 3, 2, 1)
    best = (-1.0, 0.0)
    for th in np.arange(2.0, 20.01, 0.25):
        pred = storey_class(hh, float(th))
        bacc = float(np.mean([(pred[truth == k] == k).mean() for k in (1, 2)]))
        if bacc > best[0]:
            best = (bacc, float(th))
    bacc, th = best
    pred = storey_class(hh, th)

    def pr(k: int) -> dict:
        p_ = pred == k
        return {
            "precision": round(float((truth[p_] == k).mean()), 3) if p_.any() else None,
            "recall": round(float((pred[truth == k] == k).mean()), 3),
        }

    # Why single storey is not offered: the best 1-vs-2 split on its own.
    one_two = lv <= 2
    b12 = max(
        (float(np.mean([((hh[one_two] < x) == (lv[one_two] == 1))[lv[one_two] == k].mean() for k in (1, 2)])), float(x))
        for x in np.arange(2.0, 12.01, 0.25)
    )
    report = {
        "dataset": f"{DATASET} ({YEAR}) × Open Buildings v3",
        "reference": "OpenStreetMap building:levels in the BMR bbox",
        "osm_with_levels": len(o_lv),
        "osm_failed_chunks": raw.get("failed_chunks", []),
        "matched": int(ok.sum()),
        "matched_by_levels": {"1": int((lv == 1).sum()), "2": int((lv == 2).sum()), "3+": int((lv >= 3).sum())},
        "threshold_m": th,
        "balanced_accuracy": round(bacc, 3),
        "accuracy": round(float((pred == truth).mean()), 3),
        "low_rise": pr(1),
        "three_plus": pr(2),
        "single_vs_two_best_balanced_accuracy": round(b12[0], 3),
        "confusion_rows_truth_cols_pred": {"labels": ["1-2", "3+"], "matrix": [[int(((truth == a) & (pred == b)).sum()) for b in (1, 2)] for a in (1, 2)]},
        "caveat": "OSM buildings with a levels tag are not a random sample (city centre, larger buildings over-represented).",
    }
    (HEIGHT_DIR / "calibration.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    click.echo(json.dumps(report, ensure_ascii=False, indent=2))


# ─── tiles ────────────────────────────────────────────────────────

OUT_PMTILES = REPO_ROOT / "data" / "output" / "buildings_bmr.pmtiles"
OUT_POINTS = REPO_ROOT / "data" / "output" / "buildings_bmr_points.npz"
SUMMARY = REPO_ROOT.parent / "public" / "data" / "bmr" / "building_storeys.json"
R2_PUBLIC_BASE = "https://pub-3f4b09707ccd46ec948313a3513e3b25.r2.dev"
LAYER = "buildings"


@cli.command()
def tiles() -> None:
    """PMTiles {s, h} + points npz (for the daily flood join) + summary JSON."""
    import shapely
    from datetime import datetime, timezone
    from shapely.geometry import shape

    cal = json.loads((HEIGHT_DIR / "calibration.json").read_text())
    th = cal["threshold_m"]
    lng, lat, area, rings = load_bmr_buildings()
    hl, hlat, _, h = load_heights()
    if len(hl) != len(lng) or not np.allclose(hl, lng, atol=2e-6) or not np.allclose(hlat, lat, atol=2e-6):
        sys.exit("bmr_buildings_h.csv.gz is out of step with the footprints — re-run join")
    s_cls = storey_class(h, th)

    cmd = [
        "tippecanoe", "-o", str(OUT_PMTILES), "--force", "-l", LAYER, "-Z13", "-z15",
        "--drop-smallest-as-needed", "--extend-zooms-if-still-dropping", "--simplification=4",
        "--no-feature-limit", "--maximum-tile-bytes=800000", "--detect-shared-borders",
        f"--attribution=Google Open Buildings v3 + 2.5D Temporal {YEAR} (CC BY 4.0) — low-rise/3+ estimated",
        "--name=Open Buildings · BMR · estimated storeys", "--quiet",
    ]
    import subprocess

    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, text=True, encoding="utf-8")
    assert proc.stdin is not None
    for i in range(len(lng)):
        ring = ",".join(f"[{x:.6f},{y:.6f}]" for x, y in rings[i])
        hv = "null" if np.isnan(h[i]) else str(int(round(h[i])))
        proc.stdin.write('{"type":"Feature","properties":{"s":%d,"h":%s},"geometry":{"type":"Polygon","coordinates":[[%s]]}}\n' % (s_cls[i], hv, ring))
    proc.stdin.close()
    if proc.wait() != 0:
        sys.exit("tippecanoe failed")
    np.savez_compressed(OUT_POINTS, lng=lng.astype(np.float32), lat=lat.astype(np.float32), s=s_cls)

    feats = json.loads(PROVINCES.read_text())["features"]
    per_prov = {}
    for f in feats:
        g = shape(f["geometry"])
        shapely.prepare(g)
        m = shapely.contains_xy(g, lng, lat)
        per_prov[f["properties"]["name_th"]] = {str(k): int((s_cls[m] == k).sum()) for k in (0, 1, 2)}
    size = OUT_PMTILES.stat().st_size
    SUMMARY.write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "estimate": True,
        "note": "จำนวนชั้นเป็นการประมาณจากความสูงอาคารที่ Google ประเมินจากภาพดาวเทียม Sentinel-2 ไม่ใช่ข้อมูลสำรวจ",
        "sources": [f"Google Open Buildings v3 (footprints, conf ≥ {CONF_THRESHOLD})", f"Google Open Buildings 2.5D Temporal {YEAR} (height)", "OpenStreetMap building:levels (calibration)"],
        "classes": {"0": "ไม่ทราบ", "1": "อาคารเตี้ย 1–2 ชั้น (ประมาณ)", "2": "3 ชั้นขึ้นไป (ประมาณ)"},
        "threshold_m": th,
        "calibration": {k: cal[k] for k in ("matched", "matched_by_levels", "balanced_accuracy", "accuracy", "low_rise", "three_plus", "single_vs_two_best_balanced_accuracy", "confusion_rows_truth_cols_pred", "caveat")},
        "count": int(len(lng)),
        "by_class": {str(k): int((s_cls == k).sum()) for k in (0, 1, 2)},
        "by_province": per_prov,
        "tiles": {"file": OUT_PMTILES.name, "url": f"{R2_PUBLIC_BASE}/{OUT_PMTILES.name}", "layer": LAYER, "min_zoom": 13, "max_zoom": 15, "bytes": size},
        "points": {"file": OUT_POINTS.name, "url": f"{R2_PUBLIC_BASE}/{OUT_POINTS.name}"},
    }, ensure_ascii=False, indent=2))
    click.echo(f"{OUT_PMTILES.name}: {size / 1e6:.1f} MB · {OUT_POINTS.name}: {OUT_POINTS.stat().st_size / 1e6:.1f} MB · wrote {SUMMARY.name}")
    click.echo(json.dumps({str(k): int((s_cls == k).sum()) for k in (0, 1, 2)}))


if __name__ == "__main__":
    cli()
