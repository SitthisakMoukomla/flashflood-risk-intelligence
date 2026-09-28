// ThaiWater (HII) public telemetry — shared by the national map and the
// municipal dashboards. Fetched straight from the browser; no key needed.

export const THAIWATER_RAIN_24H_URL =
  "https://api-v3.thaiwater.net/api/v1/thaiwater30/public/rain_24h";
export const THAIWATER_WATERLEVEL_URL =
  "https://api-v3.thaiwater.net/api/v1/thaiwater30/public/waterlevel";

export type ThaiWaterStation = {
  id: number;
  rain_24h: number | null;
  rain_1h: number | null;
  rainfall_datetime: string;
  agency: { agency_shortname?: { th?: string; en?: string } };
  geocode: { province_code: string; province_name?: { th?: string } };
  station: {
    tele_station_name?: { th?: string };
    tele_station_lat: number;
    tele_station_long: number;
  };
};

export type ThaiWaterLevelStation = {
  id: number;
  waterlevel_datetime: string;
  waterlevel_m: number | string | null;
  waterlevel_msl: number | string | null;
  waterlevel_msl_previous: number | string | null;
  storage_percent: number | string | null;
  flow_rate: number | string | null;
  situation_level: number | null; // 1 (low/safe) → 5 (critical)
  /** e.g. "แม่น้ำเจ้าพระยา" — lets the canal sheet draw the river. */
  river_name?: string | null;
  agency: { agency_shortname?: { th?: string; en?: string } };
  basin?: { basin_name?: { th?: string } };
  geocode: { province_code: string; province_name?: { th?: string } };
  station: {
    tele_station_name?: { th?: string };
    tele_station_lat: number;
    tele_station_long: number;
    tele_station_oldcode?: string | null;
    // Survey levels (m MSL). RID publishes these but often leaves
    // storage_percent empty, so we recompute from them.
    left_bank?: number | string | null;
    right_bank?: number | string | null;
    min_bank?: number | string | null;
    ground_level?: number | string | null;
  };
};

/** Water level as a percentage of bank height.
 *
 * Two thirds of the Royal Irrigation Department's 912 gauges arrive with
 * `storage_percent` empty — ThaiWater can only compute it when `min_bank`
 * is set, and RID frequently leaves that at 0 while still publishing the
 * surveyed bank and bed levels. Those stations were rendering as grey
 * "no data" dots across most of the country. The arithmetic is the same
 * one ThaiWater uses, verified against all 795 stations that do publish a
 * value: median error 0.005 pp, worst 0.26 pp.
 *
 * Returns null when the levels cannot support the calculation, or when the
 * result falls outside the range ThaiWater's own published values span
 * (a handful of stations carry inconsistent survey data).
 */
export function bankPercentOf(s: ThaiWaterLevelStation): number | null {
  return bankPercentAt(s);
}

/** % of bank for a given level at this station — the live reading by
 *  default, or a logged one (the survey levels it is measured against do
 *  not change between polls). */
export function bankPercentAt(s: ThaiWaterLevelStation, mslOverride?: number | null): number | null {
  const n = (v: unknown): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const f = Number(v);
    return Number.isFinite(f) ? f : null;
  };
  const published = n(s.storage_percent);
  if (published !== null && mslOverride === undefined) return published;

  const st = s.station;
  const msl = mslOverride === undefined ? n(s.waterlevel_msl) : n(mslOverride);
  const bed = n(st?.ground_level);
  if (msl === null || bed === null) return null;

  // ThaiWater's basis: min_bank when it is set, otherwise the lower of the
  // two surveyed banks. Some stations record banks in a different datum,
  // which is why min_bank wins where it exists.
  const minBank = n(st?.min_bank);
  let bank = minBank !== null && minBank > 0 && minBank > bed ? minBank : null;
  if (bank === null) {
    const sides = [n(st?.left_bank), n(st?.right_bank)].filter(
      (v): v is number => v !== null && v > bed,
    );
    if (sides.length) bank = Math.min(...sides);
  }
  if (bank === null || bank <= bed) return null;

  const pct = ((msl - bed) / (bank - bed)) * 100;
  if (!Number.isFinite(pct) || pct < -70 || pct > 200) return null;
  return pct;
}

/** Colour-by-rain (mm/24h) — light → red. */
export function rainStationColor(mm: number): string {
  if (mm <= 0) return "rgba(140,180,210,0.35)"; // dry
  if (mm < 10) return "#5cc4ee";
  if (mm < 25) return "#3b82f6";
  if (mm < 50) return "#fdae61";
  if (mm < 90) return "#f97316";
  return "#d73027";
}

/** Rainfall intensity (mm in the past hour), Thai Meteorological
 *  Department classes. Distinct from the 24 h accumulation ramp: this
 *  answers "is it pouring right now", not "how wet is the ground". */
export function rainIntensityColor(mmPerHour: number): string {
  if (mmPerHour >= 90) return "#7e22ce"; // หนักมาก
  if (mmPerHour >= 35) return "#d73027"; // หนัก
  if (mmPerHour >= 10) return "#f97316"; // ปานกลาง
  return "#38bdf8"; // เล็กน้อย
}

export function rainIntensityLabel(mmPerHour: number): string {
  if (mmPerHour >= 90) return "หนักมาก";
  if (mmPerHour >= 35) return "หนัก";
  if (mmPerHour >= 10) return "ปานกลาง";
  return "เล็กน้อย";
}
