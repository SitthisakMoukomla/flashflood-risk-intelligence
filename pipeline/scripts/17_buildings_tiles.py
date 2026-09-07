"""Phase A.2 — Nationwide building footprints as a vector tile archive.

The per-tambon footprint files (script 10) only exist for the 663 northern
tambon, so anywhere else the map falls back to the density PNG and never
shows individual houses. This packs every Open Buildings v3 polygon inside
the Thailand outline into one PMTiles archive that the frontend draws with
protomaps-leaflet from z13 up, independent of which tambon is selected.

Pipeline:
  CSV.gz (6 S2 cells, ~63 M rows)  →  filter conf ≥ 0.7 + inside outline
    →  newline-delimited GeoJSON on a pipe  →  tippecanoe  →  PMTiles

The WKT is parsed by hand (Open Buildings only ever writes single-ring
POLYGONs) because shapely.wkt.loads on 45 M rows would dominate the run.
The outline test is shapely's vectorised contains_xy on batches of
centroids, which is what makes the 28 % of rows that sit across the border
cheap to drop.

Output:
  pipeline/data/output/buildings.pmtiles     (gitignored — goes to R2)
  public/data/buildings_tiles_meta.json      (url + zoom range for the app)

Run:
  uv run python scripts/17_buildings_tiles.py                  # full build
  uv run python scripts/17_buildings_tiles.py --limit 200000   # smoke test
  uv run python scripts/17_buildings_tiles.py --ndjson-only | head
"""

from __future__ import annotations

import csv
import gzip
import io
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import click
import numpy as np
import shapely
from shapely.geometry import shape

REPO_ROOT = Path(__file__).resolve().parents[1]
BUILD_DIR = REPO_ROOT / "data" / "buildings"
THAILAND_PATH = REPO_ROOT / "data" / "aoi" / "thailand_boundary.geojson"
OUT_PMTILES = REPO_ROOT / "data" / "output" / "buildings.pmtiles"
META_PATH = REPO_ROOT.parent / "public" / "data" / "buildings_tiles_meta.json"

CONF_THRESHOLD = 0.7
BATCH = 200_000
LAYER = "buildings"
MIN_ZOOM = 13  # below this the density PNG carries the picture
MAX_ZOOM = 15  # renderer overzooms to street level from here
# Public base of the R2 bucket the SAR archive already lives in.
R2_PUBLIC_BASE = "https://pub-3f4b09707ccd46ec948313a3513e3b25.r2.dev"


def wkt_polygon_ring(wkt_str: str) -> list[list[float]] | None:
    """Outer ring of a single-ring WKT POLYGON as [[lng, lat], ...], 6 dp."""
    if not wkt_str.startswith("POLYGON(("):
        return None
    # A few footprints carry a hole ring; the outer ring is all we draw.
    body = wkt_str[9 : wkt_str.index(")")]
    ring = []
    for pair in body.split(","):
        x, y = pair.split()
        ring.append([round(float(x), 6), round(float(y), 6)])
    return ring if len(ring) >= 4 else None


def stream_features(limit: int | None, log) -> tuple[int, int, int]:
    """Write one GeoJSON Feature per line to stdout. Returns (read, kept, dropped_outside)."""
    outline = shape(json.loads(THAILAND_PATH.read_text())["geometry"])
    shapely.prepare(outline)
    out = sys.stdout
    total_read = kept = outside = 0
    cells = sorted(BUILD_DIR.glob("*_buildings.csv.gz"))
    if not cells:
        raise SystemExit(f"no *_buildings.csv.gz under {BUILD_DIR}")
    log(f"[in] {len(cells)} cell file(s): {[c.name for c in cells]}")

    for gz_path in cells:
        with gzip.open(gz_path, "rb") as fb:
            f = io.TextIOWrapper(fb, encoding="utf-8", newline="")
            reader = csv.reader(f)
            header = next(reader)
            i_lat, i_lon = header.index("latitude"), header.index("longitude")
            i_conf, i_area = header.index("confidence"), header.index("area_in_meters")
            i_geom = header.index("geometry")

            batch_xy: list[tuple[float, float]] = []
            batch_rows: list[tuple[str, int]] = []
            file_kept = 0

            def flush() -> int:
                nonlocal outside
                if not batch_xy:
                    return 0
                xy = np.asarray(batch_xy)
                inside = shapely.contains_xy(outline, xy[:, 0], xy[:, 1])
                n = 0
                for ok, (geom, area) in zip(inside, batch_rows):
                    if not ok:
                        outside += 1
                        continue
                    ring = wkt_polygon_ring(geom)
                    if ring is None:
                        continue
                    out.write(
                        '{"type":"Feature","properties":{"a":%d},"geometry":{"type":"Polygon","coordinates":[%s]}}\n'
                        % (area, json.dumps(ring, separators=(",", ":")))
                    )
                    n += 1
                batch_xy.clear()
                batch_rows.clear()
                return n

            for row in reader:
                total_read += 1
                if float(row[i_conf]) < CONF_THRESHOLD:
                    continue
                batch_xy.append((float(row[i_lon]), float(row[i_lat])))
                batch_rows.append((row[i_geom], int(float(row[i_area]))))
                if len(batch_xy) >= BATCH:
                    file_kept += flush()
                    if limit and kept + file_kept >= limit:
                        break
            file_kept += flush()
            kept += file_kept
            log(f"  {gz_path.name}: kept {file_kept:,} (running total {kept:,}; read {total_read:,})")
        if limit and kept >= limit:
            break
    out.flush()
    return total_read, kept, outside


@click.command()
@click.option("--limit", type=int, default=None, help="Stop after this many features (smoke test)")
@click.option("--ndjson-only", is_flag=True, help="Emit NDJSON to stdout and skip tippecanoe")
@click.option("--out", type=click.Path(path_type=Path), default=OUT_PMTILES, show_default=True)
def main(limit: int | None, ndjson_only: bool, out: Path) -> None:
    log = lambda m: click.echo(m, err=True)  # noqa: E731 — stdout is the data pipe
    if ndjson_only:
        stream_features(limit, log)
        return

    if subprocess.run(["which", "tippecanoe"], capture_output=True).returncode != 0:
        raise SystemExit("tippecanoe not on PATH (brew install tippecanoe)")
    out.parent.mkdir(parents=True, exist_ok=True)

    # Buildings are small, so at z13 whole towns exceed the tile budget —
    # drop the smallest footprints there rather than thinning at random,
    # and never drop at the max zoom where the user expects every house.
    cmd = [
        "tippecanoe",
        "-o", str(out), "--force",
        "-l", LAYER,
        f"-Z{MIN_ZOOM}", f"-z{MAX_ZOOM}",
        "--drop-smallest-as-needed",
        "--extend-zooms-if-still-dropping",
        "--simplification=4",
        "--no-feature-limit",
        "--maximum-tile-bytes=800000",
        "--detect-shared-borders",
        "--attribution=Google Open Buildings v3 (CC BY 4.0)",
        "--name=Open Buildings v3 · Thailand",
        "--quiet",
    ]
    log(f"[tippecanoe] {' '.join(cmd)}")
    started = datetime.now(timezone.utc)
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, text=True, encoding="utf-8")
    real_stdout = sys.stdout
    sys.stdout = proc.stdin  # type: ignore[assignment]
    try:
        total_read, kept, outside = stream_features(limit, log)
    finally:
        sys.stdout = real_stdout
        proc.stdin.close()  # type: ignore[union-attr]
    rc = proc.wait()
    if rc != 0:
        raise SystemExit(f"tippecanoe exited {rc}")
    size = out.stat().st_size
    log(f"[out] {out.name}  {size / 1e6:,.1f} MB  · {kept:,} buildings "
        f"(read {total_read:,}, {outside:,} outside the outline)  in "
        f"{(datetime.now(timezone.utc) - started).total_seconds() / 60:.1f} min")

    if limit:
        log("[meta] smoke test — not writing buildings_tiles_meta.json")
        return
    META_PATH.write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "Google Open Buildings v3 — confidence ≥ 0.7 footprints",
        "tiles": {
            "file": out.name,
            "url": f"{R2_PUBLIC_BASE}/{out.name}",
            "layer": LAYER,
            "min_zoom": MIN_ZOOM,
            "max_zoom": MAX_ZOOM,
            "bytes": size,
            "count": kept,
        },
    }, ensure_ascii=False, indent=2))
    log(f"[meta] wrote {META_PATH.name}")


if __name__ == "__main__":
    main()
