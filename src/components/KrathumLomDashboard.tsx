"use client";

// Operations view for Krathum Lom municipality staff.
//
//   Header   — live clock and when the next automatic refresh lands
//   KPI row  — the handful of numbers a duty officer checks first
//   Map      — boundary, 11-year satellite flood history, homes, gauges
//   Tabs     — ตอนนี้ (radar + gauges with 24 h trends) · ประวัติ · ข้อมูลที่รอ
//
// Radar: the BMA Nong Khaem radar loop, which TMD republishes. It sits a
// few km from the municipality — far better than RainViewer, whose free
// tier stops at zoom 7 (~1 km pixels) since 2026. The loop is shown as
// published rather than georeferenced onto the map: its projection is not
// documented, and a misplaced overlay would be worse than none.
//
// Trends: HII only serves the latest reading, so pipeline/scripts/
// 19_krathumlom_log.py records every gauge here each 30 min and publishes
// a rolling 7-day log to R2 (the site itself is only redeployed by hand).
//
// History: pipeline/scripts/18_krathumlom_history.py. About half the
// municipality is built-up land the radar satellite cannot see into; the
// page marks it as such everywhere instead of letting it read as "dry".

import {
  ArrowLeft,
  Building2,
  CloudRain,
  Droplets,
  ExternalLink,
  Layers,
  Maximize2,
  Minimize2,
  Radar,
  RefreshCw,
  Satellite,
  Waves,
} from "lucide-react";
import Link from "next/link";
import { ReportsPanel } from "@/components/KrathumLomReports";
import type * as Leaflet from "leaflet";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { haversineKm } from "@/lib/inspect";
import { bankPercentColor, bankPercentLabel } from "@/lib/maesai";
import {
  bankPercentAt,
  bankPercentOf,
  rainIntensityColor,
  rainIntensityLabel,
  THAIWATER_RAIN_24H_URL,
  THAIWATER_WATERLEVEL_URL,
  type ThaiWaterLevelStation,
  type ThaiWaterStation,
} from "@/lib/thaiwater";

const DATA = "/data/krathumlom";
const R2_PUBLIC = "https://pub-3f4b09707ccd46ec948313a3513e3b25.r2.dev";
const LOG_URLS = [`${R2_PUBLIC}/krathumlom_log.jsonl`, "/data/krathumlom_log.jsonl"];
const RADAR_URL = "https://weather.tmd.go.th/pic_bmankLoop.gif";
const RADAR_PAGE = "https://weather.tmd.go.th/bma_nkLoop.php";
/** Municipality office (OSM node 7359270019) — distances are measured from here. */
const CENTRE: [number, number] = [13.7422545, 100.3293329];
const RAIN_RADIUS_KM = 10;
const WATER_RADIUS_KM = 15;
const REFRESH_MS = 5 * 60_000;
const TREND_HOURS = 24;

type HistoryMeta = {
  generated_at: string;
  area_name: string;
  boundary_source: string;
  bounds: [number, number, number, number];
  first_pass: string | null;
  last_pass: string | null;
  passes: number;
  years_span: number;
  tambon_area_rai: number;
  not_observable_share: number;
  flooded_ever_rai: number;
  flooded_2plus_years_rai: number;
  buildings: {
    total: number;
    not_observable: number;
    thin: number;
    never: number;
    y1: number;
    y2_3: number;
    y4_6: number;
    y7plus: number;
    /** Seen flooded in any of the last three calendar years. */
    recent: number;
  };
  recent_from: number;
  classes: { min_years: number; rgba: [number, number, number, number] }[];
  per_year: Record<string, { passes: number; max_flooded_rai: number }>;
  hotspots: {
    lat: number;
    lon: number;
    rai: number;
    max_years: number;
    years: number[];
    buildings: number;
    name: string | null;
  }[];
};

/** One poll of the gauge logger: [id, telemetry time, 1 h rain, 24 h rain] / [id, time, msl]. */
type LogEntry = {
  t: string;
  rain: [number, string | null, number | null, number | null][];
  water: [number, string | null, number | null][];
};
type Point = { t: number; v: number };

type Tab = "now" | "reports" | "history" | "todo";

// Same palette as the PNG classes, for footprints drawn on top of it.
function yearsColor(y: number): string {
  if (y >= 7) return "#a50026";
  if (y >= 4) return "#f46d43";
  if (y >= 2) return "#fdae61";
  return "#fee08b";
}

const TZ = "Asia/Bangkok";
function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    // ThaiWater sends local time without a zone ("2026-09-27 20:00").
    const d = /[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? new Date(iso) : new Date(iso.replace(" ", "T") + "+07:00");
    return new Intl.DateTimeFormat("th-TH", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: TZ,
    }).format(d);
  } catch {
    return iso;
  }
}
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("th-TH", { month: "short", year: "numeric" }).format(new Date(iso));
}

const n0 = (v: number) => new Intl.NumberFormat("th-TH").format(Math.round(v));
const pos = (s: { station: { tele_station_lat: number; tele_station_long: number } }) =>
  [s.station.tele_station_lat, s.station.tele_station_long] as [number, number];

const DIRS = ["เหนือ", "ตะวันออกเฉียงเหนือ", "ตะวันออก", "ตะวันออกเฉียงใต้", "ใต้", "ตะวันตกเฉียงใต้", "ตะวันตก", "ตะวันตกเฉียงเหนือ"];
/** "1.8 กม. ทางตะวันตกเฉียงใต้ของสำนักงาน" — orientation staff can use in the field. */
function fromOffice(lat: number, lon: number): string {
  const dy = lat - CENTRE[0];
  const dx = (lon - CENTRE[1]) * Math.cos((CENTRE[0] * Math.PI) / 180);
  const bearing = (Math.atan2(dx, dy) * 180) / Math.PI;
  const dir = DIRS[Math.round(((bearing + 360) % 360) / 45) % 8];
  return `${haversineKm(CENTRE[0], CENTRE[1], lat, lon).toFixed(1)} กม. ทาง${dir}ของสำนักงาน`;
}

// ─── Sparkline ───────────────────────────────────────────────────

function Sparkline({
  points,
  kind,
  color,
  ref100,
  now,
}: {
  points: Point[];
  kind: "bars" | "line";
  color: string;
  /** Draw a dashed reference at this value (the bank, for % series). */
  ref100?: number;
  now: number;
}) {
  const W = 96;
  const H = 26;
  if (points.length < 2) {
    return <span className="kl-spark-empty">กำลังเก็บข้อมูล</span>;
  }
  const t0 = now - TREND_HOURS * 3600_000;
  const x = (t: number) => ((t - t0) / (now - t0)) * W;
  if (kind === "bars") {
    const max = Math.max(5, ...points.map((p) => p.v)); // 5 mm/h floor keeps drizzle small
    return (
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="kl-spark" aria-hidden>
        <line x1="0" x2={W} y1={H - 0.5} y2={H - 0.5} stroke="var(--hairline-2)" />
        {points.map((p) =>
          p.v > 0 ? (
            <rect key={p.t} x={x(p.t) - 1} y={H - (p.v / max) * H} width="2" height={(p.v / max) * H} fill={rainIntensityColor(p.v)} />
          ) : null,
        )}
      </svg>
    );
  }
  const vs = points.map((p) => p.v).concat(ref100 !== undefined ? [ref100] : []);
  let lo = Math.min(...vs);
  let hi = Math.max(...vs);
  if (hi - lo < 1e-6) {
    lo -= 1;
    hi += 1;
  }
  const y = (v: number) => H - 2 - ((v - lo) / (hi - lo)) * (H - 4);
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="kl-spark" aria-hidden>
      {ref100 !== undefined ? (
        <line x1="0" x2={W} y1={y(ref100)} y2={y(ref100)} stroke="rgba(215,48,39,0.7)" strokeDasharray="2 2" />
      ) : null}
      <path d={d} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(points[points.length - 1].t)} cy={y(points[points.length - 1].v)} r="2" fill={color} />
    </svg>
  );
}

// ─── Main ────────────────────────────────────────────────────────

export function KrathumLomDashboard() {
  const mapEl = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Leaflet.Map | null>(null);
  const LRef = useRef<typeof Leaflet | null>(null);
  const historyLayerRef = useRef<Leaflet.ImageOverlay | null>(null);
  const bldgLayerRef = useRef<Leaflet.GeoJSON | null>(null);
  const gaugeLayerRef = useRef<Leaflet.LayerGroup | null>(null);
  const [ready, setReady] = useState(false);
  // Handed to child components as state, not refs, so they re-render once the map exists.
  const [mapInst, setMapInst] = useState<{ L: typeof Leaflet; map: Leaflet.Map } | null>(null);

  const [meta, setMeta] = useState<HistoryMeta | null>(null);
  const [boundary, setBoundary] = useState<GeoJSON.Feature | null>(null);
  const [floodedBldg, setFloodedBldg] = useState<GeoJSON.FeatureCollection | null>(null);
  const [rain, setRain] = useState<ThaiWaterStation[] | null>(null);
  const [water, setWater] = useState<ThaiWaterLevelStation[] | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // null until mounted: the server's clock differs from the viewer's, so
  // anything time-derived renders only in the browser.
  const [now, setNow] = useState<number | null>(null);

  const [tab, setTab] = useState<Tab>("now");
  const [openReports, setOpenReports] = useState(0);
  const [showReports, setShowReports] = useState(true);
  const [showHistory, setShowHistory] = useState(true);
  const [showBldg, setShowBldg] = useState(true);
  const [radarZoom, setRadarZoom] = useState(true);
  // 4 MB loop — on phones it waits for a tap.
  const [radarWanted, setRadarWanted] = useState(true);
  useEffect(() => {
    const phone = window.matchMedia("(max-width: 820px)").matches;
    if (phone) {
      const t = window.setTimeout(() => setRadarWanted(false), 0);
      return () => window.clearTimeout(t);
    }
  }, []);

  // Clock — also drives the refresh countdown and the radar cache-buster.
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = window.setTimeout(tick, 0);
    const id = window.setInterval(tick, 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, []);

  // ── Static history (built by the pipeline)
  useEffect(() => {
    (async () => {
      try {
        const [m, b, f] = await Promise.all([
          fetch(`${DATA}/meta.json`),
          fetch(`${DATA}/boundary.geojson`),
          fetch(`${DATA}/buildings_flooded.geojson`),
        ]);
        if (!m.ok) throw new Error(`meta.json ${m.status}`);
        setMeta((await m.json()) as HistoryMeta);
        if (b.ok) setBoundary((await b.json()) as GeoJSON.Feature);
        if (f.ok) setFloodedBldg((await f.json()) as GeoJSON.FeatureCollection);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "load failed");
      }
    })();
  }, []);

  // ── Live telemetry + the trend log
  const load = useCallback(async () => {
    setBusy(true);
    try {
      const ok = (s: { station?: { tele_station_lat?: number; tele_station_long?: number } }) =>
        Number.isFinite(s.station?.tele_station_lat) && Number.isFinite(s.station?.tele_station_long);
      const [r, w] = await Promise.all([
        fetch(THAIWATER_RAIN_24H_URL, { cache: "no-store" }),
        fetch(THAIWATER_WATERLEVEL_URL, { cache: "no-store" }),
      ]);
      if (r.ok) setRain(((await r.json()).data as ThaiWaterStation[]).filter(ok));
      if (w.ok) setWater(((await w.json()).data as ThaiWaterLevelStation[]).filter(ok));
      for (const url of LOG_URLS) {
        try {
          const lr = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
          if (!lr.ok) continue;
          const lines = (await lr.text()).split("\n").filter(Boolean);
          setLog(lines.map((l) => JSON.parse(l) as LogEntry));
          break;
        } catch {
          /* CORS on localhost, or not published yet — try the next copy */
        }
      }
      setUpdatedAt(Date.now());
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "load failed");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    const id = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, [load]);

  const nearRain = useMemo(
    () =>
      (rain ?? [])
        .map((s) => ({ s, km: haversineKm(CENTRE[0], CENTRE[1], ...pos(s)) }))
        .filter((x) => x.km <= RAIN_RADIUS_KM)
        .sort((a, b) => a.km - b.km),
    [rain],
  );
  const nearWater = useMemo(
    () =>
      (water ?? [])
        .map((s) => ({ s, km: haversineKm(CENTRE[0], CENTRE[1], ...pos(s)) }))
        .filter((x) => x.km <= WATER_RADIUS_KM)
        .sort((a, b) => a.km - b.km),
    [water],
  );

  // Per-station series over the trend window, keyed by station id.
  const series = useMemo(() => {
    const cutoff = (updatedAt ?? 0) - TREND_HOURS * 3600_000;
    const rainS = new Map<number, Point[]>();
    const waterS = new Map<number, Point[]>();
    for (const e of log) {
      const t = Date.parse(e.t);
      if (!Number.isFinite(t) || t < cutoff) continue;
      for (const [id, , r1] of e.rain) if (r1 !== null) (rainS.get(id) ?? rainS.set(id, []).get(id)!).push({ t, v: r1 });
      for (const [id, , msl] of e.water) if (msl !== null) (waterS.get(id) ?? waterS.set(id, []).get(id)!).push({ t, v: msl });
    }
    return { rainS, waterS };
  }, [log, updatedAt]);

  // ── KPIs
  const rainTop = nearRain.reduce<{ v: number; name: string | null }>(
    (m, x) => ((x.s.rain_1h ?? 0) > m.v ? { v: x.s.rain_1h ?? 0, name: x.s.station.tele_station_name?.th ?? null } : m),
    { v: 0, name: null },
  );
  const rain24Top = nearRain.reduce<{ v: number; name: string | null }>(
    (m, x) => ((x.s.rain_24h ?? 0) > m.v ? { v: x.s.rain_24h ?? 0, name: x.s.station.tele_station_name?.th ?? null } : m),
    { v: 0, name: null },
  );
  const waterRows = nearWater.map(({ s, km }) => {
    const pct = bankPercentOf(s);
    const cur = Number(s.waterlevel_msl);
    const prev = Number(s.waterlevel_msl_previous);
    const dCm = Number.isFinite(cur) && Number.isFinite(prev) ? (cur - prev) * 100 : null;
    return { s, km, pct, cur, dCm };
  });
  const waterTop = waterRows.reduce<(typeof waterRows)[number] | null>(
    (m, r) => (r.pct !== null && (m === null || (m.pct ?? -1) < r.pct) ? r : m),
    null,
  );
  const rising = waterRows.filter((r) => (r.dCm ?? 0) >= 1).length;
  const overBank = waterRows.filter((r) => (r.pct ?? 0) >= 100).length;

  // ── Map
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!mapEl.current || mapRef.current) return;
      const L = await import("leaflet");
      if (cancelled || !mapEl.current) return;
      LRef.current = L;
      const map = L.map(mapEl.current, { center: CENTRE, zoom: 14, zoomControl: true, preferCanvas: true });
      L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
        maxZoom: 20,
        maxNativeZoom: 19,
        attribution: "Tiles © Esri — Esri, Maxar, Earthstar Geographics",
      }).addTo(map);
      const labels = map.createPane("labels");
      labels.style.zIndex = "480";
      labels.style.pointerEvents = "none";
      L.tileLayer(
        "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
        { pane: "labels", maxNativeZoom: 16, opacity: 0.9 },
      ).addTo(map);
      L.circleMarker(CENTRE, { radius: 5, color: "#07131a", weight: 2, fillColor: "#40e0bd", fillOpacity: 1 })
        .bindTooltip("สำนักงานเทศบาลเมืองกระทุ่มล้ม", { direction: "top" })
        .addTo(map);
      mapRef.current = map;
      setMapInst({ L, map });
      setReady(true);
    })();
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const L = LRef.current;
    const map = mapRef.current;
    if (!L || !map || !ready || !boundary) return;
    const layer = L.geoJSON(boundary as GeoJSON.GeoJsonObject, {
      interactive: false,
      style: { color: "#ffffff", weight: 2.2, opacity: 0.9, fill: false, dashArray: "6 4" },
    }).addTo(map);
    map.fitBounds(layer.getBounds(), { padding: [24, 24] });
    return () => {
      layer.removeFrom(map);
    };
  }, [ready, boundary]);

  useEffect(() => {
    const L = LRef.current;
    const map = mapRef.current;
    if (!L || !map || !ready) return;
    historyLayerRef.current?.removeFrom(map);
    historyLayerRef.current = null;
    if (!showHistory || !meta) return;
    const [w, s, e, n] = meta.bounds;
    historyLayerRef.current = L.imageOverlay(`${DATA}/flood_years.png?v=${meta.generated_at}`, [[s, w], [n, e]], {
      opacity: 0.85,
      interactive: false,
      className: "kl-pixelated",
    }).addTo(map);
  }, [ready, showHistory, meta]);

  useEffect(() => {
    const L = LRef.current;
    const map = mapRef.current;
    if (!L || !map || !ready) return;
    bldgLayerRef.current?.removeFrom(map);
    bldgLayerRef.current = null;
    if (!showBldg || !floodedBldg) return;
    bldgLayerRef.current = L.geoJSON(floodedBldg as GeoJSON.GeoJsonObject, {
      style: (f) => ({
        color: "#0a1318",
        weight: 0.8,
        fillColor: yearsColor(Number(f?.properties?.y ?? 1)),
        fillOpacity: 0.95,
      }),
      onEachFeature: (f, layer) => {
        const ys = (f.properties?.ys as number[] | undefined) ?? [];
        layer.bindTooltip(
          `ดาวเทียมเห็นน้ำท่วมบริเวณนี้ <b>${ys.length}</b> ปี<br/><span style="opacity:.8">${ys.join(" · ")}</span>`,
          { sticky: true, direction: "top" },
        );
      },
    }).addTo(map);
  }, [ready, showBldg, floodedBldg]);

  useEffect(() => {
    const L = LRef.current;
    const map = mapRef.current;
    if (!L || !map || !ready) return;
    gaugeLayerRef.current?.removeFrom(map);
    const g = L.layerGroup();
    for (const { s, km } of nearRain) {
      const mm = s.rain_1h ?? 0;
      L.circleMarker(pos(s), { radius: 6, color: "#07131a", weight: 1.5, fillColor: rainIntensityColor(mm), fillOpacity: 1 })
        .bindTooltip(
          `<b>${s.station.tele_station_name?.th ?? "สถานีฝน"}</b><br/>ฝน 1 ชม. ${mm.toFixed(1)} มม. · 24 ชม. ${(s.rain_24h ?? 0).toFixed(1)} มม.<br/><span style="opacity:.7">${km.toFixed(1)} กม. · ${fmtTime(s.rainfall_datetime)}</span>`,
          { direction: "top" },
        )
        .addTo(g);
    }
    for (const { s, km } of nearWater) {
      const pct = bankPercentOf(s);
      L.circleMarker(pos(s), {
        radius: 8,
        color: "#ffffff",
        weight: 2,
        fillColor: pct !== null ? bankPercentColor(pct) : "#9aa6a6",
        fillOpacity: 1,
      })
        .bindTooltip(
          `<b>${s.station.tele_station_name?.th ?? "สถานีระดับน้ำ"}</b><br/>${pct !== null ? `${Math.round(pct)}% ตลิ่ง` : "ไม่มีค่าตลิ่ง"}<br/><span style="opacity:.7">${km.toFixed(1)} กม. · ${fmtTime(s.waterlevel_datetime)}</span>`,
          { direction: "top" },
        )
        .addTo(g);
    }
    g.addTo(map);
    gaugeLayerRef.current = g;
  }, [ready, nearRain, nearWater]);

  const flyTo = (lat: number, lon: number) => mapRef.current?.flyTo([lat, lon], 17, { duration: 0.7 });

  const years = meta ? Object.entries(meta.per_year) : [];
  const maxYearRai = years.reduce((m, [, v]) => Math.max(m, v.max_flooded_rai), 0);
  const b = meta?.buildings;
  const observableBldg = b ? b.total - b.not_observable - b.thin : 0;
  const seenFlooded = b ? b.y1 + b.y2_3 + b.y4_6 + b.y7plus : 0;

  const clock =
    now === null
      ? "--:--:--"
      : new Intl.DateTimeFormat("th-TH", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: TZ }).format(now);
  const today =
    now === null
      ? ""
      : new Intl.DateTimeFormat("th-TH", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: TZ }).format(now);
  const nextIn = updatedAt && now !== null ? Math.max(0, updatedAt + REFRESH_MS - now) : null;
  const radarBucket = Math.floor((now ?? 0) / REFRESH_MS);

  return (
    <div className="kl-page">
      {/* ── Header */}
      <header className="kl-head">
        <Link href="/" className="ms-back" aria-label="กลับไปที่แผนที่ทั่วประเทศ">
          <ArrowLeft size={18} />
        </Link>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 className="ms-title">
            <Waves size={19} style={{ color: "var(--accent)", flex: "none" }} />
            ศูนย์ข้อมูลน้ำ · เทศบาลเมืองกระทุ่มล้ม
          </h1>
          <p className="ms-sub">อ.สามพราน จ.นครปฐม · สำหรับเจ้าหน้าที่</p>
        </div>
        <div className="kl-clock">
          <span className="num-mono kl-clock-time">{clock}</span>
          <span className="kl-clock-date">{today}</span>
        </div>
        <div className="kl-sync">
          <span className={`kl-live ${err ? "is-err" : ""}`}>{err ? "เชื่อมต่อไม่ได้" : "LIVE"}</span>
          <span className="kl-sync-text">
            {updatedAt ? `อัปเดต ${fmtTime(new Date(updatedAt).toISOString())}` : "กำลังโหลด…"}
            {nextIn !== null ? ` · รอบถัดไป ${Math.floor(nextIn / 60000)}:${String(Math.floor((nextIn % 60000) / 1000)).padStart(2, "0")}` : ""}
          </span>
        </div>
        <button className="ms-refresh" onClick={() => void load()} disabled={busy} aria-label="รีเฟรชทันที">
          <RefreshCw size={16} style={{ animation: busy ? "ff-spin 1s linear infinite" : undefined }} />
        </button>
      </header>

      {/* ── KPI strip */}
      <section className="kl-kpis">
        <div className="kl-kpi" style={{ borderColor: `${rainIntensityColor(rainTop.v)}88` }}>
          <span className="kl-kpi-label"><CloudRain size={13} /> ฝน 1 ชม. สูงสุด</span>
          <span className="kl-kpi-val num-mono" style={{ color: rainTop.v > 0 ? rainIntensityColor(rainTop.v) : "var(--ink)" }}>
            {rain === null ? "—" : rainTop.v.toFixed(1)}
            <small> มม.</small>
          </span>
          <span className="kl-kpi-sub">{rain === null ? "กำลังโหลด" : rainTop.v > 0 ? `${rainIntensityLabel(rainTop.v)} · ${rainTop.name ?? ""}` : `ไม่มีฝน · ${nearRain.length} สถานี`}</span>
        </div>
        <div className="kl-kpi">
          <span className="kl-kpi-label"><Droplets size={13} /> ฝนสะสม 24 ชม. สูงสุด</span>
          <span className="kl-kpi-val num-mono">
            {rain === null ? "—" : rain24Top.v.toFixed(1)}
            <small> มม.</small>
          </span>
          <span className="kl-kpi-sub">{rain24Top.name ?? "—"}</span>
        </div>
        <div className="kl-kpi" style={{ borderColor: waterTop?.pct != null ? `${bankPercentColor(waterTop.pct)}88` : undefined }}>
          <span className="kl-kpi-label"><Waves size={13} /> ระดับน้ำสูงสุด (เทียบตลิ่ง)</span>
          <span className="kl-kpi-val num-mono" style={{ color: waterTop?.pct != null ? bankPercentColor(waterTop.pct) : "var(--ink)" }}>
            {waterTop?.pct != null ? Math.round(waterTop.pct) : "—"}
            <small>%</small>
          </span>
          <span className="kl-kpi-sub">
            {waterTop ? `${bankPercentLabel(waterTop.pct ?? 0)} · ${waterTop.s.station.tele_station_name?.th ?? ""}` : "—"}
          </span>
        </div>
        <div className="kl-kpi" style={{ borderColor: rising ? "rgba(253,174,97,0.55)" : undefined }}>
          <span className="kl-kpi-label">▲ สถานีน้ำกำลังขึ้น</span>
          <span className="kl-kpi-val num-mono" style={{ color: rising ? "var(--r-high)" : "var(--ink)" }}>
            {water === null ? "—" : rising}
            <small> / {nearWater.length}</small>
          </span>
          <span className="kl-kpi-sub">{overBank ? `ล้นตลิ่ง ${overBank} สถานี` : "เทียบกับค่าก่อนหน้าของสถานี"}</span>
        </div>
        <div className="kl-kpi" style={{ borderColor: b?.recent ? "rgba(215,48,39,0.45)" : undefined }}>
          <span className="kl-kpi-label"><Building2 size={13} /> บ้านที่ดาวเทียมเห็นน้ำท่วม</span>
          <span className="kl-kpi-val num-mono" style={{ color: b?.recent ? "#ff8a80" : "var(--ink)" }}>
            {b ? n0(b.recent) : "—"}
            <small> หลัง</small>
          </span>
          <span className="kl-kpi-sub">{meta ? `ปี ${meta.recent_from}–${meta.recent_from + 2} · ไม่นับเขตที่มองไม่เห็น` : "—"}</span>
        </div>
      </section>

      <div className="kl-body">
        {/* ── Map */}
        <div className="kl-map-wrap">
          <div ref={mapEl} className="kl-map" />
          <div className="glass kl-layers">
            <div className="caps" style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 4px 6px" }}>
              <Layers size={11} strokeWidth={2.4} /> ชั้นข้อมูล
            </div>
            <label className="kl-check">
              <input type="checkbox" checked={showHistory} onChange={(e) => setShowHistory(e.target.checked)} />
              ประวัติน้ำท่วมจากดาวเทียม
            </label>
            <label className="kl-check">
              <input type="checkbox" checked={showBldg} onChange={(e) => setShowBldg(e.target.checked)} />
              บ้านที่ดาวเทียมเคยเห็นน้ำท่วม
            </label>
            <label className="kl-check">
              <input type="checkbox" checked={showReports} onChange={(e) => setShowReports(e.target.checked)} />
              จุดที่เจ้าหน้าที่รายงาน
            </label>
          </div>
          {meta ? (
            <div className="glass kl-legend">
              <span className="caps">ดาวเทียมเห็นน้ำท่วมกี่ปี</span>
              <span className="kl-legend-row">
                {meta.classes.map((c, i) => {
                  const next = meta.classes[i + 1]?.min_years;
                  return (
                    <span key={c.min_years} className="kl-chip">
                      <span className="sw" style={{ background: `rgba(${c.rgba.slice(0, 3).join(",")},1)` }} />
                      {next ? (next - 1 === c.min_years ? `${c.min_years}` : `${c.min_years}–${next - 1}`) : `${c.min_years}+`} ปี
                    </span>
                  );
                })}
                <span className="kl-chip">
                  <span className="sw kl-stripes" />
                  ดาวเทียมมองไม่เห็น
                </span>
                <span className="kl-chip">
                  <span className="sw" style={{ borderRadius: 999, background: "#5cc4ee" }} />
                  สถานีฝน
                </span>
                <span className="kl-chip">
                  <span className="sw" style={{ borderRadius: 999, background: "#3fbf4e", border: "2px solid #fff" }} />
                  สถานีระดับน้ำ
                </span>
                <span className="kl-chip">
                  <span className="sw kl-flag-sw" />
                  จุดที่เจ้าหน้าที่รายงาน
                </span>
              </span>
            </div>
          ) : null}
        </div>

        {/* ── Side panel */}
        <aside className="kl-side">
          <nav className="kl-tabs" role="tablist">
            {(
              [
                ["now", "ตอนนี้"],
                ["reports", "รายงาน"],
                ["history", "ประวัติ"],
                ["todo", "ที่รอ"],
              ] as [Tab, string][]
            ).map(([k, label]) => (
              <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
                {label}
                {k === "reports" && openReports > 0 ? <span className="kl-tab-badge">{openReports}</span> : null}
              </button>
            ))}
          </nav>

          {err ? <div className="ms-err">โหลดข้อมูลไม่สำเร็จ: {err}</div> : null}

          <ReportsPanel L={mapInst?.L ?? null} map={mapInst?.map ?? null} active={tab === "reports"} onCountChange={setOpenReports} visible={showReports} />

          {tab === "now" ? (
            <>
              {/* Radar */}
              <section className="kl-card">
                <div className="kl-card-head">
                  <Radar size={16} style={{ color: "#5cc4ee" }} />
                  เรดาร์หนองแขม
                  <span className="kl-card-meta">สนน. กทม. · วน 12 ภาพล่าสุด</span>
                  {radarWanted ? (
                    <button className="kl-icon-btn" onClick={() => setRadarZoom((v) => !v)} aria-label={radarZoom ? "ดูทั้งภาพ" : "ขยายรอบเทศบาล"} title={radarZoom ? "ดูทั้งภาพ" : "ขยายรอบเทศบาล"}>
                      {radarZoom ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                    </button>
                  ) : null}
                </div>
                {radarWanted && now !== null ? (
                  <div className={`kl-radar ${radarZoom ? "is-zoom" : ""}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- remote animated GIF, refreshed every 5 min */}
                    <img src={`${RADAR_URL}?t=${radarBucket}`} alt="ภาพเรดาร์ฝนหนองแขม วนภาพล่าสุด" loading="lazy" />
                  </div>
                ) : (
                  <button className="kl-radar-load" onClick={() => setRadarWanted(true)}>
                    แตะเพื่อโหลดภาพเรดาร์ (~4 MB)
                  </button>
                )}
                <div className="kl-muted" style={{ marginTop: 6, display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <span>
                    {radarZoom ? "ขยายรอบจุดตั้งเรดาร์ (หนองแขม) ซึ่งอยู่ติดกระทุ่มล้ม · " : ""}เวลาของภาพอยู่มุมขวาล่าง · เขียว→แดง = ฝนเบา→หนัก
                  </span>
                  <a href={RADAR_PAGE} target="_blank" rel="noreferrer" className="kl-link">
                    กรมอุตุฯ <ExternalLink size={11} />
                  </a>
                </div>
              </section>

              {/* Rain gauges */}
              <section className="kl-card">
                <div className="kl-card-head">
                  <CloudRain size={16} style={{ color: rainIntensityColor(rainTop.v) }} />
                  สถานีวัดฝน
                  <span className="kl-card-meta">{nearRain.length} สถานี ≤ {RAIN_RADIUS_KM} กม. · กราฟ 24 ชม.</span>
                </div>
                {rain === null ? (
                  <div className="kl-muted">กำลังโหลด…</div>
                ) : nearRain.length === 0 ? (
                  <div className="kl-muted">ไม่มีสถานีวัดฝนในรัศมี {RAIN_RADIUS_KM} กม.</div>
                ) : (
                  <table className="kl-table">
                    <thead>
                      <tr>
                        <th>สถานี</th>
                        <th>24 ชม.</th>
                        <th style={{ textAlign: "right" }}>1 ชม.</th>
                        <th style={{ textAlign: "right" }}>สะสม</th>
                      </tr>
                    </thead>
                    <tbody>
                      {nearRain.map(({ s, km }) => (
                        <tr key={s.id}>
                          <td>
                            {s.station.tele_station_name?.th ?? "สถานีฝน"}
                            <span className="kl-sub">{km.toFixed(1)} กม. · {s.agency?.agency_shortname?.th ?? ""} · {fmtTime(s.rainfall_datetime)}</span>
                          </td>
                          <td>
                            <Sparkline points={series.rainS.get(s.id) ?? []} kind="bars" color="#5cc4ee" now={updatedAt ?? now ?? 0} />
                          </td>
                          <td className="num-mono" style={{ color: rainIntensityColor(s.rain_1h ?? 0), textAlign: "right" }}>
                            {(s.rain_1h ?? 0).toFixed(1)}
                          </td>
                          <td className="num-mono" style={{ textAlign: "right" }}>
                            {(s.rain_24h ?? 0).toFixed(1)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <div className="kl-muted" style={{ marginTop: 6 }}>หน่วย มม. · 1 ชม. เล็กน้อย &lt;10 · ปานกลาง 10–35 · หนัก 35–90 · หนักมาก ≥90 (กรมอุตุฯ)</div>
              </section>

              {/* Water level gauges */}
              <section className="kl-card">
                <div className="kl-card-head">
                  <Waves size={16} style={{ color: "var(--accent)" }} />
                  ระดับน้ำคลองและแม่น้ำ
                  <span className="kl-card-meta">{nearWater.length} สถานี ≤ {WATER_RADIUS_KM} กม. · กราฟ 24 ชม.</span>
                </div>
                {water === null ? (
                  <div className="kl-muted">กำลังโหลด…</div>
                ) : (
                  <table className="kl-table">
                    <thead>
                      <tr>
                        <th>สถานี</th>
                        <th>24 ชม.</th>
                        <th style={{ textAlign: "right" }}>ตลิ่ง</th>
                        <th style={{ textAlign: "right" }}>Δ ซม.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {waterRows.map(({ s, km, pct, cur, dCm }) => {
                        const raw = series.waterS.get(s.id) ?? [];
                        // Plot as % of bank where the station's survey allows it, else as metres MSL.
                        const asPct = pct !== null ? raw.map((p) => ({ t: p.t, v: bankPercentAt(s, p.v) ?? NaN })).filter((p) => Number.isFinite(p.v)) : raw;
                        return (
                          <tr key={s.id}>
                            <td>
                              {s.station.tele_station_name?.th ?? "สถานีระดับน้ำ"}
                              <span className="kl-sub">
                                {km.toFixed(1)} กม. · {s.basin?.basin_name?.th ?? ""} · {s.agency?.agency_shortname?.th ?? ""} · {fmtTime(s.waterlevel_datetime)}
                              </span>
                            </td>
                            <td>
                              <Sparkline
                                points={asPct}
                                kind="line"
                                color={pct !== null ? bankPercentColor(pct) : "#9aa6a6"}
                                ref100={pct !== null ? 100 : undefined}
                                now={updatedAt ?? now ?? 0}
                              />
                            </td>
                            <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                              {pct !== null ? (
                                <span className="num-mono" style={{ color: bankPercentColor(pct), fontWeight: 700 }}>
                                  {Math.round(pct)}%
                                  <span className="kl-sub">{bankPercentLabel(pct)}</span>
                                </span>
                              ) : (
                                <span className="num-mono">
                                  {Number.isFinite(cur) ? `${cur.toFixed(2)}` : "—"}
                                  <span className="kl-sub">ม.รทก.</span>
                                </span>
                              )}
                            </td>
                            <td
                              className="num-mono"
                              style={{
                                textAlign: "right",
                                whiteSpace: "nowrap",
                                color: dCm === null ? "var(--ink-3)" : dCm >= 1 ? "var(--r-high)" : dCm <= -1 ? "var(--accent)" : "var(--ink-3)",
                              }}
                            >
                              {dCm === null ? "—" : `${dCm >= 1 ? "▲" : dCm <= -1 ? "▼" : "•"}${dCm >= 0 ? "+" : ""}${dCm.toFixed(0)}`}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
                <div className="kl-muted" style={{ marginTop: 6 }}>
                  เส้นประแดง = ระดับตลิ่ง · ไม่มีสถานีวัดระดับน้ำในเขตเทศบาล ค่าที่เห็นมาจากคลองและท่าจีนรอบนอก
                </div>
              </section>
            </>
          ) : null}

          {tab === "history" ? (
            meta && b ? (
              <>
                <section className="kl-card">
                  <div className="kl-card-head">
                    <Satellite size={16} style={{ color: "#5cc4ee" }} />
                    Sentinel-1
                    <span className="kl-card-meta">
                      {n0(meta.passes)} รอบถ่าย · {fmtDate(meta.first_pass)} – {fmtDate(meta.last_pass)}
                    </span>
                  </div>
                  <div className="kl-stats">
                    <div>
                      <span className="num-mono kl-stat">{n0(meta.flooded_ever_rai)}</span>
                      <span className="kl-sub">ไร่ ที่เคยเห็นน้ำท่วม</span>
                    </div>
                    <div>
                      <span className="num-mono kl-stat">{n0(meta.flooded_2plus_years_rai)}</span>
                      <span className="kl-sub">ไร่ ท่วมซ้ำ ≥ 2 ปี</span>
                    </div>
                    <div>
                      <span className="num-mono kl-stat">{Math.round(meta.not_observable_share * 100)}%</span>
                      <span className="kl-sub">ของเทศบาล มองไม่เห็น</span>
                    </div>
                  </div>
                  <div className="kl-note">
                    <b>ดาวเทียมมองไม่เห็นเขตที่มีสิ่งปลูกสร้างหนาแน่น</b> (คลื่นเรดาร์สะท้อนผนังอาคาร ไม่ใช่ผิวน้ำ)
                    พื้นที่ลายขีดบนแผนที่จึงแปลว่า &ldquo;ไม่มีข้อมูล&rdquo; ไม่ได้แปลว่า &ldquo;ไม่เคยท่วม&rdquo;
                    น้ำท่วมขังในหมู่บ้านต้องอาศัยบันทึกของเทศบาลเอง
                  </div>
                </section>

                <section className="kl-card">
                  <div className="kl-card-head">
                    <Building2 size={16} style={{ color: "var(--accent)" }} />
                    บ้านเรือนในเขตเทศบาล {n0(b.total)} หลัง
                  </div>
                  <div className="kl-bldg-bar" role="img" aria-label="สัดส่วนบ้านตามประวัติน้ำท่วม">
                    {[
                      [b.not_observable, "var(--ink-4)"],
                      [b.thin, "#3b4a4d"],
                      [b.never, "rgba(64,224,189,0.45)"],
                      [b.y1, yearsColor(1)],
                      [b.y2_3, yearsColor(2)],
                      [b.y4_6, yearsColor(4)],
                      [b.y7plus, yearsColor(7)],
                    ].map(([v, c], i) => ((v as number) > 0 ? <span key={i} style={{ flex: v as number, background: c as string }} /> : null))}
                  </div>
                  <table className="kl-table">
                    <tbody>
                      <tr>
                        <td>อยู่ในเขตที่ดาวเทียมมองไม่เห็น</td>
                        <td className="num-mono" style={{ textAlign: "right" }}>{n0(b.not_observable)}</td>
                      </tr>
                      <tr>
                        <td>มองเห็น — ไม่เคยเห็นน้ำท่วม</td>
                        <td className="num-mono" style={{ textAlign: "right" }}>{n0(b.never)}</td>
                      </tr>
                      <tr>
                        <td>มองเห็น — เคยเห็นน้ำท่วม</td>
                        <td className="num-mono" style={{ textAlign: "right", color: seenFlooded ? "var(--r-high)" : undefined, fontWeight: 700 }}>
                          {n0(seenFlooded)}
                        </td>
                      </tr>
                      {seenFlooded > 0 ? (
                        <tr>
                          <td className="kl-sub" colSpan={2} style={{ paddingTop: 0 }}>
                            1 ปี {n0(b.y1)} · 2–3 ปี {n0(b.y2_3)} · 4–6 ปี {n0(b.y4_6)} · 7 ปีขึ้นไป {n0(b.y7plus)}
                          </td>
                        </tr>
                      ) : null}
                      <tr>
                        <td>
                          <b>เห็นน้ำท่วมใน 3 ปีล่าสุด</b>
                          <span className="kl-sub">
                            {meta.recent_from}–{meta.recent_from + 2}
                          </span>
                        </td>
                        <td className="num-mono" style={{ textAlign: "right", color: b.recent ? "var(--r-severe)" : undefined, fontWeight: 700 }}>
                          {n0(b.recent)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                  <div className="kl-muted" style={{ marginTop: 6 }}>จาก {n0(observableBldg)} หลังที่ดาวเทียมมองเห็น · Google Open Buildings v3</div>
                  <div className="kl-note" style={{ marginTop: 8 }}>
                    รอยอาคารเป็นภาพปัจจุบัน แต่ประวัติย้อนไปถึงปี 2015 — หมู่บ้านที่เพิ่งสร้างอาจตั้งบนที่ดินที่เคยเป็นนาหรือบ่อ
                    ปีที่ท่วมก่อนสร้างจึงนับรวมด้วย ให้ดูว่า<b>ท่วมปีไหน</b>ประกอบ (แตะที่บ้านบนแผนที่)
                  </div>
                </section>

                {years.length ? (
                  <section className="kl-card">
                    <div className="kl-card-head">พื้นที่ท่วมมากที่สุดที่เห็นในแต่ละปี (ไร่)</div>
                    <div className="kl-years">
                      {years.map(([y, v]) => (
                        <div key={y} className="kl-year" title={`${y}: ${n0(v.max_flooded_rai)} ไร่ จาก ${v.passes} รอบถ่าย`}>
                          <span className="kl-year-val num-mono">{v.max_flooded_rai ? n0(v.max_flooded_rai) : ""}</span>
                          <span
                            className="kl-year-bar"
                            style={{
                              height: `${maxYearRai ? Math.max(2, (v.max_flooded_rai / maxYearRai) * 100) : 2}%`,
                              background: Number(y) >= meta.recent_from ? "#d7301f" : "#fdae61",
                            }}
                          />
                          <span className="kl-year-lbl num-mono">{y.slice(2)}</span>
                        </div>
                      ))}
                    </div>
                  </section>
                ) : null}

                {meta.hotspots.length ? (
                  <section className="kl-card">
                    <div className="kl-card-head">จุดที่ดาวเทียมเห็นท่วมซ้ำ ≥ 2 ปี</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                      {meta.hotspots.map((h) => (
                        <button key={`${h.lat},${h.lon}`} className="dw-row" onClick={() => flyTo(h.lat, h.lon)}>
                          <span style={{ width: 3, alignSelf: "stretch", borderRadius: 2, background: yearsColor(h.max_years), flex: "none" }} />
                          <span style={{ flex: 1, minWidth: 0 }}>
                            <span style={{ display: "block", fontSize: 13, fontWeight: 600 }}>{h.name ?? fromOffice(h.lat, h.lon)}</span>
                            <span className="kl-sub">
                              {h.name ? `${fromOffice(h.lat, h.lon)} · ` : ""}
                              {n0(h.rai)} ไร่{h.buildings ? ` · บ้าน ${n0(h.buildings)} หลัง` : " · ไม่มีบ้าน (เกษตร/ที่โล่ง)"}
                            </span>
                            <span className="kl-years-chips">
                              {(h.years ?? []).map((y) => (
                                <span key={y} className={y >= meta.recent_from ? "recent" : ""}>
                                  {String(y).slice(2)}
                                </span>
                              ))}
                            </span>
                          </span>
                        </button>
                      ))}
                    </div>
                  </section>
                ) : null}
              </>
            ) : (
              <section className="kl-card kl-muted">กำลังโหลดประวัติ…</section>
            )
          ) : null}

          {tab === "todo" ? (
            <section className="kl-card">
              <div className="kl-card-head">ข้อมูลที่ต้องได้จากเทศบาล</div>
              <ul className="kl-todo">
                <li><b>ขอบเขตเทศบาล</b> — ตอนนี้ใช้ขอบเขตตำบลกระทุ่มล้มจาก GADM แทน</li>
                <li><b>จุดน้ำท่วมขังที่เคยบันทึก</b> — เจ้าหน้าที่เพิ่มได้เองแล้วในแท็บ &ldquo;รายงาน&rdquo; ถ้ามีบันทึกเก่าเป็นไฟล์ ส่งมาให้นำเข้าได้</li>
                <li><b>สถานีสูบน้ำ ประตูระบายน้ำ</b> — ตำแหน่ง ขนาดเครื่อง สถานะ</li>
                <li><b>แนวคลองและท่อระบายน้ำหลัก</b></li>
                <li><b>ชุมชน/หมู่บ้าน</b> — ชื่อ จำนวนครัวเรือน ผู้ประสานงาน</li>
              </ul>
              <div className="kl-note" style={{ marginTop: 10 }}>
                ข้อมูลที่ได้มาจะแสดงเป็นชั้นแยก &ldquo;ข้อมูลจากเทศบาล&rdquo; โดยไม่ปนกับค่าวัดจากสถานีหรือดาวเทียม
              </div>
            </section>
          ) : null}

          <p className="ms-disclaim" style={{ marginTop: 14 }}>
            เป็นเครื่องมือแสดงข้อมูล ไม่ใช่ประกาศเตือนภัยทางการ · สถานี: สสน. (HII) · เรดาร์: สำนักการระบายน้ำ กทม. ผ่านกรมอุตุนิยมวิทยา · {meta?.boundary_source ?? ""}
          </p>
        </aside>
      </div>
    </div>
  );
}
