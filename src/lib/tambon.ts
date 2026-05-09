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

export type LayerMode = "static" | "wetness" | "live";

export const layerModes: Record<LayerMode, { label: string; description: string }> = {
  static: {
    label: "Static hazard",
    description: "ความเสี่ยงเชิงพื้นที่จาก slope + TWI + burn (ก่อนใส่ฝน)",
  },
  wetness: {
    label: "ดินอิ่มน้ำ",
    description: "ฝนสะสม 7 วันหลังนี้ (Open-Meteo) เป็น proxy ของ soil moisture",
  },
  live: {
    label: "Risk live",
    description: "static × (0.4 + 0.6 × max(wetness, radar)) — เสี่ยงตอนนี้จริง",
  },
};

// Live trigger formula: rain context boosts the static hazard.
// Conservative base: even with no rain, the static map keeps 40% of its weight.
export function liveRiskNorm(staticNorm: number, wetnessNorm: number, rainBoost = 0): number {
  const trigger = Math.max(wetnessNorm, rainBoost);
  return Math.min(1, staticNorm * (0.4 + 0.6 * trigger));
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
  liveNorm: number;
  tier: RiskTier;
  liveTier: RiskTier;
};

export function buildTambonRows(
  fc: TambonCollection,
  wetness: WetnessPayload | null,
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
    const live = liveRiskNorm(staticNorm, wetnessNorm, 0);
    return {
      feature,
      staticNorm,
      wetnessNorm,
      wetnessMm,
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
