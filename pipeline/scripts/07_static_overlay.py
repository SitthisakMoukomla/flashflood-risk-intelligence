"""Phase 1.7 — Render the GEE static susceptibility raster as a frontend PNG.

The browser can't render a 71 MB COG directly, but at zoom 6-9 the AOI
covers ~700 m/pixel anyway. We downsample to a reasonable PNG, bake the
diverging risk ramp into RGBA, and write the bbox alongside so the
frontend can drop it onto the map via `L.imageOverlay`.

Outputs:
  public/data/static_overlay.png        — downsampled susceptibility, baked color ramp
  public/data/static_overlay_meta.json  — bbox + nominal resolution

Run:
  uv run python scripts/07_static_overlay.py            # default 1200 px max dim
  uv run python scripts/07_static_overlay.py --max-dim 1800
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import click
import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling

REPO_ROOT = Path(__file__).resolve().parents[1]
SRC = REPO_ROOT / "data" / "output" / "susceptibility.tif"
PUBLIC_DATA = REPO_ROOT.parent / "public" / "data"
PUBLIC_DATA.mkdir(parents=True, exist_ok=True)
PNG_OUT = PUBLIC_DATA / "static_overlay.png"
META_OUT = PUBLIC_DATA / "static_overlay_meta.json"

# Diverging green→yellow→red ramp matching `riskRampColor` in src/lib/tambon.ts.
RAMP = [
    (0.00, (26, 152, 80)),
    (0.25, (166, 217, 106)),
    (0.50, (254, 224, 139)),
    (0.75, (253, 174, 97)),
    (1.00, (215, 48, 39)),
]


def ramp_lookup(t: np.ndarray) -> np.ndarray:
    """Interpolate t∈[0,1] across RAMP; returns (h, w, 3) uint8."""
    out = np.zeros(t.shape + (3,), dtype=np.float32)
    for i in range(len(RAMP) - 1):
        s0, c0 = RAMP[i]
        s1, c1 = RAMP[i + 1]
        m = (t >= s0) & (t <= s1)
        f = (t - s0) / max(s1 - s0, 1e-9)
        for ch in range(3):
            out[..., ch] = np.where(m, c0[ch] + f * (c1[ch] - c0[ch]), out[..., ch])
    out = np.clip(out, 0, 255)
    return out.astype(np.uint8)


@click.command()
@click.option("--max-dim", default=1200, type=int, help="Max output dimension in pixels")
def main(max_dim: int) -> None:
    if not SRC.exists():
        raise SystemExit(f"missing {SRC} — run GEE export first")

    with rasterio.open(SRC) as ds:
        click.echo(
            f"[in] {SRC.name} {ds.width}x{ds.height} {ds.dtypes[0]} "
            f"crs={ds.crs} bounds={tuple(round(b, 4) for b in ds.bounds)}"
        )
        # Downsample with bilinear so the visual is smooth.
        scale = max_dim / max(ds.width, ds.height)
        out_w = max(1, int(round(ds.width * scale)))
        out_h = max(1, int(round(ds.height * scale)))
        click.echo(f"[downsample] scale={scale:.3f} → {out_w}x{out_h}")

        susc = ds.read(
            1,
            out_shape=(out_h, out_w),
            resampling=Resampling.bilinear,
        ).astype(np.float32)
        bounds = ds.bounds  # left, bottom, right, top

    # Identify the data mask (Susc.tif uses NaN for outside-AOI).
    valid = np.isfinite(susc) & (susc > 0)
    if not valid.any():
        raise SystemExit("no valid pixels in susceptibility band")

    # Normalize using the AOI percentile range to match the on-screen tambon ramp.
    vmin = float(np.quantile(susc[valid], 0.02))
    vmax = float(np.quantile(susc[valid], 0.98))
    click.echo(f"[norm] 2-98 pct = [{vmin:.3f}, {vmax:.3f}]")
    t = np.clip((susc - vmin) / max(vmax - vmin, 1e-9), 0, 1)

    rgb = ramp_lookup(t)  # (h, w, 3)
    alpha = np.where(valid, 200, 0).astype(np.uint8)  # 200/255 ≈ 78% opaque

    rgba = np.dstack([rgb, alpha])
    Image.fromarray(rgba, "RGBA").save(PNG_OUT, optimize=True)
    size_kb = PNG_OUT.stat().st_size / 1024
    click.echo(f"[write] {PNG_OUT.name}  {out_w}x{out_h}  {size_kb:.1f} KB")

    meta = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_raster": str(SRC.relative_to(REPO_ROOT)),
        "bbox": [float(bounds.left), float(bounds.bottom), float(bounds.right), float(bounds.top)],
        "width": out_w,
        "height": out_h,
        "norm_low": vmin,
        "norm_high": vmax,
        "ramp": "green→yellow→red (matches riskRampColor)",
    }
    META_OUT.write_text(json.dumps(meta, indent=2, ensure_ascii=False))
    click.echo(f"[write] {META_OUT.name}")
    click.echo(f"\nbbox: {meta['bbox']}")


if __name__ == "__main__":
    main()
