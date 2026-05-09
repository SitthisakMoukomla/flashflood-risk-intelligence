"use client";

import {
  AlertTriangle,
  Droplets,
  Layers,
  LocateFixed,
  MapPin,
  Mountain,
  Radar,
  Search,
} from "lucide-react";
import type * as Leaflet from "leaflet";
import type { GeoJSON as LeafletGeoJSON } from "leaflet";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  methodSteps,
  productCopy,
  riskMeta,
  type SourceNote,
  tierFromNorm,
} from "@/lib/risk-intelligence";
import {
  buildTambonRows,
  colorForRow,
  layerModes,
  precipRampRGBA,
  wetnessRampRGBA,
  type LayerMode,
  type TambonCollection,
  type TambonRow,
  type WetnessGrid,
  type WetnessPayload,
} from "@/lib/tambon";

type FloodMapProps = {
  copy: typeof productCopy;
  sources: SourceNote[];
};

type RainLayerPayload = {
  generatedAt: string;
  frameTime: string;
  tileUrl: string;
  source: string;
};

type StaticOverlayMeta = {
  generated_at: string;
  bbox: [number, number, number, number]; // west, south, east, north
  width: number;
  height: number;
  norm_low: number;
  norm_high: number;
};

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

function thaiName(slug: string): string {
  return PROVINCE_NAMES[slug] ?? slug;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("th-TH").format(value);
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  try {
    return new Intl.DateTimeFormat("th-TH", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Bangkok",
    }).format(new Date(value));
  } catch {
    return "—";
  }
}

function scoreOfRow(row: TambonRow, mode: LayerMode): number {
  if (mode === "wetness") return row.wetnessNorm;
  if (mode === "live") return row.liveNorm;
  return row.staticNorm;
}

/** Render a flat grid of values to a data URL. Returns null if no map context. */
function renderGridToDataURL(
  cols: number,
  rows: number,
  values: number[],
  cap: number,
  ramp: (t: number) => [number, number, number, number],
): string | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const img = ctx.createImageData(cols, rows);
  const buf = img.data;
  for (let i = 0; i < cols * rows; i++) {
    const t = Math.min(1, Math.max(0, values[i] / cap));
    const c = ramp(t);
    buf[i * 4] = c[0];
    buf[i * 4 + 1] = c[1];
    buf[i * 4 + 2] = c[2];
    buf[i * 4 + 3] = c[3];
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL();
}

export function FloodMap({ copy, sources }: FloodMapProps) {
  const mapElementRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Leaflet.Map | null>(null);
  const leafletRef = useRef<typeof Leaflet | null>(null);
  const polyLayerRef = useRef<LeafletGeoJSON | null>(null);
  const rainLayerRef = useRef<Leaflet.TileLayer | null>(null);
  const wetnessOverlayRef = useRef<Leaflet.ImageOverlay | null>(null);
  const precipOverlayRef = useRef<Leaflet.ImageOverlay | null>(null);
  const staticOverlayRef = useRef<Leaflet.ImageOverlay | null>(null);

  const [tambonFC, setTambonFC] = useState<TambonCollection | null>(null);
  const [wetness, setWetness] = useState<WetnessPayload | null>(null);
  const [grid, setGrid] = useState<WetnessGrid | null>(null);
  const [staticMeta, setStaticMeta] = useState<StaticOverlayMeta | null>(null);
  const [rainLayer, setRainLayer] = useState<RainLayerPayload | null>(null);
  const [layerMode, setLayerMode] = useState<LayerMode>("static");
  const [showRainOverlay, setShowRainOverlay] = useState(false);
  const [showPrecipOverlay, setShowPrecipOverlay] = useState(false);
  const [provinceFilter, setProvinceFilter] = useState<string>("");
  const [query, setQuery] = useState("");
  const [selectedGid, setSelectedGid] = useState<string | null>(null);
  const [isMapReady, setIsMapReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 1) Load static data
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
        if (wRes.ok) {
          const w = (await wRes.json()) as WetnessPayload;
          if (active) setWetness(w);
        }
        if (gRes.ok) {
          const g = (await gRes.json()) as WetnessGrid;
          if (active) setGrid(g);
        }
        if (sRes.ok) {
          const m = (await sRes.json()) as StaticOverlayMeta;
          if (active) setStaticMeta(m);
        }
      } catch (e) {
        if (active) setLoadError(e instanceof Error ? e.message : "load failed");
      }

      try {
        const r = await fetch("/api/rainviewer", { cache: "no-store" });
        if (r.ok) {
          const payload = (await r.json()) as RainLayerPayload;
          if (active) setRainLayer(payload);
        }
      } catch {
        /* silent — radar is optional */
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // 2) Build rows from data
  const rows = useMemo(
    () => (tambonFC ? buildTambonRows(tambonFC, wetness, grid) : []),
    [tambonFC, wetness, grid],
  );

  const provinces = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) set.add(r.feature.properties.NAME_1);
    return [...set].sort();
  }, [rows]);

  const sortedRows = useMemo(() => {
    return [...rows].sort((a, b) => scoreOfRow(b, layerMode) - scoreOfRow(a, layerMode));
  }, [rows, layerMode]);

  const filteredRows = useMemo(() => {
    const q = query.trim().toLocaleLowerCase("th-TH");
    return sortedRows.filter((row) => {
      const p = row.feature.properties;
      if (provinceFilter && p.NAME_1 !== provinceFilter) return false;
      if (q) {
        const hay = `${p.NAME_3} ${p.NAME_2} ${p.NAME_1} ${thaiName(p.NAME_1)}`.toLocaleLowerCase("th-TH");
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [sortedRows, provinceFilter, query]);

  const selectedRow = useMemo(() => {
    if (!selectedGid) return sortedRows[0] ?? null;
    return rows.find((r) => r.feature.properties.GID_3 === selectedGid) ?? sortedRows[0] ?? null;
  }, [rows, sortedRows, selectedGid]);

  const totals = useMemo(() => {
    let severe = 0;
    let high = 0;
    let buildings = 0;
    for (const r of rows) {
      const t = layerMode === "live" ? r.liveTier : r.tier;
      if (t === "severe") severe++;
      else if (t === "high") high++;
      buildings += r.feature.properties.cells;
    }
    return { severe, high, buildings };
  }, [rows, layerMode]);

  // 3) Initialize map once
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!mapElementRef.current || mapRef.current) return;
      const L = await import("leaflet");
      if (cancelled) return;
      leafletRef.current = L;
      const map = L.map(mapElementRef.current, {
        center: [18.7, 99.5],
        zoom: 7,
        zoomControl: false,
        preferCanvas: true,
      });
      L.control.zoom({ position: "bottomright" }).addTo(map);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 18,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
      }).addTo(map);
      mapRef.current = map;
      setIsMapReady(true);
    })();
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      polyLayerRef.current = null;
      rainLayerRef.current = null;
      setIsMapReady(false);
    };
  }, []);

  // 4) Render polygons when rows/mode/filters change
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!L || !map || !isMapReady || filteredRows.length === 0) return;

    if (polyLayerRef.current) {
      polyLayerRef.current.remove();
      polyLayerRef.current = null;
    }

    const rowByGid = new Map(filteredRows.map((r) => [r.feature.properties.GID_3, r]));
    const fc: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: filteredRows.map((r) => r.feature),
    };

    polyLayerRef.current = L.geoJSON(fc as never, {
      style: (feature) => {
        const gid = feature?.properties?.GID_3 as string | undefined;
        const row = gid ? rowByGid.get(gid) : undefined;
        if (!row) return {};
        const isSelected = row.feature.properties.GID_3 === selectedGid;
        // In static and wetness modes the underlying raster carries the colour.
        // 663 tambon outlines drawn at once turn into visual hash, so polygons
        // stay invisible until the user hovers or selects one — the layer is
        // still in the DOM so click hit-testing works.
        if (layerMode === "static" || layerMode === "wetness") {
          if (isSelected) {
            return {
              fillOpacity: 0.18,
              fillColor: "#ffffff",
              color: "#ffffff",
              weight: 2.5,
              opacity: 0.95,
            };
          }
          return {
            fillOpacity: 0,
            fillColor: "transparent",
            color: "transparent",
            weight: 0,
            opacity: 0,
          };
        }
        return {
          fillColor: colorForRow(row, layerMode),
          color: isSelected ? "#ffffff" : "#1d2f33",
          weight: isSelected ? 2.5 : 0.6,
          fillOpacity: 0.6,
          opacity: 0.85,
        };
      },
      onEachFeature: (feature, layer) => {
        const gid = feature?.properties?.GID_3 as string | undefined;
        const row = gid ? rowByGid.get(gid) : undefined;
        if (!row) return;
        const p = row.feature.properties;
        const pathLayer = layer as Leaflet.Path & { feature?: { properties?: { GID_3?: string } } };
        layer.on("click", () => {
          setSelectedGid(p.GID_3);
          map.flyTo(
            (layer as Leaflet.GeoJSON).getBounds().getCenter(),
            Math.max(map.getZoom(), 9),
            { duration: 0.6 },
          );
        });
        // Hover highlight — only meaningful in modes where polygons are otherwise hidden.
        layer.on("mouseover", () => {
          if (layerMode !== "static" && layerMode !== "wetness") return;
          if (pathLayer.feature?.properties?.GID_3 === selectedGid) return;
          pathLayer.setStyle({
            color: "rgba(255,255,255,0.65)",
            weight: 1.2,
            opacity: 1,
            fillOpacity: 0.05,
            fillColor: "#ffffff",
          });
        });
        layer.on("mouseout", () => {
          if (pathLayer.feature?.properties?.GID_3 === selectedGid) return;
          polyLayerRef.current?.resetStyle(layer as Leaflet.Path);
        });
        const tooltip = `<b>${p.NAME_3}</b> · ${p.NAME_2}<br/>${thaiName(p.NAME_1)}`;
        layer.bindTooltip(tooltip, { direction: "top", sticky: true, opacity: 0.9 });
      },
    }).addTo(map);
  }, [isMapReady, filteredRows, layerMode, selectedGid]);

  // 5) Rain overlay (radar)
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!L || !map || !isMapReady) return;
    if (rainLayerRef.current) {
      rainLayerRef.current.removeFrom(map);
      rainLayerRef.current = null;
    }
    if (showRainOverlay && rainLayer?.tileUrl) {
      rainLayerRef.current = L.tileLayer(rainLayer.tileUrl, {
        opacity: 0.55,
        zIndex: 450,
        // RainViewer free tiles only render up to z10 — let Leaflet upsample beyond.
        maxNativeZoom: 10,
        maxZoom: 18,
        attribution: "RainViewer",
      }).addTo(map);
    }
  }, [isMapReady, showRainOverlay, rainLayer]);

  // 6a) Static hazard raster overlay (the GEE susceptibility export, downsampled)
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
      className: "static-overlay",
    }).addTo(map);
  }, [isMapReady, layerMode, staticMeta]);

  // 6b) Wetness raster overlay (continuous field, not following polygons)
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!L || !map || !isMapReady) return;
    if (wetnessOverlayRef.current) {
      wetnessOverlayRef.current.removeFrom(map);
      wetnessOverlayRef.current = null;
    }
    if (layerMode !== "wetness" || !grid) return;
    const url = renderGridToDataURL(
      grid.cols,
      grid.rows,
      grid.rain_7d_mm,
      grid.wetness_norm_cap_mm,
      wetnessRampRGBA,
    );
    if (!url) return;
    const [w, s, e, n] = grid.grid_bbox;
    wetnessOverlayRef.current = L.imageOverlay(url, [[s, w], [n, e]], {
      opacity: 0.7,
      interactive: false,
      // CSS image-rendering: auto allows browser bilinear smoothing when scaled.
      className: "wetness-overlay",
    }).addTo(map);
  }, [isMapReady, layerMode, grid]);

  // 7) Live precip overlay (Open-Meteo nowcast, mm/hr)
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!L || !map || !isMapReady) return;
    if (precipOverlayRef.current) {
      precipOverlayRef.current.removeFrom(map);
      precipOverlayRef.current = null;
    }
    if (!showPrecipOverlay || !grid) return;
    const url = renderGridToDataURL(
      grid.cols,
      grid.rows,
      grid.precip_now_mm_per_hr,
      grid.precip_now_norm_cap_mm_per_hr,
      precipRampRGBA,
    );
    if (!url) return;
    const [w, s, e, n] = grid.grid_bbox;
    precipOverlayRef.current = L.imageOverlay(url, [[s, w], [n, e]], {
      opacity: 0.75,
      interactive: false,
      className: "precip-overlay",
    }).addTo(map);
  }, [isMapReady, showPrecipOverlay, grid]);

  const fitNorth = () => {
    mapRef.current?.flyTo([18.7, 99.5], 7, { duration: 0.7 });
  };

  const renderRowItem = (row: TambonRow) => {
    const p = row.feature.properties;
    const tier = layerMode === "live" ? row.liveTier : row.tier;
    const meta = riskMeta[tier];
    const score = Math.round(scoreOfRow(row, layerMode) * 100);
    const isSelected = p.GID_3 === selectedGid;
    return (
      <button
        key={p.GID_3}
        className={`w-full rounded-lg border p-3 text-left transition ${
          isSelected
            ? "border-[#40e0bd]/70 bg-[#40e0bd]/10"
            : "border-white/10 bg-white/[0.035] hover:border-white/25"
        }`}
        onClick={() => {
          setSelectedGid(p.GID_3);
          const map = mapRef.current;
          if (map) {
            // Move to the polygon's bounds
            const layer = polyLayerRef.current;
            if (layer) {
              layer.eachLayer((l) => {
                const fid = (l as unknown as { feature?: { properties?: { GID_3?: string } } })
                  .feature?.properties?.GID_3;
                if (fid === p.GID_3) {
                  map.flyTo((l as Leaflet.GeoJSON).getBounds().getCenter(), 10, { duration: 0.6 });
                }
              });
            }
          }
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate font-semibold text-white">{p.NAME_3}</div>
            <div className="mt-1 text-xs text-[#9fb7b3]">
              {p.NAME_2} · {thaiName(p.NAME_1)}
            </div>
          </div>
          <span
            className="shrink-0 rounded-full px-2 py-1 text-xs font-semibold text-[#071318]"
            style={{ background: meta.color }}
          >
            {score}
          </span>
        </div>
        <div className="mt-2 grid grid-cols-3 gap-1 text-[11px] text-[#cfe2df]">
          <span className="rounded-full bg-white/8 px-2 py-1 text-center">
            ภัย {Math.round(row.staticNorm * 100)}
          </span>
          <span className="rounded-full bg-white/8 px-2 py-1 text-center">
            ดิน {Math.round(row.wetnessNorm * 100)}
          </span>
          <span className="rounded-full bg-white/8 px-2 py-1 text-center">
            live {Math.round(row.liveNorm * 100)}
          </span>
        </div>
      </button>
    );
  };

  return (
    <section className="map-shell">
      <div className="map-grid">
        <aside className="side-panel flex min-h-0 flex-col p-5">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-[#40e0bd]">
                MVP / 9 จังหวัดภาคเหนือ
              </p>
              <h1 className="text-2xl font-semibold leading-tight">{copy.title}</h1>
              <p className="mt-3 text-sm leading-6 text-[#abc0bd]">{copy.subtitle}</p>
            </div>
            <button
              aria-label="กลับมุมมองภาคเหนือ"
              className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-white/10 bg-white/5 text-[#dff8f2] transition hover:border-[#40e0bd]/60 hover:bg-[#40e0bd]/10"
              onClick={fitNorth}
              title="กลับมุมมองภาคเหนือ"
            >
              <LocateFixed size={18} />
            </button>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-lg border border-white/10 bg-white/[0.04] p-3">
              <Mountain className="mb-3 text-[#40e0bd]" size={17} />
              <div className="text-xl font-semibold">{rows.length}</div>
              <div className="mt-1 text-[11px] leading-4 text-[#9fb7b3]">ตำบล</div>
            </div>
            <div className="rounded-lg border border-white/10 bg-white/[0.04] p-3">
              <AlertTriangle className="mb-3 text-[#d73027]" size={17} />
              <div className="text-xl font-semibold">{totals.severe}</div>
              <div className="mt-1 text-[11px] leading-4 text-[#9fb7b3]">Severe</div>
            </div>
            <div className="rounded-lg border border-white/10 bg-white/[0.04] p-3">
              <AlertTriangle className="mb-3 text-[#fdae61]" size={17} />
              <div className="text-xl font-semibold">{totals.high}</div>
              <div className="mt-1 text-[11px] leading-4 text-[#9fb7b3]">High</div>
            </div>
          </div>

          <div className="mt-5 space-y-3">
            <div>
              <div className="mb-2 flex items-center gap-2 text-xs font-medium text-[#9fb7b3]">
                <Layers size={14} />
                Layer
              </div>
              <div className="grid grid-cols-3 gap-2">
                {(["static", "wetness", "live"] as LayerMode[]).map((mode) => {
                  const meta = layerModes[mode];
                  const Icon = mode === "wetness" ? Droplets : mode === "live" ? Radar : Mountain;
                  return (
                    <button
                      key={mode}
                      className={`flex h-10 items-center justify-center gap-1 rounded-lg border px-2 text-xs transition ${
                        layerMode === mode
                          ? "border-[#40e0bd]/70 bg-[#40e0bd]/12 text-white"
                          : "border-white/10 bg-white/[0.03] text-[#b9cfcc] hover:border-white/25"
                      }`}
                      onClick={() => setLayerMode(mode)}
                      title={meta.description}
                    >
                      <Icon size={13} />
                      <span>{meta.label}</span>
                    </button>
                  );
                })}
              </div>
              <p className="mt-2 text-[11px] leading-4 text-[#9fb7b3]">
                {layerModes[layerMode].description}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                className={`flex h-10 items-center justify-center gap-1 rounded-lg border px-2 text-xs transition ${
                  showRainOverlay
                    ? "border-[#40e0bd]/70 bg-[#40e0bd]/12 text-white"
                    : "border-white/10 bg-white/[0.03] text-[#b9cfcc] hover:border-white/25"
                } ${!rainLayer ? "cursor-not-allowed opacity-50" : ""}`}
                disabled={!rainLayer}
                onClick={() => setShowRainOverlay((v) => !v)}
                title={rainLayer ? `radar ${formatDate(rainLayer.frameTime)}` : "ไม่มี radar tile"}
              >
                <Radar size={13} /> Radar
              </button>
              <button
                className={`flex h-10 items-center justify-center gap-1 rounded-lg border px-2 text-xs transition ${
                  showPrecipOverlay
                    ? "border-[#fdae61]/70 bg-[#fdae61]/12 text-white"
                    : "border-white/10 bg-white/[0.03] text-[#b9cfcc] hover:border-white/25"
                } ${!grid ? "cursor-not-allowed opacity-50" : ""}`}
                disabled={!grid}
                onClick={() => setShowPrecipOverlay((v) => !v)}
                title="Open-Meteo precip nowcast (mm/hr) — ใช้เป็น live trigger"
              >
                <Droplets size={13} /> Precip now
              </button>
            </div>

            <label className="relative block">
              <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#8da5a4]" size={16} />
              <input
                aria-label="ค้นหาตำบล"
                className="h-11 w-full rounded-lg border border-white/10 bg-[#071318]/70 pl-10 pr-3 text-sm text-white outline-none transition placeholder:text-[#78928e] focus:border-[#40e0bd]/60"
                onChange={(e) => setQuery(e.target.value)}
                placeholder="ค้นหาตำบล / อำเภอ / จังหวัด"
                value={query}
              />
            </label>

            <select
              aria-label="กรองจังหวัด"
              className="h-10 w-full rounded-lg border border-white/10 bg-[#071318]/70 px-3 text-sm text-white outline-none focus:border-[#40e0bd]/60"
              onChange={(e) => setProvinceFilter(e.target.value)}
              value={provinceFilter}
            >
              <option value="">ทุกจังหวัด ({rows.length} ตำบล)</option>
              {provinces.map((p) => (
                <option key={p} value={p}>
                  {thaiName(p)}
                </option>
              ))}
            </select>
          </div>

          <div className="mt-5 min-h-0 flex-1">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Ranked ตำบล</h2>
              <span className="rounded-full bg-white/8 px-2 py-1 text-xs text-[#b9cfcc]">
                {filteredRows.length}
              </span>
            </div>
            <div className="scroll-area space-y-2 pr-1">
              {filteredRows.slice(0, 200).map(renderRowItem)}
              {filteredRows.length > 200 ? (
                <div className="rounded-lg border border-white/10 bg-white/[0.025] p-3 text-center text-xs text-[#9fb7b3]">
                  + {filteredRows.length - 200} ตำบลถัดไป — ใช้ filter เพื่อดูรายละเอียด
                </div>
              ) : null}
            </div>
          </div>
        </aside>

        <div className="leaflet-stage">
          <div className="leaflet-map" ref={mapElementRef} />
          {loadError ? (
            <div className="absolute inset-x-0 top-0 z-10 m-4 rounded-lg border border-[#ff6b6b]/40 bg-[#220a0a]/95 p-3 text-sm text-[#ffd9d9]">
              โหลดข้อมูลไม่สำเร็จ: {loadError}
            </div>
          ) : null}
          <div className="floating-status">
            <div className="flex min-w-0 items-center gap-3">
              <div
                className="grid h-9 w-9 place-items-center rounded-lg"
                style={{ background: `${riskMeta.severe.color}20`, color: riskMeta.severe.color }}
              >
                <Mountain size={18} />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-semibold">{layerModes[layerMode].label}</div>
                <div className="truncate text-xs text-[#9fb7b3]">
                  {wetness ? `ดินอิ่มน้ำ ${wetness.window_days} วัน · ${formatDate(wetness.generated_at)}` : "no wetness"}
                  {rainLayer ? ` · radar ${formatDate(rainLayer.frameTime)}` : ""}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {(["severe", "high", "watch", "low"] as const).map((tier) => (
                <div className="flex items-center gap-1 text-xs text-[#d8eee9]" key={tier}>
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: riskMeta[tier].color }} />
                  {riskMeta[tier].label}
                </div>
              ))}
            </div>
          </div>
        </div>

        <aside className="detail-panel p-5">
          {!selectedRow ? (
            <div className="flex h-full items-center justify-center text-center text-sm text-[#9fb7b3]">
              {rows.length === 0 ? "กำลังโหลดข้อมูลตำบล..." : "เลือกตำบลจากรายการหรือบนแผนที่"}
            </div>
          ) : (
            <SelectedDetail row={selectedRow} sources={sources} />
          )}
        </aside>
      </div>
    </section>
  );
}

function SelectedDetail({ row, sources }: { row: TambonRow; sources: SourceNote[] }) {
  const p = row.feature.properties;
  const tier = row.tier;
  const liveTier = row.liveTier;
  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-[#f4b740]">
            Evidence panel · ตำบล
          </p>
          <h2 className="text-2xl font-semibold">{p.NAME_3}</h2>
          <p className="mt-2 text-sm text-[#abc0bd]">
            {p.NAME_2} · {thaiName(p.NAME_1)} · อันดับที่ {p.rank}/663
          </p>
        </div>
        <span
          className="shrink-0 rounded-lg px-3 py-2 text-sm font-bold text-[#071318]"
          style={{ background: riskMeta[liveTier].color }}
        >
          {riskMeta[liveTier].label}
        </span>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-2">
        <ScoreCard
          label="Static hazard"
          icon={<Mountain size={14} />}
          score={Math.round(row.staticNorm * 100)}
          color={riskMeta[tier].color}
          sub={`p90 ${row.feature.properties.risk_p90.toFixed(2)}`}
        />
        <ScoreCard
          label="Risk live"
          icon={<Radar size={14} />}
          score={Math.round(row.liveNorm * 100)}
          color={riskMeta[liveTier].color}
          sub={`tier ${riskMeta[liveTier].label}`}
        />
        <ScoreCard
          label="ดินอิ่มน้ำ"
          icon={<Droplets size={14} />}
          score={Math.round(row.wetnessNorm * 100)}
          color="#3b82f6"
          sub={row.wetnessMm !== null ? `${row.wetnessMm.toFixed(0)} มม. / 7วัน` : "—"}
        />
        <ScoreCard
          label="ฝนตอนนี้"
          icon={<Droplets size={14} />}
          score={Math.round(row.precipNorm * 100)}
          color={row.precipMmPerHr > 0 ? "#fdae61" : "#5a7d7a"}
          sub={`${row.precipMmPerHr.toFixed(1)} มม./ชม.`}
        />
      </div>

      <div className="mt-5 space-y-3">
        <section className="rounded-lg border border-white/10 bg-white/[0.035] p-3">
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <MapPin size={15} /> Hazard breakdown
          </h3>
          <dl className="grid grid-cols-2 gap-2 text-xs">
            <Field label="p90 hazard" value={p.risk_p90.toFixed(2)} />
            <Field label="p95 hazard" value={p.risk_p95.toFixed(2)} />
            <Field label="class ≥3" value={`${p.class_3plus_pct.toFixed(0)}%`} />
            <Field label="ขนาด" value={`${formatNumber(p.cells)} cells`} />
            {p.buildings !== undefined ? (
              <Field
                label="บ้านเรือน"
                value={`${formatNumber(p.buildings)} หลัง`}
              />
            ) : null}
            {p.building_area_km2 !== undefined && p.building_area_km2 > 0 ? (
              <Field
                label="พื้นที่อาคาร"
                value={`${p.building_area_km2.toFixed(2)} กม²`}
              />
            ) : null}
          </dl>
          <p className="mt-3 text-[11px] leading-5 text-[#9fb7b3]">
            {row.wetnessMm === null
              ? "ดินอิ่มน้ำ: ไม่มีข้อมูลฝน 7 วันสำหรับตำบลนี้"
              : `ฝนสะสม 7 วัน ${row.wetnessMm.toFixed(0)} มม. → ${(row.wetnessNorm * 100).toFixed(0)}/100 (cap 80 มม.)`}
          </p>
        </section>

        <details className="rounded-lg border border-white/10 bg-white/[0.025] p-3 text-xs">
          <summary className="cursor-pointer select-none font-semibold text-[#dff8f2]">
            Method &amp; sources
          </summary>
          <div className="mt-3 space-y-2 leading-5 text-[#b9cfcc]">
            {methodSteps.slice(0, 4).map((step, i) => (
              <div className="flex gap-2" key={step}>
                <span className="font-mono text-[#40e0bd]">{i + 1}</span>
                <span>{step}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 space-y-2">
            {sources.map((source) => (
              <a
                className="block text-[11px] text-[#9fb7b3] underline-offset-2 hover:text-white hover:underline"
                href={source.href}
                key={source.href}
                rel="noreferrer"
                target="_blank"
              >
                {source.label}
              </a>
            ))}
          </div>
        </details>
      </div>
    </div>
  );
}

function ScoreCard({
  label,
  icon,
  score,
  color,
  sub,
}: {
  label: string;
  icon: React.ReactNode;
  score: number;
  color: string;
  sub: string;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.04] p-3">
      <div className="mb-2 flex items-center gap-1 text-[11px] text-[#9fb7b3]">
        {icon}
        {label}
      </div>
      <div className="text-2xl font-semibold" style={{ color }}>
        {score}
      </div>
      <div className="mt-1 text-[11px] leading-4 text-[#9fb7b3]">{sub}</div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white/[0.035] p-2">
      <dt className="text-[#9fb7b3]">{label}</dt>
      <dd className="mt-0.5 font-semibold">{value}</dd>
    </div>
  );
}

// suppress unused warning for tierFromNorm, productCopy imports if not used in types only
void tierFromNorm;
void productCopy;
