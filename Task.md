# Flashflood Risk Intelligence Map - MVP 1

## Product Goal

สร้าง webapp แผนที่ interactive สำหรับประเมินพื้นที่เสี่ยง flashflood ในประเทศไทย โดยเน้นการวิเคราะห์ความเสี่ยงเชิงพื้นที่ที่ดีกว่า dashboard ทั่วไป: พื้นที่สูง, ความลาดชันสูง, พื้นที่เผาไหม้จากไฟป่ารอบล่าสุดของฤดูกาลนี้, และบ้านเรือนที่อาจได้รับผลกระทบ

เป้าหมายหลักของ MVP 1 คือทำให้ deploy ใช้งานจริงได้ในฐานะ decision-support map สำหรับเจ้าหน้าที่, ประชาชนทั่วไป, และทีม operation โดยยังไม่ทำระบบแจ้งเตือนจริง

## Positioning

โปรเจคนี้ไม่ควรวาง GISTDA เป็นแกนการนำเสนอ และไม่ควรทำซ้ำ dashboard แบบสถานีน้ำทั่วไป

จุดขายของระบบคือการรวมข้อมูล hazard + exposure:

- พื้นที่สูงและลาดชัน
- ร่องน้ำ/พื้นที่รับน้ำที่น้ำหลากเร็ว
- burn scar หรือพื้นที่เผาไหม้จากไฟป่าฤดูกาลล่าสุด
- settlement/building exposure จาก building footprint
- ฝนปัจจุบันหรือฝนคาดการณ์เป็น context layer

## MVP Scope

### In Scope

- Interactive map ที่ deploy ได้จริง
- Layer พื้นที่เสี่ยง flashflood จากปัจจัย terrain + burn scar + settlement exposure
- Filter ตามปัจจัยหลัก เช่น risk score, slope, burn recency, building exposure, rainfall context
- Detail panel สำหรับพื้นที่ที่เลือก
- Source attribution แสดงแหล่งข้อมูลและข้อจำกัดชัดเจน
- Responsive UI ใช้ได้ทั้ง desktop และ mobile
- Data model ที่รองรับการต่อยอดเป็น alert preview หรือ alert จริงในอนาคต

### Out of Scope for MVP 1

- ไม่ทำ alert จริง
- ไม่ส่ง notification ผ่าน LINE, SMS, email, webhook
- ไม่ทำ admin dashboard
- ไม่ทำ threshold calibration เชิงสถิติเต็มรูปแบบ
- ไม่รับรองว่าเป็นประกาศอพยพหรือประกาศภัยทางการ
- ไม่ใช้ GISTDA เป็น feature หลักในการนำเสนอ

## Core User Groups

- เจ้าหน้าที่: ใช้ดูพื้นที่เสี่ยงและจัดลำดับการเฝ้าระวัง
- ประชาชนทั่วไป: ใช้ทำความเข้าใจความเสี่ยงรอบพื้นที่อยู่อาศัย
- ทีม operation: ใช้ประกอบการติดตามฝนและจุดเสี่ยงภาคสนาม

## Data Layers

### 1. Terrain Hazard

ข้อมูลที่ต้องใช้:

- DEM/elevation
- slope
- drainage proximity หรือ flow accumulation
- watershed/catchment unit ถ้าทำได้

Source candidates:

- NASA SRTM
- Copernicus DEM
- HydroSHEDS / MERIT Hydro

Output ที่ต้องการ:

- slope class
- terrain hazard score
- พื้นที่เชิงเขา/หุบเขา/ลำน้ำสั้นที่น้ำหลากเร็ว

### 2. Burn Scar / Recent Fire

ข้อมูลที่ต้องใช้:

- active fire/hotspot ฤดูกาลล่าสุด
- burned area หรือ proxy ของพื้นที่เผาไหม้
- วันที่เกิดไฟล่าสุด

Source candidates:

- NASA FIRMS
- MODIS burned area
- VIIRS active fire
- Copernicus/Sentinel derived burn scar ถ้าทำ pipeline เพิ่มได้

Output ที่ต้องการ:

- burned within 30/90/180 days
- burn intensity หรือ hotspot density ถ้ามี
- burn-risk modifier สำหรับพื้นที่ลาดชัน

### 3. Settlement / Exposure

ข้อมูลที่ต้องใช้:

- building footprint
- building count หรือ density ใน susceptibility area
- settlement downstream หรือใกล้ทางน้ำ

Source candidates:

- Google Open Buildings
- Microsoft Global ML Building Footprints
- OpenStreetMap buildings เป็น fallback

Output ที่ต้องการ:

- จำนวนอาคารในพื้นที่เสี่ยง
- density ของบ้านเรือน
- exposure score

### 4. Rain Context

ข้อมูลที่ต้องใช้:

- radar หรือ rainfall nowcast ถ้าใช้ได้ถูกสิทธิ์
- forecast precipitation เป็น fallback/context
- rainfall accumulation window เช่น 1h, 3h, 24h

Source candidates:

- RainViewer สำหรับ MVP/demo ถ้า license เหมาะกับบริบทงาน
- TMD radar ถ้าหา endpoint/API ที่ใช้ถูกสิทธิ์ได้
- Open-Meteo forecast precipitation เป็น fallback
- Windy ใช้เป็น forecast/context หรือ external reference ได้ แต่ radar layer ไม่ควรวางเป็น core dependency

Output ที่ต้องการ:

- rain layer บนแผนที่
- rainfall context ใน detail panel
- provider attribution ชัดเจน

## Risk Scoring Model

MVP 1 ใช้ rule-based score ก่อน เพื่อให้เข้าใจง่ายและอธิบายได้

ตัวอย่าง scoring:

- Terrain hazard: 0-40
- Burn scar modifier: 0-25
- Settlement exposure: 0-25
- Rain context: 0-10

Risk classes:

- Low
- Watch
- High
- Severe

Detail panel ต้องอธิบายได้ว่า risk score มาจากอะไร เช่น:

- slope สูง
- เคยเกิดไฟป่าใน 90 วันที่ผ่านมา
- มีบ้านเรือน 120 หลังใน buffer ปลายน้ำ
- forecast rainfall 3 ชั่วโมงข้างหน้าเพิ่มขึ้น

## Main Screens

### Map View

- แผนที่เต็มหน้าจอ
- layer toggle
- filter panel
- risk legend
- susceptibility area หรือ heat/surface layer ของพื้นที่เสี่ยง
- rain context layer ถ้าพร้อม

### Detail Panel

เมื่อเลือกพื้นที่ ต้องแสดง:

- ชื่อพื้นที่หรือ zone id
- risk class และ risk score
- terrain evidence
- burn scar evidence
- building exposure
- rainfall context
- source attribution
- data freshness
- caveat ว่าเป็น decision-support ไม่ใช่ประกาศภัยทางการ

### Source / Method Panel

- รายชื่อ source ทั้งหมด
- วันที่ข้อมูลล่าสุด
- license/usage caveat
- method summary แบบอ่านเร็ว

## Technical Direction

แนะนำ stack:

- Next.js App Router
- Leaflet หรือ MapLibre สำหรับ interactive map
- Vercel สำหรับ deploy
- Static/preprocessed GeoJSON สำหรับ MVP 1 ถ้าข้อมูลยังไม่ใหญ่
- API route สำหรับดึง rainfall หรือ dynamic provider
- แยก data pipeline ออกจาก frontend เมื่อข้อมูลเริ่มใหญ่

แนวทางข้อมูล MVP:

- เริ่มจาก precomputed susceptibility areas เป็น GeoJSON หรือ raster/contour surface
- เก็บ metadata ต่อ zone
- frontend โหลดเฉพาะข้อมูลที่จำเป็น
- ถ้าข้อมูล building footprint ใหญ่ ให้ aggregate เป็น count/density ก่อน ไม่ render building polygon ทุกหลัง

## Deployment Requirements

- ต้อง run local ได้
- ต้อง build ผ่าน production build
- ต้อง deploy ได้บน Vercel
- ไม่มี secret key ฝังใน frontend
- source attribution อยู่ใน UI
- มี disclaimer เรื่องการใช้งานข้อมูล

## Future Scope

### MVP 1.5 - Alert Preview

- Active alert preview panel
- rule-based trigger แบบไม่ส่ง notification
- alert state: Watch, Warning, Severe, Resolved
- cooldown เพื่อกันแจ้งเตือนถี่
- audit text ว่า alert เกิดจาก rule อะไร

### MVP 2 - Real Alert System

- notification ผ่าน LINE OA, SMS, email, webhook
- role-based dashboard สำหรับเจ้าหน้าที่
- threshold calibration จากเหตุการณ์ย้อนหลัง
- alert audit trail
- incident timeline
- feedback loop จากภาคสนาม

## Open Questions

- จะเริ่มพื้นที่นำร่องจังหวัด/ภูมิภาคไหนก่อน
- จะใช้ source ใดเป็น rainfall provider สำหรับ MVP
- จะใช้ building footprint จาก Google Open Buildings หรือ Microsoft เป็นหลัก
- จะ preprocess DEM/slope เอง หรือเริ่มจาก dataset ที่เตรียมไว้ก่อน
- ต้องการให้ susceptibility surface คำนวณบน grid, watershed, catchment ย่อย, หรือตำบล

## First Implementation Tasks

1. ตัดสินใจพื้นที่นำร่องสำหรับ MVP 1
2. เลือก data source สำหรับ DEM/slope, burn scar, building footprint, rain context
3. ออกแบบ schema ของ susceptibility area หรือ susceptibility surface GeoJSON
4. สร้าง sample dataset สำหรับพื้นที่นำร่อง
5. สร้าง map UI พร้อม layer toggle และ filter
6. สร้าง detail panel ที่อธิบาย evidence ของแต่ละ zone
7. เพิ่ม source attribution และ caveat
8. ทดสอบ responsive layout
9. ทำ production build
10. Deploy ไปยัง Vercel
