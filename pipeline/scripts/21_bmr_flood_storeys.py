"""Phase B.2 — Low-rise (1–2 storey, estimated) BMR buildings on today's observed flood.

Runs right after 14_sar_flood.py in the daily Sentinel-1 workflow. Takes the
building points published by script 20 (centre + estimated class — low-rise
1–2 storeys / 3+ — for every Open Buildings footprint in the six provinces) and counts, per class,
how many fall inside today's flood polygons.

Both inputs are approximations and the output says so: the flood extent is a
week of Sentinel-1 passes (radar misses water between tall buildings), and
the storey class is an estimate from a satellite height model, not a survey.

Output:
  public/data/bmr/flood_storeys.json

Run:
  python scripts/21_bmr_flood_storeys.py
  python scripts/21_bmr_flood_storeys.py --points data/output/buildings_bmr_points.npz
"""

from __future__ import annotations

import io
import json
import ssl
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import click
import numpy as np
import shapely
from shapely.geometry import box, shape

try:
    import certifi

    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:  # pragma: no cover
    SSL_CTX = ssl.create_default_context()

REPO_ROOT = Path(__file__).resolve().parents[1]
PUBLIC = REPO_ROOT.parent / "public" / "data"
FLOOD = PUBLIC / "sar_flood.geojson"
FLOOD_META = PUBLIC / "sar_flood_meta.json"
STOREYS = PUBLIC / "bmr" / "building_storeys.json"
OUT = PUBLIC / "bmr" / "flood_storeys.json"
BBOX = (99.831, 13.425, 100.964, 14.273)


@click.command()
@click.option("--points", "points_path", default=None, help="local npz instead of the published one")
def main(points_path: str | None) -> None:
    storeys = json.loads(STOREYS.read_text())
    if points_path:
        npz = np.load(points_path)
    else:
        # r2.dev refuses Python's default User-Agent with a 403.
        req = urllib.request.Request(storeys["points"]["url"], headers={"User-Agent": "FlashfloodRiskIntelligence/1.0 (pipeline)"})
        with urllib.request.urlopen(req, context=SSL_CTX, timeout=120) as r:
            npz = np.load(io.BytesIO(r.read()))
    lng, lat, s = npz["lng"].astype(np.float64), npz["lat"].astype(np.float64), npz["s"]

    region = box(*BBOX)
    polys = [shape(f["geometry"]) for f in json.loads(FLOOD.read_text())["features"]]
    polys = [p.buffer(0) if not p.is_valid else p for p in polys]
    polys = [p for p in polys if p.intersects(region)]
    on = np.zeros(len(lng), dtype=bool)
    if polys:
        flood = shapely.union_all(polys)
        shapely.prepare(flood)
        on = shapely.contains_xy(flood, lng, lat)

    meta = json.loads(FLOOD_META.read_text())
    counts = {str(k): int((s[on] == k).sum()) for k in (0, 1, 2)}
    OUT.write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "estimate": True,
        "note": "ประมาณการ: น้ำจากดาวเทียม Sentinel-1 (7 วัน) × อาคารเตี้ย/สูงที่ประมาณจากความสูงอาคาร — ไม่ใช่ข้อมูลสำรวจ",
        "flood_generated_at": meta.get("generated_at"),
        "flood_window_hours": meta.get("window_hours"),
        "buildings_on_flood": int(on.sum()),
        "by_class": counts,
        "classes": storeys["classes"],
    }, ensure_ascii=False, indent=2))
    click.echo(f"{OUT.name}: {int(on.sum()):,} buildings on observed flood · by class {counts}")


if __name__ == "__main__":
    main()
