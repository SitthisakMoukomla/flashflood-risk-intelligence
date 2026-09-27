"use client";

// Operations view for Krathum Lom municipality staff.
//
// Two questions, side by side:
//   ตอนนี้ — how hard is it raining around the municipality, and where are
//            the canals and the Tha Chin relative to their banks?
//   ที่ผ่านมา — which parts of the municipality has the satellite seen
//            under water, in how many of the last years, and which houses
//            stand there?
//
// The history comes from pipeline/scripts/18_krathumlom_history.py. About
// half the municipality is built-up land the radar cannot see into; the
// page marks it as such everywhere instead of letting it read as "dry".

import { ArrowLeft, Building2, CloudRain, Droplets, Layers, RefreshCw, Satellite, Waves } from "lucide-react";
import Link from "next/link";
import type * as Leaflet from "leaflet";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

const DATA = "/data/krathumlom";
/** Municipality office — the centre distances are measured from. */
const CENTRE: [number, number] = [13.7422545, 100.3293329];
const RAIN_RADIUS_KM = 10;
const WATER_RADIUS_KM = 15;

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

// Same palette as the PNG classes, for footprints drawn on top of it.
function yearsColor(y: number): string {
  if (y >= 7) return "#a50026";
  if (y >= 4) return "#f46d43";
  if (y >= 2) return "#fdae61";
  return "#fee08b";
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("th-TH", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "Asia/Bangkok",
    }).format(new Date(iso.replace(" ", "T")));
  } catch {
    return iso;
  }
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("th-TH", { month: "short", year: "numeric" }).format(new Date(iso));
}

const DIRS = ["เหนือ", "ตะวันออกเฉียงเหนือ", "ตะวันออก", "ตะวันออกเฉียงใต้", "ใต้", "ตะวันตกเฉียงใต้", "ตะวันตก", "ตะวันตกเฉียงเหนือ"];
/** "1.8 กม. ทางตะวันตกเฉียงใต้ของสำนักงาน" — orientation staff can use in the field. */
function fromOffice(lat: number, lon: number): string {
  const dy = lat - CENTRE[0];
  const dx = (lon - CENTRE[1]) * Math.cos((CENTRE[0] * Math.PI) / 180);
  const bearing = (Math.atan2(dx, dy) * 180) / Math.PI;
  const dir = DIRS[Math.round(((bearing + 360) % 360) / 45) % 8];
  return `${haversineKm(CENTRE[0], CENTRE[1], lat, lon).toFixed(1)} กม. ทาง${dir}ของสำนักงาน`;
}

const n0 = (v: number) => new Intl.NumberFormat("th-TH").format(Math.round(v));
const pos = (s: { station: { tele_station_lat: number; tele_station_long: number } }) =>
  [s.station.tele_station_lat, s.station.tele_station_long] as [number, number];

export function KrathumLomDashboard() {
  const mapEl = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Leaflet.Map | null>(null);
  const LRef = useRef<typeof Leaflet | null>(null);
  const historyLayerRef = useRef<Leaflet.ImageOverlay | null>(null);
  const bldgLayerRef = useRef<Leaflet.GeoJSON | null>(null);
  const radarLayerRef = useRef<Leaflet.TileLayer | null>(null);
  const gaugeLayerRef = useRef<Leaflet.LayerGroup | null>(null);
  const [ready, setReady] = useState(false);

  const [meta, setMeta] = useState<HistoryMeta | null>(null);
  const [boundary, setBoundary] = useState<GeoJSON.Feature | null>(null);
  const [floodedBldg, setFloodedBldg] = useState<GeoJSON.FeatureCollection | null>(null);
  const [rain, setRain] = useState<ThaiWaterStation[] | null>(null);
  const [water, setWater] = useState<ThaiWaterLevelStation[] | null>(null);
  const [radarUrl, setRadarUrl] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [showHistory, setShowHistory] = useState(true);
  const [showBldg, setShowBldg] = useState(true);
  const [showRadar, setShowRadar] = useState(false);

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

  // ── Live telemetry
  const load = useCallback(async () => {
    setBusy(true);
    try {
      const [r, w, rv] = await Promise.all([
        fetch(THAIWATER_RAIN_24H_URL, { cache: "no-store" }),
        fetch(THAIWATER_WATERLEVEL_URL, { cache: "no-store" }),
        fetch("/api/rainviewer", { cache: "no-store" }),
      ]);
      const ok = (s: { station?: { tele_station_lat?: number; tele_station_long?: number } }) =>
        Number.isFinite(s.station?.tele_station_lat) && Number.isFinite(s.station?.tele_station_long);
      if (r.ok) setRain(((await r.json()).data as ThaiWaterStation[]).filter(ok));
      if (w.ok) setWater(((await w.json()).data as ThaiWaterLevelStation[]).filter(ok));
      if (rv.ok) setRadarUrl(((await rv.json()) as { tileUrl?: string }).tileUrl ?? null);
      setUpdatedAt(new Date());
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "load failed");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    // Deferred so the first fetch does not set state inside the effect body.
    const first = window.setTimeout(() => void load(), 0);
    const id = window.setInterval(() => void load(), 10 * 60_000);
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
  const maxRain1h = nearRain.reduce((m, x) => Math.max(m, x.s.rain_1h ?? 0), 0);
  const maxRain24h = nearRain.reduce((m, x) => Math.max(m, x.s.rain_24h ?? 0), 0);

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
      mapRef.current = map;
      setReady(true);
    })();
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  // Boundary
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

  // History overlay
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

  // Buildings the satellite has seen flooded
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

  // Rain radar
  useEffect(() => {
    const L = LRef.current;
    const map = mapRef.current;
    if (!L || !map || !ready) return;
    radarLayerRef.current?.removeFrom(map);
    radarLayerRef.current = null;
    if (!showRadar || !radarUrl) return;
    radarLayerRef.current = L.tileLayer(radarUrl, { opacity: 0.7, maxNativeZoom: 10, zIndex: 400 }).addTo(map);
  }, [ready, showRadar, radarUrl]);

  // Gauges
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

  return (
    <div className="kl-page">
      <header className="kl-head">
        <Link href="/" className="ms-back" aria-label="กลับไปที่แผนที่ทั่วประเทศ">
          <ArrowLeft size={18} />
        </Link>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 className="ms-title">
            <Waves size={19} style={{ color: "var(--accent)", flex: "none" }} />
            เทศบาลเมืองกระทุ่มล้ม
          </h1>
          <p className="ms-sub">ข้อมูลน้ำท่วมสำหรับเจ้าหน้าที่ · อ.สามพราน จ.นครปฐม</p>
        </div>
        <button className="ms-refresh" onClick={() => void load()} disabled={busy} aria-label="รีเฟรช">
          <RefreshCw size={16} style={{ animation: busy ? "ff-spin 1s linear infinite" : undefined }} />
        </button>
      </header>

      <div className="kl-body">
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
            <label className="kl-check" style={{ opacity: radarUrl ? 1 : 0.5 }}>
              <input type="checkbox" checked={showRadar} disabled={!radarUrl} onChange={(e) => setShowRadar(e.target.checked)} />
              เรดาร์ฝนล่าสุด
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
              </span>
            </div>
          ) : null}
        </div>

        <aside className="kl-side">
          {err ? <div className="ms-err">โหลดข้อมูลไม่สำเร็จ: {err}</div> : null}

          {/* ── Now */}
          <h2 className="ms-h2" style={{ marginTop: 0 }}>ตอนนี้</h2>
          <section className="kl-card">
            <div className="kl-card-head">
              <CloudRain size={16} style={{ color: rainIntensityColor(maxRain1h) }} />
              ฝนรอบเทศบาล ({nearRain.length} สถานีในรัศมี {RAIN_RADIUS_KM} กม.)
            </div>
            {rain === null ? (
              <div className="kl-muted">กำลังโหลด…</div>
            ) : nearRain.length === 0 ? (
              <div className="kl-muted">ไม่มีสถานีวัดฝนในรัศมี {RAIN_RADIUS_KM} กม.</div>
            ) : (
              <>
                <div className="kl-big">
                  <span className="num-mono" style={{ color: rainIntensityColor(maxRain1h) }}>{maxRain1h.toFixed(1)}</span>
                  <span className="kl-unit">มม./ชม. สูงสุด · {maxRain1h > 0 ? rainIntensityLabel(maxRain1h) : "ไม่มีฝน"}</span>
                </div>
                <div className="kl-muted" style={{ marginBottom: 8 }}>ฝนสะสม 24 ชม. สูงสุด {maxRain24h.toFixed(1)} มม.</div>
                <table className="kl-table">
                  <tbody>
                    {nearRain.map(({ s, km }) => (
                      <tr key={s.id}>
                        <td>
                          {s.station.tele_station_name?.th ?? "สถานีฝน"}
                          <span className="kl-sub">{km.toFixed(1)} กม. · {s.agency?.agency_shortname?.th ?? ""} · {fmtTime(s.rainfall_datetime)}</span>
                        </td>
                        <td className="num-mono" style={{ color: rainIntensityColor(s.rain_1h ?? 0), textAlign: "right" }}>
                          {(s.rain_1h ?? 0).toFixed(1)}
                          <span className="kl-sub">1 ชม.</span>
                        </td>
                        <td className="num-mono" style={{ textAlign: "right" }}>
                          {(s.rain_24h ?? 0).toFixed(1)}
                          <span className="kl-sub">24 ชม.</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </section>

          <section className="kl-card">
            <div className="kl-card-head">
              <Droplets size={16} style={{ color: "var(--accent)" }} />
              ระดับน้ำคลองและแม่น้ำ ({nearWater.length} สถานีในรัศมี {WATER_RADIUS_KM} กม.)
            </div>
            {water === null ? (
              <div className="kl-muted">กำลังโหลด…</div>
            ) : (
              <table className="kl-table">
                <tbody>
                  {nearWater.map(({ s, km }) => {
                    const pct = bankPercentOf(s);
                    const cur = Number(s.waterlevel_msl);
                    const prev = Number(s.waterlevel_msl_previous);
                    const dCm = Number.isFinite(cur) && Number.isFinite(prev) ? (cur - prev) * 100 : null;
                    return (
                      <tr key={s.id}>
                        <td>
                          {s.station.tele_station_name?.th ?? "สถานีระดับน้ำ"}
                          <span className="kl-sub">
                            {km.toFixed(1)} กม. · {s.basin?.basin_name?.th ?? ""} · {s.agency?.agency_shortname?.th ?? ""} · {fmtTime(s.waterlevel_datetime)}
                          </span>
                        </td>
                        <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                          {pct !== null ? (
                            <span className="num-mono" style={{ color: bankPercentColor(pct), fontWeight: 700 }}>
                              {Math.round(pct)}%
                              <span className="kl-sub">{bankPercentLabel(pct)}</span>
                            </span>
                          ) : (
                            <span className="num-mono">
                              {Number.isFinite(cur) ? `${cur.toFixed(2)} ม.` : "—"}
                              <span className="kl-sub">รทก. · ไม่มีค่าตลิ่ง</span>
                            </span>
                          )}
                        </td>
                        <td className="num-mono" style={{ textAlign: "right", whiteSpace: "nowrap", color: dCm === null ? "var(--ink-3)" : dCm >= 1 ? "var(--r-high)" : dCm <= -1 ? "var(--accent)" : "var(--ink-3)" }}>
                          {dCm === null ? "—" : `${dCm >= 1 ? "▲" : dCm <= -1 ? "▼" : "•"} ${dCm >= 0 ? "+" : ""}${dCm.toFixed(0)}`}
                          <span className="kl-sub">ซม.</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <div className="kl-muted" style={{ marginTop: 6 }}>ไม่มีสถานีวัดระดับน้ำในเขตเทศบาล — ค่าที่เห็นมาจากคลองและท่าจีนรอบนอก</div>
          </section>

          {/* ── History */}
          <h2 className="ms-h2">ประวัติน้ำท่วมจากดาวเทียม</h2>
          {meta && b ? (
            <>
              <section className="kl-card">
                <div className="kl-card-head">
                  <Satellite size={16} style={{ color: "#5cc4ee" }} />
                  Sentinel-1 · {n0(meta.passes)} รอบถ่าย · {fmtDate(meta.first_pass)} – {fmtDate(meta.last_pass)}
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
                  ].map(([v, c], i) =>
                    (v as number) > 0 ? (
                      <span key={i} style={{ flex: v as number, background: c as string }} />
                    ) : null,
                  )}
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
                        <span className="kl-sub">{meta.recent_from}–{meta.recent_from + 2}</span>
                      </td>
                      <td className="num-mono" style={{ textAlign: "right", color: b.recent ? "var(--r-severe)" : undefined, fontWeight: 700 }}>
                        {n0(b.recent)}
                      </td>
                    </tr>
                  </tbody>
                </table>
                <div className="kl-muted" style={{ marginTop: 6 }}>
                  จาก {n0(observableBldg)} หลังที่ดาวเทียมมองเห็น · Google Open Buildings v3
                </div>
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
                          style={{ height: `${maxYearRai ? Math.max(2, (v.max_flooded_rai / maxYearRai) * 100) : 2}%` }}
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
                          <span style={{ display: "block", fontSize: 13, fontWeight: 600 }}>
                            {h.name ?? fromOffice(h.lat, h.lon)}
                          </span>
                          <span className="kl-sub">
                            {h.name ? `${fromOffice(h.lat, h.lon)} · ` : ""}
                            {n0(h.rai)} ไร่{h.buildings ? ` · บ้าน ${n0(h.buildings)} หลัง` : " · ไม่มีบ้าน (เกษตร/ที่โล่ง)"}
                          </span>
                          <span className="kl-years-chips">
                            {(h.years ?? []).map((y) => (
                              <span key={y} className={y >= meta.recent_from ? "recent" : ""}>{String(y).slice(2)}</span>
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
          )}

          {/* ── What the municipality can add */}
          <h2 className="ms-h2">ข้อมูลที่รอจากเทศบาล</h2>
          <section className="kl-card">
            <ul className="kl-todo">
              <li><b>ขอบเขตเทศบาล</b> — ตอนนี้ใช้ขอบเขตตำบลกระทุ่มล้มจาก GADM แทน</li>
              <li><b>จุดน้ำท่วมขังที่เคยบันทึก</b> — เติมเขตที่ดาวเทียมมองไม่เห็น</li>
              <li><b>สถานีสูบน้ำ ประตูระบายน้ำ</b> — ตำแหน่ง ขนาดเครื่อง</li>
              <li><b>แนวคลองและท่อระบายน้ำหลัก</b></li>
              <li><b>ชุมชน/หมู่บ้าน</b> — ชื่อ จำนวนครัวเรือน ผู้ประสานงาน</li>
            </ul>
          </section>

          <p className="ms-disclaim" style={{ marginTop: 14 }}>
            เป็นเครื่องมือแสดงข้อมูล ไม่ใช่ประกาศเตือนภัยทางการ · {meta?.boundary_source ?? ""}
            {updatedAt ? ` · ข้อมูลสถานีอัปเดต ${fmtTime(updatedAt.toISOString())}` : ""}
          </p>
        </aside>
      </div>
    </div>
  );
}
