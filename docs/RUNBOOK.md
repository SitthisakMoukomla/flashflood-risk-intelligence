# คู่มือดูแลระบบ

ทำอะไรเมื่อเกิดเหตุ — เขียนให้คนที่ไม่ได้สร้างระบบนี้อ่านแล้วแก้ได้

## ตรวจสุขภาพระบบ (30 วินาที)

```bash
node scripts/preflight.mjs
```

บอกทันทีว่าข้อมูลน้ำท่วมครบมั้ย ฝนมีกี่จุด tile archive สมบูรณ์มั้ย

ดูสถานะบนเว็บจริง:
```bash
curl -s https://flashflood-risk-intelligence.vercel.app/data/sar_flood_meta.json | python3 -m json.tool | head -20
```

---

## อาการ: ข้อมูลบนเว็บค้าง ไม่อัปเดต

**1. ดูว่า cron ทำงานล่าสุดเมื่อไหร่**
```bash
gh run list --workflow=sar-flood.yml --limit 5
gh run list --workflow=log-maesai.yml --limit 3
```

**2. ถ้าล้ม ดูสาเหตุ**
```bash
gh run view <run-id> --log-failed
```

**3. สั่งรันเองทันที**
```bash
gh workflow run sar-flood.yml
```

> เคยเกิดแล้ว: cron ล้มเงียบ 3 เดือนเพราะเรียกสคริปต์ที่ต้องใช้ไฟล์ใน `.gitignore`
> ดูรายละเอียดใน [LESSONS.md](LESSONS.md) ข้อ 5

---

## อาการ: เลเยอร์น้ำท่วมหาย / ว่างเปล่า

**เช็คตามลำดับ**

1. ไฟล์ยังอยู่บน R2 มั้ย
   ```bash
   curl -sI "$(curl -s https://flashflood-risk-intelligence.vercel.app/data/sar_flood_meta.json | python3 -c 'import json,sys;print(json.load(sys.stdin)["tiles"]["url"])')" | head -3
   ```
   ต้องได้ `HTTP/2 200` และ `accept-ranges: bytes`

2. ถ้า 403/404 → credentials R2 ใน GitHub Secrets หมดอายุหรือถูกลบ
   สร้าง token ใหม่ที่ Cloudflare → R2 → API Tokens แล้วอัปเดต secret

3. ถ้าไฟล์ปกติแต่แผนที่ว่าง → เปิด DevTools ดู console
   น่าจะเป็นปัญหา CORS: bucket ต้องอนุญาต origin ของเว็บและ header `range`

---

## อาการ: สถานีวัดน้ำ/ฝน หายหมด

API ของ สสน. ล่มหรือเปลี่ยนรูปแบบ ตรวจตรงๆ:
```bash
curl -s -H "User-Agent: Mozilla/5.0" --max-time 60 \
  "https://api-v3.thaiwater.net/api/v1/thaiwater30/public/waterlevel" -o /tmp/wl.json
python3 -c "import json; d=json.load(open('/tmp/wl.json')); print('stations:', len(d['data']))"
```

- ได้ 1,400+ = API ปกติ ปัญหาอยู่ฝั่งเว็บ
- ล้มเหลว/ว่าง = API ล่ม รอ หรือติดต่อ สสน.
- **ต้องใส่ User-Agent** ไม่งั้นถูกปฏิเสธ

---

## อาการ: อยากอัปเดตข้อมูลเดี๋ยวนี้

```bash
cd pipeline

# น้ำท่วมจากดาวเทียม (~45 นาที)
uv run python scripts/14_sar_flood.py --hours 168

# ฝนสะสม (~10 นาที)
uv run python scripts/17_rain_chirps.py

# ระดับน้ำแม่สาย (ทันที)
python3 scripts/12_maesai_log.py
```

เสร็จแล้ว **ต้อง** ตรวจก่อน deploy:
```bash
cd .. && npm run deploy
```

---

## อาการ: เว็บช้า / โหลดนาน

วัดจริงก่อนเดา — เปิด DevTools → Console แล้ววาง:
```js
performance.getEntriesByType('resource')
  .filter(r => r.name.includes('/data/') || r.name.includes('pmtiles'))
  .map(r => ({ f: r.name.split('/').pop(), kb: Math.round(r.transferSize/1024), ms: Math.round(r.duration) }))
  .sort((a,b) => b.ms - a.ms)
```

ค่าปกติ: PMTiles ~19 KB ต่อมุมมอง, wetness_grid ~0.1 MB (โหลดครั้งเดียว), รวมเสร็จใน ~2 วินาที

---

## เพิ่มพื้นที่ใหม่ / ขยายขอบเขต

1. แก้ `THAILAND_BBOX` ใน `pipeline/scripts/14_sar_flood.py`
2. แก้ขอบเขตใน `pipeline/scripts/15_susceptibility_thailand.py`
3. รัน pipeline ใหม่ทั้งชุด
4. `npm run deploy`

**ระวัง**: ถ้าขยายออกนอกกรอบแผ่น JRC ที่ใช้อยู่ ต้องเพิ่มแผ่นใหม่ด้วย
(ดูฟังก์ชัน `build_water_reference()` — มันเลือกแผ่นอัตโนมัติจาก bbox)

---

## อาการ: ซูมแล้วไม่เห็นบ้านรายหลัง (เห็นแต่จุดความหนาแน่น)

บ้านรายหลังมาจาก `buildings.pmtiles` (~GB) บน R2 ไม่ได้อยู่ใน repo
เว็บอ่าน URL จาก `public/data/buildings_tiles_meta.json`

1. เปิด URL ใน meta ตรง ๆ — ถ้าไม่ใช่ 200/206 แปลว่าไฟล์บน R2 หาย
2. สร้างใหม่ (ต้องมี CSV ทั้ง 6 แผ่นใน `pipeline/data/buildings/` และ `brew install tippecanoe`):

```bash
cd pipeline && uv run python scripts/17_buildings_tiles.py
```

   ใช้เวลาเป็นชั่วโมง ได้ `pipeline/data/output/buildings.pmtiles` และเขียน meta ให้เอง

3. อัปโหลด (ตั้ง `R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET R2_PUBLIC_BASE`
   ค่าเดียวกับ secrets ใน GitHub Actions):

```bash
cd pipeline && uv run python scripts/r2_upload.py data/output/buildings.pmtiles
```

4. `npm run deploy` — preflight จะยิง HEAD ไปที่ URL ใน meta ก่อน ถ้าไม่ตอบจะไม่ยอม deploy

---

## ค่าใช้จ่าย — ตรวจว่ายังฟรีอยู่

| บริการ | โควตาฟรี | ใช้จริง |
|---|---|---|
| Cloudflare R2 | 10 GB | 13 MB |
| GitHub Actions | 2,000 นาที/เดือน | ~1,500 |
| Vercel | 100 GB bandwidth | ขึ้นกับผู้ใช้ |
| Open-Meteo, CHIRPS, GFM, ThaiWater | ไม่จำกัด | — |

จุดที่จะเกินก่อนเพื่อน: **Vercel bandwidth** ถ้ามีคนเข้าเยอะช่วงน้ำท่วม
แก้ได้โดยย้ายไฟล์ใหญ่ไป R2 เพิ่ม (R2 ไม่คิดค่า egress)

---

## เอกสารอื่น

- [ARCHITECTURE.md](ARCHITECTURE.md) — อะไรอยู่ตรงไหน
- [LESSONS.md](LESSONS.md) — เคยพลาดอะไรมาบ้าง
- [../workshop/](../workshop/) — สื่อการสอน
