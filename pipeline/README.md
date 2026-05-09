# FlashFlood Pipeline — Static Seasonal Susceptibility

Local Python pipeline that produces the static seasonal susceptibility raster
for the FlashFlood Risk Intelligence webapp. **No GEE, no API keys for the
core terrain layer** — DEM is fetched anonymously from AWS Open Data.

```
seasonal_susceptibility = terrain (slope + TWI) + burn_modifier + exposure
                          ↑ this folder produces the COG, ↑ then frontend overlays rainfall
```

## Setup

```bash
cd pipeline
uv sync
```

## Phase 1 stages (run in order)

| Step | Script | Output |
|---|---|---|
| 1.1 AOI | `scripts/01_aoi_mask.py` | `data/aoi/aoi_north_thailand.geojson`, `aoi_bbox.json` |
| 1.2a DEM | `scripts/02a_fetch_dem.py` | `data/dem/Copernicus_DSM_*.tif` (20 tiles, ~900 MB) |
| 1.2b Terrain | `scripts/02b_terrain_score.py` | `data/output/terrain_score.tif` (0-40, COG) |
| 1.3 Burn | (todo) `scripts/03_burn_modifier.py` | `data/output/burn_modifier.tif` (0-25) |
| 1.4 Exposure | (todo) `scripts/04_exposure.py` | `data/output/exposure_score.tif` (0-25) |
| 1.5 Composite | (todo) `scripts/05_susceptibility.py` | `data/output/susceptibility.tif` (0-90) |

## Pilot mode (smoke test)

Each script supports `--pilot` to run only the N19_E098 tile (~Pai region):

```bash
uv run python scripts/02a_fetch_dem.py --pilot
uv run python scripts/02b_terrain_score.py --pilot
```

Pilot outputs use `_pilot` suffix and are independent of full-AOI outputs.

## Data sources

| Layer | Source | Auth | Free |
|---|---|---|---|
| Province boundaries | GADM 4.1 (Thailand level 1) | none | yes |
| DEM 30m | Copernicus DSM via `s3://copernicus-dem-30m` (public AWS) | none | yes |
| Active fire (planned) | NASA FIRMS REST API | MAP_KEY (free) | yes |
| Burned area (planned) | NASA LP DAAC MCD64A1 | NASA Earthdata account | yes |
| Buildings (planned) | Google Open Buildings v3 | none | yes |

## Honest caveats

- This is **not** a calibrated flash-flood probability — it's a relative ranking.
- Slope and TWI are computed in EPSG:4326; cell size in meters varies with
  latitude (within ±5% across the AOI). Acceptable for pre-screening.
- Score normalization clips to 5th–95th percentile inside the AOI. A cell at
  score 40 in this AOI is not the same as a cell at score 40 in a different
  region.
