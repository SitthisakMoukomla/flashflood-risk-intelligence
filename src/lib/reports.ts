// Staff-reported flood points for the Krathum Lom dashboard.
//
// The satellite cannot see into the built-up half of the municipality, so
// what staff have seen on the ground is the only record of flooding there.
// These are kept strictly apart from measured data: they carry who reported
// them and when, and the map draws them with their own symbol.
//
// Storage: one JSON document in a private Vercel Blob store, read and
// written only by /api/krathumlom/reports (a shared staff code gates every
// call). Writes use the blob's ETag so two officers saving at the same
// moment cannot overwrite each other.

export const REPORT_KINDS = {
  ponding: { label: "น้ำท่วมขัง", color: "#5cc4ee" },
  canal: { label: "คลอง/น้ำล้น", color: "#3b82f6" },
  drain: { label: "ท่อ/ทางระบายอุดตัน", color: "#a78bfa" },
  pump: { label: "สถานีสูบ/ประตูน้ำ", color: "#40e0bd" },
  other: { label: "อื่น ๆ", color: "#9aa6a6" },
} as const;
export type ReportKind = keyof typeof REPORT_KINDS;

export type ReportStatus = "open" | "resolved";

export type Report = {
  id: string;
  lat: number;
  lng: number;
  kind: ReportKind;
  title: string;
  note: string;
  /** Water depth staff observed, cm — optional, as reported. */
  depth_cm: number | null;
  /** When it was observed (ISO); may be earlier than created_at. */
  observed_at: string;
  reported_by: string;
  status: ReportStatus;
  /** Photo id under /api/krathumlom/photos?id=…, if one was attached. */
  photo: string | null;
  created_at: string;
  updated_at: string;
};

/** Fields a client may send; everything else is set by the server. */
export type ReportInput = Pick<Report, "lat" | "lng" | "kind" | "title" | "note" | "depth_cm" | "observed_at" | "reported_by" | "photo">;

// Bounds a report must fall in: the municipality plus a generous margin,
// so a mis-tap on the far side of the province is refused rather than stored.
const BOUNDS = { south: 13.60, west: 100.18, north: 13.88, east: 100.45 };

export function validateReportInput(raw: unknown): { ok: true; value: ReportInput } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "ต้องส่งข้อมูลเป็น JSON object" };
  const r = raw as Record<string, unknown>;
  const lat = Number(r.lat);
  const lng = Number(r.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { ok: false, error: "พิกัดไม่ถูกต้อง" };
  if (lat < BOUNDS.south || lat > BOUNDS.north || lng < BOUNDS.west || lng > BOUNDS.east)
    return { ok: false, error: "จุดอยู่นอกพื้นที่เทศบาลและบริเวณโดยรอบ" };
  const kind = String(r.kind ?? "");
  if (!(kind in REPORT_KINDS)) return { ok: false, error: "ประเภทไม่ถูกต้อง" };
  const title = String(r.title ?? "").trim();
  if (title.length < 2 || title.length > 120) return { ok: false, error: "ต้องระบุชื่อจุด (2–120 ตัวอักษร)" };
  const note = String(r.note ?? "").trim().slice(0, 1000);
  const reported_by = String(r.reported_by ?? "").trim().slice(0, 80);
  if (!reported_by) return { ok: false, error: "ต้องระบุชื่อผู้รายงาน" };
  let depth_cm: number | null = null;
  if (r.depth_cm !== null && r.depth_cm !== undefined && r.depth_cm !== "") {
    const d = Number(r.depth_cm);
    if (!Number.isFinite(d) || d < 0 || d > 500) return { ok: false, error: "ระดับน้ำต้องเป็นตัวเลข 0–500 ซม." };
    depth_cm = Math.round(d);
  }
  const observed = new Date(String(r.observed_at ?? ""));
  if (Number.isNaN(observed.getTime())) return { ok: false, error: "วันเวลาที่พบไม่ถูกต้อง" };
  if (observed.getTime() > Date.now() + 60 * 60_000) return { ok: false, error: "วันเวลาที่พบอยู่ในอนาคต" };
  const photo = r.photo === null || r.photo === undefined || r.photo === "" ? null : String(r.photo);
  if (photo !== null && !/^[a-z0-9-]{8,64}$/.test(photo)) return { ok: false, error: "รหัสรูปไม่ถูกต้อง" };
  return {
    ok: true,
    value: {
      lat: Math.round(lat * 1e6) / 1e6,
      lng: Math.round(lng * 1e6) / 1e6,
      kind: kind as ReportKind,
      title,
      note,
      depth_cm,
      observed_at: observed.toISOString(),
      reported_by,
      photo,
    },
  };
}
