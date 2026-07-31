// Shared model for the Mae Sai (Sai river) early-warning chain.
// Used by the map's station markers and by the dedicated /maesai page.

/** Gauges on the Sai river, ordered upstream → downstream.
 *  HII oldcodes; three of the four sit on the Myanmar bank
 *  (province_code 10499) so they must be exempted from the
 *  nine-northern-provinces filter. */
export const MAESAI_CHAIN: {
  code: string;
  role: string;
  note: string;
  /** Approximate along-river distance from the bridge, negative = upstream. */
  km: number;
}[] = [
  { code: "MYA001", role: "ต้นน้ำสุด", note: "~21 กม. เหนือสะพาน", km: -21 },
  { code: "MYA002", role: "ต้นน้ำ", note: "~2.5 กม. เหนือสะพาน", km: -2.5 },
  { code: "MYA004", role: "สะพานมิตรภาพ", note: "จุดเฝ้าระวังหลัก", km: 0 },
  { code: "MYA003", role: "ปลายน้ำ", note: "~8.5 กม. ใต้สะพาน", km: 8.5 },
];

export const MAESAI_CODES = new Set(MAESAI_CHAIN.map((c) => c.code));

/** ระดับน้ำเทียบตลิ่ง (storage_percent) — ≥100% = above the lowest bank. */
export function bankPercentColor(sp: number): string {
  if (sp >= 100) return "#d73027";
  if (sp >= 80) return "#f97316";
  if (sp >= 60) return "#fdae61";
  if (sp >= 30) return "#5cc4ee";
  return "#3f7f5f";
}

export function bankPercentLabel(sp: number): string {
  if (sp >= 100) return "ล้นตลิ่ง";
  if (sp >= 80) return "ใกล้ล้นตลิ่ง";
  if (sp >= 60) return "ค่อนข้างสูง";
  if (sp >= 30) return "ปกติ";
  return "น้ำน้อย";
}

/** One row of public/data/maesai_log.jsonl, written by 12_maesai_log.py. */
export type MaeSaiLogReading = {
  code: string;
  name: string | null;
  dt: string | null;
  msl: number | null;
  prev: number | null;
  sp: number | null;
  lat?: number;
  lon?: number;
};

export type MaeSaiLogEntry = { t: string; readings: MaeSaiLogReading[] };

/** Parse the append-only JSONL log; tolerates a trailing newline and
 *  skips any malformed line rather than throwing away the whole file. */
export function parseMaeSaiLog(text: string): MaeSaiLogEntry[] {
  const out: MaeSaiLogEntry[] = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const e = JSON.parse(s) as MaeSaiLogEntry;
      if (e && Array.isArray(e.readings)) out.push(e);
    } catch {
      /* skip bad line */
    }
  }
  return out;
}
