// Domain types and copy for the Flashflood Risk Intelligence map.
// Risk zones are no longer hard-coded — they are loaded from
// /data/village_risk.geojson (663 subdistricts in 9 northern provinces).

export type SourceNote = {
  label: string;
  href: string;
  note: string;
};

export const productCopy = {
  generatedAt: "9 พ.ค. 2026",
  title: "Flashflood Risk Intelligence",
  subtitle:
    "แผนที่คัดกรองตำบลเสี่ยงน้ำป่าใน 9 จังหวัดภาคเหนือ จาก hazard surface ที่คำนวณบน Google Earth Engine ทับด้วย rainfall trigger จาก radar API",
  disclaimer:
    "MVP — decision-support map ไม่ใช่ประกาศภัยทางการ คะแนน per-ตำบลคำนวณจาก zonal stats ของ susceptibility raster (GEE export 100m, EPSG:4326)",
  region: "ภาคเหนือ 9 จังหวัด",
  unitName: "ตำบล",
  unitCount: 663,
};

export type RiskTier = "severe" | "high" | "watch" | "low";

export const riskMeta: Record<
  RiskTier,
  { label: string; color: string; minNorm: number; tone: string }
> = {
  severe: {
    label: "Severe",
    color: "#d73027",
    minNorm: 0.75,
    tone: "ตำบลที่อยู่ใน p90 บนสุดของ AOI — เฝ้าระวังเป็นลำดับแรก",
  },
  high: {
    label: "High",
    color: "#fdae61",
    minNorm: 0.5,
    tone: "ความเสี่ยงสูงกว่าค่ากลาง — ติดตามเมื่อฝนสะสมเข้าพื้นที่",
  },
  watch: {
    label: "Watch",
    color: "#fee08b",
    minNorm: 0.25,
    tone: "ความเสี่ยงปานกลาง — เฝ้าระวังตามฤดูกาล",
  },
  low: {
    label: "Low",
    color: "#1a9850",
    minNorm: 0,
    tone: "ความเสี่ยงต่ำในชั้นข้อมูลปัจจุบัน",
  },
};

export function tierFromNorm(norm: number): RiskTier {
  if (norm >= riskMeta.severe.minNorm) return "severe";
  if (norm >= riskMeta.high.minNorm) return "high";
  if (norm >= riskMeta.watch.minNorm) return "watch";
  return "low";
}

export const sourceNotes: SourceNote[] = [
  {
    label: "Google Earth Engine — flashflood_north_2026",
    href: "https://earthengine.google.com/",
    note: "Hazard composite จาก SRTM slope, MERIT TWI, MODIS EVI, MCD64A1 burned area, ESA WorldCover built-up และ CHIRPS 60-day rain accumulation. Export 100 m COG.",
  },
  {
    label: "GADM 4.1 — ขอบเขตตำบล",
    href: "https://gadm.org/",
    note: "ใช้ admin level 3 (ตำบล/แขวง) ของไทย กรอง 9 จังหวัดภาคเหนือ เป็น polygon สำหรับ zonal stats per ตำบล",
  },
  {
    label: "RainViewer Weather Maps API",
    href: "https://www.rainviewer.com/api/weather-maps-api.html",
    note: "Radar nowcast ใช้เป็น dynamic trigger overlay ทับ static susceptibility ไม่ใช้ key สำหรับ MVP",
  },
  {
    label: "OpenStreetMap",
    href: "https://www.openstreetmap.org/copyright",
    note: "Basemap พร้อม attribution",
  },
];

export const methodSteps = [
  "Hazard surface คำนวณบน GEE: slope + TWI + drainage proximity + EVI + DEM-low + burned + built + 60-day rain",
  "Export 100 m COG (EPSG:4326) ครอบคลุม 9 จังหวัดภาคเหนือ",
  "Zonal stats per ตำบล: mean / max / p75 / p90 / p95 ของ RISK band",
  "Rescale risk เป็น 0..1 ตาม percentile ใน AOI (raster max ~0.59 ไม่ใช่ 1.0)",
  "จัดอันดับ ตำบล ตาม p90 risk; แบ่งระดับ Severe / High / Watch / Low ตาม normalized score",
  "Rainfall trigger จาก RainViewer ทับเป็น dynamic layer ฝั่งหน้าเว็บ",
];
