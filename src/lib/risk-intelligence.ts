export type RiskClass = "severe" | "high" | "watch" | "low";

export type EvidenceMetric = {
  label: string;
  value: string;
  score: number;
  description: string;
};

export type RiskZone = {
  id: string;
  name: string;
  province: string;
  region: string;
  center: [number, number];
  riskClass: RiskClass;
  totalScore: number;
  terrain: EvidenceMetric & {
    maxSlopeDeg: number;
    downslopeBearingDeg: number;
    slopeLengthKm: number;
    slopeWidthKm: number;
    elevationRangeM: string;
    drainage: string;
  };
  burn: EvidenceMetric & {
    lastFireWindow: string;
    hotspotDensity: string;
  };
  exposure: EvidenceMetric & {
    buildingCount: number;
    settlementPattern: string;
  };
  rain: EvidenceMetric & {
    provider: string;
    window: string;
  };
  operatingNote: string;
  dataFreshness: string;
  tags: string[];
};

export type SourceNote = {
  label: string;
  href: string;
  note: string;
};

export const productCopy = {
  generatedAt: "9 พ.ค. 2026",
  title: "Flashflood Risk Intelligence",
  subtitle:
    "แผนที่คัดกรองพื้นที่น้ำป่าไหลหลากจากความลาดชัน พื้นที่เผาไหม้ และบ้านเรือนที่อยู่ในทางน้ำ",
  disclaimer:
    "MVP นี้เป็น decision-support map ไม่ใช่ประกาศภัยทางการ คะแนนในชั้น prototype ใช้ schema ที่พร้อมแทนด้วย pipeline GIS จริง",
};

export const riskMeta: Record<
  RiskClass,
  { label: string; color: string; minScore: number; tone: string }
> = {
  severe: {
    label: "Severe",
    color: "#ef476f",
    minScore: 82,
    tone: "ลาดชัน + ไฟป่าล่าสุด + บ้านเรือนปลายน้ำ",
  },
  high: {
    label: "High",
    color: "#ff9f1c",
    minScore: 68,
    tone: "hazard สูงและมี exposure ชัดเจน",
  },
  watch: {
    label: "Watch",
    color: "#ffd166",
    minScore: 48,
    tone: "ต้องติดตามเมื่อมีฝนสะสม",
  },
  low: {
    label: "Low",
    color: "#2ec4b6",
    minScore: 0,
    tone: "ยังไม่เข้าเงื่อนไขเร่งด่วน",
  },
};

export const sourceNotes: SourceNote[] = [
  {
    label: "NASA SRTM / Copernicus DEM",
    href: "https://www.earthdata.nasa.gov/data/instruments/srtm",
    note: "ใช้เป็น candidate สำหรับคำนวณ elevation, slope, drainage และ terrain hazard score",
  },
  {
    label: "NASA FIRMS / VIIRS Active Fire",
    href: "https://firms.modaps.eosdis.nasa.gov/",
    note: "ใช้เป็น candidate สำหรับ recent fire/hotspot proxy ก่อนต่อยอดเป็น burn scar จาก Sentinel หรือ MODIS burned area",
  },
  {
    label: "Google Open Buildings",
    href: "https://sites.research.google/gr/open-buildings/",
    note: "ใช้ aggregate จำนวนอาคารหรือ settlement density ใน susceptibility area ไม่ render building polygon ทุกหลังใน MVP",
  },
  {
    label: "RainViewer Weather Maps API",
    href: "https://www.rainviewer.com/api/weather-maps-api.html",
    note: "ใช้ radar tile เป็น rain context layer แบบไม่มี secret key เหมาะกับ MVP/demo และต้องตรวจ license ก่อนใช้เชิง operation",
  },
  {
    label: "OpenStreetMap",
    href: "https://www.openstreetmap.org/copyright",
    note: "ใช้เป็น basemap สำหรับ MVP พร้อม attribution บนแผนที่",
  },
];

export const methodSteps = [
  "Precompute susceptibility surface จาก slope, downslope bearing, drainage และ catchment",
  "ให้ terrain score จาก slope/elevation/drainage ก่อน ไม่เริ่มจาก polygon",
  "บวก burned-area modifier จาก hotspot/burn scar บริเวณ upslope ภายใน 30/90/180 วัน",
  "aggregate building footprint เป็น exposure score บริเวณ downslope/outlet",
  "ซ้อน rainfall trigger จาก radar/nowcast เพื่อเพิ่ม intensity แต่ยังไม่ส่ง alert ใน MVP 1",
];

export const riskZones: RiskZone[] = [
  {
    id: "msn-pai-pangmapha",
    name: "ปาย - ปางมะผ้า",
    province: "แม่ฮ่องสอน",
    region: "ภาคเหนือ",
    center: [19.41, 98.37],
    riskClass: "severe",
    totalScore: 88,
    terrain: {
      label: "Terrain",
      value: "38/40",
      score: 38,
      description: "หุบเขาแคบ ลำห้วยสั้น และทางน้ำลงเร็ว",
      maxSlopeDeg: 37,
      downslopeBearingDeg: 150,
      slopeLengthKm: 42,
      slopeWidthKm: 14,
      elevationRangeM: "520-1,640 m",
      drainage: "ลำน้ำย่อยหนาแน่นตามแนวหุบเขา",
    },
    burn: {
      label: "Burn",
      value: "22/25",
      score: 22,
      description: "พบ hotspot หนาแน่นในฤดูไฟล่าสุดบนพื้นที่ลาดชัน",
      lastFireWindow: "ภายใน 90 วัน",
      hotspotDensity: "สูง",
    },
    exposure: {
      label: "Exposure",
      value: "20/25",
      score: 20,
      description: "ชุมชนและที่พักกระจุกตัวตามลำน้ำและถนนในหุบเขา",
      buildingCount: 1320,
      settlementPattern: "linear valley settlement",
    },
    rain: {
      label: "Rain",
      value: "8/10",
      score: 8,
      description: "ใช้ radar/forecast เป็น trigger context เมื่อฝนเข้าด้านตะวันตก",
      provider: "RainViewer radar context",
      window: "nowcast layer",
    },
    operatingNote:
      "เหมาะสำหรับ watchlist เชิง operation เมื่อฝนหนักต่อเนื่อง 1-3 ชั่วโมงบนต้นน้ำและพื้นที่ burn scar",
    dataFreshness: "Prototype geometry; replace with DEM/FIRMS/Open Buildings pipeline",
    tags: ["ลาดชันสูง", "ไฟป่าล่าสุด", "ชุมชนหุบเขา"],
  },
  {
    id: "tak-maesot-phopphra",
    name: "แม่สอด - พบพระ",
    province: "ตาก",
    region: "ตะวันตก",
    center: [16.55, 98.73],
    riskClass: "high",
    totalScore: 79,
    terrain: {
      label: "Terrain",
      value: "34/40",
      score: 34,
      description: "แนวเขาชายแดน มีลำห้วยสั้นตัดผ่านถนนและชุมชน",
      maxSlopeDeg: 33,
      downslopeBearingDeg: 105,
      slopeLengthKm: 48,
      slopeWidthKm: 18,
      elevationRangeM: "260-1,480 m",
      drainage: "ลำห้วยลงสู่พื้นที่ราบแม่สอด",
    },
    burn: {
      label: "Burn",
      value: "20/25",
      score: 20,
      description: "hotspot ฤดูแล้งกระจายในพื้นที่ป่าและไร่บนลาดเขา",
      lastFireWindow: "ภายใน 180 วัน",
      hotspotDensity: "กลาง-สูง",
    },
    exposure: {
      label: "Exposure",
      value: "18/25",
      score: 18,
      description: "บ้านเรือนและโครงข่ายถนนอยู่บริเวณ outlet ของลำห้วย",
      buildingCount: 2140,
      settlementPattern: "roadside + valley outlet",
    },
    rain: {
      label: "Rain",
      value: "7/10",
      score: 7,
      description: "ฝนด้านตะวันตกสามารถยกตัวตามแนวเขาและไหลลงเร็ว",
      provider: "RainViewer radar context",
      window: "nowcast layer",
    },
    operatingNote:
      "ควรติดตามฝนบนเขาเหนือชุมชน ไม่ใช่เฉพาะฝนที่ตกในตัวเมืองแม่สอด",
    dataFreshness: "Prototype geometry; replace with DEM/FIRMS/Open Buildings pipeline",
    tags: ["ชายแดน", "ทางน้ำตัดถนน", "burn modifier"],
  },
  {
    id: "kan-saiyok-thongphaphum",
    name: "ไทรโยค - ทองผาภูมิ",
    province: "กาญจนบุรี",
    region: "ตะวันตก",
    center: [14.62, 98.66],
    riskClass: "high",
    totalScore: 76,
    terrain: {
      label: "Terrain",
      value: "35/40",
      score: 35,
      description: "ภูเขาตะวันตกและลำน้ำสาขาไหลลงสู่แควน้อย",
      maxSlopeDeg: 35,
      downslopeBearingDeg: 125,
      slopeLengthKm: 56,
      slopeWidthKm: 20,
      elevationRangeM: "120-1,530 m",
      drainage: "ลำห้วยสั้นเชื่อมรีสอร์ต/พื้นที่ท่องเที่ยวริมน้ำ",
    },
    burn: {
      label: "Burn",
      value: "17/25",
      score: 17,
      description: "พื้นที่เผาไหม้และ hotspot กระจายตามป่าเบญจพรรณ",
      lastFireWindow: "ภายใน 180 วัน",
      hotspotDensity: "กลาง",
    },
    exposure: {
      label: "Exposure",
      value: "17/25",
      score: 17,
      description: "exposure สูงบริเวณแหล่งท่องเที่ยวและที่พักริมน้ำ",
      buildingCount: 1580,
      settlementPattern: "river recreation corridor",
    },
    rain: {
      label: "Rain",
      value: "7/10",
      score: 7,
      description: "ฝนสะสมต้นน้ำเพิ่มความเสี่ยงน้ำหลากบริเวณแหล่งท่องเที่ยว",
      provider: "RainViewer radar context",
      window: "nowcast layer",
    },
    operatingNote:
      "เน้น decision support สำหรับปิดน้ำตก/ล่องแพชั่วคราวเมื่อฝนบนต้นน้ำรุนแรง",
    dataFreshness: "Prototype geometry; replace with DEM/FIRMS/Open Buildings pipeline",
    tags: ["พื้นที่ท่องเที่ยว", "ลำห้วยสั้น", "ต้นน้ำ"],
  },
  {
    id: "chiangmai-maechaem",
    name: "แม่แจ่ม - อมก๋อย",
    province: "เชียงใหม่",
    region: "ภาคเหนือ",
    center: [18.15, 98.28],
    riskClass: "severe",
    totalScore: 86,
    terrain: {
      label: "Terrain",
      value: "39/40",
      score: 39,
      description: "ภูเขาสูง ลาดชันมาก และ catchment ขนาดเล็กจำนวนมาก",
      maxSlopeDeg: 42,
      downslopeBearingDeg: 140,
      slopeLengthKm: 60,
      slopeWidthKm: 18,
      elevationRangeM: "410-2,200 m",
      drainage: "headwater catchments",
    },
    burn: {
      label: "Burn",
      value: "23/25",
      score: 23,
      description: "ฤดูไฟล่าสุดมี hotspot หนาแน่นบนพื้นที่เกษตรและป่า",
      lastFireWindow: "ภายใน 90 วัน",
      hotspotDensity: "สูงมาก",
    },
    exposure: {
      label: "Exposure",
      value: "16/25",
      score: 16,
      description: "หมู่บ้านกระจายตัวตามร่องเขาและถนนเลียบลำห้วย",
      buildingCount: 980,
      settlementPattern: "upland villages",
    },
    rain: {
      label: "Rain",
      value: "8/10",
      score: 8,
      description: "ฝนต้นฤดูบน burn scar เพิ่ม runoff และ sediment flow",
      provider: "RainViewer radar context",
      window: "nowcast layer",
    },
    operatingNote:
      "พื้นที่นี้เหมาะโชว์ความต่างของระบบ เพราะ burn scar + slope คือสัญญาณที่ dashboard น้ำทั่วไปมองไม่เห็น",
    dataFreshness: "Prototype geometry; replace with DEM/FIRMS/Open Buildings pipeline",
    tags: ["slope extreme", "burn scar", "headwater"],
  },
  {
    id: "nan-bo-kluea-pua",
    name: "บ่อเกลือ - ปัว",
    province: "น่าน",
    region: "ภาคเหนือ",
    center: [19.18, 101.08],
    riskClass: "high",
    totalScore: 78,
    terrain: {
      label: "Terrain",
      value: "37/40",
      score: 37,
      description: "ลุ่มน้ำภูเขา ลาดชันสูง และถนนตัดเขาหลายช่วง",
      maxSlopeDeg: 39,
      downslopeBearingDeg: 135,
      slopeLengthKm: 48,
      slopeWidthKm: 16,
      elevationRangeM: "320-1,940 m",
      drainage: "ร่องน้ำลงสู่ชุมชนตามหุบเขา",
    },
    burn: {
      label: "Burn",
      value: "18/25",
      score: 18,
      description: "พบ hotspot บนพื้นที่ลาดชันช่วงฤดูแล้ง",
      lastFireWindow: "ภายใน 180 วัน",
      hotspotDensity: "กลาง-สูง",
    },
    exposure: {
      label: "Exposure",
      value: "16/25",
      score: 16,
      description: "บ้านเรือนและที่พักกระจุกใน valley floor",
      buildingCount: 1120,
      settlementPattern: "valley floor settlement",
    },
    rain: {
      label: "Rain",
      value: "7/10",
      score: 7,
      description: "ฝนภูเขาเฉพาะแห่งอาจทำให้ลำห้วยเพิ่มเร็ว",
      provider: "RainViewer radar context",
      window: "nowcast layer",
    },
    operatingNote:
      "ควรใช้คู่กับข้อมูลฝนระยะสั้น เพราะฝนเฉพาะเขาลูกเดียวอาจกระทบชุมชนปลายน้ำ",
    dataFreshness: "Prototype geometry; replace with DEM/FIRMS/Open Buildings pipeline",
    tags: ["หุบเขา", "ถนนตัดเขา", "ฝนเฉพาะแห่ง"],
  },
  {
    id: "loei-phuruea-dansai",
    name: "ภูเรือ - ด่านซ้าย",
    province: "เลย",
    region: "ภาคตะวันออกเฉียงเหนือ",
    center: [17.32, 101.24],
    riskClass: "watch",
    totalScore: 64,
    terrain: {
      label: "Terrain",
      value: "29/40",
      score: 29,
      description: "พื้นที่ภูเขาและร่องน้ำบนที่สูง มีชุมชนตามทางน้ำ",
      maxSlopeDeg: 29,
      downslopeBearingDeg: 155,
      slopeLengthKm: 40,
      slopeWidthKm: 18,
      elevationRangeM: "330-1,280 m",
      drainage: "ลำน้ำสาขาลงสู่พื้นที่เกษตร",
    },
    burn: {
      label: "Burn",
      value: "14/25",
      score: 14,
      description: "hotspot กระจายบางส่วนในฤดูแล้ง",
      lastFireWindow: "ภายใน 180 วัน",
      hotspotDensity: "กลาง",
    },
    exposure: {
      label: "Exposure",
      value: "14/25",
      score: 14,
      description: "หมู่บ้านและสวนอยู่ใกล้ร่องน้ำย่อย",
      buildingCount: 760,
      settlementPattern: "upland agriculture villages",
    },
    rain: {
      label: "Rain",
      value: "7/10",
      score: 7,
      description: "ใช้เป็น watch เมื่อฝนสะสมเข้าภูเขาตอนบน",
      provider: "RainViewer radar context",
      window: "nowcast layer",
    },
    operatingNote:
      "ยังไม่ใช่ severe zone แต่เหมาะเป็นพื้นที่เฝ้าระวังเมื่อ radar มีฝนค้างบนภูเขา",
    dataFreshness: "Prototype geometry; replace with DEM/FIRMS/Open Buildings pipeline",
    tags: ["watch", "เกษตรที่สูง", "ฝนค้างภูเขา"],
  },
  {
    id: "nakhon-lansaka-phromkhiri",
    name: "ลานสกา - พรหมคีรี",
    province: "นครศรีธรรมราช",
    region: "ภาคใต้",
    center: [8.37, 99.76],
    riskClass: "high",
    totalScore: 81,
    terrain: {
      label: "Terrain",
      value: "36/40",
      score: 36,
      description: "เชิงเขาหลวง ลำคลองต้นน้ำลงชุมชนเร็ว",
      maxSlopeDeg: 36,
      downslopeBearingDeg: 95,
      slopeLengthKm: 38,
      slopeWidthKm: 13,
      elevationRangeM: "40-1,780 m",
      drainage: "คลองต้นน้ำจากเขาหลวง",
    },
    burn: {
      label: "Burn",
      value: "8/25",
      score: 8,
      description: "burn modifier ต่ำกว่าเหนือ แต่ terrain + rain เด่น",
      lastFireWindow: "ไม่เด่นใน prototype",
      hotspotDensity: "ต่ำ",
    },
    exposure: {
      label: "Exposure",
      value: "24/25",
      score: 24,
      description: "บ้านเรือนจำนวนมากอยู่ตรง outlet จากเขาสู่พื้นที่ราบ",
      buildingCount: 3860,
      settlementPattern: "foothill urban fringe",
    },
    rain: {
      label: "Rain",
      value: "10/10",
      score: 10,
      description: "ภาคใต้มี rain trigger เด่นจากฝนหนักและฝนสะสม",
      provider: "RainViewer radar context",
      window: "nowcast layer",
    },
    operatingNote:
      "ใช้เป็น priority zone เมื่อ radar เห็นกลุ่มฝนเกาะแนวเขาหลวงต่อเนื่อง",
    dataFreshness: "Prototype geometry; replace with DEM/FIRMS/Open Buildings pipeline",
    tags: ["เขาหลวง", "บ้านเรือนหนาแน่น", "rain trigger"],
  },
  {
    id: "phatthalung-khaochaison-khuankhanun",
    name: "เขาชัยสน - ควนขนุน",
    province: "พัทลุง",
    region: "ภาคใต้ตอนล่าง",
    center: [7.54, 100.09],
    riskClass: "high",
    totalScore: 77,
    terrain: {
      label: "Terrain",
      value: "33/40",
      score: 33,
      description: "รับน้ำจากเทือกเขาบรรทัดลงพื้นที่ลุ่มทะเลสาบ",
      maxSlopeDeg: 32,
      downslopeBearingDeg: 92,
      slopeLengthKm: 44,
      slopeWidthKm: 16,
      elevationRangeM: "10-1,130 m",
      drainage: "คลองสายสั้นลงที่ลุ่ม",
    },
    burn: {
      label: "Burn",
      value: "7/25",
      score: 7,
      description: "burn modifier ต่ำ แต่มี runoff จากแนวเขา",
      lastFireWindow: "ไม่เด่นใน prototype",
      hotspotDensity: "ต่ำ",
    },
    exposure: {
      label: "Exposure",
      value: "24/25",
      score: 24,
      description: "ชุมชนและพื้นที่เกษตรต่อเนื่องตามเชิงเขาและปลายน้ำ",
      buildingCount: 4210,
      settlementPattern: "foothill + lowland villages",
    },
    rain: {
      label: "Rain",
      value: "10/10",
      score: 10,
      description: "ฝนหนักบนเทือกเขาบรรทัดทำให้น้ำลงที่ลุ่มเร็ว",
      provider: "RainViewer radar context",
      window: "nowcast layer",
    },
    operatingNote:
      "เหมาะสำหรับดู exposure downstream มากกว่าดูจุดฝนในตัวอำเภออย่างเดียว",
    dataFreshness: "Prototype geometry; replace with DEM/FIRMS/Open Buildings pipeline",
    tags: ["เทือกเขาบรรทัด", "พื้นที่ลุ่ม", "exposure สูง"],
  },
  {
    id: "narathiwat-sukhirin-waeng",
    name: "สุคิริน - แว้ง",
    province: "นราธิวาส",
    region: "ภาคใต้ตอนล่าง",
    center: [5.94, 101.78],
    riskClass: "severe",
    totalScore: 87,
    terrain: {
      label: "Terrain",
      value: "36/40",
      score: 36,
      description: "เชิงเขาสันกาลาคีรีและลำน้ำสั้นลงชุมชน",
      maxSlopeDeg: 34,
      downslopeBearingDeg: 42,
      slopeLengthKm: 46,
      slopeWidthKm: 16,
      elevationRangeM: "30-1,190 m",
      drainage: "คลองภูเขาไหลลงชุมชนปลายน้ำ",
    },
    burn: {
      label: "Burn",
      value: "9/25",
      score: 9,
      description: "burn modifier ไม่ใช่ driver หลักของพื้นที่นี้",
      lastFireWindow: "ไม่เด่นใน prototype",
      hotspotDensity: "ต่ำ",
    },
    exposure: {
      label: "Exposure",
      value: "25/25",
      score: 25,
      description: "หมู่บ้านจำนวนมากอยู่ใกล้ทางน้ำและเชิงเขา",
      buildingCount: 4680,
      settlementPattern: "foothill villages",
    },
    rain: {
      label: "Rain",
      value: "10/10",
      score: 10,
      description: "ฝนภาคใต้ตอนล่างเป็น trigger หลัก จึงให้น้ำหนัก rain context สูงใน prototype",
      provider: "RainViewer radar context",
      window: "nowcast layer",
    },
    operatingNote:
      "priority สูงเมื่อกลุ่มฝนอยู่เหนือแนวเขา แม้ยังไม่มีรายงานน้ำท่วมในพื้นที่ราบ",
    dataFreshness: "Prototype geometry; replace with DEM/FIRMS/Open Buildings pipeline",
    tags: ["ภาคใต้ตอนล่าง", "บ้านเรือนเชิงเขา", "rain trigger"],
  },
  {
    id: "songkhla-sadao-nathawi",
    name: "สะเดา - นาทวี",
    province: "สงขลา",
    region: "ภาคใต้ตอนล่าง",
    center: [6.75, 100.63],
    riskClass: "high",
    totalScore: 80,
    terrain: {
      label: "Terrain",
      value: "32/40",
      score: 32,
      description: "แนวเขาชายแดนและคลองสั้นหลายสาย",
      maxSlopeDeg: 31,
      downslopeBearingDeg: 35,
      slopeLengthKm: 42,
      slopeWidthKm: 17,
      elevationRangeM: "20-960 m",
      drainage: "คลองชายแดนและคลองสาขา",
    },
    burn: {
      label: "Burn",
      value: "8/25",
      score: 8,
      description: "burn modifier ต่ำถึงกลาง",
      lastFireWindow: "ไม่เด่นใน prototype",
      hotspotDensity: "ต่ำ-กลาง",
    },
    exposure: {
      label: "Exposure",
      value: "24/25",
      score: 24,
      description: "ชุมชนและถนนหลักอยู่ในแนวรับน้ำจากเขา",
      buildingCount: 5120,
      settlementPattern: "transport corridor settlement",
    },
    rain: {
      label: "Rain",
      value: "10/10",
      score: 10,
      description: "กลุ่มฝนภาคใต้ตอนล่างเป็นตัวเร่งความเสี่ยง",
      provider: "RainViewer radar context",
      window: "nowcast layer",
    },
    operatingNote:
      "ควรดูเส้นทางคมนาคมและจุดข้ามน้ำต่ำร่วมกับ layer ฝน",
    dataFreshness: "Prototype geometry; replace with DEM/FIRMS/Open Buildings pipeline",
    tags: ["ถนนหลัก", "คลองสั้น", "ชุมชนหนาแน่น"],
  },
  {
    id: "chanthaburi-khaokhitchakut",
    name: "เขาคิชฌกูฏ - มะขาม",
    province: "จันทบุรี",
    region: "ภาคตะวันออก",
    center: [12.86, 102.15],
    riskClass: "watch",
    totalScore: 66,
    terrain: {
      label: "Terrain",
      value: "30/40",
      score: 30,
      description: "เขาสูงใกล้ชายฝั่งและคลองลงสวนผลไม้",
      maxSlopeDeg: 30,
      downslopeBearingDeg: 205,
      slopeLengthKm: 36,
      slopeWidthKm: 16,
      elevationRangeM: "20-1,050 m",
      drainage: "คลองสั้นลงพื้นที่สวนและชุมชน",
    },
    burn: {
      label: "Burn",
      value: "10/25",
      score: 10,
      description: "burn modifier มีบางส่วนแต่ไม่ใช่ driver หลัก",
      lastFireWindow: "ภายใน 180 วัน",
      hotspotDensity: "ต่ำ-กลาง",
    },
    exposure: {
      label: "Exposure",
      value: "17/25",
      score: 17,
      description: "บ้านเรือนและสวนอยู่ตามคลองเชิงเขา",
      buildingCount: 1920,
      settlementPattern: "orchard + foothill villages",
    },
    rain: {
      label: "Rain",
      value: "9/10",
      score: 9,
      description: "เข้าสู่ watch เมื่อมรสุมตะวันตกเฉียงใต้แรงและฝนค้างบนเขา",
      provider: "RainViewer radar context",
      window: "nowcast layer",
    },
    operatingNote:
      "พื้นที่นี้เหมาะเป็น seasonal watch สำหรับช่วงมรสุมแรงในภาคตะวันออก",
    dataFreshness: "Prototype geometry; replace with DEM/FIRMS/Open Buildings pipeline",
    tags: ["สวนผลไม้", "มรสุม", "watch"],
  },
];
