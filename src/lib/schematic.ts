import type { BmaGauge, BmaStatus } from "./bma";

/**
 * "ผังคลอง" — a transit-map style sheet of the BMA canal network, built from
 * the live gauge list alone. Nothing is hand-placed:
 *
 * - every gauge is projected onto the sheet with an equal-area-ish scale
 *   (longitude shrunk by cos φ) inside the gauges' own bounding box;
 * - a canal with at least MIN_LINE gauges becomes a straight horizontal or
 *   vertical line (whichever way its gauges spread) at the mean of the other
 *   coordinate, and its gauges snap onto that line, keeping their order;
 * - gauges on smaller canals stay as loose dots at their projected spot;
 * - the Chao Phraya is a polyline through the HII stations that ThaiWater
 *   tags with river_name เจ้าพระยา, top to bottom.
 *
 * So the drawing is not to scale along a line, but relative positions are
 * real, and a gauge is never invented or moved to another canal.
 */

export const MIN_LINE = 2;

export type SheetStation = {
  code: string;
  name: string;
  /** Short station label: the part after the canal name. */
  label: string;
  canal: string;
  x: number;
  y: number;
  lat: number;
  lng: number;
  status: BmaStatus;
  kind: BmaGauge["kind"];
  level: number | null;
  levelOut: number | null;
  warning: number | null;
  critical: number | null;
  bank: number | null;
  ageMin: number | null;
  /** Metres over the reference line (critical, else warning, else bank). */
  over: number | null;
  /** Gate whose river side is ≥ 1 m above the canal side: holding, not over. */
  pressure: boolean;
};

export type SheetCanal = {
  name: string;
  orient: "h" | "v";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stations: SheetStation[];
};

export type RiverStation = {
  id: number;
  name: string;
  x: number;
  y: number;
  lat: number;
  lng: number;
  pct: number | null;
  stale: boolean;
};

export type Sheet = {
  w: number;
  h: number;
  canals: SheetCanal[];
  loose: SheetStation[];
  river: { points: [number, number][]; stations: RiverStation[] };
  /** Other HII stations (canals the BMA list does not cover). */
  hii: RiverStation[];
};

export type HiiInput = {
  id: number;
  name: string;
  lat: number;
  lng: number;
  pct: number | null;
  stale: boolean;
  onRiver: boolean;
};

const PREFIX = /^(จุดวัด|ประตูระบายน้ำ|สถานีสูบน้ำ|ปตร\.)\s*/;

/** Canal a gauge belongs to: the first word after the BMA type prefix. */
export function canalOf(name: string): string {
  const rest = name.replace(PREFIX, "").trim();
  const word = rest.split(/\s+/)[0] ?? rest;
  return word.replace(/[,;:]+$/, "");
}

/** The part of a gauge name that distinguishes it on its canal. */
export function labelOf(name: string, canal: string): string {
  const rest = name.replace(PREFIX, "").trim();
  const tail = rest.startsWith(canal) ? rest.slice(canal.length).trim() : rest;
  return tail.replace(/^[-–—:,\s]+/, "").replace(/^(ตอน|ช่วง)\s*/, "") || rest;
}

export function overOf(g: BmaGauge): number | null {
  if (g.level === null) return null;
  const ref = g.critical ?? g.warning ?? g.bank;
  return ref === null ? null : g.level - ref;
}

type Projector = (lat: number, lng: number) => [number, number];

/**
 * Sheet projection. Linear (equal-area-ish) position blended with the
 * station's rank along each axis — the usual schematic trick: dense inner
 * districts spread out, empty fringes shrink, and left/right, up/down order
 * is never changed. `spread` 0 = plain map, 1 = pure rank order.
 */
function projector(pts: { lat: number; lng: number }[], w: number, h: number, pad: number, spread: number): Projector {
  const lats = pts.map((p) => p.lat);
  const lngs = pts.map((p) => p.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const k = Math.cos(((minLat + maxLat) / 2) * (Math.PI / 180));
  const spanX = (maxLng - minLng) * k || 1e-6;
  const spanY = maxLat - minLat || 1e-6;
  const sortedX = [...lngs].sort((a, b) => a - b);
  const sortedY = [...lats].sort((a, b) => a - b);
  // Fraction of stations at or below v (0..1), linearly interpolated.
  const rank = (sorted: number[], v: number) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    return sorted.length <= 1 ? 0.5 : lo / (sorted.length - 1);
  };
  const innerW = w - 2 * pad;
  const innerH = h - 2 * pad;
  // Keep the map's aspect for the linear part so the city is not stretched.
  const s = Math.min(innerW / spanX, innerH / spanY);
  const ox = (w - spanX * s) / 2;
  const oy = (h - spanY * s) / 2;
  return (lat, lng) => {
    const lx = ox + (lng - minLng) * k * s;
    const ly = oy + (maxLat - lat) * s;
    const rx = pad + rank(sortedX, lng) * innerW;
    const ry = pad + (1 - rank(sortedY, lat)) * innerH;
    return [lx * (1 - spread) + rx * spread, ly * (1 - spread) + ry * spread];
  };
}

export function buildSheet(gauges: BmaGauge[], hii: HiiInput[], opts: { w?: number; h?: number; pad?: number; spread?: number } = {}): Sheet {
  const w = opts.w ?? 1000;
  const h = opts.h ?? 640;
  const pad = opts.pad ?? 28;
  const spread = opts.spread ?? 0.55;
  const usable = gauges.filter((g) => Number.isFinite(g.lat) && Number.isFinite(g.lng));
  // The sheet is the BMA network's frame (plus the river through it);
  // outlying HII stations elsewhere in the region fall off the sheet.
  const frame = [...usable, ...hii.filter((s) => s.onRiver)];
  if (frame.length === 0) return { w, h, canals: [], loose: [], river: { points: [], stations: [] }, hii: [] };
  const proj = projector(frame, w, h, pad, spread);
  const onSheet = (p: { x: number; y: number }) => p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h;

  const toStation = (g: BmaGauge): SheetStation => {
    const canal = canalOf(g.name);
    const [x, y] = proj(g.lat, g.lng);
    const gap = g.kind === "gate" && g.level !== null && g.levelOut !== null ? g.levelOut - g.level : null;
    return {
      code: g.code,
      name: g.name,
      label: labelOf(g.name, canal),
      canal,
      x,
      y,
      lat: g.lat,
      lng: g.lng,
      status: g.status,
      kind: g.kind,
      level: g.level,
      levelOut: g.levelOut,
      warning: g.warning,
      critical: g.critical,
      bank: g.bank,
      ageMin: g.ageMin,
      over: overOf(g),
      pressure: gap !== null && gap >= 1,
    };
  };

  const byCanal = new Map<string, SheetStation[]>();
  for (const g of usable) {
    const s = toStation(g);
    const list = byCanal.get(s.canal);
    if (list) list.push(s);
    else byCanal.set(s.canal, [s]);
  }

  const canals: SheetCanal[] = [];
  const loose: SheetStation[] = [];
  for (const [name, stations] of byCanal) {
    if (stations.length < MIN_LINE) {
      loose.push(...stations);
      continue;
    }
    const xs = stations.map((s) => s.x);
    const ys = stations.map((s) => s.y);
    const spreadX = Math.max(...xs) - Math.min(...xs);
    const spreadY = Math.max(...ys) - Math.min(...ys);
    const orient: "h" | "v" = spreadX >= spreadY ? "h" : "v";
    const mean = (a: number[]) => a.reduce((p, c) => p + c, 0) / a.length;
    const ext = 14;
    if (orient === "h") {
      const y = mean(ys);
      const snapped = stations.map((s) => ({ ...s, y })).sort((a, b) => a.x - b.x);
      canals.push({ name, orient, x1: Math.min(...xs) - ext, y1: y, x2: Math.max(...xs) + ext, y2: y, stations: snapped });
    } else {
      const x = mean(xs);
      const snapped = stations.map((s) => ({ ...s, x })).sort((a, b) => a.y - b.y);
      canals.push({ name, orient, x1: x, y1: Math.min(...ys) - ext, x2: x, y2: Math.max(...ys) + ext, stations: snapped });
    }
  }
  // Longest lines first so short ones draw on top and stay legible.
  canals.sort((a, b) => Math.hypot(b.x2 - b.x1, b.y2 - b.y1) - Math.hypot(a.x2 - a.x1, a.y2 - a.y1));

  const toRiver = (s: HiiInput): RiverStation => {
    const [x, y] = proj(s.lat, s.lng);
    return { id: s.id, name: s.name, x, y, lat: s.lat, lng: s.lng, pct: s.pct, stale: s.stale };
  };
  const riverStations = hii.filter((s) => s.onRiver).map(toRiver).sort((a, b) => a.y - b.y);
  const others = hii.filter((s) => !s.onRiver).map(toRiver).filter(onSheet);

  return {
    w,
    h,
    canals,
    loose,
    river: { points: riverStations.map((s) => [s.x, s.y]), stations: riverStations },
    hii: others,
  };
}
