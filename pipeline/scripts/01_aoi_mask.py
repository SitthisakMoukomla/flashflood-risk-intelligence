"""Phase 1.1 — Build AOI mask for 8 northern Thailand provinces.

Downloads GADM 4.1 Thailand level-1 boundaries, filters to the 8 northern
provinces, dissolves into a single multipolygon, and writes:

  data/aoi/aoi_north_thailand.geojson  — dissolved AOI
  data/aoi/aoi_north_provinces.geojson — per-province polygons
  data/aoi/aoi_bbox.json               — minx, miny, maxx, maxy in EPSG:4326

Run:
  uv run python scripts/01_aoi_mask.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import geopandas as gpd
import requests
from tqdm import tqdm

# --- Constants ---------------------------------------------------------------

# Per spec: 8 northern provinces. NAME_1 values follow GADM 4.1 (CamelCase, no spaces).
NORTHERN_PROVINCES_GADM = [
    "ChiangMai",
    "ChiangRai",
    "Lampang",
    "Lamphun",
    "MaeHongSon",
    "Nan",
    "Phayao",
    "Phrae",
]

GADM_URL = "https://geodata.ucdavis.edu/gadm/gadm4.1/json/gadm41_THA_1.json.zip"

REPO_ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = REPO_ROOT / "data" / "aoi"
OUT_DIR.mkdir(parents=True, exist_ok=True)

GADM_CACHE = OUT_DIR / "gadm41_THA_1.json.zip"
DISSOLVED_PATH = OUT_DIR / "aoi_north_thailand.geojson"
PROVINCES_PATH = OUT_DIR / "aoi_north_provinces.geojson"
BBOX_PATH = OUT_DIR / "aoi_bbox.json"


def download_gadm(url: str, dest: Path) -> None:
    if dest.exists():
        print(f"[cache] {dest.name} ({dest.stat().st_size / 1024:.0f} KB)")
        return
    print(f"[download] {url}")
    with requests.get(url, stream=True, timeout=120) as r:
        r.raise_for_status()
        total = int(r.headers.get("content-length", 0))
        with dest.open("wb") as f, tqdm(
            total=total, unit="B", unit_scale=True, desc=dest.name
        ) as bar:
            for chunk in r.iter_content(chunk_size=1 << 14):
                if chunk:
                    f.write(chunk)
                    bar.update(len(chunk))


def main() -> int:
    download_gadm(GADM_URL, GADM_CACHE)

    print("[load] reading GADM level 1...")
    # geopandas can read zipped GeoJSON directly via fiona/pyogrio
    gdf = gpd.read_file(f"zip://{GADM_CACHE}")
    print(f"[load] {len(gdf)} provinces, columns: {list(gdf.columns)[:8]}...")

    if "NAME_1" not in gdf.columns:
        print("ERROR: NAME_1 column missing", file=sys.stderr)
        return 2

    available = sorted(gdf["NAME_1"].unique().tolist())
    missing = [p for p in NORTHERN_PROVINCES_GADM if p not in available]
    if missing:
        print(f"ERROR: missing provinces in GADM: {missing}", file=sys.stderr)
        print(f"Available sample: {available[:15]}", file=sys.stderr)
        return 3

    north = gdf[gdf["NAME_1"].isin(NORTHERN_PROVINCES_GADM)].copy()
    north = north[["NAME_1", "geometry"]].reset_index(drop=True)
    assert len(north) == 8, f"expected 8 provinces, got {len(north)}"

    # Per-province polygons
    north.to_file(PROVINCES_PATH, driver="GeoJSON")
    print(f"[write] {PROVINCES_PATH.name} — {len(north)} features")

    # Dissolve into single multipolygon
    dissolved = north.dissolve()
    dissolved["region"] = "north_thailand_8_provinces"
    dissolved = dissolved[["region", "geometry"]]
    dissolved.to_file(DISSOLVED_PATH, driver="GeoJSON")
    print(f"[write] {DISSOLVED_PATH.name}")

    # Bbox + area
    minx, miny, maxx, maxy = dissolved.total_bounds
    # Approx area in km² via equal-area projection
    area_km2 = float(north.to_crs("EPSG:6933").geometry.area.sum() / 1e6)
    bbox = {
        "crs": "EPSG:4326",
        "minx": float(minx),
        "miny": float(miny),
        "maxx": float(maxx),
        "maxy": float(maxy),
        "width_deg": float(maxx - minx),
        "height_deg": float(maxy - miny),
        "area_km2": round(area_km2, 1),
        "provinces": NORTHERN_PROVINCES_GADM,
    }
    BBOX_PATH.write_text(json.dumps(bbox, indent=2, ensure_ascii=False))
    print(f"[write] {BBOX_PATH.name}")
    print(json.dumps(bbox, indent=2, ensure_ascii=False))

    print(f"\nOK — bbox covers {area_km2:,.0f} km²")
    return 0


if __name__ == "__main__":
    sys.exit(main())
