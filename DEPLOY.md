# Deploy notes

## Connect Vercel project to this GitHub repo

The Vercel project (`prj_pXCCh2r9MyGkQ48asnOTyq7VBPxF` /
`flashflood-risk-intelligence`) was originally created via the Vercel CLI.
To get auto-deploy on every push to GitHub:

1. Open <https://vercel.com/team_N1ePqkML6itsPQHP2mm3EXT1/flashflood-risk-intelligence/settings/git>
   (or **Settings → Git** in the project dashboard).
2. Click **Connect Git Repository** → choose
   `SitthisakMoukomla/flashflood-risk-intelligence`.
3. Production branch: `main`. Preview branches: any non-`main` branch
   (so `feat/real-data-mvp` will get a preview URL on every push).
4. Build settings — should auto-detect:
   - Framework preset: **Next.js**
   - Build command: `next build`
   - Output: `.next`
   - Install: `npm install`

After connecting, every push triggers a deploy. Pushing to `main`
publishes to <https://flashflood-risk-intelligence.vercel.app>.

## What ships in `public/data/`

| File | Source | Refresh |
|---|---|---|
| `village_risk.geojson`, `village_risk_table.csv` | `pipeline/scripts/05_village_risk.py` | when GEE static raster changes |
| `wetness_7d.json` | `pipeline/scripts/06_wetness.py` | daily via GitHub Actions |
| `wetness_grid.json` | `pipeline/scripts/06_wetness_grid.py` | daily via GitHub Actions |
| `static_overlay.png`, `static_overlay_meta.json` | `pipeline/scripts/07_static_overlay.py` | when GEE static raster changes |
| `buildings_per_tambon.json` | `pipeline/scripts/08_buildings_per_tambon.py` | once per ~6 months |

## Daily refresh

`.github/workflows/refresh-wetness.yml` runs at 01:00 UTC (08:00 Asia/Bangkok)
and re-fetches the wetness layers, commits the JSON updates to `main`,
and lets Vercel rebuild automatically.

To trigger a manual refresh: GitHub → Actions → "Refresh wetness data"
→ Run workflow.

## Rebuilding the heavy artefacts locally

```bash
cd pipeline
uv sync

# fast (only on data dependency change):
uv run python scripts/01_aoi_mask.py
uv run python scripts/05_village_risk.py
uv run python scripts/07_static_overlay.py

# slow (downloads ~5 GB once):
uv run python scripts/08_buildings_per_tambon.py

# regular refresh (~1 min total):
uv run python scripts/06_wetness.py
uv run python scripts/06_wetness_grid.py
```

The `pipeline/data/dem/`, `pipeline/data/buildings/`, and
`pipeline/data/output/` directories are gitignored — only the small
JSON/PNG outputs in `public/data/` ride along to deploy.

## Refreshing the GEE static raster

When the static susceptibility map needs to be re-run for a new season:

1. Run the GEE script ([pipeline/GEE_HANDOFF.md](pipeline/GEE_HANDOFF.md)) and
   `Export.image.toDrive` the result.
2. Drop the GeoTIFF into `pipeline/data/output/susceptibility.tif`.
3. Re-run:
   ```bash
   uv run python scripts/05_village_risk.py
   uv run python scripts/07_static_overlay.py
   ```
4. Commit `public/data/{village_risk.*, static_overlay.*}` and push.
