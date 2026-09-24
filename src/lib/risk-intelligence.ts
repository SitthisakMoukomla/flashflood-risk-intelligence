// Domain types and copy for the Flashflood Risk Intelligence map.
// Risk is read from the nationwide model grid (public/data/wetness_grid.json)
// and drawn as an H3 hex surface; any point in Thailand can be inspected.

export type SourceNote = {
  label: string;
  href: string;
  note: string;
};

export const productCopy = {
  generatedAt: "9 พ.ค. 2026",
  title: "Flashflood Risk Intelligence",
  subtitle:
    "แผนที่ความเสี่ยงน้ำป่าทั่วประเทศไทย จากภูมิประเทศ × ดินอิ่มน้ำ × ฝนตอนนี้ แตะจุดใดก็ได้เพื่อดูระดับความเสี่ยงและข้อมูลวัดจริงใกล้จุดนั้น",
  disclaimer:
    "แผนที่บอกระดับความเสี่ยงเชิงข้อมูล ไม่ใช่ประกาศภัยทางการ และไม่ใช่คำสั่งให้ดำเนินการใด ๆ การตัดสินใจเชิงปฏิบัติเป็นของหน่วยงานท้องถิ่น",
  region: "ทั่วประเทศ",
};

export type RiskTier = "severe" | "high" | "watch" | "low";

// Thresholds on the live 0..1 value — the same cut points the hex
// surface is coloured with (LIVE_BANDS in FloodMap), so a tier label and
// the hex colour under it always agree.
export const riskMeta: Record<
  RiskTier,
  { label: string; color: string; minNorm: number; tone: string }
> = {
  severe: {
    label: "เสี่ยงสูงสุด",
    color: "#d73027",
    minNorm: 0.55,
    tone: "ระดับบนสุดของแผนที่ — บอกระดับความเสี่ยง ไม่ใช่ประกาศภัย",
  },
  high: {
    label: "เสี่ยงสูง",
    color: "#fdae61",
    minNorm: 0.4,
    tone: "ความเสี่ยงสูงกว่าค่ากลางของพื้นที่",
  },
  watch: {
    label: "เสี่ยงปานกลาง",
    color: "#fee08b",
    minNorm: 0.2,
    tone: "ความเสี่ยงปานกลางตามฤดูกาล",
  },
  low: {
    label: "เสี่ยงต่ำ",
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
    label: "HydroSHEDS + Copernicus DEM — ภูมิประเทศ",
    href: "https://www.hydrosheds.org/",
    note: "TWI, ระยะถึงลำน้ำ, ความสูง จาก HydroSHEDS 15″ และความชันจาก Copernicus DEM 90 ม. คำนวณทั้งประเทศ",
  },
  {
    label: "CHIRPS + Open-Meteo — ฝน",
    href: "https://www.chc.ucsb.edu/data/chirps",
    note: "ฝนสะสม 7 วันจาก CHIRPS และฝนรายชั่วโมงจาก Open-Meteo บน grid 0.15° ทั่วประเทศ",
  },
  {
    label: "สสน. ThaiWater — สถานีวัดฝนและระดับน้ำ",
    href: "https://www.thaiwater.net/",
    note: "ค่าวัดจริงจากสถานีโทรมาตร เรียกสดจากเบราว์เซอร์",
  },
  {
    label: "Copernicus GFM — น้ำท่วมจาก Sentinel-1",
    href: "https://global-flood.emergency.copernicus.eu/",
    note: "พื้นที่น้ำท่วมตรวจพบจากเรดาร์ดาวเทียม รวม 7 วัน ตัดแหล่งน้ำถาวรออกด้วย JRC Global Surface Water",
  },
  {
    label: "Google Open Buildings v3",
    href: "https://sites.research.google/open-buildings/",
    note: "รอยอาคาร confidence ≥ 0.7 ทั่วประเทศ (CC BY 4.0)",
  },
  {
    label: "RainViewer Weather Maps API",
    href: "https://www.rainviewer.com/api/weather-maps-api.html",
    note: "เรดาร์ฝนเคลื่อนไหว",
  },
  {
    label: "OpenStreetMap + Nominatim",
    href: "https://www.openstreetmap.org/copyright",
    note: "แผนที่พื้นฐาน ค้นหาสถานที่ และชื่อพื้นที่ของจุดที่แตะ",
  },
];

export const methodSteps = [
  "ความเสี่ยงจากภูมิประเทศ คำนวณทั้งประเทศจาก TWI, ความชัน, ระยะถึงลำน้ำ, ความสูง และพื้นที่สิ่งปลูกสร้าง",
  "ดินอิ่มน้ำ = ฝนสะสม 7 วัน, ฝนตอนนี้ = ฝนรายชั่วโมง — ทั้งคู่บน grid 0.15° ทั่วประเทศ",
  "ระดับตอนนี้ = ภูมิประเทศที่ถูกขยายด้วยดินอิ่มน้ำ บวกแรงกระตุ้นจากฝนตอนนี้ แล้วแบ่งเป็น 4 ระดับ",
  "แสดงเป็น hex H3 ขนาด ~7 กม. จุดที่แตะจะอ่านระดับจาก hex ที่ครอบจุดนั้น (เส้นประบนแผนที่)",
  "ข้อมูลวัดจริงใกล้จุด: สถานีระดับน้ำ ≤ 30 กม., สถานีฝน ≤ 20 กม., น้ำท่วมดาวเทียมรัศมี 5 กม., บ้านเรือนรัศมี 1 กม.",
  "จุดเฝ้าระวัง = กลุ่ม hex ระดับเสี่ยงสูงขึ้นไปที่อยู่ห่างกันไม่เกิน 25 กม. รวมเป็น 1 จุด",
];
