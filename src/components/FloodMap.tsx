"use client";

import {
  AlertTriangle,
  Building2,
  ChevronDown,
  ChevronRight,
  Droplets,
  Info,
  Layers,
  Locate,
  MapPin,
  Menu,
  Mountain,
  Pause,
  Play,
  RefreshCw,
  Radar,
  Search,
  Waves,
  X,
} from "lucide-react";
import Link from "next/link";
import type * as Leaflet from "leaflet";
import type { GeoJSON as LeafletGeoJSON } from "leaflet";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  methodSteps,
  productCopy,
  riskMeta,
  type RiskTier,
  type SourceNote,
  tierFromNorm,
} from "@/lib/risk-intelligence";
import {
  bankPercentColor,
  bankPercentLabel,
  MAESAI_CHAIN,
} from "@/lib/maesai";
import {
  buildTambonRows,
  computeLiveGrid,
  layerModes,
  type LayerMode,
  type TambonCollection,
  type TambonRow,
  type WetnessGrid,
  type WetnessPayload,
} from "@/lib/tambon";

// ─── Types ──────────────────────────────────────────────────────

type FloodMapProps = {
  copy: typeof productCopy;
  sources: SourceNote[];
};

type RadarFrame = { time: number; path: string; nowcast: boolean };

type RainLayerPayload = {
  generatedAt: string;
  host: string;
  frames: RadarFrame[];
  latestIndex: number;
  frameTime: string;
  tileUrl: string;
  source: string;
};

type StaticOverlayMeta = {
  generated_at: string;
  bbox: [number, number, number, number];
  width: number;
  height: number;
  norm_low: number;
  norm_high: number;
};

type BuildingsOverlayMeta = {
  generated_at: string;
  grid_bbox: [number, number, number, number];
  rows: number;
  cols: number;
  total_buildings: number;
};

type GeoStatus = "idle" | "asking" | "granted" | "denied" | "unsupported" | "outside";

/** A place from the Nominatim proxy (/api/geocode). */
type GeoPlace = {
  id: number;
  lat: number;
  lon: number;
  label: string;
  detail: string;
  full: string;
  kind: string | null;
  tambon: string | null;
  amphoe: string | null;
  province: string | null;
};

type ThaiWaterStation = {
  id: number;
  rain_24h: number | null;
  rain_1h: number | null;
  rainfall_datetime: string;
  agency: { agency_shortname?: { th?: string; en?: string } };
  geocode: { province_code: string; province_name?: { th?: string } };
  station: {
    tele_station_name?: { th?: string };
    tele_station_lat: number;
    tele_station_long: number;
  };
};

type ThaiWaterLevelStation = {
  id: number;
  waterlevel_datetime: string;
  waterlevel_m: number | string | null;
  waterlevel_msl: number | string | null;
  waterlevel_msl_previous: number | string | null;
  storage_percent: number | string | null;
  flow_rate: number | string | null;
  situation_level: number | null; // 1 (low/safe) → 5 (critical)
  agency: { agency_shortname?: { th?: string; en?: string } };
  basin?: { basin_name?: { th?: string } };
  geocode: { province_code: string; province_name?: { th?: string } };
  station: {
    tele_station_name?: { th?: string };
    tele_station_lat: number;
    tele_station_long: number;
    tele_station_oldcode?: string | null;
  };
};

const NORTH_PROVINCE_CODES = new Set([
  "50", // Chiang Mai
  "51", // Lamphun
  "52", // Lampang
  "53", // Uttaradit
  "54", // Phrae
  "55", // Nan
  "56", // Phayao
  "57", // Chiang Rai
  "58", // Mae Hong Son
]);
const THAIWATER_RAIN_24H_URL =
  "https://api-v3.thaiwater.net/api/v1/thaiwater30/public/rain_24h";
const THAIWATER_WATERLEVEL_URL =
  "https://api-v3.thaiwater.net/api/v1/thaiwater30/public/waterlevel";

/** Colour-by-rain (mm/24h) — light → red. */
function rainStationColor(mm: number): string {
  if (mm <= 0) return "rgba(140,180,210,0.35)"; // dry
  if (mm < 10) return "#5cc4ee";
  if (mm < 25) return "#3b82f6";
  if (mm < 50) return "#fdae61";
  if (mm < 90) return "#f97316";
  return "#d73027";
}

/** Situation-level colour (HII tier 1-5; null falls back to neutral). */
function situationColor(level: number | null): string {
  switch (level) {
    case 5: return "#d73027"; // critical
    case 4: return "#f97316"; // high
    case 3: return "#fdae61"; // warning
    case 2: return "#5cc4ee"; // normal
    case 1: return "#1a9850"; // low
    default: return "#9aa6a6";
  }
}
function situationLabel(level: number | null): string {
  switch (level) {
    case 5: return "วิกฤต";
    case 4: return "สูงมาก";
    case 3: return "เฝ้าระวัง";
    case 2: return "ปกติ";
    case 1: return "น้อย";
    default: return "ไม่มีข้อมูล";
  }
}


type Basemap = "osm" | "topo" | "satellite";

const BASEMAPS: Record<
  Basemap,
  { label: string; url: string; attribution: string; maxNativeZoom?: number; maxZoom: number }
> = {
  osm: {
    label: "OSM",
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  },
  topo: {
    label: "Topo",
    url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    attribution:
      'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>, <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
    maxNativeZoom: 17,
    maxZoom: 19,
  },
  satellite: {
    label: "Satellite",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution:
      "Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics, IGN",
    maxNativeZoom: 19,
    maxZoom: 20,
  },
};

// ─── Helpers ────────────────────────────────────────────────────

const PROVINCE_NAMES: Record<string, string> = {
  ChiangMai: "เชียงใหม่",
  ChiangRai: "เชียงราย",
  Lampang: "ลำปาง",
  Lamphun: "ลำพูน",
  MaeHongSon: "แม่ฮ่องสอน",
  Nan: "น่าน",
  Phayao: "พะเยา",
  Phrae: "แพร่",
  Uttaradit: "อุตรดิตถ์",
};
const thaiName = (slug: string) => PROVINCE_NAMES[slug] ?? slug;

/** Thai อำเภอ name when GADM supplied one (NL_NAME_2), else the romanised
 *  NAME_2. GADM 4.1 has no Thai tambon names, so NAME_3 stays romanised. */
const amphoeName = (p: TambonRow["feature"]["properties"]) => p.NL_NAME_2 ?? p.NAME_2;

function formatNumber(value: number): string {
  return new Intl.NumberFormat("th-TH").format(value);
}

function formatTimeBKK(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("th-TH", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "Asia/Bangkok",
    }).format(new Date(iso));
  } catch {
    return "—";
  }
}

// Descriptive only — the app explains the risk level, it does not issue
// directives. Operational decisions belong to local authorities.
function tierActionTH(tier: RiskTier): string {
  if (tier === "severe")
    return "ภูมิประเทศ + ดินอิ่มน้ำ + ฝนตอนนี้ รวมกันอยู่ในระดับเสี่ยงสูงสุดในขณะนี้";
  if (tier === "high")
    return "ความเสี่ยงสูงกว่าค่ากลางของพื้นที่ — ติดตามสถานการณ์ฝนต้นน้ำ";
  if (tier === "watch")
    return "ความเสี่ยงปานกลาง — เฝ้าระวังเมื่อฝนหนักต่อเนื่อง 1-3 ชั่วโมง";
  return "ความเสี่ยงต่ำในชั้นข้อมูลปัจจุบัน";
}

const TIER_EN: Record<RiskTier, string> = {
  severe: "Severe",
  high: "High",
  watch: "Watch",
  low: "Low",
};
const TIER_TH: Record<RiskTier, string> = {
  severe: "เสี่ยงสูงสุด",
  high: "เสี่ยงสูง",
  watch: "เสี่ยงปานกลาง",
  low: "เสี่ยงต่ำ",
};
const TIER_PILL: Record<RiskTier, string> = {
  severe: "tier-severe",
  high: "tier-high",
  watch: "tier-watch",
  low: "tier-low",
};

function pointInRing(lng: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function pointInGeom(lng: number, lat: number, geom: GeoJSON.Polygon | GeoJSON.MultiPolygon): boolean {
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  for (const poly of polys) {
    if (!pointInRing(lng, lat, poly[0])) continue;
    let inHole = false;
    for (let i = 1; i < poly.length; i++) if (pointInRing(lng, lat, poly[i])) { inHole = true; break; }
    if (!inHole) return true;
  }
  return false;
}

type Band = { min: number; rgba: [number, number, number, number] };

/** Weather-warning-style banded raster: bilinear-upsample the coarse grid,
 *  then quantise into solid colour classes. Sharp, bold zones instead of
 *  the foggy blob the browser makes of a 29×24 canvas. */
function renderBandedGridToDataURL(
  cols: number,
  rows: number,
  values: number[] | Float32Array,
  cap: number,
  bands: Band[], // ascending by min; value below bands[0].min → transparent
  mask?: number[] | Float32Array | null,
  scale = 10,
): string | null {
  if (typeof document === "undefined") return null;
  const W = cols * scale;
  const H = rows * scale;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const img = ctx.createImageData(W, H);
  const buf = img.data;

  const sample = (arr: number[] | Float32Array, gx: number, gy: number): number => {
    const x0 = Math.max(0, Math.min(cols - 1, Math.floor(gx)));
    const y0 = Math.max(0, Math.min(rows - 1, Math.floor(gy)));
    const x1 = Math.min(cols - 1, x0 + 1);
    const y1 = Math.min(rows - 1, y0 + 1);
    const fx = Math.max(0, Math.min(1, gx - x0));
    const fy = Math.max(0, Math.min(1, gy - y0));
    const v00 = Number(arr[y0 * cols + x0]) || 0;
    const v10 = Number(arr[y0 * cols + x1]) || 0;
    const v01 = Number(arr[y1 * cols + x0]) || 0;
    const v11 = Number(arr[y1 * cols + x1]) || 0;
    return v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
  };

  for (let y = 0; y < H; y++) {
    const gy = (y + 0.5) / scale - 0.5;
    for (let x = 0; x < W; x++) {
      const gx = (x + 0.5) / scale - 0.5;
      const o = (y * W + x) * 4;
      if (mask && sample(mask, gx, gy) < 0.5) {
        buf[o + 3] = 0;
        continue;
      }
      const t = Math.min(1, Math.max(0, sample(values, gx, gy) / cap));
      let band: Band | null = null;
      for (const b of bands) {
        if (t >= b.min) band = b;
        else break;
      }
      if (!band) {
        buf[o + 3] = 0;
        continue;
      }
      buf[o] = band.rgba[0];
      buf[o + 1] = band.rgba[1];
      buf[o + 2] = band.rgba[2];
      buf[o + 3] = band.rgba[3];
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL();
}

// Live risk bands — tier colours, solid and bold.
const LIVE_BANDS: Band[] = [
  { min: 0.08, rgba: [26, 152, 80, 130] },
  { min: 0.2, rgba: [254, 224, 139, 190] },
  { min: 0.4, rgba: [253, 174, 97, 210] },
  { min: 0.55, rgba: [215, 48, 39, 225] },
];

// Wetness bands — mm of 7-day rain against the 80 mm cap.
const WETNESS_BANDS: Band[] = [
  { min: 0.06, rgba: [127, 208, 240, 140] }, // ~5 mm
  { min: 0.19, rgba: [59, 130, 246, 180] }, // ~15 mm
  { min: 0.38, rgba: [29, 78, 216, 205] }, // ~30 mm
  { min: 0.63, rgba: [30, 41, 120, 225] }, // ~50 mm+
];

function scoreOfRow(row: TambonRow, mode: LayerMode | null): number {
  if (mode === "wetness") return row.wetnessNorm;
  if (mode === "static") return row.staticNorm;
  // Default & live both rank by liveNorm — that's the operational ranking.
  return row.liveNorm;
}

// ─── Inline glyph for tier badge (visual is an inset !/·/✓) ─────
function tierGlyph(tier: RiskTier): string {
  if (tier === "severe" || tier === "high") return "!";
  if (tier === "watch") return "·";
  return "✓";
}

// ─── Main component ─────────────────────────────────────────────

export function FloodMap({ copy, sources }: FloodMapProps) {
  const mapElementRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Leaflet.Map | null>(null);
  const leafletRef = useRef<typeof Leaflet | null>(null);
  const polyLayerRef = useRef<LeafletGeoJSON | null>(null);
  const wetnessOverlayRef = useRef<Leaflet.ImageOverlay | null>(null);
  const staticOverlayRef = useRef<Leaflet.ImageOverlay | null>(null);
  const liveOverlayRef = useRef<Leaflet.ImageOverlay | null>(null);
  const buildingsOverlayRef = useRef<Leaflet.ImageOverlay | null>(null);
  const buildingsPtsLayerRef = useRef<Leaflet.LayerGroup | null>(null);
  const buildingsPtsCacheRef = useRef<Map<string, [number, number][]>>(new Map());
  const basemapRef = useRef<Leaflet.TileLayer | null>(null);
  const userMarkerRef = useRef<Leaflet.LayerGroup | null>(null);
  const rainStationsLayerRef = useRef<Leaflet.LayerGroup | null>(null);
  const waterStationsLayerRef = useRef<Leaflet.LayerGroup | null>(null);
  const radarCacheRef = useRef<Map<string, Leaflet.TileLayer>>(new Map());

  // Layer z-stack (lower = farther back). Polygons sit on canvas pane
  // (zIndex ~600) so they're always on top for hover/click.
  const Z_HAZARD = 200; // static / wetness / live
  const Z_BUILDINGS = 350; // bumped above hazard so density reads through
  const Z_RADAR = 450; // RainViewer on top of everything raster
  // At z=12 a 5-10 m building footprint is ~0.2 px wide — sub-pixel and
  // effectively invisible on canvas. The density PNG actually reads better
  // until ~z=14 where buildings start being ≥1 px and the polygon layer
  // earns its place.
  const VECTOR_BUILDING_ZOOM = 14;

  const [tambonFC, setTambonFC] = useState<TambonCollection | null>(null);
  const [wetness, setWetness] = useState<WetnessPayload | null>(null);
  const [grid, setGrid] = useState<WetnessGrid | null>(null);
  const [staticMeta, setStaticMeta] = useState<StaticOverlayMeta | null>(null);
  const [buildingsMeta, setBuildingsMeta] = useState<BuildingsOverlayMeta | null>(null);
  const [rainLayer, setRainLayer] = useState<RainLayerPayload | null>(null);

  // null = no hazard layer shown (basemap visible). Click an active mode
  // again to toggle it off.
  const [layerMode, setLayerMode] = useState<LayerMode | null>("live");
  const [showRainOverlay, setShowRainOverlay] = useState(false);
  const [radarIdx, setRadarIdx] = useState(0);
  const [radarPlaying, setRadarPlaying] = useState(true);
  const [showBuildings, setShowBuildings] = useState(false);
  const [showRainStations, setShowRainStations] = useState(false);
  const [rainStations, setRainStations] = useState<ThaiWaterStation[] | null>(null);
  // Measured river levels are the most trustworthy layer we have and the
  // thing people open the site for — on by default.
  const [showWaterStations, setShowWaterStations] = useState(true);
  const [waterStations, setWaterStations] = useState<ThaiWaterLevelStation[] | null>(null);
  const [basemap, setBasemap] = useState<Basemap>("satellite");
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [mobileLayersOpen, setMobileLayersOpen] = useState(false);

  const [userLoc, setUserLoc] = useState<[number, number] | null>(null);
  const [geoStatus, setGeoStatus] = useState<GeoStatus>("idle");
  const [userPlace, setUserPlace] = useState<GeoPlace | null>(null);
  const [searchQ, setSearchQ] = useState("");
  const [geoResults, setGeoResults] = useState<GeoPlace[] | null>(null);
  const [geoSearching, setGeoSearching] = useState(false);

  const [selectedGid, setSelectedGid] = useState<string | null>(null);
  // Drawer defaults to closed on phones (the bottom sheet eats too much
  // map otherwise). SSR always renders open; a post-mount effect closes it
  // on small screens — reading matchMedia in the useState initializer
  // caused a hydration mismatch.
  const [drawerOpen, setDrawerOpen] = useState(true);
  useEffect(() => {
    if (window.matchMedia("(max-width: 820px)").matches) {
      setDrawerOpen(false);
    }
  }, []);
  const [methodOpen, setMethodOpen] = useState(false);
  const [isMapReady, setIsMapReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(7);

  // 1) Data load
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [vrRes, wRes, gRes, sRes] = await Promise.all([
          fetch("/data/village_risk.geojson"),
          fetch("/data/wetness_7d.json"),
          fetch("/data/wetness_grid.json"),
          fetch("/data/static_overlay_meta.json"),
        ]);
        if (!vrRes.ok) throw new Error(`village_risk.geojson ${vrRes.status}`);
        const fc = (await vrRes.json()) as TambonCollection;
        if (active) setTambonFC(fc);
        if (wRes.ok && active) setWetness((await wRes.json()) as WetnessPayload);
        if (gRes.ok && active) setGrid((await gRes.json()) as WetnessGrid);
        if (sRes.ok && active) setStaticMeta((await sRes.json()) as StaticOverlayMeta);
        try {
          const bRes = await fetch("/data/buildings_density_meta.json");
          if (bRes.ok && active) setBuildingsMeta((await bRes.json()) as BuildingsOverlayMeta);
        } catch {
          /* optional */
        }
      } catch (e) {
        if (active) setLoadError(e instanceof Error ? e.message : "load failed");
      }
      try {
        const r = await fetch("/api/rainviewer", { cache: "no-store" });
        if (r.ok && active) setRainLayer((await r.json()) as RainLayerPayload);
      } catch {
        /* radar optional */
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // 1c) Dynamic refresh — re-fetch wetness grid (rain + precip-now) on a
  // 15-minute timer and whenever the tab regains focus. Frontend re-derives
  // the live combined raster automatically because computeLiveGrid runs in
  // a useMemo that depends on `grid`.
  useEffect(() => {
    let active = true;
    const fetchStations = async () => {
      try {
        const r = await fetch(THAIWATER_RAIN_24H_URL, { cache: "no-store" });
        if (!r.ok || !active) return;
        const payload = (await r.json()) as { data: ThaiWaterStation[] };
        // Filter to the 9 northern provinces; drop rows missing coordinates.
        const north = payload.data.filter(
          (s) =>
            NORTH_PROVINCE_CODES.has(s.geocode?.province_code) &&
            s.station &&
            Number.isFinite(s.station.tele_station_lat) &&
            Number.isFinite(s.station.tele_station_long),
        );
        if (active) setRainStations(north);
      } catch {
        /* leave previous payload */
      }
    };
    const fetchWaterLevel = async () => {
      try {
        const r = await fetch(THAIWATER_WATERLEVEL_URL, { cache: "no-store" });
        if (!r.ok || !active) return;
        const payload = (await r.json()) as { data: ThaiWaterLevelStation[] };
        const chainCodes = new Set(MAESAI_CHAIN.map((c) => c.code));
        const north = payload.data.filter((s) => {
          if (!s.station) return false;
          if (
            !Number.isFinite(s.station.tele_station_lat) ||
            !Number.isFinite(s.station.tele_station_long)
          ) {
            return false;
          }
          // The upstream Sai-river gauges sit on the Myanmar side
          // (province_code 10499) and would otherwise be filtered out —
          // they're the whole point of the Mae Sai watch panel.
          if (s.station.tele_station_oldcode && chainCodes.has(s.station.tele_station_oldcode)) {
            return true;
          }
          return NORTH_PROVINCE_CODES.has(s.geocode?.province_code);
        });
        if (active) setWaterStations(north);
      } catch {
        /* leave previous */
      }
    };
    const refresh = async () => {
      if (!active) return;
      setRefreshing(true);
      try {
        const r = await fetch("/data/wetness_grid.json?t=" + Date.now());
        if (r.ok && active) {
          setGrid((await r.json()) as WetnessGrid);
          setRefreshedAt(new Date());
        }
        const rv = await fetch("/api/rainviewer", { cache: "no-store" });
        if (rv.ok && active) setRainLayer((await rv.json()) as RainLayerPayload);
        await Promise.all([fetchStations(), fetchWaterLevel()]);
      } catch {
        /* keep prev data */
      } finally {
        if (active) setRefreshing(false);
      }
    };
    // First load: also fetch ThaiWater stations once.
    void fetchStations();
    void fetchWaterLevel();
    const id = window.setInterval(refresh, 15 * 60_000);
    const onVis = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      active = false;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  const triggerRefresh = async () => {
    setRefreshing(true);
    try {
      const r = await fetch("/data/wetness_grid.json?t=" + Date.now());
      if (r.ok) {
        setGrid((await r.json()) as WetnessGrid);
        setRefreshedAt(new Date());
      }
      const rv = await fetch("/api/rainviewer", { cache: "no-store" });
      if (rv.ok) setRainLayer((await rv.json()) as RainLayerPayload);
    } catch {
      /* silent */
    } finally {
      setRefreshing(false);
    }
  };

  // 2) Geolocation
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setGeoStatus("unsupported");
      return;
    }
    setGeoStatus("asking");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setUserLoc([pos.coords.longitude, pos.coords.latitude]);
        setGeoStatus("granted");
      },
      () => setGeoStatus("denied"),
      { enableHighAccuracy: false, maximumAge: 5 * 60_000, timeout: 10_000 },
    );
  }, []);

  // 3) Build tambon rows
  const rows = useMemo(
    () => (tambonFC ? buildTambonRows(tambonFC, wetness, grid) : []),
    [tambonFC, wetness, grid],
  );

  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => scoreOfRow(b, layerMode) - scoreOfRow(a, layerMode)),
    [rows, layerMode],
  );

  const userRow = useMemo(() => {
    if (!userLoc || rows.length === 0) return null;
    const [lng, lat] = userLoc;
    for (const row of rows) if (pointInGeom(lng, lat, row.feature.geometry)) return row;
    return null;
  }, [userLoc, rows]);

  // Reverse-geocode the user's coordinate so we can name where they
  // actually are — including when that's outside our 9-province coverage.
  useEffect(() => {
    if (!userLoc) {
      setUserPlace(null);
      return;
    }
    const ctrl = new AbortController();
    const [lng, lat] = userLoc;
    fetch(`/api/geocode?lat=${lat}&lon=${lng}`, { signal: ctrl.signal })
      .then((r) => r.json() as Promise<{ result?: GeoPlace | null }>)
      .then((p) => setUserPlace(p.result ?? null))
      .catch(() => {
        /* keep whatever we had */
      });
    return () => ctrl.abort();
  }, [userLoc]);

  useEffect(() => {
    if (geoStatus === "granted" && userLoc && rows.length > 0 && !userRow) {
      setGeoStatus("outside");
    }
  }, [geoStatus, userLoc, rows.length, userRow]);

  // Auto-select user's tambon when first found
  useEffect(() => {
    if (userRow && !selectedGid) setSelectedGid(userRow.feature.properties.GID_3);
  }, [userRow, selectedGid]);

  const selectedRow = useMemo(() => {
    if (!selectedGid) return userRow ?? sortedRows[0] ?? null;
    return rows.find((r) => r.feature.properties.GID_3 === selectedGid) ?? userRow ?? sortedRows[0] ?? null;
  }, [rows, sortedRows, selectedGid, userRow]);

  // When the user's coordinate falls outside the 9 provinces we have no
  // tambon for them. Showing `selectedRow` there would name a random
  // high-risk tambon hundreds of km away — the hero must say "outside
  // coverage" instead.
  const outsideCoverage = geoStatus === "outside";
  const heroRow = outsideCoverage ? null : (userRow ?? selectedRow);
  const heroTier: RiskTier = heroRow?.liveTier ?? "low";
  const isHighOrSevere = heroTier === "high" || heroTier === "severe";

  // Search results (only when query)
  // Search is powered by OpenStreetMap Nominatim (Thailand-only) via our
  // proxy — GADM only knows 663 romanised tambon names, Nominatim knows
  // provinces, districts, subdistricts and villages in Thai.
  useEffect(() => {
    const q = searchQ.trim();
    if (q.length < 2) {
      setGeoResults(null);
      setGeoSearching(false);
      return;
    }
    setGeoSearching(true);
    const ctrl = new AbortController();
    // Debounced to stay inside Nominatim's 1 req/s usage policy.
    const t = window.setTimeout(async () => {
      try {
        const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`, { signal: ctrl.signal });
        const payload = (await r.json()) as { results?: GeoPlace[] };
        setGeoResults(payload.results ?? []);
      } catch {
        if (!ctrl.signal.aborted) setGeoResults([]);
      } finally {
        if (!ctrl.signal.aborted) setGeoSearching(false);
      }
    }, 450);
    return () => {
      ctrl.abort();
      window.clearTimeout(t);
    };
  }, [searchQ]);

  /** The Mae Sai chain, upstream → downstream, with rise/fall since the
   *  previous telemetry push. HII gives us `waterlevel_msl_previous`, so a
   *  trend is available without any stored history. */
  const maeSaiChain = useMemo(() => {
    if (!waterStations) return [];
    const byCode = new Map(
      waterStations
        .filter((s) => s.station?.tele_station_oldcode)
        .map((s) => [s.station.tele_station_oldcode as string, s]),
    );
    return MAESAI_CHAIN.map((meta) => {
      const s = byCode.get(meta.code);
      if (!s) return { ...meta, station: null as ThaiWaterLevelStation | null, sp: null, deltaCm: null, name: null };
      const sp = Number(s.storage_percent);
      const cur = Number(s.waterlevel_msl);
      const prev = Number(s.waterlevel_msl_previous);
      const deltaCm =
        Number.isFinite(cur) && Number.isFinite(prev) ? (cur - prev) * 100 : null;
      return {
        ...meta,
        station: s,
        sp: Number.isFinite(sp) ? sp : null,
        deltaCm,
        name: s.station.tele_station_name?.th ?? null,
      };
    });
  }, [waterStations]);

  const maeSaiBridge = maeSaiChain.find((c) => c.code === "MYA004") ?? null;
  /** Upstream gauges rising ≥1 cm since the last push — the actionable cue. */
  const maeSaiUpstreamRising = maeSaiChain
    .filter((c) => c.code === "MYA001" || c.code === "MYA002")
    .filter((c) => (c.deltaCm ?? 0) >= 1).length;

  /** Which tambon (if any) contains a coordinate. */
  const tambonAt = useMemo(
    () =>
      (lng: number, lat: number): TambonRow | null => {
        for (const row of rows) if (pointInGeom(lng, lat, row.feature.geometry)) return row;
        return null;
      },
    [rows],
  );

  // ─── Map setup ────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!mapElementRef.current || mapRef.current) return;
      const L = await import("leaflet");
      if (cancelled) return;
      leafletRef.current = L;
      const map = L.map(mapElementRef.current, {
        center: [18.7, 99.8],
        zoom: 7,
        zoomControl: false,
        preferCanvas: true,
      });
      L.control.zoom({ position: "bottomright" }).addTo(map);
      map.on("zoomend", () => setZoom(map.getZoom()));
      mapRef.current = map;
      setIsMapReady(true);
    })();
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      polyLayerRef.current = null;
      setIsMapReady(false);
    };
  }, []);

  // Basemap layer — swap when user picks OSM / Topo / Satellite
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!L || !map || !isMapReady) return;
    if (basemapRef.current) {
      basemapRef.current.removeFrom(map);
      basemapRef.current = null;
    }
    const b = BASEMAPS[basemap];
    basemapRef.current = L.tileLayer(b.url, {
      maxZoom: b.maxZoom,
      maxNativeZoom: b.maxNativeZoom ?? b.maxZoom,
      attribution: b.attribution,
      zIndex: 0,
    }).addTo(map);
  }, [isMapReady, basemap]);

  // User location pin
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!L || !map || !isMapReady) return;
    if (userMarkerRef.current) {
      userMarkerRef.current.removeFrom(map);
      userMarkerRef.current = null;
    }
    if (!userLoc) return;
    const [lng, lat] = userLoc;
    const tier = userRow?.liveTier ?? "low";
    const color = riskMeta[tier].color;
    const group = L.layerGroup();
    L.circleMarker([lat, lng], {
      radius: 18,
      color,
      weight: 0,
      fillColor: color,
      fillOpacity: 0.16,
      interactive: false,
      className: "user-loc-halo",
    }).addTo(group);
    L.circleMarker([lat, lng], {
      radius: 7,
      color: "#07131a",
      weight: 2,
      fillColor: color,
      fillOpacity: 1,
      interactive: false,
    }).addTo(group);
    group.addTo(map);
    userMarkerRef.current = group;
  }, [isMapReady, userLoc, userRow]);

  // Tambon click layer (transparent — only for hover/click hit testing)
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!L || !map || !isMapReady || rows.length === 0) return;

    if (polyLayerRef.current) {
      polyLayerRef.current.remove();
      polyLayerRef.current = null;
    }

    const fc: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: rows.map((r) => r.feature),
    };

    const rowByGid = new Map(rows.map((r) => [r.feature.properties.GID_3, r]));

    polyLayerRef.current = L.geoJSON(fc as never, {
      style: (feature) => {
        const gid = feature?.properties?.GID_3 as string | undefined;
        const isSelected = gid === selectedGid;
        if (isSelected) {
          return {
            stroke: true,
            fill: true,
            fillOpacity: 0.16,
            fillColor: "#ffffff",
            color: "#ffffff",
            weight: 2.6,
            opacity: 0.95,
          };
        }
        // Only Severe tambon carry a coloured outline — everything else
        // stays invisible so the basemap is readable. User can still
        // click any polygon (Leaflet canvas hit-test on geometry) and
        // hover paints a transient white outline for orientation.
        const row = gid ? rowByGid.get(gid) : undefined;
        const tier = row?.liveTier ?? "low";
        if (tier !== "severe") {
          return { stroke: false, fill: false };
        }
        return {
          stroke: true,
          fill: false,
          color: riskMeta.severe.color,
          weight: 1.6,
          opacity: 0.95,
        };
      },
      onEachFeature: (feature, layer) => {
        const p = feature.properties as TambonRow["feature"]["properties"];
        const path = layer as Leaflet.Path & { feature?: { properties?: { GID_3?: string } } };
        layer.on("click", () => {
          setSelectedGid(p.GID_3);
          setDrawerOpen(true);
        });
        layer.on("mouseover", () => {
          if (path.feature?.properties?.GID_3 === selectedGid) return;
          const gid = path.feature?.properties?.GID_3;
          const r = gid ? rowByGid.get(gid) : undefined;
          const isSevere = r?.liveTier === "severe";
          // All tambon get a faint hover ring so they read as clickable.
          // Severe tambon already have a red outline — bump theirs to
          // a thicker white so the contrast is obvious.
          path.setStyle({
            stroke: true,
            fill: false,
            color: isSevere ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.55)",
            weight: isSevere ? 1.8 : 0.9,
            opacity: 1,
          });
        });
        layer.on("mouseout", () => {
          if (path.feature?.properties?.GID_3 === selectedGid) return;
          polyLayerRef.current?.resetStyle(layer as Leaflet.Path);
        });
        layer.bindTooltip(`<b>${p.NAME_3}</b> · อ.${amphoeName(p)}<br/>จ.${thaiName(p.NAME_1)}`, {
          direction: "top",
          sticky: true,
          opacity: 0.9,
        });
      },
    }).addTo(map);
  }, [isMapReady, rows, selectedGid]);

  // Static raster overlay
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!L || !map || !isMapReady) return;
    if (staticOverlayRef.current) {
      staticOverlayRef.current.removeFrom(map);
      staticOverlayRef.current = null;
    }
    if (layerMode !== "static" || !staticMeta) return;
    const [w, s, e, n] = staticMeta.bbox;
    staticOverlayRef.current = L.imageOverlay("/data/static_overlay.png", [[s, w], [n, e]], {
      opacity: 0.78,
      interactive: false,
      zIndex: Z_HAZARD,
    }).addTo(map);
  }, [isMapReady, layerMode, staticMeta]);

  // Wetness raster overlay
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!L || !map || !isMapReady) return;
    if (wetnessOverlayRef.current) {
      wetnessOverlayRef.current.removeFrom(map);
      wetnessOverlayRef.current = null;
    }
    if (layerMode !== "wetness" || !grid) return;
    const aoiMask = grid.static_norm; // 0 outside AOI (sampled from susceptibility.tif)
    const url = renderBandedGridToDataURL(
      grid.cols,
      grid.rows,
      grid.rain_7d_mm,
      grid.wetness_norm_cap_mm,
      WETNESS_BANDS,
      aoiMask,
    );
    if (!url) return;
    const [w, s, e, n] = grid.grid_bbox;
    wetnessOverlayRef.current = L.imageOverlay(url, [[s, w], [n, e]], {
      opacity: 0.88,
      interactive: false,
      zIndex: Z_HAZARD,
    }).addTo(map);
  }, [isMapReady, layerMode, grid]);

  // Live combined raster
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!L || !map || !isMapReady) return;
    if (liveOverlayRef.current) {
      liveOverlayRef.current.removeFrom(map);
      liveOverlayRef.current = null;
    }
    if (layerMode !== "live" || !grid) return;
    const live = computeLiveGrid(grid);
    const aoiMask = grid.static_norm;
    const url = renderBandedGridToDataURL(grid.cols, grid.rows, live, 1.0, LIVE_BANDS, aoiMask);
    if (!url) return;
    const [w, s, e, n] = grid.grid_bbox;
    liveOverlayRef.current = L.imageOverlay(url, [[s, w], [n, e]], {
      opacity: 0.88,
      interactive: false,
      zIndex: Z_HAZARD,
    }).addTo(map);
  }, [isMapReady, layerMode, grid]);

  // Buildings density overlay
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!L || !map || !isMapReady) return;
    if (buildingsOverlayRef.current) {
      buildingsOverlayRef.current.removeFrom(map);
      buildingsOverlayRef.current = null;
    }
    if (!showBuildings || !buildingsMeta) return;
    // When zoomed in we render actual building polygons (effect 7) for
    // the selected (or auto-selected) tambon — let those carry the
    // visual instead of the blob.
    const effectiveGid =
      selectedGid ?? selectedRow?.feature.properties.GID_3 ?? null;
    if (zoom >= VECTOR_BUILDING_ZOOM && effectiveGid) return;
    const [w, s, e, n] = buildingsMeta.grid_bbox;
    buildingsOverlayRef.current = L.imageOverlay("/data/buildings_density.png", [[s, w], [n, e]], {
      opacity: 0.85,
      interactive: false,
      zIndex: Z_BUILDINGS,
    }).addTo(map);
  }, [isMapReady, showBuildings, buildingsMeta, zoom, selectedGid, selectedRow]);

  // Reset playback position whenever a fresh radar payload arrives.
  useEffect(() => {
    if (rainLayer?.frames?.length) {
      setRadarIdx(Math.min(rainLayer.latestIndex ?? 0, rainLayer.frames.length - 1));
    }
  }, [rainLayer]);

  // Radar overlay — animated. One cached tile layer per frame; the active
  // frame gets opacity, the next frame is pre-added at opacity 0 so its
  // tiles are already loaded when the playhead reaches it.
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!L || !map || !isMapReady) return;
    const cache = radarCacheRef.current;

    if (!showRainOverlay || !rainLayer?.frames?.length) {
      for (const l of cache.values()) l.removeFrom(map);
      cache.clear();
      return;
    }

    const frames = rainLayer.frames;
    const idx = Math.min(radarIdx, frames.length - 1);

    // Drop cached layers for frames that fell out of the animation window
    // (happens after the 15-minute payload refresh).
    const validPaths = new Set(frames.map((f) => f.path));
    for (const [path, l] of cache) {
      if (!validPaths.has(path)) {
        l.removeFrom(map);
        cache.delete(path);
      }
    }

    const layerOf = (f: RadarFrame): Leaflet.TileLayer => {
      let l = cache.get(f.path);
      if (!l) {
        l = L.tileLayer(`${rainLayer.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`, {
          opacity: 0,
          zIndex: Z_RADAR,
          // RainViewer free tier only serves real tiles up to z=7;
          // beyond that Leaflet upscales.
          maxNativeZoom: 7,
          maxZoom: 18,
          attribution: "RainViewer",
        });
        cache.set(f.path, l);
      }
      if (!map.hasLayer(l)) l.addTo(map);
      return l;
    };

    layerOf(frames[idx]);
    layerOf(frames[(idx + 1) % frames.length]); // preload next
    for (const [path, l] of cache) {
      l.setOpacity(path === frames[idx].path ? 0.6 : 0);
    }
  }, [isMapReady, showRainOverlay, rainLayer, radarIdx]);

  // Radar playback clock — 650 ms per frame, 1.6 s hold on the last frame.
  useEffect(() => {
    if (!showRainOverlay || !radarPlaying || !rainLayer?.frames?.length) return;
    const n = rainLayer.frames.length;
    const atEnd = radarIdx >= n - 1;
    const t = window.setTimeout(() => {
      setRadarIdx((i) => (i >= n - 1 ? 0 : i + 1));
    }, atEnd ? 1600 : 650);
    return () => window.clearTimeout(t);
  }, [showRainOverlay, radarPlaying, radarIdx, rainLayer]);

  // 6e) HII ThaiWater rain-station observations (1,400+ gauges in N TH)
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!L || !map || !isMapReady) return;
    if (rainStationsLayerRef.current) {
      rainStationsLayerRef.current.removeFrom(map);
      rainStationsLayerRef.current = null;
    }
    if (!showRainStations || !rainStations || rainStations.length === 0) return;

    const group = L.layerGroup();
    for (const s of rainStations) {
      const lat = s.station.tele_station_lat;
      const lng = s.station.tele_station_long;
      const mm24 = Number(s.rain_24h ?? 0) || 0;
      const mm1 = Number(s.rain_1h ?? 0) || 0;
      const radius = 4 + Math.min(8, Math.sqrt(mm24));
      const marker = L.circleMarker([lat, lng], {
        radius,
        color: "#0a1318",
        weight: 0.6,
        fillColor: rainStationColor(mm24),
        fillOpacity: 0.9,
        interactive: true,
      });
      const name = s.station.tele_station_name?.th ?? "(สถานี)";
      const agency = s.agency?.agency_shortname?.th ?? "";
      const province = s.geocode?.province_name?.th ?? "";
      marker.bindTooltip(
        `<b>${name}</b>` +
          (agency ? ` <span style="opacity:.7">${agency}</span>` : "") +
          `<br/>${province}` +
          `<br/>ฝน 24 ชม. <b>${mm24.toFixed(1)}</b> มม.` +
          ` · 1 ชม. <b>${mm1.toFixed(1)}</b> มม.` +
          `<br/><span style="opacity:.6;font-size:10px">${s.rainfall_datetime}</span>`,
        { sticky: true, opacity: 0.95, direction: "top" },
      );
      marker.addTo(group);
    }
    group.addTo(map);
    rainStationsLayerRef.current = group;
  }, [isMapReady, showRainStations, rainStations]);

  // 6f) HII ThaiWater water-level stations (น้ำท่า) — coloured by
  // ระดับน้ำเทียบตลิ่ง (storage_percent). ≥100% = overtopping, drawn with
  // an extra warning ring. Falls back to the agency situation tier when
  // the bank percentage is missing.
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!L || !map || !isMapReady) return;
    if (waterStationsLayerRef.current) {
      waterStationsLayerRef.current.removeFrom(map);
      waterStationsLayerRef.current = null;
    }
    if (!showWaterStations || !waterStations || waterStations.length === 0) return;

    const group = L.layerGroup();
    for (const s of waterStations) {
      const lat = s.station.tele_station_lat;
      const lng = s.station.tele_station_long;
      const sit = s.situation_level == null ? null : Number(s.situation_level);
      const spRaw =
        s.storage_percent === null || s.storage_percent === undefined
          ? null
          : Number(s.storage_percent);
      const sp = spRaw !== null && Number.isFinite(spRaw) ? spRaw : null;
      const wl =
        s.waterlevel_m === null || s.waterlevel_m === undefined
          ? null
          : Number(s.waterlevel_m);

      const color = sp !== null ? bankPercentColor(sp) : situationColor(sit);
      const overtopping = sp !== null && sp >= 100;
      // Water height inside the channel, clamped so >100% still reads as
      // "full" while the spill cap communicates the overflow.
      const fillPct = sp === null ? 0 : Math.max(4, Math.min(100, sp));

      // A channel cross-section rather than a bubble: the box IS the bank,
      // the fill IS the water. Reading "how close to overtopping" no longer
      // requires decoding a radius.
      const W = 16;
      const H = 20;
      const padTop = 3; // space above the bank line for the spill cap
      const chH = H - padTop - 1;
      const waterH = (chH - 2) * (fillPct / 100);
      const waterY = padTop + 1 + (chH - 2 - waterH);
      const svg = `
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <rect x="2.5" y="${padTop + 0.5}" width="${W - 5}" height="${chH}" rx="2.5"
        fill="rgba(7,19,24,0.72)" stroke="rgba(255,255,255,0.55)" stroke-width="1"/>
  ${
    sp === null
      ? `<line x1="4.5" y1="${padTop + chH / 2}" x2="${W - 4.5}" y2="${padTop + chH / 2}" stroke="#9aa6a6" stroke-width="1.4"/>`
      : `<rect x="3.5" y="${waterY.toFixed(2)}" width="${W - 7}" height="${Math.max(1.5, waterH).toFixed(2)}" rx="1.5" fill="${color}"/>`
  }
  <line x1="1" y1="${padTop + 0.5}" x2="${W - 1}" y2="${padTop + 0.5}"
        stroke="${overtopping ? "#d73027" : "rgba(255,255,255,0.85)"}" stroke-width="${overtopping ? 1.8 : 1.2}"
        stroke-linecap="round"/>
  ${overtopping ? `<path d="M3 ${padTop - 1.2} q3 -2.4 5 0 q3 -2.4 5 0" fill="none" stroke="#d73027" stroke-width="1.6" stroke-linecap="round"/>` : ""}
</svg>`.trim();

      const marker = L.marker([lat, lng], {
        icon: L.divIcon({
          className: `ff-gauge${overtopping ? " is-over" : ""}`,
          html: svg,
          iconSize: [W, H],
          iconAnchor: [W / 2, H - 1], // sit the channel base on the station
        }),
        interactive: true,
        keyboard: false,
      });

      const name = s.station.tele_station_name?.th ?? "(สถานี)";
      const agency = s.agency?.agency_shortname?.th ?? "";
      const province = s.geocode?.province_name?.th ?? "";
      const basin = s.basin?.basin_name?.th ?? "";
      const bankLine =
        sp !== null
          ? `<br/>เทียบตลิ่ง <b style="color:${color}">${sp.toFixed(0)}% · ${bankPercentLabel(sp)}</b>`
          : `<br/>ระดับน้ำ <b>${situationLabel(sit)}</b>`;
      marker.bindTooltip(
        `<b>${name}</b>` +
          (agency ? ` <span style="opacity:.7">${agency}</span>` : "") +
          `<br/>${province}` +
          (basin ? ` · ${basin}` : "") +
          bankLine +
          (wl != null ? ` · ระดับ ${wl.toFixed(2)} ม.` : "") +
          `<br/><span style="opacity:.6;font-size:10px">${s.waterlevel_datetime}</span>`,
        { sticky: true, opacity: 0.95, direction: "top" },
      );
      marker.addTo(group);
    }
    group.addTo(map);
    waterStationsLayerRef.current = group;
  }, [isMapReady, showWaterStations, waterStations]);

  // 7) Per-tambon building points (vector). Replaces the density blob with
  // actual centroids when the user has selected a tambon AND zoomed past 12.
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!L || !map || !isMapReady) return;

    const clear = () => {
      if (buildingsPtsLayerRef.current) {
        buildingsPtsLayerRef.current.removeFrom(map);
        buildingsPtsLayerRef.current = null;
      }
    };

    // Fall back to the resolved selectedRow's GID if the user hasn't
    // explicitly clicked a tambon yet (e.g. denied geolocation) — the
    // drawer is already showing data for it, the buildings layer should
    // match.
    const effectiveGid =
      selectedGid ?? selectedRow?.feature.properties.GID_3 ?? null;
    if (!showBuildings || zoom < VECTOR_BUILDING_ZOOM || !effectiveGid) {
      clear();
      return;
    }

    let cancelled = false;
    const cache = buildingsPtsCacheRef.current;
    const draw = (polygons: [number, number][][]) => {
      if (cancelled) return;
      clear();
      if (polygons.length === 0) return;
      const group = L.layerGroup();
      // Stronger styling so footprints read clearly on Satellite basemap.
      // Stroke goes 1 → 1.4 with zoom; fill opacity 0.85 stays solid.
      const stroke = zoom >= 17 ? 1.4 : zoom >= 15 ? 1.1 : 1;
      for (const ring of polygons) {
        // ring is [[lng, lat], ...] — Leaflet wants [[lat, lng], ...]
        const latlngs = ring.map(([lng, lat]) => [lat, lng] as [number, number]);
        L.polygon(latlngs, {
          color: "#0a1318",
          weight: stroke,
          fillColor: "#fdae61",
          fillOpacity: 0.85,
          interactive: false,
        }).addTo(group);
      }
      group.addTo(map);
      buildingsPtsLayerRef.current = group;
    };

    const cached = cache.get(effectiveGid);
    if (cached) {
      draw(cached as unknown as [number, number][][]);
    } else {
      fetch(`/data/buildings_pts/${effectiveGid}.json`)
        .then((r) =>
          r.ok ? (r.json() as Promise<[number, number][][]>) : Promise.resolve([]),
        )
        .then((polys) => {
          cache.set(effectiveGid, polys as unknown as [number, number][]);
          draw(polys);
        })
        .catch(() => {
          /* silent — fall back to density blob */
        });
    }

    return () => {
      cancelled = true;
    };
  }, [isMapReady, showBuildings, selectedGid, selectedRow, zoom]);

  // ─── Actions ─────────────────────────────────────────────────
  const flyToTambon = (gid: string) => {
    setSelectedGid(gid);
    setDrawerOpen(true);
    const map = mapRef.current;
    const layer = polyLayerRef.current;
    if (!map || !layer) return;
    layer.eachLayer((l) => {
      const fid = (l as unknown as { feature?: { properties?: { GID_3?: string } } }).feature?.properties?.GID_3;
      if (fid === gid) {
        map.flyTo((l as Leaflet.GeoJSON).getBounds().getCenter(), 11, { duration: 0.6 });
      }
    });
  };

  /** Fly to a Nominatim result and select the tambon that contains it (if
   *  the place falls inside our 9-province coverage). */
  const flyToPlace = (place: GeoPlace) => {
    const map = mapRef.current;
    if (!map) return;
    // Villages/points deserve a closer look than provinces.
    const zoom =
      place.kind === "village" || place.kind === "hamlet" || place.kind === "town"
        ? 13
        : place.kind === "county" || place.kind === "district"
          ? 11
          : 9;
    map.flyTo([place.lat, place.lon], zoom, { duration: 0.8 });
    const hit = tambonAt(place.lon, place.lat);
    if (hit) {
      setSelectedGid(hit.feature.properties.GID_3);
      setDrawerOpen(true);
    }
  };

  const flyToUser = () => {
    const map = mapRef.current;
    if (!map) return;
    if (!userLoc) {
      // Re-request geolocation if we don't have it yet
      if (typeof navigator !== "undefined" && navigator.geolocation) {
        setGeoStatus("asking");
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            setUserLoc([pos.coords.longitude, pos.coords.latitude]);
            setGeoStatus("granted");
            map.flyTo([pos.coords.latitude, pos.coords.longitude], 13, { duration: 0.7 });
          },
          () => setGeoStatus("denied"),
          { enableHighAccuracy: false, maximumAge: 5 * 60_000, timeout: 10_000 },
        );
      }
      return;
    }
    const [lng, lat] = userLoc;
    map.flyTo([lat, lng], 13, { duration: 0.7 });
    if (userRow) setSelectedGid(userRow.feature.properties.GID_3);
  };

  // Top-N risk list for drawer
  const topRiskList = useMemo(() => sortedRows.slice(0, 5), [sortedRows]);

  // ─── Render ──────────────────────────────────────────────────
  return (
    <div className="ff-shell">
      <div className="ff-map" ref={mapElementRef} />

      {/* Top hero ribbon */}
      <HeroRibbon
        row={heroRow}
        userRow={userRow}
        status={geoStatus}
        userPlace={userPlace}
        outsideCoverage={outsideCoverage}
        searchQ={searchQ}
        onSearchChange={setSearchQ}
        geoResults={geoResults}
        geoSearching={geoSearching}
        onPlacePick={(place) => {
          setSearchQ("");
          setGeoResults(null);
          flyToPlace(place);
        }}
        loadError={loadError}
        copy={copy}
      />

      {/* Left mode picker + layer toggles */}
      <div
        className="desktop-only"
        style={{
          position: "absolute",
          top: 88,
          left: 16,
          width: 268,
          zIndex: 18,
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div className="glass mode">
          {(["live", "static", "wetness"] as LayerMode[]).map((m) => {
            const meta = layerModes[m];
            const Icon = m === "live" ? AlertTriangle : m === "wetness" ? Droplets : Mountain;
            const isActive = m === layerMode;
            return (
              <button
                key={m}
                className={`mode-item ${isActive ? "active" : ""}`}
                onClick={() => setLayerMode(isActive ? null : m)}
                title={isActive ? "คลิกอีกครั้งเพื่อปิดเลเยอร์" : meta.description}
              >
                <span className="mi-glyph">
                  <Icon size={20} strokeWidth={2} />
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="mi-label">{meta.label}</span>
                  <span className="mi-desc">{meta.description}</span>
                </span>
                <span
                  className="mi-sw"
                  aria-hidden
                  style={{
                    width: 28,
                    height: 16,
                    borderRadius: 999,
                    background: isActive ? "var(--accent)" : "rgba(120,200,200,0.18)",
                    position: "relative",
                    flex: "none",
                    transition: "background 0.15s",
                  }}
                >
                  <span
                    style={{
                      position: "absolute",
                      top: 2,
                      left: isActive ? 14 : 2,
                      width: 12,
                      height: 12,
                      borderRadius: "50%",
                      background: isActive ? "var(--bg)" : "var(--ink-2)",
                      transition: "left 0.15s, background 0.15s",
                    }}
                  />
                </span>
              </button>
            );
          })}
        </div>

        <div className="glass" style={{ padding: 6 }}>
          <div className="caps" style={{ padding: "6px 10px 4px" }}>
            เลเยอร์เพิ่มเติม
          </div>
          <LayerSwitch
            on={showRainOverlay}
            disabled={!rainLayer}
            label="เรดาร์ฝน"
            hint={rainLayer ? `RainViewer · ${formatTimeBKK(rainLayer.frameTime)}` : "ไม่มีข้อมูล"}
            icon={<Radar size={18} strokeWidth={2} />}
            onClick={() => setShowRainOverlay((v) => !v)}
          />
          <LayerSwitch
            on={showRainStations}
            disabled={!rainStations}
            label="ฝนสถานีตรวจวัด"
            hint={
              rainStations
                ? `HII · ${rainStations.length} สถานี · ฝน 24 ชม.`
                : "ไม่มีข้อมูล"
            }
            icon={<Droplets size={18} strokeWidth={2} />}
            onClick={() => setShowRainStations((v) => !v)}
          />
          <LayerSwitch
            on={showWaterStations}
            disabled={!waterStations}
            label="น้ำท่าสถานีตรวจวัด"
            hint={
              waterStations
                ? (() => {
                    const over = waterStations.filter(
                      (s) => Number(s.storage_percent) >= 100,
                    ).length;
                    return over > 0
                      ? `HII · ${waterStations.length} สถานี · ล้นตลิ่ง ${over}`
                      : `HII · ${waterStations.length} สถานี · เทียบตลิ่ง`;
                  })()
                : "ไม่มีข้อมูล"
            }
            icon={<Waves size={18} strokeWidth={2} />}
            onClick={() => setShowWaterStations((v) => !v)}
          />
          <LayerSwitch
            on={showBuildings}
            disabled={!buildingsMeta}
            label="บ้านเรือน"
            hint={
              buildingsMeta
                ? `${formatNumber(buildingsMeta.total_buildings)} หลัง · Open Buildings v3`
                : "ไม่มีข้อมูล"
            }
            icon={<Building2 size={18} strokeWidth={2} />}
            onClick={() => setShowBuildings((v) => !v)}
          />
          <Link
            href="/maesai"
            className="toggle"
            style={{ textDecoration: "none" }}
          >
            <span className="tg-glyph"><Waves size={18} strokeWidth={2} /></span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span className="tg-label">เฝ้าระวังแม่สาย</span>
              <span className="tg-hint">
                {maeSaiBridge?.sp != null
                  ? `สะพานมิตรภาพ ${maeSaiBridge.sp.toFixed(0)}% ของตลิ่ง · เปิดหน้าเต็ม`
                  : "แม่น้ำสาย · ต้นน้ำ→สะพาน"}
              </span>
            </span>
            <ChevronRight size={15} style={{ color: "var(--ink-3)", flex: "none" }} />
          </Link>
        </div>
      </div>

      {/* Right drawer */}
      {drawerOpen && selectedRow ? (
        <Drawer
          row={selectedRow}
          isUser={selectedRow === userRow}
          onClose={() => setDrawerOpen(false)}
          methodOpen={methodOpen}
          onToggleMethod={() => setMethodOpen((v) => !v)}
          methodSteps={methodSteps}
          sources={sources}
          topRiskList={topRiskList}
          onPickRow={(gid) => flyToTambon(gid)}
        />
      ) : null}

      {/* Map control cluster — basemap, location, refresh */}
      <div
        className="desktop-only"
        style={{
          position: "absolute",
          left: 16,
          bottom: 80,
          zIndex: 17,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div className="glass" style={{ padding: 4, display: "flex", flexDirection: "column", gap: 2 }}>
          <button
            onClick={flyToUser}
            title="ไปที่ตำแหน่งของคุณ"
            aria-label="ไปที่ตำแหน่งของคุณ"
            style={controlBtnStyle(userLoc !== null)}
          >
            <Locate size={18} strokeWidth={2} />
          </button>
          <button
            onClick={triggerRefresh}
            disabled={refreshing}
            title="รีเฟรชข้อมูลฝน + เรดาร์"
            aria-label="refresh"
            style={controlBtnStyle(false, refreshing)}
          >
            <RefreshCw
              size={18}
              strokeWidth={2}
              style={{ animation: refreshing ? "ff-spin 1s linear infinite" : undefined }}
            />
          </button>
        </div>

        <div className="glass" style={{ padding: 4 }}>
          <div className="caps" style={{ padding: "4px 8px 2px", display: "flex", alignItems: "center", gap: 6 }}>
            <Layers size={11} strokeWidth={2.4} /> Basemap
          </div>
          {(Object.keys(BASEMAPS) as Basemap[]).map((b) => (
            <button
              key={b}
              onClick={() => setBasemap(b)}
              style={{
                display: "block",
                width: "100%",
                padding: "6px 10px",
                fontSize: 12,
                fontWeight: 600,
                color: basemap === b ? "var(--ink)" : "var(--ink-3)",
                background: basemap === b ? "rgba(64,224,189,0.12)" : "transparent",
                border: 0,
                borderRadius: 6,
                textAlign: "left",
                cursor: "pointer",
              }}
            >
              {BASEMAPS[b].label}
            </button>
          ))}
        </div>
      </div>

      {/* Bottom legend */}
      <div
        style={{
          position: "absolute",
          left: 16,
          right: drawerOpen ? 412 : 16,
          bottom: 16,
          zIndex: 16,
        }}
        className="desktop-only"
      >
        <div className="glass legend">
          <span className="legend-chip">
            <span
              className="sw"
              style={{
                background: "transparent",
                border: `2px solid ${riskMeta.severe.color}`,
                width: 14,
                height: 14,
              }}
            />
            ขอบแดง = ตำบลเสี่ยงสูงสุดตอนนี้
          </span>
          <span className="legend-meta">
            {refreshedAt
              ? `อัปเดต ${formatTimeBKK(refreshedAt.toISOString())}`
              : wetness
                ? `ดิน ${formatTimeBKK(wetness.generated_at)}`
                : "—"}
            {rainLayer ? ` · เรดาร์ ${formatTimeBKK(rainLayer.frameTime)}` : ""}
          </span>
        </div>
      </div>

      {/* Radar playback control — visible whenever the animated radar is on */}
      {showRainOverlay && rainLayer?.frames?.length ? (
        <div
          className="glass"
          style={{
            position: "absolute",
            left: "50%",
            transform: "translateX(-50%)",
            bottom: 68,
            zIndex: 19,
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 14px",
            borderRadius: 999,
            maxWidth: "calc(100% - 24px)",
          }}
        >
          <button
            onClick={() => setRadarPlaying((v) => !v)}
            aria-label={radarPlaying ? "หยุด" : "เล่น"}
            style={{
              width: 30,
              height: 30,
              borderRadius: 999,
              border: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(64,224,189,0.16)",
              color: "var(--accent)",
              cursor: "pointer",
              flex: "none",
            }}
          >
            {radarPlaying ? <Pause size={14} strokeWidth={2.4} /> : <Play size={14} strokeWidth={2.4} />}
          </button>
          <input
            type="range"
            min={0}
            max={rainLayer.frames.length - 1}
            value={Math.min(radarIdx, rainLayer.frames.length - 1)}
            onChange={(e) => {
              setRadarPlaying(false);
              setRadarIdx(Number(e.target.value));
            }}
            style={{ width: 150, accentColor: "var(--accent)" }}
            aria-label="เลือกเวลาเรดาร์"
          />
          <span className="num-mono" style={{ fontSize: 12, color: "var(--ink)", whiteSpace: "nowrap" }}>
            {formatTimeBKK(
              new Date(rainLayer.frames[Math.min(radarIdx, rainLayer.frames.length - 1)].time * 1000).toISOString(),
            )}{" "}
            น.
          </span>
          {rainLayer.frames[Math.min(radarIdx, rainLayer.frames.length - 1)].nowcast ? (
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "var(--r-high)",
                background: "rgba(253,174,97,0.14)",
                border: "1px solid rgba(253,174,97,0.4)",
                borderRadius: 999,
                padding: "2px 8px",
                whiteSpace: "nowrap",
              }}
            >
              คาดการณ์
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Mobile-only floating action cluster — exposes the controls that
          live in the desktop side panels. */}
      <div className="mobile-only mobile-fab">
        <button
          onClick={flyToUser}
          aria-label="ตำแหน่งของฉัน"
          className={userLoc ? "on" : ""}
          title="ไปที่ตำแหน่งของคุณ"
        >
          <Locate size={18} />
        </button>
        <button
          onClick={triggerRefresh}
          aria-label="รีเฟรช"
          title="รีเฟรชข้อมูลฝน"
        >
          <RefreshCw
            size={18}
            style={{ animation: refreshing ? "ff-spin 1s linear infinite" : undefined }}
          />
        </button>
        <Link
          href="/maesai"
          aria-label="เฝ้าระวังแม่สาย"
          title="เฝ้าระวังแม่สาย"
        >
          <Waves size={18} />
        </Link>
        <button
          onClick={() => setMobileLayersOpen(true)}
          className={mobileLayersOpen ? "on" : ""}
          aria-label="เลเยอร์ทั้งหมด"
          title="เลเยอร์ + แผนที่พื้นฐาน"
        >
          <Layers size={18} />
        </button>
        <button
          onClick={() => setDrawerOpen((v) => !v)}
          className={drawerOpen ? "on" : ""}
          aria-label="เปิด/ปิดรายละเอียด"
          title="รายละเอียดตำบล"
        >
          <Info size={18} />
        </button>
      </div>

      {/* Mobile side menu — the desktop left panel, slid in from the left.
          Opened by the ☰ in the mode strip or the Layers FAB. */}
      {mobileLayersOpen ? (
        <>
          <div
            className="mobile-only"
            onClick={() => setMobileLayersOpen(false)}
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.5)",
              zIndex: 38,
            }}
          />
          <div className="mobile-only glass mobile-side-menu">
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                paddingBottom: 12,
                borderBottom: "1px solid var(--hairline)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <AlertTriangle size={20} style={{ color: "var(--accent)" }} />
                <span style={{ fontWeight: 700, fontSize: 15, letterSpacing: -0.2 }}>
                  FLASHFLOOD
                </span>
              </div>
              <button
                onClick={() => setMobileLayersOpen(false)}
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 15,
                  background: "rgba(255,255,255,0.10)",
                  color: "var(--ink)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  border: 0,
                  cursor: "pointer",
                }}
                aria-label="ปิดเมนู"
              >
                <X size={15} />
              </button>
            </div>

            {/* Search inside the side menu — the hero search is hidden on
                small screens, but Nominatim coverage makes it too useful
                to bury. */}
            <div style={{ marginTop: 14, position: "relative" }}>
              <div className="search">
                <Search size={14} style={{ color: "var(--ink-3)", flex: "none" }} />
                <input
                  placeholder="ค้นหา จังหวัด / อำเภอ / ตำบล / หมู่บ้าน"
                  value={searchQ}
                  onChange={(e) => setSearchQ(e.target.value)}
                />
                {geoSearching ? (
                  <RefreshCw
                    size={13}
                    style={{ color: "var(--ink-3)", flex: "none", animation: "ff-spin 1s linear infinite" }}
                  />
                ) : null}
              </div>
              {searchQ.trim().length >= 2 && geoResults !== null ? (
                <div style={{ marginTop: 6, maxHeight: "40vh", overflowY: "auto" }}>
                  {geoResults.length === 0 ? (
                    <div style={{ padding: "12px 10px", fontSize: 13, color: "var(--ink-3)", textAlign: "center" }}>
                      ไม่พบพื้นที่ &ldquo;{searchQ.trim()}&rdquo;
                    </div>
                  ) : (
                    geoResults.map((place) => (
                      <button
                        key={place.id}
                        onClick={() => {
                          setSearchQ("");
                          setGeoResults(null);
                          setMobileLayersOpen(false);
                          flyToPlace(place);
                        }}
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          gap: 10,
                          padding: "9px 8px",
                          borderRadius: 8,
                          color: "var(--ink)",
                          width: "100%",
                          textAlign: "left",
                          background: "transparent",
                          border: 0,
                          cursor: "pointer",
                        }}
                      >
                        <MapPin size={14} style={{ color: "var(--accent)", flex: "none", marginTop: 2 }} />
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ display: "block", fontSize: 13, fontWeight: 600 }}>{place.label}</span>
                          <span
                            style={{
                              display: "block",
                              fontSize: 11,
                              color: "var(--ink-3)",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {place.detail || place.full}
                          </span>
                        </span>
                      </button>
                    ))
                  )}
                </div>
              ) : null}
            </div>

            <div className="caps" style={{ marginTop: 14 }}>เลือกมุมมอง</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 6 }}>
              {(["live", "static", "wetness"] as LayerMode[]).map((m) => {
                const meta = layerModes[m];
                const Icon = m === "live" ? AlertTriangle : m === "wetness" ? Droplets : Mountain;
                const isActive = m === layerMode;
                return (
                  <button
                    key={m}
                    className={`mode-item ${isActive ? "active" : ""}`}
                    onClick={() => setLayerMode(isActive ? null : m)}
                  >
                    <span className="mi-glyph">
                      <Icon size={20} strokeWidth={2} />
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span className="mi-label">{meta.label}</span>
                      <span className="mi-desc">{meta.description}</span>
                    </span>
                    <span
                      aria-hidden
                      style={{
                        width: 28,
                        height: 16,
                        borderRadius: 999,
                        background: isActive ? "var(--accent)" : "rgba(120,200,200,0.18)",
                        position: "relative",
                        flex: "none",
                        transition: "background 0.15s",
                      }}
                    >
                      <span
                        style={{
                          position: "absolute",
                          top: 2,
                          left: isActive ? 14 : 2,
                          width: 12,
                          height: 12,
                          borderRadius: "50%",
                          background: isActive ? "var(--bg)" : "var(--ink-2)",
                          transition: "left 0.15s, background 0.15s",
                        }}
                      />
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="caps" style={{ marginTop: 16 }}>เลเยอร์เพิ่มเติม</div>
            <LayerSwitch
              on={showRainOverlay}
              disabled={!rainLayer}
              label="เรดาร์ฝน"
              hint={rainLayer ? `RainViewer · ${formatTimeBKK(rainLayer.frameTime)}` : "ไม่มีข้อมูล"}
              icon={<Radar size={18} strokeWidth={2} />}
              onClick={() => setShowRainOverlay((v) => !v)}
            />
            <LayerSwitch
              on={showRainStations}
              disabled={!rainStations}
              label="ฝนสถานีตรวจวัด"
              hint={rainStations ? `HII · ${rainStations.length} สถานี` : "ไม่มีข้อมูล"}
              icon={<Droplets size={18} strokeWidth={2} />}
              onClick={() => setShowRainStations((v) => !v)}
            />
            <LayerSwitch
              on={showWaterStations}
              disabled={!waterStations}
              label="น้ำท่าสถานีตรวจวัด"
              hint={waterStations ? `HII · ${waterStations.length} สถานี` : "ไม่มีข้อมูล"}
              icon={<Waves size={18} strokeWidth={2} />}
              onClick={() => setShowWaterStations((v) => !v)}
            />
            <LayerSwitch
              on={showBuildings}
              disabled={!buildingsMeta}
              label="บ้านเรือน"
              hint={buildingsMeta ? `${formatNumber(buildingsMeta.total_buildings)} หลัง` : "ไม่มีข้อมูล"}
              icon={<Building2 size={18} strokeWidth={2} />}
              onClick={() => setShowBuildings((v) => !v)}
            />
          <Link
            href="/maesai"
            className="toggle"
            style={{ textDecoration: "none" }}
          >
            <span className="tg-glyph"><Waves size={18} strokeWidth={2} /></span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span className="tg-label">เฝ้าระวังแม่สาย</span>
              <span className="tg-hint">
                {maeSaiBridge?.sp != null
                  ? `สะพานมิตรภาพ ${maeSaiBridge.sp.toFixed(0)}% ของตลิ่ง · เปิดหน้าเต็ม`
                  : "แม่น้ำสาย · ต้นน้ำ→สะพาน"}
              </span>
            </span>
            <ChevronRight size={15} style={{ color: "var(--ink-3)", flex: "none" }} />
          </Link>


            <div className="caps" style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 6 }}>
              <Layers size={11} strokeWidth={2.4} /> Basemap
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              {(Object.keys(BASEMAPS) as Basemap[]).map((b) => (
                <button
                  key={b}
                  onClick={() => setBasemap(b)}
                  style={{
                    flex: 1,
                    padding: "10px 8px",
                    fontSize: 13,
                    fontWeight: 600,
                    color: basemap === b ? "var(--ink)" : "var(--ink-3)",
                    background: basemap === b ? "rgba(64,224,189,0.16)" : "rgba(120,200,200,0.06)",
                    border: `1px solid ${basemap === b ? "rgba(64,224,189,0.45)" : "var(--hairline-2)"}`,
                    borderRadius: 8,
                    cursor: "pointer",
                  }}
                >
                  {BASEMAPS[b].label}
                </button>
              ))}
            </div>
          </div>
        </>
      ) : null}

      {/* Mobile mode picker — sits directly below the hero so it's always
          visible even when the bottom-sheet drawer is open (drawer z=30
          covered the old bottom-positioned picker). */}
      <div
        className="mobile-only mobile-mode-picker"
        style={{
          position: "absolute",
          left: 8,
          right: 8,
          top: 78,
          zIndex: 23,
        }}
      >
        <div className="glass" style={{ display: "flex", padding: 3, gap: 2 }}>
          <button
            className="mode-item"
            style={{ padding: "7px 9px", borderRadius: 7, flex: "none", color: "var(--ink-2)" }}
            onClick={() => setMobileLayersOpen(true)}
            title="เมนูทั้งหมด"
            aria-label="เปิดเมนู"
          >
            <Menu size={15} />
          </button>
          {(["live", "static", "wetness"] as LayerMode[]).map((m) => {
            const meta = layerModes[m];
            const isActive = m === layerMode;
            return (
              <button
                key={m}
                className={`mode-item ${isActive ? "active" : ""}`}
                style={{
                  flex: 1,
                  justifyContent: "center",
                  padding: "7px 4px",
                  fontSize: 12,
                  color: isActive ? "var(--ink)" : "var(--ink-3)",
                  borderRadius: 7,
                }}
                onClick={() => setLayerMode(isActive ? null : m)}
              >
                <span className="mi-label" style={{ fontSize: 12 }}>
                  {meta.label}
                </span>
              </button>
            );
          })}
          <button
            className="mode-item"
            style={{
              padding: "7px 10px",
              fontSize: 12,
              color: layerMode === null ? "var(--accent)" : "var(--ink-3)",
              borderRadius: 7,
              background: layerMode === null ? "rgba(64,224,189,0.14)" : "transparent",
            }}
            onClick={() => setLayerMode(null)}
            title="ปิดทุกเลเยอร์ความเสี่ยง"
            aria-label="ปิดเลเยอร์"
          >
            <X size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── HeroRibbon ──────────────────────────────────────────────────

function HeroRibbon({
  row,
  userRow,
  status,
  userPlace,
  outsideCoverage,
  searchQ,
  onSearchChange,
  geoResults,
  geoSearching,
  onPlacePick,
  loadError,
  copy,
}: {
  row: TambonRow | null;
  userRow: TambonRow | null;
  status: GeoStatus;
  userPlace: GeoPlace | null;
  outsideCoverage: boolean;
  searchQ: string;
  onSearchChange: (v: string) => void;
  geoResults: GeoPlace[] | null;
  geoSearching: boolean;
  onPlacePick: (place: GeoPlace) => void;
  loadError: string | null;
  copy: typeof productCopy;
}) {
  const tier: RiskTier = row?.liveTier ?? "low";
  const action = tierActionTH(tier);
  const pulseClass = tier === "high" || tier === "severe" ? "pulse" : "";
  const isUser = row && userRow && row.feature.properties.GID_3 === userRow.feature.properties.GID_3;
  const liveLabel = isUser ? "บ้านคุณอยู่ที่" : "ตำบลที่เลือก";

  const statusMsg =
    status === "denied"
      ? "ไม่ได้รับอนุญาตเข้าถึงตำแหน่ง"
      : status === "unsupported"
        ? "เบราว์เซอร์ไม่รองรับ GPS"
        : null;

  return (
    <div
      className={`hero hero-${tier} ${pulseClass} hero-mobile`}
      style={{ position: "absolute", top: 0, left: 0, right: 0, zIndex: 22, padding: "12px 16px" }}
    >
      <div className="hero-row" style={{ display: "flex", alignItems: "center", gap: 14, minHeight: 44, flexWrap: "nowrap" }}>
        {/* Wordmark — desktop only */}
        <div
          className="hero-wordmark"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            paddingRight: 14,
            borderRight: "1px solid var(--hairline-2)",
          }}
        >
          <span style={{ width: 22, height: 22, color: "var(--accent)", display: "flex", flex: "none" }}>
            <AlertTriangle size={22} strokeWidth={2.2} />
          </span>
          <span style={{ fontWeight: 700, letterSpacing: -0.2, fontSize: 14, whiteSpace: "nowrap" }}>
            FLASHFLOOD
            <span className="hero-wordmark-sub" style={{ color: "var(--ink-3)", fontWeight: 400 }}>
              {" "}· {copy.region}
            </span>
          </span>
        </div>

        {/* Risk text + tier */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 10, flexWrap: "nowrap" }}>
          {row ? (
            <>
              <span style={{ display: "flex", alignItems: "center", flex: "none" }}>
                <MapPin size={16} style={{ color: "var(--accent)" }} />
                <span
                  className="hero-locate-label"
                  style={{
                    color: "var(--ink-2)",
                    fontSize: 13,
                    whiteSpace: "nowrap",
                    marginLeft: 6,
                  }}
                >
                  {liveLabel}
                </span>
              </span>
              <span className="hero-tambon" style={{ fontSize: 15.5, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: "1 1 auto", minWidth: 0 }}>
                ตำบล{row.feature.properties.NAME_3}
                <span style={{ color: "var(--ink-2)", fontWeight: 500 }}>
                  {" "}อ.{amphoeName(row.feature.properties)} · จ.{thaiName(row.feature.properties.NAME_1)}
                </span>
              </span>
              <span className={`tier ${TIER_PILL[tier]} hero-tier-pill`} style={{ flex: "none" }}>
                {TIER_TH[tier]}
              </span>
              <span
                className="hero-action"
                style={{
                  color: "var(--ink-2)",
                  fontSize: 13,
                  minWidth: 0,
                  flex: "1 1 auto",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                · {action}
              </span>
            </>
          ) : outsideCoverage ? (
            <span
              style={{
                color: "var(--ink-2)",
                fontSize: 13,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              <MapPin size={14} style={{ color: "var(--r-high)", verticalAlign: "-2px" }} />{" "}
              {userPlace ? (
                <>
                  คุณอยู่ที่{" "}
                  <b style={{ color: "var(--ink)" }}>{userPlace.label}</b>
                  {userPlace.detail ? ` · ${userPlace.detail}` : ""} —{" "}
                </>
              ) : null}
              นอกพื้นที่ให้บริการ (เฉพาะ 9 จังหวัดภาคเหนือ)
            </span>
          ) : (
            <span style={{ color: "var(--ink-2)", fontSize: 13 }}>
              {statusMsg ? `${statusMsg} — เลือกตำบลของคุณจากแผนที่หรือค้นหา` : "กำลังโหลด…"}
            </span>
          )}
        </div>

        {/* Search — OpenStreetMap Nominatim, Thailand only */}
        <div className="hero-search" style={{ position: "relative", flex: "none" }}>
          <div className="search">
            <Search size={14} style={{ color: "var(--ink-3)", flex: "none" }} />
            <input
              placeholder="ค้นหา จังหวัด / อำเภอ / ตำบล / หมู่บ้าน"
              value={searchQ}
              onChange={(e) => onSearchChange(e.target.value)}
            />
            {geoSearching ? (
              <RefreshCw
                size={13}
                style={{ color: "var(--ink-3)", flex: "none", animation: "ff-spin 1s linear infinite" }}
              />
            ) : null}
          </div>
          {searchQ.trim().length >= 2 && geoResults !== null ? (
            <div
              className="glass"
              style={{
                position: "absolute",
                top: "calc(100% + 6px)",
                right: 0,
                left: 0,
                padding: 6,
                maxHeight: "min(60vh, 380px)",
                overflowY: "auto",
                zIndex: 30,
              }}
            >
              {geoResults.length === 0 ? (
                <div style={{ padding: "14px 12px", fontSize: 13, color: "var(--ink-3)", textAlign: "center" }}>
                  ไม่พบพื้นที่ &ldquo;{searchQ.trim()}&rdquo;
                  <div style={{ fontSize: 11, marginTop: 4 }}>ลองพิมพ์ชื่ออำเภอหรือจังหวัดแทน</div>
                </div>
              ) : (
                geoResults.map((place) => (
                  <button
                    key={place.id}
                    onClick={() => onPlacePick(place)}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 10,
                      padding: "9px 10px",
                      borderRadius: 8,
                      color: "var(--ink)",
                      width: "100%",
                      textAlign: "left",
                      background: "transparent",
                      border: 0,
                      cursor: "pointer",
                    }}
                  >
                    <MapPin size={14} style={{ color: "var(--accent)", flex: "none", marginTop: 2 }} />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: "block", fontSize: 13, fontWeight: 600 }}>{place.label}</span>
                      <span
                        style={{
                          display: "block",
                          fontSize: 11,
                          color: "var(--ink-3)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={place.full}
                      >
                        {place.detail || place.full}
                      </span>
                    </span>
                  </button>
                ))
              )}
              <div
                style={{
                  fontSize: 10,
                  color: "var(--ink-4)",
                  textAlign: "right",
                  padding: "6px 8px 2px",
                }}
              >
                ค้นหาโดย OpenStreetMap Nominatim
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {loadError ? (
        <div
          style={{
            marginTop: 8,
            padding: 8,
            background: "rgba(215,48,39,0.18)",
            border: "1px solid rgba(215,48,39,0.5)",
            borderRadius: 8,
            color: "#ffd9d9",
            fontSize: 12,
          }}
        >
          โหลดข้อมูลไม่สำเร็จ: {loadError}
        </div>
      ) : null}
    </div>
  );
}

// ─── LayerSwitch ────────────────────────────────────────────────

function LayerSwitch({
  on,
  disabled,
  label,
  hint,
  icon,
  onClick,
}: {
  on: boolean;
  disabled?: boolean;
  label: string;
  hint: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      className={`toggle ${on ? "on" : ""}`}
      style={{ opacity: disabled ? 0.4 : 1, cursor: disabled ? "not-allowed" : "pointer" }}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="tg-glyph">{icon}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span className="tg-label">{label}</span>
        <span className="tg-hint">{hint}</span>
      </span>
      <span className="tg-sw" />
    </button>
  );
}

// ─── Drawer ─────────────────────────────────────────────────────

function Drawer({
  row,
  isUser,
  onClose,
  methodOpen,
  onToggleMethod,
  methodSteps,
  sources,
  topRiskList,
  onPickRow,
}: {
  row: TambonRow;
  isUser: boolean;
  onClose: () => void;
  methodOpen: boolean;
  onToggleMethod: () => void;
  methodSteps: string[];
  sources: SourceNote[];
  topRiskList: TambonRow[];
  onPickRow: (gid: string) => void;
}) {
  const p = row.feature.properties;
  const tier = row.liveTier;

  // Contribution components — derived from per-tambon row values
  const terrain = Math.min(1, row.staticNorm);
  const wet = Math.min(1, row.wetnessNorm);
  const precip = Math.min(1, row.precipNorm);

  return (
    <aside
      className="glass drawer-mobile"
      style={{
        position: "absolute",
        top: 88,
        right: 16,
        bottom: 16,
        width: 384,
        zIndex: 18,
        padding: "16px 18px 18px",
        borderRadius: 16,
        display: "flex",
        flexDirection: "column",
        gap: 14,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 8,
          paddingBottom: 12,
          borderBottom: "1px solid var(--hairline)",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: -0.3, lineHeight: 1.2 }}>
            ตำบล{p.NAME_3}
          </div>
          <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 3, display: "flex", alignItems: "center", gap: 8 }}>
            อ.{amphoeName(p)} · จ.{thaiName(p.NAME_1)}
            {isUser ? (
              <span
                style={{
                  color: "var(--accent)",
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: "0.10em",
                  textTransform: "uppercase",
                  background: "rgba(64,224,189,0.12)",
                  border: "1px solid rgba(64,224,189,0.35)",
                  borderRadius: 999,
                  padding: "2px 8px",
                }}
              >
                ที่ตั้งของคุณ
              </span>
            ) : null}
          </div>
        </div>
        <button
          onClick={onClose}
          style={{
            width: 28,
            height: 28,
            borderRadius: 14,
            background: "rgba(255,255,255,0.10)",
            color: "var(--ink)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: 0,
            cursor: "pointer",
            flex: "none",
          }}
          aria-label="ปิด"
        >
          <X size={14} />
        </button>
      </div>

      <div className="drawer-scroll" style={{ display: "flex", flexDirection: "column", gap: 18, paddingRight: 4 }}>
        {/* Tier banner — severity + what it means, one card */}
        <div className={`tier-banner tbn-${tier}`}>
          <div className="tb-head">
            <div className="tb-glyph">{tierGlyph(tier)}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="tb-label">{TIER_TH[tier]}</div>
              <div className="tb-en">{TIER_EN[tier]} · flash flood risk</div>
            </div>
          </div>
          <div className="tb-action">{tierActionTH(tier)}</div>
        </div>

        {/* Contributions */}
        <div>
          <div className="dw-section-title">ทำไมถึงระดับนี้</div>
          <div className="contrib">
            <ContribRow name="ภูมิประเทศ" en="Terrain" cls="terrain" pct={terrain * 100} />
            <ContribRow
              name="ดินอิ่มน้ำ"
              en="Wetness"
              cls="wet"
              pct={wet * 100}
              extra={
                row.wetnessMm !== null && row.wetnessMm > 0
                  ? wet > 0.66
                    ? "ฝนสะสม 7 วันสูง"
                    : wet > 0.33
                      ? "ฝนสะสม 7 วันปานกลาง"
                      : "ฝนสะสม 7 วันต่ำ"
                  : undefined
              }
            />
            <ContribRow
              name="ฝนตอนนี้"
              en="Precip"
              cls="precip"
              pct={precip * 100}
              extra={
                row.precipMmPerHr > 5
                  ? "ฝนตกหนัก"
                  : row.precipMmPerHr > 1
                    ? "ฝนตกปานกลาง"
                    : row.precipMmPerHr > 0
                      ? "ฝนพรำ"
                      : undefined
              }
            />
          </div>
        </div>

        {/* Buildings exposure — inventory count, not a risk score. */}
        {p.buildings !== undefined ? (
          <div className="dw-card" style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span
              style={{
                width: 38,
                height: 38,
                borderRadius: 10,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "rgba(64,224,189,0.10)",
                color: "var(--accent)",
                flex: "none",
              }}
            >
              <Building2 size={19} strokeWidth={2} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="dw-section-title" style={{ marginBottom: 2 }}>
                บ้านเรือนในตำบล
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.1 }}>
                <span className="num-mono">{formatNumber(p.buildings)}</span>
                <span style={{ fontSize: 12, color: "var(--ink-3)", marginLeft: 6, fontWeight: 500 }}>
                  หลัง · Open Buildings v3
                </span>
              </div>
            </div>
          </div>
        ) : null}

        {/* Top risk */}
        <div>
          <div className="dw-section-title">ตำบลเสี่ยงสูงตอนนี้</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {topRiskList.map((r) => {
              const t = r.liveTier;
              const isCurrent = r.feature.properties.GID_3 === p.GID_3;
              return (
                <button
                  key={r.feature.properties.GID_3}
                  onClick={() => onPickRow(r.feature.properties.GID_3)}
                  className={`dw-row ${isCurrent ? "current" : ""}`}
                >
                  <span
                    style={{
                      width: 3,
                      alignSelf: "stretch",
                      borderRadius: 2,
                      background: riskMeta[t].color,
                      flex: "none",
                    }}
                  />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span
                      style={{
                        display: "block",
                        fontSize: 13,
                        fontWeight: 600,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      ตำบล{r.feature.properties.NAME_3}
                    </span>
                    <span style={{ display: "block", fontSize: 11, color: "var(--ink-3)", marginTop: 1 }}>
                      อ.{amphoeName(r.feature.properties)} · {thaiName(r.feature.properties.NAME_1)}
                    </span>
                  </span>
                  <span className={`tier ${TIER_PILL[t]}`} style={{ fontSize: 10.5, padding: "3px 8px" }}>
                    {TIER_TH[t]}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Method + sources collapsible */}
        <button
          onClick={onToggleMethod}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "10px 14px",
            borderRadius: 10,
            background: "rgba(120,200,200,0.06)",
            border: "1px solid var(--hairline-2)",
            color: "var(--ink-2)",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Info size={14} style={{ color: "var(--ink-3)" }} />
            วิธีคำนวณ + แหล่งข้อมูล
          </span>
          <ChevronDown
            size={14}
            style={{ transform: methodOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}
          />
        </button>

        {methodOpen ? (
          <div
            style={{
              padding: 14,
              borderRadius: 10,
              background: "rgba(7,19,24,0.55)",
              border: "1px solid var(--hairline)",
              fontSize: 12,
              lineHeight: 1.65,
              color: "var(--ink-2)",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {methodSteps.slice(0, 5).map((step, i) => (
                <div key={step} style={{ display: "flex", gap: 8 }}>
                  <span className="num-mono" style={{ color: "var(--accent)" }}>
                    {i + 1}
                  </span>
                  <span>{step}</span>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
              {sources.map((src) => (
                <a
                  key={src.href}
                  href={src.href}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "var(--ink-2)", textDecoration: "underline", textDecorationColor: "var(--ink-4)" }}
                >
                  {src.label}
                </a>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </aside>
  );
}

function ContribRow({
  name,
  en,
  cls,
  pct,
  extra,
}: {
  name: string;
  en: string;
  cls: string;
  pct: number;
  extra?: string;
}) {
  return (
    <div className="contrib-row">
      <div className="contrib-head">
        <span className="name">
          {name} <small>{en}</small>
        </span>
        {extra ? (
          <span style={{ color: "var(--ink-2)", fontSize: 11 }}>{extra}</span>
        ) : null}
      </div>
      <div className="contrib-track">
        <div className={`contrib-fill ${cls}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function controlBtnStyle(active: boolean, disabled = false): React.CSSProperties {
  return {
    width: 38,
    height: 38,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    border: 0,
    borderRadius: 8,
    background: active ? "rgba(64,224,189,0.18)" : "rgba(120,200,200,0.06)",
    color: active ? "var(--accent)" : "var(--ink-2)",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.55 : 1,
  };
}

// keep imports referenced even if not used in this version
void tierFromNorm;
