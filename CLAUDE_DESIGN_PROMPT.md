# Claude Design — Brief

Paste everything below this line into Claude Design.

---

# Flashflood Risk Intelligence — Northern Thailand

Design a public-facing flash-flood risk webapp targeting villagers in the
9 northern Thai provinces (Chiang Mai, Chiang Rai, Lampang, Lamphun,
Mae Hong Son, Nan, Phayao, Phrae, Uttaradit — 88,200 km², 663 ตำบล).

This is a *warning tool* in the spirit of an earthquake-alert app or the
Japan Meteorological Agency typhoon page — NOT a developer dashboard.
Current implementation is technically correct but reads as analytics
software; the redesign needs to be operational and emotionally clear.

## Audience & purpose

| Audience | Question they need answered in <5 seconds |
|---|---|
| **Villager** (primary) | "บ้านฉันเสี่ยงน้ำป่ามั้ย ถ้าฝนตกตอนนี้?" |
| **District officer / กำนัน-ผู้ใหญ่บ้าน** | "ตำบลไหนต้องเตือนก่อน?" |
| **Field operations / ปภ. / กรมป้องกันฯ** | "พื้นที่ไหนต้องเฝ้าระวังเป็นพิเศษ?" |

The villager always wins. If a design choice helps officials but loses
the villager, drop it.

## Data layers we already have (do not re-design)

1. **Static hazard surface** — slope + TWI + drainage proximity + recent
   burn scar + EVI, computed in Google Earth Engine. Continuous raster
   (1 km native, 100 m export), 0..1 normalized inside AOI.
2. **Soil saturation proxy** — 7-day antecedent rainfall from Open-Meteo,
   gridded ~15 km. Continuous raster.
3. **Live precipitation** — Open-Meteo nowcast (next-1-hour mm) gridded,
   plus RainViewer radar tiles for visual context.
4. **Combined live risk** — `static × (0.4 + 0.6 × wetness) + precip ×
   (0.3 + 0.4 × wetness)`, clipped to 1. The number to put in front of a
   villager.
5. **Building footprints** — 5.6M Open Buildings v3 buildings joined to
   each ตำบล for exposure context.
6. **Province + ตำบล polygons** (GADM 4.1) for boundary clipping &
   click hit-testing.

## Risk tiers

| Tier | Label TH | Label EN | What the villager should do |
|---|---|---|---|
| Severe | อพยพได้ทันที | Severe | "ถ้าฝนยังตกหนัก เตรียมย้ายของขึ้นที่สูงและสามารถอพยพได้ทันที" |
| High | เฝ้าระวัง | High | "ติดตามฝนต้นน้ำใกล้ชิด เตรียมแผนสำรอง" |
| Watch | ระวังตามฤดู | Watch | "ระวังเมื่อฝนหนักต่อเนื่อง 1-3 ชั่วโมง" |
| Low | ปลอดภัย | Low | "ความเสี่ยงต่ำในชั้นข้อมูลปัจจุบัน" |

Ramp colors used today (keep or evolve, but keep the *meaning*):
green `#1a9850` → yellow `#fee08b` → orange `#fdae61` → red `#d73027`.

## Default screen — "เตือนภัยตอนนี้" (live)

The map is the entire surface. On top:

1. **Hero alert ribbon** at the top: locates user via geolocation, then
   says
   > **"บ้านคุณอยู่ใน ตำบล{NAME} อ.{DISTRICT} จ.{PROVINCE}"**
   > **"ตอนนี้: {TIER}"** + one-line action verb from the tier table.
   If geolocation denied/unavailable, fall back to "เลือกตำบลของคุณ →"
   with a tiny search box.

2. **Floating mode picker** (left side, vertical, glassy):
   - **เตือนภัยตอนนี้** (default) — combined live risk, continuous raster
   - **พื้นที่เสี่ยง** — terrain hazard only (the "static" map)
   - **ดินอิ่มน้ำ** — 7-day soil saturation proxy, continuous raster
   - With one-line description of what each layer *means to the villager*.

3. **Independent toggles** (collapsed by default):
   - Radar (live rain tiles)
   - Precip-now (orange overlay where rain is currently falling)

4. **Bottom legend** (always visible, simple):
   - 4 colored chips: ปลอดภัย / ระวัง / เฝ้าระวัง / อพยพได้ทันที
   - timestamp "ข้อมูลฝน: {time}" + radar timestamp when active

5. **No detail panel by default** — drawer slides in from right (desktop)
   or bottom (mobile) when the user taps a ตำบล. Drawer shows:
   - ตำบลชื่อ + อันดับใน 663
   - Big tier badge with action text
   - Why this tier: 3 mini-bars (ภูมิประเทศ / ดินอิ่มน้ำ / ฝนตอนนี้) showing
     the contribution
   - "บ้านเรือน X หลัง" exposure
   - Collapsible "วิธีคำนวณ + แหล่งข้อมูล"

## Mobile-first, with desktop expansion

- 360-430px width must be the default canvas. Map fills the screen, hero
  alert is a sticky banner, mode picker becomes a horizontal bottom-bar.
- 1280px+ shows the same content with the drawer always-open on the
  right and the mode picker docked left.
- 768-1180px tablet stays single-column with the drawer modal.

## Aesthetic direction

- **Operational, not playful.** Think: USGS earthquake map, Japan ฝนเตือน
  amber alert, US National Weather Service. Crisp, readable, honest.
- **Dark mode primary.** Current palette `#071318` background + `#40e0bd`
  accent + warning `#d73027` works — keep the warm-dark teal.
- **Glass-morphism cards** floating over the map, not opaque blocks.
- **Typography**: Thai-Latin paired sans (IBM Plex Sans Thai or Noto
  Sans Thai). Big numbers in display weight for the tier; small all-caps
  for labels. Avoid serif.
- **Iconography**: minimal geometric (existing lucide-react icons are
  fine; don't add illustration). One icon per concept, no ambiguous
  pictograms. The mountain glyph for terrain, droplet for moisture,
  cloud-rain for live rain, radar arc for radar.
- **Motion**: subtle pulsing on the hero alert if tier ≥ High; rain
  layer tiles can crossfade. No bouncing, no springs.
- **Color-blind safe**: severe/high cannot rely on red-orange alone —
  add an `!` icon and bold weight on the badge.

## What's missing right now (do design these)

- A clear hero alert that names the villager's ตำบล and tells them what
  to do.
- A picker that uses operational language ("เตือนภัยตอนนี้") instead of
  technical names ("Risk live", "Static hazard").
- A mobile layout — the current dev preview is desktop-only.
- A geolocation permission flow + denied-state fallback.
- An "ใส่ที่อยู่" search affordance for users who can't geolocate.
- An offline / no-data state (rural 4G is unreliable).

## What NOT to redesign

- Don't move away from MapLibre/Leaflet — we're staying on Leaflet.
- Don't introduce 3D terrain — the 2D raster is the deliverable.
- Don't suggest user accounts / login.
- Don't add notifications/push (out of MVP scope; will be Phase 2).

## Deliverables to design

1. **Mobile screen — default** (geolocation granted, current tier).
2. **Mobile screen — tier ≥ High alert state** (animated hero, action card).
3. **Mobile screen — drawer expanded** (selected ตำบล detail).
4. **Desktop layout** — 1440×900 with mode picker + drawer pre-open.
5. **Color & type system** — tier colors, type ramp, icon set.
6. **One animation** — the hero pulse for High/Severe tiers (loom-style frames).
7. **Empty/error state** — "ไม่พบที่ตั้งของคุณ" with the search fallback.

Optional: a printable A3 community-board version showing all ตำบล in
one province colored by current risk for กำนันto post in the village.

## Constraints

- All copy in Thai-first, English secondary (small grey).
- Page weight target: < 3 MB on first paint (we already serve a 2 MB
  static raster + 1.6 MB GeoJSON, so the rest must be lean).
- WCAG AA contrast on everything except the map basemap.
- Respect that this displays disaster info — no marketing language, no
  "amazing", no exclamation marks except in the alert ribbon.

## Repo + live URL for context

- Live: https://flashflood-risk-intelligence.vercel.app
- Repo: https://github.com/SitthisakMoukomla/flashflood-risk-intelligence
- The data layers in `public/data/` are real and hot-refreshed daily.
