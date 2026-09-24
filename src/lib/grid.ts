// The nationwide model grid behind the hex risk surface.
// Data: public/data/wetness_grid.json — static susceptibility, 7-day rain
// and rain-now on a 0.15° grid over Thailand, refreshed by the daily cron.

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
  /** null where the last Open-Meteo fetch did not reach — treat as
   *  "not measured", never as zero. */
  rain_7d_mm: (number | null)[];
  precip_now_mm_per_hr: (number | null)[];
  /** Per-cell static hazard (0..1). Filled in by 06_wetness_grid.py
   *  by sampling the GEE susceptibility raster. */
  static_norm?: number[];
  /** Provenance of the 7-day rain field (CHIRPS lags a few days). */
  rain_source?: string;
  /** Last day (YYYY-MM-DD) the 7-day rain window covers. */
  rain_window_end?: string;
};

/** Compute the per-cell live risk array from a wetness grid. */
export function computeLiveGrid(grid: WetnessGrid): Float32Array {
  const n = grid.rows * grid.cols;
  const out = new Float32Array(n);
  const wcap = grid.wetness_norm_cap_mm;
  const pcap = grid.precip_now_norm_cap_mm_per_hr;
  const staticArr = grid.static_norm ?? new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const rain = grid.rain_7d_mm[i];
    const precip = grid.precip_now_mm_per_hr[i];
    if (rain === null || rain === undefined) {
      // No rain measurement here. Drawing 0 would render as "low risk",
      // which is a claim we cannot make — mark the cell unknown instead.
      out[i] = NaN;
      continue;
    }
    const wet = Math.min(1, rain / wcap);
    const pre = Math.min(1, (precip ?? 0) / pcap);
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
