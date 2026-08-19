"""Phase T.1 — Merge sharded GEE susceptibility exports into one raster.

A country-scale Export.image.toDrive is split by GEE into several
GeoTIFF shards (``<prefix>-0000000000-0000000000.tif`` …). Download all
of them into ``pipeline/data/gee_exports/`` and run this script; it
mosaics them into ``data/output/susceptibility.tif`` (tiled + LZW) that
the rest of the pipeline already consumes. Works with a single file too.

Run:
  uv run python scripts/13_merge_gee_exports.py
  uv run python scripts/13_merge_gee_exports.py --src "data/gee_exports/*.tif" --out data/output/susceptibility.tif
"""

from __future__ import annotations

import glob
from pathlib import Path

import click
import numpy as np
import rasterio
from rasterio.merge import merge

REPO_ROOT = Path(__file__).resolve().parents[1]


@click.command()
@click.option(
    "--src",
    default="data/gee_exports/*.tif",
    help="Glob (relative to pipeline/) of GEE export shards",
)
@click.option(
    "--out",
    default="data/output/susceptibility.tif",
    help="Merged output path (relative to pipeline/)",
)
def main(src: str, out: str) -> None:
    paths = sorted(glob.glob(str(REPO_ROOT / src)))
    if not paths:
        raise SystemExit(f"no files match {REPO_ROOT / src} — download the GEE shards first")

    datasets = [rasterio.open(p) for p in paths]
    first = datasets[0]
    click.echo(f"[in] {len(paths)} shard(s), bands={first.count} {first.descriptions}")
    for p, ds in zip(paths, datasets):
        click.echo(f"     {Path(p).name}  {ds.width}x{ds.height}  {tuple(round(b, 3) for b in ds.bounds)}")

    mosaic, transform = merge(datasets, nodata=first.nodata)
    h, w = mosaic.shape[1], mosaic.shape[2]

    out_path = REPO_ROOT / out
    out_path.parent.mkdir(parents=True, exist_ok=True)
    profile = {
        "driver": "GTiff",
        "dtype": first.dtypes[0],
        "count": first.count,
        "width": w,
        "height": h,
        "crs": first.crs,
        "transform": transform,
        "nodata": first.nodata,
        "tiled": True,
        "blockxsize": 512,
        "blockysize": 512,
        "compress": "lzw",
        "BIGTIFF": "IF_SAFER",
    }
    with rasterio.open(out_path, "w", **profile) as dst:
        dst.write(mosaic)
        for b, name in enumerate(first.descriptions, start=1):
            if name:
                dst.set_band_description(b, name)

    # Sanity: value distribution of band 1 must look like a 0-1 hazard.
    band1 = mosaic[0].astype("float64")
    valid = band1[np.isfinite(band1) & (band1 > 0)]
    if valid.size == 0:
        raise SystemExit("merged band 1 has no valid pixels — wrong inputs?")
    pct = np.percentile(valid, [2, 50, 98])
    size_mb = out_path.stat().st_size / 1e6
    out_label = out_path.relative_to(REPO_ROOT) if out_path.is_relative_to(REPO_ROOT) else out_path
    click.echo(f"[out] {out_label}  {w}x{h}  {size_mb:.1f} MB")
    click.echo(f"[stats] band1 p2/p50/p98 = {pct.round(3)}  max={valid.max():.3f}")
    if pct[2] > 1.5:
        click.echo("WARNING: band 1 p98 > 1.5 — this does not look like the 0-1 hazard band")

    for ds in datasets:
        ds.close()


if __name__ == "__main__":
    main()
