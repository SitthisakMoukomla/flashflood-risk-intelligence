// Bangkok Drainage & Sewerage Department (สนน. กทม.) canal telemetry.
//
// BMA runs its own ~200 khlong gauges and gates, none of which appear in
// the HII public feed. BMA's site refuses non-Thai IPs, so the data is read
// from the People's Party relay (flood69), which copies BMA every 5 min and
// credits สนน. That relay is a third party and may vanish; the API route
// caches the last good copy and the UI says how old it is.
//
// Status uses BMA's own per-station warning/critical levels rather than our
// % of bank, because BMA's thresholds are what their operators act on.

export type BmaStatus = "critical" | "warning" | "watch" | "normal" | "unknown";

export type BmaGauge = {
  code: string; // WL.xxx.nn
  name: string;
  lat: number;
  lng: number;
  kind: "gate" | "gauge";
  /** Inside level, m MSL (for a gate: the canal side it protects). */
  level: number | null;
  /** Outside level for a gate (river side), m MSL. */
  levelOut: number | null;
  warning: number | null;
  critical: number | null;
  /** Lower of the two surveyed banks, m MSL. */
  bank: number | null;
  /** Highest level so far today, m MSL. */
  maxToday: number | null;
  /** Telemetry time (ISO). */
  time: string | null;
  /** Minutes since telemetry at the moment the route built the payload. */
  ageMin: number | null;
  status: BmaStatus;
  /** Metres above (+) or below (−) the critical level; null without a threshold. */
  overCritical: number | null;
};

/** One day of BMA's tide table at the river mouth: two highs, two lows, m MSL. */
export type BmaTide = {
  date: string;
  highTime: string | null;
  high: number | null;
  lowTime: string | null;
  low: number | null;
  nightTime: string | null;
  nightHigh: number | null;
  nightLowTime: string | null;
  nightLow: number | null;
};

export type BmaPayload = {
  fetchedAt: string;
  sourceAt: string | null;
  gauges: BmaGauge[];
  tide: BmaTide[];
  attribution: string;
};

/** BMA leaves unset thresholds at 0; a threshold that is not above the
 *  canal bed is no threshold. */
export function threshold(v: number | null): number | null {
  return v !== null && v > 0 ? v : null;
}

export function bmaStatus(level: number | null, warning: number | null, critical: number | null, bank: number | null): BmaStatus {
  if (level === null) return "unknown";
  warning = threshold(warning);
  critical = threshold(critical);
  // A "critical" below "warning" is a data-entry slip — trust neither.
  if (warning !== null && critical !== null && critical < warning) {
    warning = null;
    critical = null;
  }
  if (critical !== null && level >= critical) return "critical";
  if (warning !== null && level >= warning) return "warning";
  // Some stations publish no thresholds; fall back to the bank.
  if (critical === null && warning === null && bank !== null) {
    if (level >= bank) return "critical";
    if (level >= bank - 0.3) return "warning";
  }
  const ref = warning ?? critical;
  if (ref !== null && level >= ref - 0.2) return "watch";
  return "normal";
}

export const BMA_STATUS_META: Record<BmaStatus, { label: string; color: string; rank: number }> = {
  critical: { label: "วิกฤต", color: "#e63b2e", rank: 4 },
  warning: { label: "เตือนภัย", color: "#ff8c1a", rank: 3 },
  watch: { label: "เฝ้าระวัง", color: "#ffd23f", rank: 2 },
  normal: { label: "ปกติ", color: "#3fbf4e", rank: 1 },
  unknown: { label: "ไม่มีข้อมูล", color: "#9aa6a6", rank: 0 },
};

/** BMA serialises dates as "/Date(1790442000000)/" — epoch ms, UTC. */
export function bmaDate(v: unknown): string | null {
  const m = /(\d{10,13})/.exec(String(v ?? ""));
  if (!m) return null;
  const ms = m[1].length === 10 ? Number(m[1]) * 1000 : Number(m[1]);
  return new Date(ms).toISOString();
}

export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
