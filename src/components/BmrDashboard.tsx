"use client";

// รอระบาย (กรุงเทพฯ และปริมณฑล) — an operations view over the six
// provinces of the Bangkok Metropolitan Region.
//
// Live sources, each drawn with its own symbol so nobody mistakes one for
// another:
//   BMA canal gauges & gates  — สนน. กทม. KlongMap (via relay), BMA's own
//                               warning/critical levels, 5-min telemetry
//   River gauges              — HII/RID ThaiWater, % of bank, 30-day history
//   Rain gauges               — HII feed (BMA + HII + TMD), 1 h and 24 h
//   Cameras                   — iTIC / Longdo public traffic cameras, JPEG
//   Satellite flood (7 days)  — Copernicus GFM tiles already on R2
//   Radar                     — BMA Nong Khaem & Nong Chok loops via TMD
//   Tide                      — BMA daily table (the lower Chao Phraya is tidal)

import {
  ArrowLeft,
  Camera as CameraIcon,
  CloudRain,
  Droplets,
  ExternalLink,
  Layers,
  Radar,
  RefreshCw,
  Satellite,
  Waves,
  X,
} from "lucide-react";
import Link from "next/link";
import type * as Leaflet from "leaflet";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Camera } from "@/app/api/bmr/cameras/route";
import { BMA_STATUS_META, type BmaGauge, type BmaPayload, type BmaStatus } from "@/lib/bma";
import { haversineKm } from "@/lib/inspect";
import { bankPercentColor, bankPercentLabel } from "@/lib/maesai";
import {
  bankPercentOf,
  rainIntensityColor,
  rainIntensityLabel,
  THAIWATER_RAIN_24H_URL,
  THAIWATER_WATERLEVEL_URL,
  type ThaiWaterLevelStation,
  type ThaiWaterStation,
} from "@/lib/thaiwater";

const BBOX = { w: 99.831, s: 13.425, e: 100.964, n: 14.273 };
const CENTRE: [number, number] = [13.85, 100.5];
const REFRESH_MS = 5 * 60_000;
const RADARS = {
  nk: { label: "หนองแขม (ฝั่งตะวันตก)", url: "https://weather.tmd.go.th/pic_bmankLoop.gif", page: "https://weather.tmd.go.th/bma_nkLoop.php" },
  nc: { label: "หนองจอก (ฝั่งตะวันออก)", url: "https://weather.tmd.go.th/pic_bmancLoop.gif", page: "https://weather.tmd.go.th/bma_ncLoop.php" },
} as const;
type RadarKey = keyof typeof RADARS;

type SarFloodMeta = {
  generated_at: string;
  window_hours: number;
  flood_area_rai: number;
  tiles?: { file: string; url?: string | null; max_zoom: number };
};
type Tab = "now" | "canals" | "rivers" | "rain" | "cameras";
type Selected = { kind: "bma"; code: string } | { kind: "hii"; id: number } | { kind: "cam"; id: string } | null;
type History = { points: [number, number][]; bank: number | null };

const TZ = "Asia/Bangkok";
const n0 = (v: number) => new Intl.NumberFormat("th-TH").format(Math.round(v));
function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = /[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? new Date(iso) : new Date(iso.replace(" ", "T") + "+07:00");
    return new Intl.DateTimeFormat("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ }).format(d);
  } catch {
    return iso;
  }
}
const fmtClock = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat("th-TH", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ }).format(new Date(iso)) : "—";
// Cache-buster that works for URLs with and without a query string
// (iTIC snapshots carry one, the drainage-department JPEGs do not).
const withTick = (url: string, t: number | string) => `${url}${url.includes("?") ? "&" : "?"}t=${t}`;
const stPos = (s: { station: { tele_station_lat: number; tele_station_long: number } }) =>
  [s.station.tele_station_lat, s.station.tele_station_long] as [number, number];
const inBox = (lat: number, lng: number) => lat >= BBOX.s && lat <= BBOX.n && lng >= BBOX.w && lng <= BBOX.e;

// ─── 30-day level chart (SVG) ────────────────────────────────────
function LevelChart({ h, color, label }: { h: History; color: string; label: string }) {
  const W = 340;
  const H = 110;
  const pts = h.points;
  if (pts.length < 2) return <div className="kl-muted">ไม่มีประวัติ</div>;
  const t0 = pts[0][0];
  const t1 = pts[pts.length - 1][0];
  const vs = pts.map((p) => p[1]).concat(h.bank !== null ? [h.bank] : []);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const pad = (hi - lo || 1) * 0.08;
  const x = (t: number) => ((t - t0) / (t1 - t0 || 1)) * W;
  const y = (v: number) => H - 4 - ((v - (lo - pad)) / (hi + pad - (lo - pad))) * (H - 8);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(" ");
  const days: number[] = [];
  for (let t = t0; t <= t1; t += 7 * 86400_000) days.push(t);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} className="kl-spark" role="img" aria-label={label}>
        {days.map((t) => (
          <line key={t} x1={x(t)} x2={x(t)} y1="0" y2={H} stroke="var(--hairline)" />
        ))}
        {h.bank !== null ? (
          <>
            <line x1="0" x2={W} y1={y(h.bank)} y2={y(h.bank)} stroke="rgba(215,48,39,0.7)" strokeDasharray="3 3" />
            <text x={W - 2} y={y(h.bank) - 3} fontSize="9" fill="#ff8a80" textAnchor="end">
              ตลิ่ง {h.bank.toFixed(2)}
            </text>
          </>
        ) : null}
        <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
        <text x="2" y="10" fontSize="9" fill="var(--ink-3)">
          {hi.toFixed(2)} ม.
        </text>
        <text x="2" y={H - 2} fontSize="9" fill="var(--ink-3)">
          {lo.toFixed(2)} ม.
        </text>
      </svg>
      <div className="kl-sub" style={{ display: "flex", justifyContent: "space-between" }}>
        <span>{fmtTime(new Date(t0).toISOString())}</span>
        <span>30 วัน · ทุก 10 นาที · ม.รทก.</span>
        <span>{fmtTime(new Date(t1).toISOString())}</span>
      </div>
    </div>
  );
}

// ─── Main ────────────────────────────────────────────────────────
export type FocusTarget = { kind: "bma"; code: string } | { kind: "hii"; id: number };

export function BmrDashboard({ focus = null, onBack }: { focus?: FocusTarget | null; onBack?: () => void } = {}) {
  const mapEl = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Leaflet.Map | null>(null);
  const LRef = useRef<typeof Leaflet | null>(null);
  const [mapInst, setMapInst] = useState<{ L: typeof Leaflet; map: Leaflet.Map } | null>(null);
  const layerRefs = useRef<Record<string, Leaflet.Layer | null>>({});

  const [bma, setBma] = useState<BmaPayload | null>(null);
  const [bmaErr, setBmaErr] = useState<string | null>(null);
  const [rain, setRain] = useState<ThaiWaterStation[] | null>(null);
  const [water, setWater] = useState<ThaiWaterLevelStation[] | null>(null);
  const [cams, setCams] = useState<Camera[] | null>(null);
  const [camsListed, setCamsListed] = useState<number | null>(null);
  const [sar, setSar] = useState<SarFloodMeta | null>(null);
  const [provinces, setProvinces] = useState<GeoJSON.FeatureCollection | null>(null);
  const [hist, setHist] = useState<Record<string, History | "loading" | "error">>({});
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const [tab, setTab] = useState<Tab>("now");
  const [selected, setSelected] = useState<Selected>(null);
  const [radar, setRadar] = useState<RadarKey>("nk");
  const [radarWanted, setRadarWanted] = useState(true);
  const [show, setShow] = useState({ heat: true, bma: true, hii: true, rain: false, cams: true, sar: true });
  const [camTick, setCamTick] = useState(0);
  const [mapCentre, setMapCentre] = useState<[number, number]>(CENTRE);

  useEffect(() => {
    const phone = window.matchMedia("(max-width: 820px)").matches;
    const t = window.setTimeout(() => {
      setNow(Date.now());
      if (phone) setRadarWanted(false);
    }, 0);
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearTimeout(t);
      window.clearInterval(id);
    };
  }, []);

  // ── Static-ish payloads
  useEffect(() => {
    (async () => {
      try {
        const [p, s, c] = await Promise.all([fetch("/data/bmr/provinces.geojson"), fetch("/data/sar_flood_meta.json"), fetch("/api/bmr/cameras")]);
        if (p.ok) setProvinces((await p.json()) as GeoJSON.FeatureCollection);
        if (s.ok) setSar((await s.json()) as SarFloodMeta);
        if (c.ok) {
          const j = (await c.json()) as { cameras: Camera[]; listed?: number };
          setCams(j.cameras);
          setCamsListed(j.listed ?? null);
        }
      } catch {
        /* each layer is optional */
      }
    })();
  }, []);

  // ── Live payloads
  const load = useCallback(async () => {
    setBusy(true);
    const ok = (s: { station?: { tele_station_lat?: number; tele_station_long?: number } }) =>
      Number.isFinite(s.station?.tele_station_lat) &&
      Number.isFinite(s.station?.tele_station_long) &&
      inBox(s.station!.tele_station_lat!, s.station!.tele_station_long!);
    await Promise.all([
      fetch("/api/bmr/klongmap", { cache: "no-store" })
        .then(async (r) => {
          const j = (await r.json()) as BmaPayload & { error?: string };
          if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
          setBma(j);
          setBmaErr(null);
        })
        .catch((e) => setBmaErr(e instanceof Error ? e.message : "relay failed")),
      fetch(THAIWATER_RAIN_24H_URL, { cache: "no-store" })
        .then(async (r) => r.ok && setRain(((await r.json()).data as ThaiWaterStation[]).filter(ok)))
        .catch(() => {}),
      fetch(THAIWATER_WATERLEVEL_URL, { cache: "no-store" })
        .then(async (r) => r.ok && setWater(((await r.json()).data as ThaiWaterLevelStation[]).filter(ok)))
        .catch(() => {}),
    ]);
    setUpdatedAt(Date.now());
    setCamTick((v) => v + 1);
    setBusy(false);
  }, []);
  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    const id = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, [load]);

  // ── Derived
  const bmaSorted = useMemo(
    () => [...(bma?.gauges ?? [])].sort((a, b) => BMA_STATUS_META[b.status].rank - BMA_STATUS_META[a.status].rank || (b.overCritical ?? -9) - (a.overCritical ?? -9)),
    [bma],
  );
  const bmaCounts = useMemo(() => {
    const c: Record<BmaStatus, number> = { critical: 0, warning: 0, watch: 0, normal: 0, unknown: 0 };
    for (const g of bma?.gauges ?? []) c[g.status]++;
    return c;
  }, [bma]);
  const waterRows = useMemo(
    () =>
      (water ?? [])
        .map((s) => {
          const pct = bankPercentOf(s);
          const cur = Number(s.waterlevel_msl);
          const prev = Number(s.waterlevel_msl_previous);
          // HII keeps serving a station's last value after it goes quiet;
          // a reading older than a day is history, not status.
          const t = Date.parse((s.waterlevel_datetime ?? "").replace(" ", "T") + "+07:00");
          // Measured against the last refresh, not the wall clock: the memo
          // must stay pure and only move when the data does.
          const stale = !Number.isFinite(t) || (updatedAt ?? 0) - t > 24 * 3600_000;
          return { s, pct, cur, dCm: Number.isFinite(cur) && Number.isFinite(prev) ? (cur - prev) * 100 : null, stale };
        })
        .sort((a, b) => Number(a.stale) - Number(b.stale) || (b.pct ?? -1) - (a.pct ?? -1)),
    [water, updatedAt],
  );
  const liveRows = waterRows.filter((r) => !r.stale);
  const staleCount = waterRows.length - liveRows.length;
  const overBank = liveRows.filter((r) => (r.pct ?? 0) >= 100).length;
  const nearBank = liveRows.filter((r) => (r.pct ?? 0) >= 80 && (r.pct ?? 0) < 100).length;
  const rising = liveRows.filter((r) => (r.dCm ?? 0) >= 1).length;
  const rainSorted = useMemo(() => [...(rain ?? [])].sort((a, b) => (b.rain_1h ?? 0) - (a.rain_1h ?? 0)), [rain]);
  const rainTop = rainSorted[0];
  const raining = (rain ?? []).filter((s) => (s.rain_1h ?? 0) > 0).length;
  const tideToday = useMemo(() => {
    const t = bma?.tide ?? [];
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
    return t.find((x) => x.date && new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(x.date)) === today) ?? t[0] ?? null;
  }, [bma]);
  const tideMax = useMemo(() => {
    if (!tideToday) return null;
    const c = [
      { v: tideToday.high, t: tideToday.highTime, label: "รอบเช้า" },
      { v: tideToday.nightHigh, t: tideToday.nightTime, label: "รอบค่ำ" },
    ].filter((x): x is { v: number; t: string | null; label: string } => x.v !== null);
    return c.sort((a, b) => b.v - a.v)[0] ?? null;
  }, [tideToday]);
  // Points at/above their threshold — drives the flood heatmap and ranks
  // the cameras. Weight 0.25 = just at the line, 1 = well over.
  const heatPts = useMemo(() => {
    const pts: { lat: number; lng: number; w: number; name: string }[] = [];
    for (const g of bma?.gauges ?? []) {
      if (g.status === "unknown" || g.level === null) continue;
      const ref = g.critical ?? g.warning ?? g.bank;
      if (ref === null) continue;
      const over = g.level - ref;
      if (over <= -0.1) continue; // only at or above the line
      // 0.8 m over critical saturates; just at the line is a faint glow.
      pts.push({ lat: g.lat, lng: g.lng, w: Math.min(1, 0.25 + over / 0.8), name: g.name });
    }
    for (const { s, pct, stale } of waterRows) {
      if (stale || pct === null || pct < 90) continue;
      const [lat, lng] = stPos(s);
      pts.push({ lat, lng, w: Math.min(1, 0.25 + (pct - 90) / 40), name: s.station.tele_station_name?.th ?? "สถานี สสน." });
    }
    return pts;
  }, [bma, waterRows]);
  // Cameras ranked by distance to the nearest over-threshold point — eyes on
  // the trouble. With nothing over threshold, nearest to the map centre.
  const camsNear = useMemo(
    () =>
      (cams ?? [])
        .map((c) => {
          if (heatPts.length === 0) return { c, km: haversineKm(mapCentre[0], mapCentre[1], c.lat, c.lng), near: null as string | null };
          let best = Infinity;
          let near: string | null = null;
          for (const pt of heatPts) {
            const d = haversineKm(pt.lat, pt.lng, c.lat, c.lng);
            if (d < best) {
              best = d;
              near = pt.name;
            }
          }
          return { c, km: best, near };
        })
        .sort((a, b) => a.km - b.km)
        .slice(0, 12),
    [cams, mapCentre, heatPts],
  );

  // ── History on demand (HII only)
  const loadHistory = useCallback(
    async (code: string) => {
      if (hist[code]) return;
      setHist((h) => ({ ...h, [code]: "loading" }));
      try {
        const r = await fetch(`/api/hii/history?code=${encodeURIComponent(code)}`);
        const j = (await r.json()) as { points?: [number, number][]; bank?: number | null; error?: string };
        if (!r.ok || !j.points) throw new Error(j.error ?? "no data");
        setHist((h) => ({ ...h, [code]: { points: j.points!, bank: j.bank ?? null } }));
      } catch {
        setHist((h) => ({ ...h, [code]: "error" }));
      }
    },
    [hist],
  );
  const selHii = selected?.kind === "hii" ? waterRows.find((r) => r.s.id === selected.id) ?? null : null;
  const selHiiCode = selHii?.s.station.tele_station_oldcode ?? null;
  useEffect(() => {
    if (!selHiiCode) return;
    const t = window.setTimeout(() => void loadHistory(selHiiCode), 0);
    return () => window.clearTimeout(t);
  }, [selHiiCode, loadHistory]);
  const selBma = selected?.kind === "bma" ? bma?.gauges.find((g) => g.code === selected.code) ?? null : null;
  const selCam = selected?.kind === "cam" ? cams?.find((c) => c.id === selected.id) ?? null : null;

  // ── Map
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!mapEl.current || mapRef.current) return;
      const L = await import("leaflet");
      if (cancelled || !mapEl.current) return;
      LRef.current = L;
      const map = L.map(mapEl.current, { center: CENTRE, zoom: 10, zoomControl: true, preferCanvas: true });
      L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
        maxNativeZoom: 16,
        maxZoom: 19,
        attribution: "Basemap © Esri, HERE, Garmin, OpenStreetMap contributors",
      }).addTo(map);
      const labels = map.createPane("labels");
      labels.style.zIndex = "480";
      labels.style.pointerEvents = "none";
      L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}", {
        pane: "labels",
        maxNativeZoom: 16,
        opacity: 0.9,
      }).addTo(map);
      map.fitBounds([
        [BBOX.s, BBOX.w],
        [BBOX.n, BBOX.e],
      ]);
      map.on("moveend", () => {
        const c = map.getCenter();
        setMapCentre([c.lat, c.lng]);
      });
      mapRef.current = map;
      setMapInst({ L, map });
    })();
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  const swap = (key: string, layer: Leaflet.Layer | null) => {
    const map = mapRef.current;
    const old = layerRefs.current[key];
    if (old && map) old.removeFrom(map);
    layerRefs.current[key] = layer;
    if (layer && map) layer.addTo(map);
  };

  useEffect(() => {
    if (!mapInst || !provinces) return;
    swap(
      "prov",
      mapInst.L.geoJSON(provinces as GeoJSON.GeoJsonObject, {
        interactive: false,
        style: { color: "#ffffff", weight: 1.2, opacity: 0.55, fill: false, dashArray: "4 4" },
      }),
    );
  }, [mapInst, provinces]);

  // Satellite flood (7 d) — the same archive the national map draws.
  useEffect(() => {
    if (!mapInst) return;
    let cancelled = false;
    if (!show.sar || !sar?.tiles) {
      swap("sar", null);
      return;
    }
    (async () => {
      const { PMTiles, leafletRasterLayer } = await import("pmtiles");
      if (cancelled) return;
      const t = sar.tiles!;
      const layer = leafletRasterLayer(new PMTiles(t.url || `/data/${t.file}`), {
        opacity: 0.9,
        maxNativeZoom: t.max_zoom,
        maxZoom: 19,
        attribution: "Copernicus EMS GFM · Sentinel-1",
      }) as unknown as Leaflet.Layer;
      if (!cancelled) swap("sar", layer);
    })();
    return () => {
      cancelled = true;
    };
  }, [mapInst, show.sar, sar]);

  // Exceedance heat — where the canal system is over its limits, weighted
  // by how far over. A blinking square only says a line was crossed; the
  // surface shows a basin failing together. Includes HII/RID gauges over
  // their bank so the Chao Phraya reads in the same picture.
  useEffect(() => {
    if (!mapInst) return;
    let cancelled = false;
    if (!show.heat || (!bma && !water)) {
      swap("heat", null);
      return;
    }
    (async () => {
      const { L } = mapInst;
      // leaflet.heat attaches itself to the global `L`. The dynamic import
      // gives a frozen ES-module namespace, which the plugin cannot extend;
      // hand it the real Leaflet object (the CJS export behind `default`).
      const Lreal = (L as unknown as { default?: typeof Leaflet }).default ?? L;
      (window as unknown as { L: typeof Leaflet }).L = Lreal;
      await import("leaflet.heat");
      if (cancelled) return;
      const pts: [number, number, number][] = heatPts.map((pt) => [pt.lat, pt.lng, pt.w]);
      // The plugin always draws into the overlay pane (z 400), which sits
      // under the marker pane, so gauge squares stay on top of the glow.
      const layer = Lreal.heatLayer(pts, {
        radius: 34,
        blur: 26,
        minOpacity: 0.28,
        maxZoom: 13,
        gradient: { 0.2: "#67E8F9", 0.55: "#38BDF8", 1: "#1D4ED8" },
      });
      swap("heat", layer);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapInst, show.heat, heatPts]);

  // BMA canal gauges — squares, coloured by BMA's own status.
  useEffect(() => {
    if (!mapInst) return;
    if (!show.bma || !bma) {
      swap("bma", null);
      return;
    }
    const { L } = mapInst;
    const g = L.layerGroup();
    for (const s of bma.gauges) {
      const m = BMA_STATUS_META[s.status];
      // River side ≥ 1 m above the canal side: the gate is holding back the
      // river. Shown as a ring, not in the heatmap — the canal is not over.
      const gap = s.kind === "gate" && s.level !== null && s.levelOut !== null ? s.levelOut - s.level : null;
      const pressure = gap !== null && gap >= 1;
      const icon = L.divIcon({
        className: "bmr-pin",
        html: `<span class="bmr-sq ${s.kind === "gate" ? "is-gate" : ""} ${pressure ? "is-pressure" : ""}" style="--c:${m.color}"></span>`,
        iconSize: [12, 12],
        iconAnchor: [6, 6],
      });
      L.marker([s.lat, s.lng], { icon, zIndexOffset: s.status === "critical" ? 300 : 100 })
        .bindTooltip(
          `<b>${s.name}</b><br/>${m.label}${s.level !== null ? ` · ${s.level.toFixed(2)} ม.` : ""}${s.critical !== null ? ` (วิกฤต ${s.critical.toFixed(2)})` : ""}${pressure && s.levelOut !== null && gap !== null ? `<br/>นอกประตู ${s.levelOut.toFixed(2)} ม. — สูงกว่าใน ${gap.toFixed(2)} ม.` : ""}<br/><span style="opacity:.7">สนน. กทม. · ${s.ageMin !== null ? `${s.ageMin} นาทีก่อน` : "—"}</span>`,
          { direction: "top" },
        )
        .on("click", () => setSelected({ kind: "bma", code: s.code }))
        .addTo(g);
    }
    swap("bma", g);
  }, [mapInst, show.bma, bma]);

  // HII/RID gauges — circles, % of bank.
  useEffect(() => {
    if (!mapInst) return;
    if (!show.hii || !water) {
      swap("hii", null);
      return;
    }
    const { L } = mapInst;
    const g = L.layerGroup();
    for (const { s, pct, stale } of waterRows) {
      L.circleMarker(stPos(s), { radius: 7, color: "#ffffff", weight: 2, fillColor: !stale && pct !== null ? bankPercentColor(pct) : "#9aa6a6", fillOpacity: stale ? 0.6 : 1 })
        .bindTooltip(
          `<b>${s.station.tele_station_name?.th ?? "สถานี"}</b><br/>${pct !== null ? `${Math.round(pct)}% ตลิ่ง · ${bankPercentLabel(pct)}` : "ไม่มีค่าตลิ่ง"}<br/><span style="opacity:.7">${s.agency?.agency_shortname?.th ?? ""} · ${fmtTime(s.waterlevel_datetime)}</span>`,
          { direction: "top" },
        )
        .on("click", () => setSelected({ kind: "hii", id: s.id }))
        .addTo(g);
    }
    swap("hii", g);
  }, [mapInst, show.hii, water, waterRows]);

  // Rain gauges — small dots by 1 h intensity, off by default (185 of them).
  useEffect(() => {
    if (!mapInst) return;
    if (!show.rain || !rain) {
      swap("rain", null);
      return;
    }
    const { L } = mapInst;
    const g = L.layerGroup();
    for (const s of rain) {
      const mm = s.rain_1h ?? 0;
      L.circleMarker(stPos(s), { radius: mm > 0 ? 5 : 3, color: "#07131a", weight: 1, fillColor: mm > 0 ? rainIntensityColor(mm) : "rgba(120,180,210,0.5)", fillOpacity: 1, interactive: true })
        .bindTooltip(`<b>${s.station.tele_station_name?.th ?? "ฝน"}</b><br/>1 ชม. ${mm.toFixed(1)} มม. · 24 ชม. ${(s.rain_24h ?? 0).toFixed(1)} มม.<br/><span style="opacity:.7">${s.agency?.agency_shortname?.th ?? ""} · ${fmtTime(s.rainfall_datetime)}</span>`, { direction: "top" })
        .addTo(g);
    }
    swap("rain", g);
  }, [mapInst, show.rain, rain]);

  // Cameras.
  useEffect(() => {
    if (!mapInst) return;
    if (!show.cams || !cams) {
      swap("cams", null);
      return;
    }
    const { L } = mapInst;
    const g = L.layerGroup();
    const icon = L.divIcon({ className: "bmr-pin", html: '<span class="bmr-cam">▣</span>', iconSize: [14, 14], iconAnchor: [7, 7] });
    const waterIcon = L.divIcon({ className: "bmr-pin", html: '<span class="bmr-cam is-water">▣</span>', iconSize: [14, 14], iconAnchor: [7, 7] });
    for (const c of cams) {
      L.marker([c.lat, c.lng], { icon: c.kind === "water" ? waterIcon : icon, zIndexOffset: c.kind === "water" ? 80 : 50 })
        .bindTooltip(`${c.kind === "water" ? "💧" : "📷"} ${c.title}<br/><span style="opacity:.7">${c.org}</span>`, { direction: "top" })
        .on("click", () => {
          setSelected({ kind: "cam", id: c.id });
          setTab("cameras");
        })
        .addTo(g);
    }
    swap("cams", g);
  }, [mapInst, show.cams, cams]);

  const flyTo = (lat: number, lng: number, z = 14) => mapRef.current?.flyTo([lat, lng], Math.max(z, mapRef.current.getZoom()), { duration: 0.6 });

  // Opened from the canal sheet / board with a station in hand: select it
  // and fly there once its payload is in.
  const focusedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!focus || !mapInst) return;
    const key = `${focus.kind}:${"code" in focus ? focus.code : focus.id}`;
    if (focusedRef.current === key) return;
    let sel: Selected = null;
    let tabFor: Tab = "canals";
    let at: [number, number] | null = null;
    if (focus.kind === "bma") {
      const g = bma?.gauges.find((x) => x.code === focus.code);
      if (!g) return;
      sel = { kind: "bma", code: g.code };
      at = [g.lat, g.lng];
    } else {
      const st = water?.find((x) => x.id === focus.id);
      if (!st) return;
      sel = { kind: "hii", id: st.id };
      tabFor = "rivers";
      at = [st.station.tele_station_lat, st.station.tele_station_long];
    }
    focusedRef.current = key;
    mapInst.map.flyTo(at, 14, { duration: 0.6 });
    // Deferred so the selection is not a synchronous set-state in the effect.
    const t = window.setTimeout(() => {
      setSelected(sel);
      setTab(tabFor);
    }, 0);
    return () => window.clearTimeout(t);
  }, [focus, mapInst, bma, water]);

  const clock = now === null ? "--:--:--" : new Intl.DateTimeFormat("th-TH", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: TZ }).format(now);
  const nextIn = updatedAt && now !== null ? Math.max(0, updatedAt + REFRESH_MS - now) : null;
  const radarBucket = Math.floor((now ?? 0) / REFRESH_MS);
  const bmaAge = bma?.sourceAt && now !== null ? Math.round((now - Date.parse(bma.sourceAt)) / 60000) : null;

  return (
    <div className="kl-page">
      <header className="kl-head">
        {onBack ? (
          <button type="button" className="ms-back" onClick={onBack} aria-label="กลับไปผังคลอง">
            <ArrowLeft size={18} />
          </button>
        ) : (
          <Link href="/" className="ms-back" aria-label="กลับไปที่แผนที่ทั่วประเทศ">
            <ArrowLeft size={18} />
          </Link>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 className="ms-title">
            <Waves size={19} style={{ color: "var(--accent)", flex: "none" }} />
            รอระบาย · กรุงเทพฯ และปริมณฑล
          </h1>
          <p className="ms-sub"><span className="ms-slogan">ข้อมูลมีอยู่ทุกที่ เราแค่หยิบมาวางที่เดียว</span> · กทม. นนทบุรี ปทุมธานี สมุทรปราการ สมุทรสาคร นครปฐม · ข้อมูลสดจาก สนน. กทม., สสน., ชป., iTIC, Copernicus</p>
        </div>
        <div className="kl-clock">
          <span className="num-mono kl-clock-time">{clock}</span>
          <span className="kl-clock-date">{now === null ? "" : new Intl.DateTimeFormat("th-TH", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: TZ }).format(now)}</span>
        </div>
        <div className="kl-sync">
          <span className={`kl-live ${bmaErr && !bma ? "is-err" : ""}`}>{bmaErr && !bma ? "บางแหล่งล่ม" : "LIVE"}</span>
          <span className="kl-sync-text">
            {updatedAt ? `อัปเดต ${fmtClock(new Date(updatedAt).toISOString())}` : "กำลังโหลด…"}
            {nextIn !== null ? ` · รอบถัดไป ${Math.floor(nextIn / 60000)}:${String(Math.floor((nextIn % 60000) / 1000)).padStart(2, "0")}` : ""}
          </span>
        </div>
        <button className="ms-refresh" onClick={() => void load()} disabled={busy} aria-label="รีเฟรชทันที">
          <RefreshCw size={16} style={{ animation: busy ? "ff-spin 1s linear infinite" : undefined }} />
        </button>
      </header>

      {/* ── KPIs */}
      <section className="kl-kpis">
        <div className="kl-kpi" style={{ borderColor: bmaCounts.critical ? "rgba(230,59,46,0.6)" : undefined }}>
          <span className="kl-kpi-label"><Waves size={13} /> คลอง กทม. ถึงระดับวิกฤต</span>
          <span className="kl-kpi-val num-mono" style={{ color: bmaCounts.critical ? "#ff8a80" : "var(--ink)" }}>
            {bma ? bmaCounts.critical : "—"}
            <small> / {bma?.gauges.length ?? "—"} สถานี</small>
          </span>
          <span className="kl-kpi-sub">{bma ? `เตือนภัย ${bmaCounts.warning} · เฝ้าระวัง ${bmaCounts.watch} · เกณฑ์ของ สนน. กทม.` : bmaErr ?? "กำลังโหลด"}</span>
        </div>
        <div className="kl-kpi" style={{ borderColor: overBank ? "rgba(230,59,46,0.6)" : undefined }}>
          <span className="kl-kpi-label"><Droplets size={13} /> แม่น้ำ/คลอง ล้นตลิ่ง (สสน./ชป.)</span>
          <span className="kl-kpi-val num-mono" style={{ color: overBank ? "#ff8a80" : "var(--ink)" }}>
            {water ? overBank : "—"}
            <small> / {liveRows.length || "—"} สถานี</small>
          </span>
          <span className="kl-kpi-sub">{water ? `ใกล้ล้น ${nearBank} · กำลังขึ้น ${rising}${staleCount ? ` · ไม่ส่งข้อมูล ${staleCount}` : ""}` : "กำลังโหลด"}</span>
        </div>
        <div className="kl-kpi" style={{ borderColor: rainTop && (rainTop.rain_1h ?? 0) > 0 ? `${rainIntensityColor(rainTop.rain_1h ?? 0)}88` : undefined }}>
          <span className="kl-kpi-label"><CloudRain size={13} /> ฝน 1 ชม. สูงสุด</span>
          <span className="kl-kpi-val num-mono" style={{ color: rainTop && (rainTop.rain_1h ?? 0) > 0 ? rainIntensityColor(rainTop.rain_1h ?? 0) : "var(--ink)" }}>
            {rainTop ? (rainTop.rain_1h ?? 0).toFixed(1) : "—"}
            <small> มม.</small>
          </span>
          <span className="kl-kpi-sub">{rain ? (raining ? `${rainIntensityLabel(rainTop?.rain_1h ?? 0)} · ${rainTop?.station.tele_station_name?.th ?? ""} · ตก ${raining}/${rain.length} สถานี` : `ไม่มีฝน · ${rain.length} สถานี`) : "กำลังโหลด"}</span>
        </div>
        <div className="kl-kpi">
          <span className="kl-kpi-label">🌊 น้ำทะเลหนุนสูงสุดวันนี้</span>
          <span className="kl-kpi-val num-mono">
            {tideMax ? tideMax.v.toFixed(2) : "—"}
            <small> ม.</small>
          </span>
          <span className="kl-kpi-sub">{tideMax ? `เวลา ${fmtClock(tideMax.t)} น. · ${tideMax.label}` : "ตาราง สนน. กทม."}</span>
        </div>
        <div className="kl-kpi">
          <span className="kl-kpi-label"><Satellite size={13} /> น้ำท่วมจากดาวเทียม 7 วัน</span>
          <span className="kl-kpi-val num-mono">
            {sar ? n0(sar.flood_area_rai) : "—"}
            <small> ไร่ ทั่วประเทศ</small>
          </span>
          <span className="kl-kpi-sub">{sar ? `Sentinel-1 · ถึง ${fmtTime(sar.generated_at)}` : "—"}</span>
        </div>
      </section>

      <div className="kl-body">
        <div className="kl-map-wrap">
          <div ref={mapEl} className="kl-map" />
          <div className="glass kl-layers">
            <div className="caps" style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 4px 6px" }}>
              <Layers size={11} strokeWidth={2.4} /> ชั้นข้อมูล
            </div>
            {(
              [
                ["heat", "พื้นที่คาดว่าน้ำท่วม (คลอง/แม่น้ำเกินเกณฑ์)"],
                ["bma", "สถานีคลอง/ประตูน้ำ กทม. (สนน.)"],
                ["hii", "แม่น้ำ/คลอง สสน.-ชป."],
                ["rain", "สถานีฝน"],
                ["cams", cams ? `กล้อง (มีภาพ ${cams.length}${camsListed ? `/${camsListed}` : ""})` : "กล้อง"],
                ["sar", "น้ำท่วมจากดาวเทียม 7 วัน"],
              ] as [keyof typeof show, string][]
            ).map(([k, label]) => (
              <label key={k} className="kl-check">
                <input type="checkbox" checked={show[k]} onChange={(e) => setShow({ ...show, [k]: e.target.checked })} />
                {label}
              </label>
            ))}
          </div>
          <div className="glass kl-legend">
            <span className="kl-legend-row">
              <span className="kl-chip"><span className="sw" style={{ width: 52, borderRadius: 4, background: "linear-gradient(90deg, rgba(103,232,249,0), #67E8F9, #38BDF8, #1D4ED8)" }} /> พื้นที่คาดว่าน้ำท่วม · เกินเกณฑ์น้อย → มาก</span>
              <span className="kl-chip"><span className="sw bmr-sq-legend" style={{ background: "#e63b2e" }} /> สถานี กทม. วิกฤต</span>
              <span className="kl-chip"><span className="sw bmr-sq-legend" style={{ background: "#3fbf4e" }} /> ปกติ</span>
              <span className="kl-chip"><span className="sw bmr-sq-legend" style={{ background: "#3fbf4e", boxShadow: "0 0 0 3px rgba(125,211,252,0.6)" }} /> ประตูรับแรงดันแม่น้ำ (นอก−ใน ≥ 1 ม.)</span>
              <span className="kl-chip"><span className="sw" style={{ borderRadius: 999, background: "#e63b2e", border: "2px solid #fff" }} /> สสน./ชป. ล้นตลิ่ง</span>
              <span className="kl-chip"><span className="sw" style={{ background: "#22d3ee", opacity: 0.8 }} /> ดาวเทียมเห็นน้ำ</span>
              <span className="kl-chip"><span className="bmr-cam" style={{ fontSize: 12 }}>▣</span> กล้อง</span>
            </span>
          </div>
        </div>

        <aside className="kl-side">
          <nav className="kl-tabs" role="tablist">
            {(
              [
                ["now", "ตอนนี้"],
                ["canals", `คลอง กทม.${bmaCounts.critical ? ` ${bmaCounts.critical}` : ""}`],
                ["rivers", "สสน./ชป."],
                ["rain", "ฝน"],
                ["cameras", "กล้อง"],
              ] as [Tab, string][]
            ).map(([k, label]) => (
              <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
                {label}
              </button>
            ))}
          </nav>

          {/* ── Selected item detail (any tab) */}
          {selBma ? (
            <section className="kl-card" style={{ borderColor: `${BMA_STATUS_META[selBma.status].color}88` }}>
              <div className="kl-card-head">
                <span className="bmr-sq" style={{ "--c": BMA_STATUS_META[selBma.status].color } as React.CSSProperties} />
                {selBma.name}
                <button className="kl-icon-btn" style={{ marginLeft: "auto" }} onClick={() => setSelected(null)} aria-label="ปิด"><X size={14} /></button>
              </div>
              <div className="kl-stats">
                <div><span className="num-mono kl-stat" style={{ color: BMA_STATUS_META[selBma.status].color }}>{selBma.level?.toFixed(2) ?? "—"}</span><span className="kl-sub">ระดับน้ำ ม.รทก.</span></div>
                <div><span className="num-mono kl-stat">{selBma.warning?.toFixed(2) ?? "—"}</span><span className="kl-sub">เตือนภัย</span></div>
                <div><span className="num-mono kl-stat">{selBma.critical?.toFixed(2) ?? "—"}</span><span className="kl-sub">วิกฤต</span></div>
              </div>
              <div className="kl-sub">
                {BMA_STATUS_META[selBma.status].label}
                {selBma.overCritical !== null ? ` · ${selBma.overCritical >= 0 ? "เกินวิกฤต" : "ต่ำกว่าวิกฤต"} ${Math.abs(selBma.overCritical).toFixed(2)} ม.` : ""}
                {selBma.maxToday !== null ? ` · สูงสุดวันนี้ ${selBma.maxToday.toFixed(2)} ม.` : ""}
                {selBma.levelOut !== null ? ` · นอกประตู ${selBma.levelOut.toFixed(2)} ม.` : ""}
                {selBma.bank !== null ? ` · ตลิ่ง ${selBma.bank.toFixed(2)} ม.` : ""}
                <br />
                {selBma.code} · สนน. กทม. · {selBma.time ? fmtTime(selBma.time) : "—"} · ไม่มีกราฟย้อนหลัง (BMA ให้เฉพาะค่าล่าสุด)
              </div>
              <button className="kl-btn" style={{ marginTop: 8 }} onClick={() => flyTo(selBma.lat, selBma.lng, 15)}>ไปที่จุดบนแผนที่</button>
            </section>
          ) : null}
          {selHii ? (
            <section className="kl-card" style={{ borderColor: selHii.pct !== null ? `${bankPercentColor(selHii.pct)}88` : undefined }}>
              <div className="kl-card-head">
                <Droplets size={16} style={{ color: selHii.pct !== null ? bankPercentColor(selHii.pct) : "var(--ink-3)" }} />
                {selHii.s.station.tele_station_name?.th ?? "สถานี"}
                <button className="kl-icon-btn" style={{ marginLeft: "auto" }} onClick={() => setSelected(null)} aria-label="ปิด"><X size={14} /></button>
              </div>
              <div className="kl-stats">
                <div><span className="num-mono kl-stat" style={{ color: selHii.pct !== null ? bankPercentColor(selHii.pct) : undefined }}>{selHii.pct !== null ? `${Math.round(selHii.pct)}%` : "—"}</span><span className="kl-sub">ของตลิ่ง</span></div>
                <div><span className="num-mono kl-stat">{Number.isFinite(selHii.cur) ? selHii.cur.toFixed(2) : "—"}</span><span className="kl-sub">ม.รทก.</span></div>
                <div><span className="num-mono kl-stat" style={{ color: (selHii.dCm ?? 0) >= 1 ? "var(--r-high)" : (selHii.dCm ?? 0) <= -1 ? "var(--accent)" : undefined }}>{selHii.dCm === null ? "—" : `${selHii.dCm >= 0 ? "+" : ""}${selHii.dCm.toFixed(0)}`}</span><span className="kl-sub">ซม. จากค่าก่อน</span></div>
              </div>
              <div className="kl-sub" style={{ marginBottom: 8 }}>
                {selHii.s.agency?.agency_shortname?.th ?? ""} · {selHii.s.basin?.basin_name?.th ?? ""} · {fmtTime(selHii.s.waterlevel_datetime)} · {selHiiCode ?? ""}
              </div>
              {selHiiCode ? (
                hist[selHiiCode] === "loading" || !hist[selHiiCode] ? (
                  <div className="kl-muted">กำลังโหลดประวัติ 30 วัน…</div>
                ) : hist[selHiiCode] === "error" ? (
                  <div className="kl-muted">สถานีนี้ไม่มีกราฟย้อนหลังใน สสน. (มักเป็นสถานี ชป.)</div>
                ) : (
                  <LevelChart h={hist[selHiiCode] as History} color={selHii.pct !== null ? bankPercentColor(selHii.pct) : "#5cc4ee"} label="ระดับน้ำ 30 วัน" />
                )
              ) : null}
              <button className="kl-btn" style={{ marginTop: 8 }} onClick={() => flyTo(...stPos(selHii.s), 14)}>ไปที่จุดบนแผนที่</button>
            </section>
          ) : null}
          {selCam ? (
            <section className="kl-card">
              <div className="kl-card-head">
                <CameraIcon size={16} style={{ color: "#5cc4ee" }} />
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selCam.title}</span>
                <button className="kl-icon-btn" onClick={() => setSelected(null)} aria-label="ปิด"><X size={14} /></button>
              </div>
              {/* eslint-disable-next-line @next/next/no-img-element -- MJPEG stream; the browser plays multipart/x-mixed-replace in an <img> */}
              <img
                key={`${selCam.id}-${camTick}`}
                src={selCam.live ? withTick(selCam.live, camTick) : withTick(selCam.snapshot, camTick)}
                alt={selCam.title}
                className="bmr-cam-img"
                onError={(e) => {
                  // Stream refused → fall back to the still.
                  const img = e.currentTarget;
                  if (!img.src.includes(selCam.snapshot)) img.src = withTick(selCam.snapshot, Date.now());
                }}
              />
              <div className="kl-sub" style={{ marginTop: 6 }}>{selCam.live ? "🔴 ภาพสด (MJPEG) · " : selCam.capturedAt ? `💧 ภาพเมื่อ ${new Intl.DateTimeFormat("th-TH", { hour: "2-digit", minute: "2-digit", timeZone: TZ }).format(new Date(selCam.capturedAt))} น. · ` : "ภาพนิ่ง · "}{selCam.org}{selCam.sponsor && selCam.sponsor !== selCam.org ? ` · ${selCam.sponsor}` : ""}</div>
            </section>
          ) : null}

          {tab === "now" ? (
            <>
              <section className="kl-card">
                <div className="kl-card-head">
                  <Radar size={16} style={{ color: "#5cc4ee" }} />
                  เรดาร์ฝน
                  <span className="kl-card-meta">สนน. กทม. ผ่านกรมอุตุฯ · วน 12 ภาพล่าสุด</span>
                </div>
                <div className="kl-tabs" style={{ marginBottom: 8, position: "static" }}>
                  {(Object.keys(RADARS) as RadarKey[]).map((k) => (
                    <button key={k} className={radar === k ? "on" : ""} onClick={() => setRadar(k)}>{RADARS[k].label}</button>
                  ))}
                </div>
                {radarWanted && now !== null ? (
                  <div className="kl-radar">
                    {/* eslint-disable-next-line @next/next/no-img-element -- remote animated GIF */}
                    <img src={`${RADARS[radar].url}?t=${radarBucket}`} alt={`เรดาร์ ${RADARS[radar].label}`} loading="lazy" />
                  </div>
                ) : (
                  <button className="kl-radar-load" onClick={() => setRadarWanted(true)}>แตะเพื่อโหลดภาพเรดาร์ (~4 MB)</button>
                )}
                <div className="kl-muted" style={{ marginTop: 6, display: "flex", justifyContent: "space-between" }}>
                  <span>เวลาของภาพอยู่มุมขวาล่าง · เขียว→แดง = ฝนเบา→หนัก</span>
                  <a href={RADARS[radar].page} target="_blank" rel="noreferrer" className="kl-link">กรมอุตุฯ <ExternalLink size={11} /></a>
                </div>
              </section>

              <section className="kl-card">
                <div className="kl-card-head"><Waves size={16} style={{ color: "#ff8a80" }} /> คลอง กทม. ที่ถึงระดับวิกฤต/เตือนภัย<span className="kl-card-meta">{bma ? `ข้อมูล ${bmaAge !== null ? `${bmaAge} นาทีก่อน` : ""}` : ""}</span></div>
                {!bma ? <div className="kl-muted">{bmaErr ?? "กำลังโหลด…"}</div> : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    {bmaSorted.filter((g) => g.status === "critical" || g.status === "warning").slice(0, 8).map((g) => <BmaRow key={g.code} g={g} onPick={() => { setSelected({ kind: "bma", code: g.code }); flyTo(g.lat, g.lng, 14); }} />)}
                    {bmaCounts.critical + bmaCounts.warning > 8 ? <button className="dw-row" style={{ justifyContent: "center", fontSize: 12.5, color: "var(--ink-2)" }} onClick={() => setTab("canals")}>ดูทั้งหมด {bmaCounts.critical + bmaCounts.warning} สถานี →</button> : null}
                    {bmaCounts.critical + bmaCounts.warning === 0 ? <div className="kl-muted">ไม่มีสถานีถึงเกณฑ์เตือนภัย</div> : null}
                  </div>
                )}
              </section>

              {tideToday ? (
                <section className="kl-card">
                  <div className="kl-card-head">🌊 น้ำทะเลหนุนวันนี้ (ตาราง สนน. กทม.)<span className="kl-card-meta">{tideToday.date ? new Intl.DateTimeFormat("th-TH", { weekday: "short", day: "numeric", month: "short", timeZone: TZ }).format(new Date(tideToday.date)) : ""}</span></div>
                  <div className="kl-stats" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
                    {(
                      [
                        ["ขึ้นเช้า", tideToday.high, tideToday.highTime, "#5cc4ee"],
                        ["ลงเช้า", tideToday.low, tideToday.lowTime, "var(--ink-2)"],
                        ["ขึ้นค่ำ", tideToday.nightHigh, tideToday.nightTime, "#5cc4ee"],
                        ["ลงค่ำ", tideToday.nightLow, tideToday.nightLowTime, "var(--ink-2)"],
                      ] as [string, number | null, string | null, string][]
                    ).map(([label, v, t, color]) => (
                      <div key={label}>
                        <span className="num-mono kl-stat" style={{ color, fontSize: 18 }}>{v !== null ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}` : "—"}</span>
                        <span className="kl-sub">{label} · {fmtClock(t)} น.</span>
                      </div>
                    ))}
                  </div>
                  <div className="kl-muted">ระดับที่ปากน้ำ ม.รทก. · น้ำหนุนช่วงเดียวกับฝนหนักคือช่วงที่คลองระบายไม่ทัน</div>
                </section>
              ) : null}
            </>
          ) : null}

          {tab === "canals" ? (
            <section className="kl-card">
              <div className="kl-card-head"><Waves size={16} style={{ color: "var(--accent)" }} /> คลองและประตูน้ำ กทม. {bma ? `(${bma.gauges.length})` : ""}<span className="kl-card-meta">เรียงตามความรุนแรง</span></div>
              {!bma ? <div className="kl-muted">{bmaErr ?? "กำลังโหลด…"}</div> : (
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  {bmaSorted.map((g) => <BmaRow key={g.code} g={g} onPick={() => { setSelected({ kind: "bma", code: g.code }); flyTo(g.lat, g.lng, 14); }} />)}
                </div>
              )}
              <div className="kl-muted" style={{ marginTop: 8 }}>{bma?.attribution}</div>
            </section>
          ) : null}

          {tab === "rivers" ? (
            <section className="kl-card">
              <div className="kl-card-head"><Droplets size={16} style={{ color: "var(--accent)" }} /> สถานีแม่น้ำ/คลอง สสน. และ ชป. {water ? `(${water.length})` : ""}<span className="kl-card-meta">เรียงตาม % ตลิ่ง</span></div>
              {!water ? <div className="kl-muted">กำลังโหลด…</div> : (
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  {waterRows.map(({ s, pct, cur, dCm, stale }) => (
                    <button key={s.id} className="dw-row" style={{ opacity: stale ? 0.55 : 1 }} onClick={() => { setSelected({ kind: "hii", id: s.id }); flyTo(...stPos(s), 13); }}>
                      <span style={{ width: 3, alignSelf: "stretch", borderRadius: 2, background: !stale && pct !== null ? bankPercentColor(pct) : "#9aa6a6", flex: "none" }} />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: "block", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.station.tele_station_name?.th ?? "สถานี"}</span>
                        <span className="kl-sub">{stale ? "⚠ ไม่ส่งข้อมูลเกิน 24 ชม. · " : ""}{s.agency?.agency_shortname?.th ?? ""} · {s.basin?.basin_name?.th ?? ""} · {fmtTime(s.waterlevel_datetime)}</span>
                      </span>
                      <span className="num-mono" style={{ textAlign: "right", color: pct !== null ? bankPercentColor(pct) : "var(--ink-3)", fontWeight: 700 }}>
                        {pct !== null ? `${Math.round(pct)}%` : Number.isFinite(cur) ? `${cur.toFixed(2)} ม.` : "—"}
                        <span className="kl-sub" style={{ color: (dCm ?? 0) >= 1 ? "var(--r-high)" : (dCm ?? 0) <= -1 ? "var(--accent)" : undefined }}>{dCm === null ? "" : `${dCm >= 1 ? "▲" : dCm <= -1 ? "▼" : "•"}${dCm >= 0 ? "+" : ""}${dCm.toFixed(0)} ซม.`}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
              <div className="kl-muted" style={{ marginTop: 8 }}>แตะสถานีเพื่อดูกราฟ 30 วัน (สถานี สสน.)</div>
            </section>
          ) : null}

          {tab === "rain" ? (
            <section className="kl-card">
              <div className="kl-card-head"><CloudRain size={16} style={{ color: "#5cc4ee" }} /> สถานีฝน {rain ? `(${rain.length})` : ""}<span className="kl-card-meta">เรียงตามฝน 1 ชม.</span></div>
              {!rain ? <div className="kl-muted">กำลังโหลด…</div> : (
                <table className="kl-table">
                  <thead><tr><th>สถานี</th><th style={{ textAlign: "right" }}>1 ชม.</th><th style={{ textAlign: "right" }}>24 ชม.</th></tr></thead>
                  <tbody>
                    {rainSorted.slice(0, 40).map((s) => (
                      <tr key={s.id} onClick={() => flyTo(...stPos(s), 13)} style={{ cursor: "pointer" }}>
                        <td>{s.station.tele_station_name?.th ?? "ฝน"}<span className="kl-sub">{s.agency?.agency_shortname?.th ?? ""} · {fmtTime(s.rainfall_datetime)}</span></td>
                        <td className="num-mono" style={{ textAlign: "right", color: rainIntensityColor(s.rain_1h ?? 0) }}>{(s.rain_1h ?? 0).toFixed(1)}</td>
                        <td className="num-mono" style={{ textAlign: "right" }}>{(s.rain_24h ?? 0).toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="kl-muted" style={{ marginTop: 8 }}>แสดง 40 สถานีแรก · เปิดชั้น &ldquo;สถานีฝน&rdquo; บนแผนที่เพื่อดูทั้งหมด · หน่วย มม.</div>
            </section>
          ) : null}

          {tab === "cameras" ? (
            <section className="kl-card">
              <div className="kl-card-head"><CameraIcon size={16} style={{ color: "#5cc4ee" }} /> {heatPts.length ? "กล้องใกล้จุดน้ำเกินเกณฑ์" : "กล้องใกล้กลางแผนที่"}<span className="kl-card-meta">{cams ? `มีภาพ ${cams.length}${camsListed ? ` จาก ${camsListed}` : ""} ตัว` : ""}</span></div>
              {!cams ? <div className="kl-muted">กำลังโหลด…</div> : (
                <div className="bmr-cam-grid">
                  {camsNear.map(({ c, km, near }) => (
                    <button key={c.id} className="bmr-cam-card" onClick={() => { setSelected({ kind: "cam", id: c.id }); flyTo(c.lat, c.lng, 14); }}>
                      {/* eslint-disable-next-line @next/next/no-img-element -- remote snapshot */}
                      <img src={withTick(c.snapshot, camTick)} alt={c.title} loading="lazy" />
                      <span className="bmr-cam-title">{c.kind === "water" ? "💧 " : ""}{c.title}</span>
                      <span className="kl-sub">{km.toFixed(1)} กม.{near ? ` จาก ${near}` : ""} · {c.org}</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="kl-muted" style={{ marginTop: 8 }}>กล้องสาธารณะ: จราจร (iTIC/Longdo/กรมทางหลวง) + กล้องระดับน้ำ สนน. กทม. 6 จุด (💧) — แสดงเฉพาะตัวที่มีภาพ ณ ตอนนี้; กล้อง สนน. ต้องมีภาพใหม่ภายใน 30 นาที — ตรวจใหม่ทุก 10 นาที · แตะเพื่อดูภาพสด · เลื่อนแผนที่เพื่อเปลี่ยนชุดกล้อง · กล้องกรมทางหลวงในฟีดไม่ส่งภาพ และไม่มีกล้องของ สนน. ในฟีดสาธารณะ</div>
            </section>
          ) : null}

          <p className="ms-disclaim" style={{ marginTop: 14 }}>
            เป็นเครื่องมือแสดงข้อมูล ไม่ใช่ประกาศเตือนภัยทางการ · คลอง กทม.: สนน. กทม. ผ่าน relay flood69 · สถานี: สสน./ชป. · ฝน: สสน. (รวม สนน. กทม., อต.) · กล้อง: iTIC/Longdo, ทล. · น้ำท่วมดาวเทียม: Copernicus GFM · เรดาร์: สนน. กทม. ผ่านกรมอุตุฯ
          </p>
        </aside>
      </div>
    </div>
  );
}

function BmaRow({ g, onPick }: { g: BmaGauge; onPick: () => void }) {
  const m = BMA_STATUS_META[g.status];
  return (
    <button className="dw-row" onClick={onPick}>
      <span style={{ width: 3, alignSelf: "stretch", borderRadius: 2, background: m.color, flex: "none" }} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{g.name}</span>
        <span className="kl-sub">
          {g.kind === "gate" ? "ประตูน้ำ" : "จุดวัด"} · {m.label}
          {g.overCritical !== null ? ` · ${g.overCritical >= 0 ? "เกินวิกฤต" : "ต่ำกว่าวิกฤต"} ${Math.abs(g.overCritical).toFixed(2)} ม.` : ""}
          {g.ageMin !== null ? ` · ${g.ageMin} นาทีก่อน` : ""}
        </span>
      </span>
      <span className="num-mono" style={{ textAlign: "right", color: m.color, fontWeight: 700 }}>
        {g.level?.toFixed(2) ?? "—"}
        <span className="kl-sub">วิกฤต {g.critical?.toFixed(2) ?? "—"}</span>
      </span>
    </button>
  );
}
