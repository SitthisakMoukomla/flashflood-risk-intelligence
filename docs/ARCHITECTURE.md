# สถาปัตยกรรม — อะไรอยู่ตรงไหน

เอกสารนี้ตอบคำถามเดียว: **ถ้าอยากแก้เรื่อง X ต้องไปที่ไฟล์ไหน**

## หลักการที่ยึดทั้งระบบ

**ไม่มีฐานข้อมูล ไม่มีเซิร์ฟเวอร์** — ทุกอย่างเป็นไฟล์นิ่งที่คำนวณไว้ล่วงหน้า
เว็บเป็น static site ล้วน ที่เหลือคือ cron ที่เขียนไฟล์ทับเป็นระยะ

เหตุผล: ข้อมูลทั้งหมดอ่านอย่างเดียวและเหมือนกันสำหรับทุกคน ไม่มีบัญชีผู้ใช้
ฐานข้อมูลจึงไม่ได้แก้ปัญหาอะไร มีแต่เพิ่มค่าใช้จ่ายและจุดที่พังได้

ผลลัพธ์: ค่าใช้จ่าย 0 บาท และรองรับคนพร้อมกันได้เท่าที่ CDN รับไหว

## ไหลของข้อมูล

```
แหล่งข้อมูลเปิด          →  pipeline (Python)  →  ไฟล์ใน public/data  →  เว็บ (อ่านอย่างเดียว)
Copernicus GFM                14_sar_flood.py       sar_flood.pmtiles      เลเยอร์น้ำท่วม
CHIRPS                        17_rain_chirps.py     wetness_grid.json      hex เสี่ยง
Copernicus DEM + HydroSHEDS   15_susceptibility     susceptibility.tif     hex พื้นที่เสี่ยง
Google Open Buildings         09_buildings_density  buildings_density.png  ความหนาแน่นบ้าน (z≤12)
Google Open Buildings         17_buildings_tiles    buildings.pmtiles (R2) บ้านรายหลัง (z≥13)

เรียกสดจากเบราว์เซอร์ (ไม่ผ่าน pipeline)
สสน. ThaiWater API      →  สถานีฝน/น้ำท่า        (ไม่ต้องมี key)
RainViewer              →  เรดาร์ฝนเคลื่อนไหว
Planetary Computer      →  ภาพเรดาร์ Sentinel-1   (ผ่าน /api/sar-mosaic)
```

## แก้เรื่องนี้ ไปที่ไฟล์นี้

| อยากแก้ | ไฟล์ |
|---|---|
| หน้าตาแผนที่ เลเยอร์ ปุ่ม สี | `src/components/FloodMap.tsx` |
| สูตรคำนวณความเสี่ยง | `src/lib/grid.ts` → `computeLiveGrid()` |
| แผง "ตรวจจุดนี้" + จุดเฝ้าระวัง | `src/lib/inspect.ts` (คำนวณ) · `InspectPanel` ใน `FloodMap.tsx` (หน้าตา) |
| เกณฑ์ระดับน้ำเทียบตลิ่ง | `src/lib/maesai.ts` → `bankPercentColor()` |
| หน้าเฝ้าระวังแม่สาย | `src/components/MaeSaiWatch.tsx` |
| การตรวจจับน้ำท่วมจากดาวเทียม | `pipeline/scripts/14_sar_flood.py` |
| แผนที่พื้นที่เสี่ยง (static) | `pipeline/scripts/15_susceptibility_thailand.py` |
| ข้อมูลฝนสะสม | `pipeline/scripts/17_rain_chirps.py` |
| ตารางเวลาอัปเดตอัตโนมัติ | `.github/workflows/*.yml` |
| สี ฟอนต์ ระยะห่าง | `src/app/globals.css` |

## ไฟล์ข้อมูลที่เผยแพร่

| ไฟล์ | ขนาด | เก็บที่ไหน | อัปเดตโดย |
|---|---|---|---|
| `sar_flood.pmtiles` | 13 MB | **Cloudflare R2** | cron ทุก 12 ชม. |
| `sar_flood.geojson` | 3.5 MB | git (ไว้วิเคราะห์ ไม่ส่งให้เบราว์เซอร์) | cron ทุก 12 ชม. |
| `maesai_log.jsonl` | 0.5 MB | git | cron ทุก 30 นาที |
| `wetness_grid.json` | 0.1 MB | git | cron รายวัน |

**ทำไม pmtiles อยู่ R2 ไม่ใช่ git**: ไฟล์ 13 MB ถูกเขียนทับวันละ 2 ครั้ง
ถ้าเก็บใน git ประวัติจะโตเดือนละ ~800 MB ภายในปีเดียว clone ไม่ไหว

## ระบบอัตโนมัติ

| งาน | ความถี่ | ใช้เวลา |
|---|---|---|
| `sar-flood.yml` | ทุก 12 ชม. | ~45 นาที |
| `log-maesai.yml` | ทุก 30 นาที | < 1 นาที |
| `refresh-wetness.yml` | รายวัน | ~10 นาที |

ทั้งหมดอยู่ในโควตาฟรีของ GitHub Actions (2,000 นาที/เดือน)

## ก่อน deploy ทุกครั้ง

```bash
npm run deploy    # ตรวจข้อมูลก่อน แล้วค่อยขึ้น production
```

คำสั่งนี้เรียก `scripts/preflight.mjs` ซึ่งจะปฏิเสธถ้าข้อมูลไม่สมบูรณ์
(หน้าต่างเวลาสั้นเกิน ดาวเทียมผ่านน้อยเกิน พื้นที่น้อยผิดปกติ ไฟล์ tile บางเกิน)

**อย่าใช้ `vercel deploy` ตรงๆ** — มันอ่านไฟล์จากเครื่อง ไม่ใช่จาก git
ถ้าเผลอมีไฟล์ทดสอบค้างอยู่ มันจะขึ้น production ทันที (เคยเกิดแล้ว ดู LESSONS.md)
