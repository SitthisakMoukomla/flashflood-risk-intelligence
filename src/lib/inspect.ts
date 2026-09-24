// Point inspection — answers "what do the nationwide layers say about this
// spot?" for any coordinate in Thailand. Replaces the per-tambon model,
// which only ever covered 663 subdistricts in the north.
//
// Every number here is read from a layer the map already draws, so the
// panel can never disagree with what the user sees on screen:
//   tier       — the live hex surface (same grid, same formula, same cell)
//   rain       — the wetness grid behind that surface
//   stations   — ThaiWater gauges already loaded for the station layers
//   flood      — the Sentinel-1 flood tile pyramid on R2
//   buildings  — the Open Buildings footprint tiles on R2

import { cellToLatLng, gridDisk, latLngToCell } from "h3-js";
import { tierFromNorm, type RiskTier } from "./risk-intelligence";
import { computeLiveGrid, type WetnessGrid } from "./grid";

/** H3 resolution the inspector reports at — the finer of the two the map
 *  draws, matching the data's real ~7 km resolution. */
export const INSPECT_HEX_RES = 6;

/** Below this static mask value a hex is not drawn at all (sea, outside
 *  the country) — same cut buildHexCells uses. */
const MASK_MIN = 0.02;

export type PointRisk = {
  /** False when the point falls outside the modelled area (sea, abroad). */
  inside: boolean;
  /** H3 cell the tier was read from — drawn as the highlighted hex. */
  cell: string;
  /** Live tier, or null where no rain measurement reaches this cell. */
  tier: RiskTier | null;
  /** The live value behind `tier` (NaN when unmeasured) — for ordering only,
   *  never shown: the app reports tiers, not scores. */
  liveNorm: number;
  /** Static terrain tier alone — available even without rain data. */
  staticTier: RiskTier;
  staticNorm: number;
  wetnessNorm: number | null;
  precipNorm: number | null;
  rain7dMm: number | null;
  precipNowMmPerHr: number | null;
};

function bilinear(arr: ArrayLike<number>, cols: number, rows: number, gx: number, gy: number): number {
  const x0 = Math.max(0, Math.min(cols - 1, Math.floor(gx)));
  const y0 = Math.max(0, Math.min(rows - 1, Math.floor(gy)));
  const x1 = Math.min(cols - 1, x0 + 1);
  const y1 = Math.min(rows - 1, y0 + 1);
  const fx = Math.max(0, Math.min(1, gx - x0));
  const fy = Math.max(0, Math.min(1, gy - y0));
  const corners: [number, number][] = [
    [Number(arr[y0 * cols + x0]), (1 - fx) * (1 - fy)],
    [Number(arr[y0 * cols + x1]), fx * (1 - fy)],
    [Number(arr[y1 * cols + x0]), (1 - fx) * fy],
    [Number(arr[y1 * cols + x1]), fx * fy],
  ];
  let acc = 0;
  let wsum = 0;
  for (const [v, w] of corners) {
    if (!Number.isFinite(v)) continue;
    acc += v * w;
    wsum += w;
  }
  return wsum > 0 ? acc / wsum : NaN;
}

const nullable = (a: (number | null)[]) => Float32Array.from(a, (v) => (v === null || v === undefined ? NaN : v));

/** Cached per grid payload: the arrays the hex surface is coloured from. */
const gridCache = new WeakMap<WetnessGrid, { live: Float32Array; rain: Float32Array; precip: Float32Array }>();

function gridArrays(grid: WetnessGrid) {
  let c = gridCache.get(grid);
  if (!c) {
    c = { live: computeLiveGrid(grid), rain: nullable(grid.rain_7d_mm), precip: nullable(grid.precip_now_mm_per_hr) };
    gridCache.set(grid, c);
  }
  return c;
}

/** Risk at a coordinate, read at the centre of its hex so the answer is
 *  exactly the colour of the hex drawn under the pin. */
export function riskAt(grid: WetnessGrid, lat: number, lng: number): PointRisk {
  const cell = latLngToCell(lat, lng, INSPECT_HEX_RES);
  const [clat, clng] = cellToLatLng(cell);
  const [w, s, e, n] = grid.grid_bbox;
  const gx = ((clng - w) / (e - w)) * (grid.cols - 1);
  const gy = ((n - clat) / (n - s)) * (grid.rows - 1);
  const inBox = clng >= w && clng <= e && clat >= s && clat <= n;
  const staticNorm = inBox && grid.static_norm ? bilinear(grid.static_norm, grid.cols, grid.rows, gx, gy) : NaN;
  const inside = Number.isFinite(staticNorm) && staticNorm > MASK_MIN;
  const empty: PointRisk = {
    inside: false,
    cell,
    tier: null,
    liveNorm: NaN,
    staticTier: "low",
    staticNorm: 0,
    wetnessNorm: null,
    precipNorm: null,
    rain7dMm: null,
    precipNowMmPerHr: null,
  };
  if (!inside) return empty;

  const a = gridArrays(grid);
  const live = bilinear(a.live, grid.cols, grid.rows, gx, gy);
  const rain = bilinear(a.rain, grid.cols, grid.rows, gx, gy);
  const precip = bilinear(a.precip, grid.cols, grid.rows, gx, gy);
  return {
    inside: true,
    cell,
    tier: Number.isFinite(live) ? tierFromNorm(live) : null,
    liveNorm: live,
    staticTier: tierFromNorm(staticNorm),
    staticNorm: Math.min(1, staticNorm),
    wetnessNorm: Number.isFinite(rain) ? Math.min(1, rain / grid.wetness_norm_cap_mm) : null,
    precipNorm: Number.isFinite(precip) ? Math.min(1, precip / grid.precip_now_norm_cap_mm_per_hr) : null,
    rain7dMm: Number.isFinite(rain) ? rain : null,
    precipNowMmPerHr: Number.isFinite(precip) ? precip : null,
  };
}

// ─── Hotspots ─────────────────────────────────────────────────────

/** Mean area of an H3 resolution-6 cell, km². */
export const HEX_AREA_KM2 = 36.13;

export type Hotspot = {
  /** Peak of the area — the hex with the highest live value. */
  lat: number;
  lng: number;
  tier: RiskTier;
  /** Contiguous hexes in the area. */
  cells: number;
};

export type HotspotSummary = {
  /** Worst areas first: severe areas by size, then high-only areas by size. */
  hotspots: Hotspot[];
  severeKm2: number;
  highKm2: number;
  /** Hexes with a measurement behind them — the denominator for shares. */
  measuredKm2: number;
};

/** Group severe (and high) hexes into contiguous areas. One storm or one
 *  wet basin reads as one hotspot however many hexes it spans, instead of
 *  being cut into arbitrary discs. */
export function hotspots(grid: WetnessGrid, cells: { lat: number; lng: number }[]): HotspotSummary {
  const at = new Map<string, { tier: RiskTier; v: number; lat: number; lng: number }>();
  let severe = 0;
  let high = 0;
  let measured = 0;
  for (const c of cells) {
    const r = riskAt(grid, c.lat, c.lng);
    if (!r.inside || !r.tier) continue;
    measured++;
    if (r.tier === "severe") severe++;
    else if (r.tier === "high") high++;
    at.set(r.cell, { tier: r.tier, v: r.liveNorm, lat: c.lat, lng: c.lng });
  }

  const components = (member: (t: RiskTier) => boolean) => {
    const seen = new Set<string>();
    const out: { cells: string[]; hasSevere: boolean }[] = [];
    for (const [cell, info] of at) {
      if (seen.has(cell) || !member(info.tier)) continue;
      const stack = [cell];
      const group: string[] = [];
      let hasSevere = false;
      seen.add(cell);
      while (stack.length) {
        const x = stack.pop()!;
        group.push(x);
        if (at.get(x)!.tier === "severe") hasSevere = true;
        for (const nb of gridDisk(x, 1)) {
          const t = at.get(nb)?.tier;
          if (t && member(t) && !seen.has(nb)) {
            seen.add(nb);
            stack.push(nb);
          }
        }
      }
      out.push({ cells: group, hasSevere });
    }
    return out;
  };

  const peak = (group: string[], tier: RiskTier): Hotspot => {
    let best = at.get(group[0])!;
    for (const c of group) {
      const i = at.get(c)!;
      if (i.v > best.v) best = i;
    }
    return { lat: best.lat, lng: best.lng, tier, cells: group.length };
  };

  const severeAreas = components((t) => t === "severe").map((g) => peak(g.cells, "severe"));
  // High areas that contain no severe hex — the ones not already listed.
  const highAreas = components((t) => t === "severe" || t === "high")
    .filter((g) => !g.hasSevere)
    .map((g) => peak(g.cells, "high"));
  severeAreas.sort((a, b) => b.cells - a.cells);
  highAreas.sort((a, b) => b.cells - a.cells);

  return {
    hotspots: [...severeAreas, ...highAreas],
    severeKm2: severe * HEX_AREA_KM2,
    highKm2: high * HEX_AREA_KM2,
    measuredKm2: measured * HEX_AREA_KM2,
  };
}

// ─── Distance + nearest stations ──────────────────────────────────

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function nearest<T>(
  items: T[] | null,
  pos: (t: T) => [number, number] | null,
  lat: number,
  lng: number,
  maxKm: number,
  limit: number,
): { item: T; km: number }[] {
  if (!items) return [];
  const out: { item: T; km: number }[] = [];
  for (const it of items) {
    const p = pos(it);
    if (!p) continue;
    const km = haversineKm(lat, lng, p[0], p[1]);
    if (km <= maxKm) out.push({ item: it, km });
  }
  out.sort((a, b) => a.km - b.km);
  return out.slice(0, limit);
}

// ─── Tile helpers ─────────────────────────────────────────────────

/** Fractional global pixel position of a coordinate at zoom z (256 px tiles). */
function worldPx(lat: number, lng: number, z: number): [number, number] {
  const scale = 256 * 2 ** z;
  const x = ((lng + 180) / 360) * scale;
  const s = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale;
  return [x, y];
}

/** Ground metres per pixel at zoom z and latitude. */
function metresPerPx(lat: number, z: number): number {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
}

/** Tiles whose area overlaps a circle of `radiusPx` around a world pixel. */
function tilesAround(px: number, py: number, radiusPx: number): [number, number][] {
  const out: [number, number][] = [];
  for (let tx = Math.floor((px - radiusPx) / 256); tx <= Math.floor((px + radiusPx) / 256); tx++)
    for (let ty = Math.floor((py - radiusPx) / 256); ty <= Math.floor((py + radiusPx) / 256); ty++) out.push([tx, ty]);
  return out;
}

// ─── Observed flood near a point ──────────────────────────────────

export type FloodNear = {
  /** Flooded area inside the radius, in rai (1 rai = 1,600 m²). */
  rai: number;
  /** Distance to the nearest flooded pixel, or null when none. */
  nearestKm: number | null;
  radiusKm: number;
};

/** Zoom the flood pyramid is sampled at: ~75 m pixels, and a 5 km circle
 *  spans at most 2 × 2 tiles. */
const FLOOD_Z = 11;

type RasterArchive = { getZxy: (z: number, x: number, y: number) => Promise<{ data: ArrayBuffer } | undefined> };

/** Sum the Sentinel-1 flood mask inside a circle. The tile alpha channel
 *  carries each pixel's flooded fraction, so area is alpha-weighted. */
export async function floodNear(
  archive: RasterArchive,
  lat: number,
  lng: number,
  radiusKm = 5,
): Promise<FloodNear> {
  const mpp = metresPerPx(lat, FLOOD_Z);
  const [px, py] = worldPx(lat, lng, FLOOD_Z);
  const rPx = (radiusKm * 1000) / mpp;
  const pxArea = mpp * mpp;
  let areaM2 = 0;
  let nearestPx = Infinity;

  await Promise.all(
    tilesAround(px, py, rPx).map(async ([tx, ty]) => {
      const res = await archive.getZxy(FLOOD_Z, tx, ty);
      if (!res?.data || res.data.byteLength === 0) return;
      const bmp = await createImageBitmap(new Blob([res.data]));
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(bmp, 0, 0);
      const k = bmp.width / 256; // archives may carry 512 px tiles
      const { data } = ctx.getImageData(0, 0, bmp.width, bmp.height);
      for (let y = 0; y < bmp.height; y++) {
        const gy = ty * 256 + (y + 0.5) / k;
        for (let x = 0; x < bmp.width; x++) {
          const a = data[(y * bmp.width + x) * 4 + 3];
          if (a === 0) continue;
          const gx = tx * 256 + (x + 0.5) / k;
          const d = Math.hypot(gx - px, gy - py);
          if (d > rPx) continue;
          areaM2 += (a / 255) * (pxArea / (k * k));
          if (d < nearestPx) nearestPx = d;
        }
      }
    }),
  );

  return {
    rai: areaM2 / 1600,
    nearestKm: Number.isFinite(nearestPx) ? (nearestPx * mpp) / 1000 : null,
    radiusKm,
  };
}

// ─── Buildings near a point ───────────────────────────────────────

/** Zoom the footprint archive is counted at. z14 keeps ~99 % of
 *  footprints (only z13 thins) and a 1 km circle fits in ≤ 2 × 2 tiles. */
const BUILDINGS_Z = 14;

type VectorCache = {
  get: (c: { z: number; x: number; y: number }) => Promise<Map<string, { bbox: { minX: number; minY: number; maxX: number; maxY: number } }[]>>;
};

/** Count footprints whose centre lies inside the circle. A building cut
 *  by a tile edge appears in both tiles; its two halves have different
 *  centres, so near edges the count can run slightly high — it is shown
 *  as an approximate figure. */
export async function buildingsNear(
  cache: VectorCache,
  layer: string,
  lat: number,
  lng: number,
  radiusKm = 1,
): Promise<number> {
  const mpp = metresPerPx(lat, BUILDINGS_Z);
  const [px, py] = worldPx(lat, lng, BUILDINGS_Z);
  const rPx = (radiusKm * 1000) / mpp;
  let count = 0;
  await Promise.all(
    tilesAround(px, py, rPx).map(async ([tx, ty]) => {
      const tile = await cache.get({ z: BUILDINGS_Z, x: tx, y: ty });
      for (const f of tile.get(layer) ?? []) {
        // Geometry is in 256 px tile space (TileCache built with tileSize 256).
        const cx = tx * 256 + (f.bbox.minX + f.bbox.maxX) / 2;
        const cy = ty * 256 + (f.bbox.minY + f.bbox.maxY) / 2;
        if (Math.hypot(cx - px, cy - py) <= rPx) count++;
      }
    }),
  );
  return count;
}
