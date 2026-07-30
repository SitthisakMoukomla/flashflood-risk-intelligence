// Types and helpers for the per-tambon risk model.
// Data: public/data/village_risk.geojson (zonal stats from GEE susceptibility)
//       public/data/wetness_7d.json     (Open-Meteo 7-day antecedent rainfall)

import { riskMeta, type RiskTier, tierFromNorm } from "./risk-intelligence";

export type TambonProperties = {
  rank: number;
  GID_3: string;
  NAME_3: string;
  NAME_2: string;
  NAME_1: string;
  TYPE_3: string;
  /** Alternate romanisations from GADM, pipe-separated (may be absent). */
  VARNAME_3?: string | null;
  cells: number;
  risk_mean: number;
  risk_max: number;
  risk_p75: number;
  risk_p90: number;
  risk_p95: number;
  class_max: number;
  class_3plus_cells: number;
  class_3plus_pct: number;
  risk_p90_norm: number;
  risk_p95_norm: number;
  /** Added by 08_buildings_per_tambon.py — present after the buildings refresh runs. */
  buildings?: number;
  building_area_km2?: number;
  /** Thai อำเภอ name, added by 11_add_thai_names.py from GADM NL_NAME_2.
   *  GADM has no Thai tambon names, so NAME_3 stays romanised. */
  NL_NAME_2?: string;
};

export type TambonFeature = GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon, TambonProperties>;
export type TambonCollection = GeoJSON.FeatureCollection<
  GeoJSON.Polygon | GeoJSON.MultiPolygon,
  TambonProperties
>;

export type WetnessRecord = {
  GID_3: string;
  rain_7d_mm: number;
  wetness_norm: number;
};

export type WetnessPayload = {
  generated_at: string;
  window_days: number;
  norm_cap_mm: number;
  source: string;
  tambon: WetnessRecord[];
};

export type WetnessGrid = {
  generated_at: string;
  source: string;
  bbox: [number, number, number, number];
  grid_bbox: [number, number, number, number]; // west, south, east, north
  rows: number;
  cols: number;
  step_deg: number;
  wetness_norm_cap_mm: number;
  precip_now_norm_cap_mm_per_hr: number;
  static_norm_low?: number;
  static_norm_high?: number;
  rain_7d_mm: number[];
  precip_now_mm_per_hr: number[];
  /** Per-cell static hazard (0..1). Filled in by 06_wetness_grid.py
   *  by sampling the GEE susceptibility raster. */
  static_norm?: number[];
};

/** Compute the per-cell live risk array from a wetness grid. */
export function computeLiveGrid(grid: WetnessGrid): Float32Array {
  const n = grid.rows * grid.cols;
  const out = new Float32Array(n);
  const wcap = grid.wetness_norm_cap_mm;
  const pcap = grid.precip_now_norm_cap_mm_per_hr;
  const staticArr = grid.static_norm ?? new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const wet = Math.min(1, (grid.rain_7d_mm[i] ?? 0) / wcap);
    const pre = Math.min(1, (grid.precip_now_mm_per_hr[i] ?? 0) / pcap);
    const s = staticArr[i] ?? 0;
    const base = s * (0.4 + 0.6 * wet);
    const kick = pre * (0.3 + 0.4 * wet);
    out[i] = Math.min(1, base + kick);
  }
  return out;
}

/** RGBA color for wetness 0..1: light → deep blue. */
export function wetnessRampRGBA(t: number): [number, number, number, number] {
  const x = Math.max(0, Math.min(1, t));
  const r = Math.round(220 - 195 * x);
  const g = Math.round(238 - 145 * x);
  const b = Math.round(255 - 60 * x);
  // Below ~0.05 use a low alpha so dry areas don't paint over the basemap.
  const a = Math.round(Math.min(220, 60 + 200 * x));
  return [r, g, b, a];
}

/** RGBA color for live precipitation 0..1: transparent → orange/red. */
export function precipRampRGBA(t: number): [number, number, number, number] {
  const x = Math.max(0, Math.min(1, t));
  if (x < 0.02) return [0, 0, 0, 0];
  const r = Math.round(255);
  const g = Math.round(220 - 200 * x);
  const b = Math.round(150 - 130 * x);
  const a = Math.round(140 + 100 * x);
  return [r, g, b, a];
}

export type LayerMode = "live" | "static" | "wetness";

export const layerModes: Record<LayerMode, { label: string; sublabel: string; description: string }> = {
  live: {
    label: "เตือนภัยตอนนี้",
    sublabel: "Risk now",
    description: "ความเสี่ยงน้ำป่าตอนนี้ — รวมพื้นที่เสี่ยง + ดินอิ่มน้ำ + ฝนตอนนี้",
  },
  static: {
    label: "พื้นที่เสี่ยง",
    sublabel: "Terrain",
    description: "ที่ดินที่น้ำป่ามักไหลผ่าน — ภูเขาชัน ลำห้วยลงเร็ว ก่อนเอาฝนเข้ามาคำนวณ",
  },
  wetness: {
    label: "ดินอิ่มน้ำ",
    sublabel: "Soil moisture",
    description: "ฝนสะสม 7 วันหลังนี้ — ดินอิ่มเท่าไหร่ ฝนรอบใหม่ก็ไหลบ่าเร็ว",
  },
};

// Live trigger formula.
// Two channels combine:
//   base    = static × (0.4 + 0.6 × wetness)         — saturated soil amplifies static hazard
//   kick    = precipNow × (0.3 + 0.4 × wetness)      — live rain adds *on top*, more on already-wet ground
//   live    = min(1, base + kick)
// This lets precip push beyond static when intensity is high — the user's
// requested behaviour. Clipped at 1.0 so colour ramp stays bounded.
export function liveRiskNorm(staticNorm: number, wetnessNorm: number, precipNorm = 0): number {
  const base = staticNorm * (0.4 + 0.6 * wetnessNorm);
  const kick = precipNorm * (0.3 + 0.4 * wetnessNorm);
  return Math.min(1, base + kick);
}

// 5-stop diverging color ramp for risk values in [0..1].
// Matches the GEE script palette so the two products tell the same story.
const RAMP = [
  { stop: 0.0, color: [26, 152, 80] }, // green
  { stop: 0.25, color: [166, 217, 106] },
  { stop: 0.5, color: [254, 224, 139] },
  { stop: 0.75, color: [253, 174, 97] },
  { stop: 1.0, color: [215, 48, 39] }, // red
] as const;

export function riskRampColor(t: number): string {
  const x = Math.max(0, Math.min(1, t));
  for (let i = 0; i < RAMP.length - 1; i++) {
    const a = RAMP[i];
    const b = RAMP[i + 1];
    if (x >= a.stop && x <= b.stop) {
      const f = b.stop === a.stop ? 0 : (x - a.stop) / (b.stop - a.stop);
      const r = Math.round(a.color[0] + f * (b.color[0] - a.color[0]));
      const g = Math.round(a.color[1] + f * (b.color[1] - a.color[1]));
      const bl = Math.round(a.color[2] + f * (b.color[2] - a.color[2]));
      return `rgb(${r},${g},${bl})`;
    }
  }
  return `rgb(${RAMP[RAMP.length - 1].color.join(",")})`;
}

// Wetness uses a single-hue blue ramp so it reads as "moisture" not "danger".
export function wetnessRampColor(t: number): string {
  const x = Math.max(0, Math.min(1, t));
  // light blue → deep blue
  const r = Math.round(220 - 180 * x);
  const g = Math.round(235 - 130 * x);
  const b = Math.round(255 - 60 * x);
  return `rgb(${r},${g},${b})`;
}

export type TambonRow = {
  feature: TambonFeature;
  staticNorm: number;
  wetnessNorm: number;
  wetnessMm: number | null;
  precipNorm: number;
  precipMmPerHr: number;
  liveNorm: number;
  tier: RiskTier;
  liveTier: RiskTier;
};

/** Approximate centroid of a Polygon/MultiPolygon by averaging exterior ring vertices. */
function approxCentroid(geom: GeoJSON.Polygon | GeoJSON.MultiPolygon): [number, number] | null {
  const ring =
    geom.type === "Polygon" ? geom.coordinates[0] : geom.coordinates[0]?.[0];
  if (!ring || ring.length === 0) return null;
  let sx = 0;
  let sy = 0;
  for (const [lon, lat] of ring) {
    sx += lon;
    sy += lat;
  }
  return [sx / ring.length, sy / ring.length];
}

/** Nearest-cell sample of a flat grid at (lat, lon). Returns 0 outside grid. */
function sampleGrid(grid: WetnessGrid, lat: number, lon: number, field: "rain_7d_mm" | "precip_now_mm_per_hr"): number {
  const [w, s, e, n] = grid.grid_bbox;
  if (lat < s || lat > n || lon < w || lon > e) return 0;
  const col = Math.min(grid.cols - 1, Math.max(0, Math.round((lon - w) / (e - w) * (grid.cols - 1))));
  const row = Math.min(grid.rows - 1, Math.max(0, Math.round((n - lat) / (n - s) * (grid.rows - 1))));
  return grid[field][row * grid.cols + col] ?? 0;
}

export function buildTambonRows(
  fc: TambonCollection,
  wetness: WetnessPayload | null,
  grid: WetnessGrid | null = null,
): TambonRow[] {
  const wetByGid = new Map<string, WetnessRecord>();
  if (wetness) {
    for (const w of wetness.tambon) wetByGid.set(w.GID_3, w);
  }

  return fc.features.map((feature) => {
    const p = feature.properties;
    const w = wetByGid.get(p.GID_3);
    const wetnessNorm = w ? w.wetness_norm : 0;
    const wetnessMm = w ? w.rain_7d_mm : null;
    const staticNorm = p.risk_p90_norm;

    let precipMmPerHr = 0;
    let precipNorm = 0;
    if (grid) {
      const c = approxCentroid(feature.geometry);
      if (c) {
        precipMmPerHr = sampleGrid(grid, c[1], c[0], "precip_now_mm_per_hr");
        precipNorm = Math.min(1, precipMmPerHr / grid.precip_now_norm_cap_mm_per_hr);
      }
    }

    const live = liveRiskNorm(staticNorm, wetnessNorm, precipNorm);
    return {
      feature,
      staticNorm,
      wetnessNorm,
      wetnessMm,
      precipNorm,
      precipMmPerHr,
      liveNorm: live,
      tier: tierFromNorm(staticNorm),
      liveTier: tierFromNorm(live),
    };
  });
}

export function colorForRow(row: TambonRow, mode: LayerMode): string {
  if (mode === "static") return riskRampColor(row.staticNorm);
  if (mode === "wetness") return wetnessRampColor(row.wetnessNorm);
  return riskRampColor(row.liveNorm);
}

export function tierColorForMode(row: TambonRow, mode: LayerMode): string {
  const tier = mode === "live" ? row.liveTier : row.tier;
  return riskMeta[tier].color;
}
