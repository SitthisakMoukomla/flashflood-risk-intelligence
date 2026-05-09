"use client";

import {
  AlertTriangle,
  Building2,
  ChevronDown,
  Droplets,
  Info,
  MapPin,
  Mountain,
  Radar,
  Search,
  X,
} from "lucide-react";
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
  buildTambonRows,
  computeLiveGrid,
  layerModes,
  riskRampColor,
  wetnessRampRGBA,
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

type RainLayerPayload = {
  generatedAt: string;
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
const TIER_BG: Record<RiskTier, string> = {
  severe: "tb-severe",
  high: "tb-high",
  watch: "tb-watch",
  low: "tb-low",
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

function renderGridToDataURL(
  cols: number,
  rows: number,
  values: number[] | Float32Array,
  cap: number,
  ramp: (t: number) => [number, number, number, number],
  /** Optional 0/1 mask (or any non-zero == inside). Cells where mask[i] is
   *  falsy render fully transparent — used to clip overlays to the
   *  Thailand AOI (the gridded data covers the bbox, which spills into
   *  Myanmar/Laos). */
  mask?: number[] | Float32Array | null,
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
    if (mask && !mask[i]) {
      buf[i * 4 + 3] = 0;
      continue;
    }
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

function scoreOfRow(row: TambonRow, mode: LayerMode): number {
  if (mode === "wetness") return row.wetnessNorm;
  if (mode === "live") return row.liveNorm;
  return row.staticNorm;
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
  const rainLayerRef = useRef<Leaflet.TileLayer | null>(null);
  const wetnessOverlayRef = useRef<Leaflet.ImageOverlay | null>(null);
  const staticOverlayRef = useRef<Leaflet.ImageOverlay | null>(null);
  const liveOverlayRef = useRef<Leaflet.ImageOverlay | null>(null);
  const buildingsOverlayRef = useRef<Leaflet.ImageOverlay | null>(null);

  // Layer z-stack (lower = farther back). Polygons sit on canvas pane
  // (zIndex ~600) so they're always on top for hover/click.
  const Z_HAZARD = 200; // static / wetness / live
  const Z_BUILDINGS = 350; // bumped above hazard so density reads through
  const Z_RADAR = 450; // RainViewer on top of everything raster

  const [tambonFC, setTambonFC] = useState<TambonCollection | null>(null);
  const [wetness, setWetness] = useState<WetnessPayload | null>(null);
  const [grid, setGrid] = useState<WetnessGrid | null>(null);
  const [staticMeta, setStaticMeta] = useState<StaticOverlayMeta | null>(null);
  const [buildingsMeta, setBuildingsMeta] = useState<BuildingsOverlayMeta | null>(null);
  const [rainLayer, setRainLayer] = useState<RainLayerPayload | null>(null);

  const [layerMode, setLayerMode] = useState<LayerMode>("live");
  const [showRainOverlay, setShowRainOverlay] = useState(false);
  const [showBuildings, setShowBuildings] = useState(false);

  const [userLoc, setUserLoc] = useState<[number, number] | null>(null);
  const [geoStatus, setGeoStatus] = useState<GeoStatus>("idle");
  const [searchQ, setSearchQ] = useState("");

  const [selectedGid, setSelectedGid] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [methodOpen, setMethodOpen] = useState(false);
  const [isMapReady, setIsMapReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

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

  const heroRow = userRow ?? selectedRow;
  const heroTier: RiskTier = heroRow?.liveTier ?? "low";
  const isHighOrSevere = heroTier === "high" || heroTier === "severe";

  // Search results (only when query)
  const searchResults = useMemo(() => {
    const q = searchQ.trim().toLocaleLowerCase("th-TH");
    if (!q) return [];
    return rows
      .filter((r) => {
        const p = r.feature.properties;
        const hay = `${p.NAME_3} ${p.NAME_2} ${p.NAME_1} ${thaiName(p.NAME_1)}`.toLocaleLowerCase("th-TH");
        return hay.includes(q);
      })
      .slice(0, 8);
  }, [rows, searchQ]);

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
      setIsMapReady(false);
    };
  }, []);

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

    polyLayerRef.current = L.geoJSON(fc as never, {
      style: (feature) => {
        const isSelected = feature?.properties?.GID_3 === selectedGid;
        if (isSelected) {
          return {
            fillOpacity: 0.16,
            fillColor: "#ffffff",
            color: "#ffffff",
            weight: 2.4,
            opacity: 0.9,
          };
        }
        return { fillOpacity: 0, color: "transparent", weight: 0, opacity: 0 };
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
          path.setStyle({
            color: "rgba(255,255,255,0.55)",
            weight: 1,
            opacity: 1,
            fillOpacity: 0.04,
            fillColor: "#ffffff",
          });
        });
        layer.on("mouseout", () => {
          if (path.feature?.properties?.GID_3 === selectedGid) return;
          polyLayerRef.current?.resetStyle(layer as Leaflet.Path);
        });
        layer.bindTooltip(`<b>${p.NAME_3}</b> · ${p.NAME_2}<br/>${thaiName(p.NAME_1)}`, {
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
    const url = renderGridToDataURL(
      grid.cols,
      grid.rows,
      grid.rain_7d_mm,
      grid.wetness_norm_cap_mm,
      wetnessRampRGBA,
      aoiMask,
    );
    if (!url) return;
    const [w, s, e, n] = grid.grid_bbox;
    wetnessOverlayRef.current = L.imageOverlay(url, [[s, w], [n, e]], {
      opacity: 0.7,
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
    const url = renderGridToDataURL(
      grid.cols,
      grid.rows,
      live,
      1.0,
      (t) => {
        const c = riskRampColor(t);
        const m = c.match(/rgb\((\d+),(\d+),(\d+)\)/);
        if (!m) return [0, 0, 0, 0];
        const [r, g, b] = [+m[1], +m[2], +m[3]];
        const a = Math.round(Math.min(220, 80 + 200 * t));
        return [r, g, b, a];
      },
      aoiMask,
    );
    if (!url) return;
    const [w, s, e, n] = grid.grid_bbox;
    liveOverlayRef.current = L.imageOverlay(url, [[s, w], [n, e]], {
      opacity: 0.78,
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
    const [w, s, e, n] = buildingsMeta.grid_bbox;
    buildingsOverlayRef.current = L.imageOverlay("/data/buildings_density.png", [[s, w], [n, e]], {
      opacity: 0.85,
      interactive: false,
      zIndex: Z_BUILDINGS,
    }).addTo(map);
  }, [isMapReady, showBuildings, buildingsMeta]);

  // Radar overlay
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
        zIndex: Z_RADAR,
        // RainViewer free tier (size 256, color scheme 2) only serves real
        // tiles up to z=7. z>=8 returns the "Zoom Level Not Supported"
        // placeholder. Cap maxNativeZoom and let Leaflet upscale.
        maxNativeZoom: 7,
        maxZoom: 18,
        attribution: "RainViewer",
      }).addTo(map);
    }
  }, [isMapReady, showRainOverlay, rainLayer]);

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
        searchQ={searchQ}
        onSearchChange={setSearchQ}
        searchResults={searchResults}
        onSearchPick={(gid) => {
          setSearchQ("");
          flyToTambon(gid);
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
            return (
              <button
                key={m}
                className={`mode-item ${m === layerMode ? "active" : ""}`}
                onClick={() => setLayerMode(m)}
              >
                <span className="mi-glyph">
                  <Icon size={20} strokeWidth={2} />
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="mi-label">{meta.label}</span>
                  <span className="mi-desc">{meta.description}</span>
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
          {(["low", "watch", "high", "severe"] as RiskTier[]).map((t) => (
            <span key={t} className="legend-chip">
              <span className="sw" style={{ background: riskMeta[t].color }} />
              {TIER_TH[t]}
            </span>
          ))}
          <span className="legend-meta">
            {wetness ? `ดิน ${formatTimeBKK(wetness.generated_at)}` : "—"}
            {rainLayer ? ` · เรดาร์ ${formatTimeBKK(rainLayer.frameTime)}` : ""}
          </span>
        </div>
      </div>

      {/* Mobile floating mode picker (compact) */}
      <div
        className="mobile-only"
        style={{ position: "absolute", left: 12, right: 12, bottom: 12, zIndex: 17, display: "flex", flexDirection: "column", gap: 8 }}
      >
        <div className="glass" style={{ display: "flex", padding: 4 }}>
          {(["live", "static", "wetness"] as LayerMode[]).map((m) => {
            const meta = layerModes[m];
            return (
              <button
                key={m}
                className={`mode-item ${m === layerMode ? "active" : ""}`}
                style={{
                  flex: 1,
                  justifyContent: "center",
                  padding: "8px 4px",
                  fontSize: 12,
                  color: m === layerMode ? "var(--ink)" : "var(--ink-3)",
                }}
                onClick={() => setLayerMode(m)}
              >
                <span className="mi-label" style={{ fontSize: 12 }}>
                  {meta.label}
                </span>
              </button>
            );
          })}
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
  searchQ,
  onSearchChange,
  searchResults,
  onSearchPick,
  loadError,
  copy,
}: {
  row: TambonRow | null;
  userRow: TambonRow | null;
  status: GeoStatus;
  searchQ: string;
  onSearchChange: (v: string) => void;
  searchResults: TambonRow[];
  onSearchPick: (gid: string) => void;
  loadError: string | null;
  copy: typeof productCopy;
}) {
  const tier: RiskTier = row?.liveTier ?? "low";
  const action = tierActionTH(tier);
  const pulseClass = tier === "high" || tier === "severe" ? "pulse" : "";
  const isUser = row && userRow && row.feature.properties.GID_3 === userRow.feature.properties.GID_3;
  const score = row ? Math.round(row.liveNorm * 100) : 0;
  const liveLabel = isUser ? "บ้านคุณอยู่ที่" : "ตำบลที่เลือก";

  const statusMsg =
    status === "denied"
      ? "ไม่ได้รับอนุญาตเข้าถึงตำแหน่ง"
      : status === "unsupported"
        ? "เบราว์เซอร์ไม่รองรับ GPS"
        : status === "outside"
          ? "อยู่นอก 9 จังหวัดภาคเหนือ"
          : null;

  return (
    <div
      className={`hero hero-${tier} ${pulseClass}`}
      style={{ position: "absolute", top: 0, left: 0, right: 0, zIndex: 22, padding: "12px 16px" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 14, minHeight: 44 }}>
        {/* Wordmark */}
        <div
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
            <span className="desktop-only" style={{ color: "var(--ink-3)", fontWeight: 400 }}>
              {" "}· {copy.region}
            </span>
          </span>
        </div>

        {/* Risk text + tier */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          {row ? (
            <>
              <span
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  color: "var(--ink-2)",
                  fontSize: 13,
                  whiteSpace: "nowrap",
                }}
              >
                <MapPin size={14} style={{ color: "var(--accent)" }} />
                {liveLabel}
              </span>
              <span style={{ fontSize: 15.5, fontWeight: 700, whiteSpace: "nowrap" }}>
                ตำบล{row.feature.properties.NAME_3}
                <span style={{ color: "var(--ink-2)", fontWeight: 500 }}>
                  {" "}อ.{row.feature.properties.NAME_2} · จ.{thaiName(row.feature.properties.NAME_1)}
                </span>
              </span>
              <span className={`tier ${TIER_PILL[tier]}`}>
                ตอนนี้: {TIER_TH[tier]}
              </span>
              <span className="desktop-only" style={{ color: "var(--ink-2)", fontSize: 13, minWidth: 0 }}>
                · {action}
              </span>
              <span
                className="num-mono desktop-only"
                style={{
                  marginLeft: "auto",
                  fontSize: 22,
                  fontWeight: 700,
                  color: riskMeta[tier].color,
                  paddingRight: 6,
                }}
              >
                {score}
                <span style={{ fontSize: 11, color: "var(--ink-3)", marginLeft: 4 }}>/100</span>
              </span>
            </>
          ) : (
            <span style={{ color: "var(--ink-2)", fontSize: 13 }}>
              {statusMsg ? `${statusMsg} — เลือกตำบลของคุณจากแผนที่หรือค้นหา` : "กำลังโหลด…"}
            </span>
          )}
        </div>

        {/* Search */}
        <div style={{ position: "relative", width: 280, flex: "none" }} className="desktop-only">
          <div className="search">
            <Search size={14} style={{ color: "var(--ink-3)", flex: "none" }} />
            <input
              placeholder="ใส่ที่อยู่ของคุณ — ตำบล / อำเภอ"
              value={searchQ}
              onChange={(e) => onSearchChange(e.target.value)}
            />
          </div>
          {searchResults.length > 0 ? (
            <div
              className="glass"
              style={{
                position: "absolute",
                top: "calc(100% + 6px)",
                right: 0,
                left: 0,
                padding: 6,
                maxHeight: 320,
                overflowY: "auto",
                zIndex: 30,
              }}
            >
              {searchResults.map((r) => (
                <button
                  key={r.feature.properties.GID_3}
                  onClick={() => onSearchPick(r.feature.properties.GID_3)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 10px",
                    borderRadius: 8,
                    color: "var(--ink)",
                    width: "100%",
                    textAlign: "left",
                    background: "transparent",
                    border: 0,
                    cursor: "pointer",
                  }}
                >
                  <MapPin size={14} style={{ color: riskMeta[r.liveTier].color }} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 13, fontWeight: 600 }}>
                      ตำบล{r.feature.properties.NAME_3}
                    </span>
                    <span style={{ display: "block", fontSize: 11, color: "var(--ink-3)" }}>
                      อ.{r.feature.properties.NAME_2} · {thaiName(r.feature.properties.NAME_1)}
                    </span>
                  </span>
                  <span className={`tier ${TIER_PILL[r.liveTier]}`} style={{ fontSize: 11 }}>
                    {TIER_TH[r.liveTier]}
                  </span>
                </button>
              ))}
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
  const score = Math.round(row.liveNorm * 100);

  // Contribution components — derived from per-tambon row values
  const terrain = Math.min(1, row.staticNorm);
  const wet = Math.min(1, row.wetnessNorm);
  const precip = Math.min(1, row.precipNorm);

  return (
    <aside
      className="glass desktop-only"
      style={{
        position: "absolute",
        top: 88,
        right: 16,
        bottom: 16,
        width: 384,
        zIndex: 18,
        padding: 18,
        display: "flex",
        flexDirection: "column",
        gap: 14,
        overflow: "hidden",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>
            ตำบล{p.NAME_3}
            {isUser ? (
              <span style={{ color: "var(--accent)", fontSize: 11, fontWeight: 600, marginLeft: 8, letterSpacing: "0.10em", textTransform: "uppercase" }}>
                ที่ตั้งของคุณ
              </span>
            ) : null}
          </div>
          <div style={{ fontSize: 13, color: "var(--ink-2)" }}>
            อ.{p.NAME_2} · จ.{thaiName(p.NAME_1)}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ textAlign: "right" }}>
            <div className="num-mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
              อันดับ
            </div>
            <div className="num-mono" style={{ fontSize: 16, fontWeight: 600 }}>
              {p.rank}
              <span style={{ color: "var(--ink-3)", marginLeft: 2 }}>/ 663</span>
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
            }}
            aria-label="ปิด"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="drawer-scroll" style={{ display: "flex", flexDirection: "column", gap: 14, paddingRight: 4 }}>
        {/* Tier badge */}
        <div className={`tier-badge ${TIER_BG[tier]}`}>
          <div className="glyph">{tierGlyph(tier)}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="label-tier">{TIER_TH[tier]}</div>
            <div className="label-en">{TIER_EN[tier]} · flash flood risk</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="num-mono" style={{ fontSize: 24, fontWeight: 700, color: "currentColor" }}>
              {score}
            </div>
            <div className="caps" style={{ color: "currentColor", opacity: 0.7 }}>
              / 100
            </div>
          </div>
        </div>

        {/* Action verb */}
        <div className="action" style={{ color: riskMeta[tier].color }}>
          <span>{tierActionTH(tier)}</span>
        </div>

        {/* Contributions */}
        <div>
          <div className="caps" style={{ marginBottom: 8 }}>
            ทำไมถึงระดับนี้
          </div>
          <div className="contrib">
            <ContribRow
              name="ภูมิประเทศ"
              en="Terrain"
              cls="terrain"
              value={Math.round(terrain * 100)}
              pct={terrain * 100}
            />
            <ContribRow
              name="ดินอิ่มน้ำ"
              en="Wetness"
              cls="wet"
              value={Math.round(wet * 100)}
              pct={wet * 100}
              extra={row.wetnessMm !== null ? `${row.wetnessMm.toFixed(0)} มม. / 7วัน` : undefined}
            />
            <ContribRow
              name="ฝนตอนนี้"
              en="Precip"
              cls="precip"
              value={Math.round(precip * 100)}
              pct={precip * 100}
              extra={`${row.precipMmPerHr.toFixed(1)} มม./ชม.`}
            />
          </div>
        </div>

        {/* Mini stats */}
        <div style={{ display: "flex", gap: 10 }}>
          <div
            style={{
              flex: 1,
              padding: 10,
              borderRadius: 10,
              background: "rgba(120,200,200,0.06)",
              border: "1px solid var(--hairline)",
            }}
          >
            <div className="caps">บ้านเรือน</div>
            <div style={{ fontSize: 18, fontWeight: 700, marginTop: 4 }}>
              <span className="num-mono">
                {p.buildings !== undefined ? formatNumber(p.buildings) : "—"}
              </span>
              <span style={{ fontSize: 11, color: "var(--ink-3)", marginLeft: 4 }}>หลัง</span>
            </div>
            {p.building_area_km2 !== undefined ? (
              <div className="num-mono" style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
                {p.building_area_km2.toFixed(2)} กม²
              </div>
            ) : null}
          </div>
          <div
            style={{
              flex: 1,
              padding: 10,
              borderRadius: 10,
              background: "rgba(120,200,200,0.06)",
              border: "1px solid var(--hairline)",
            }}
          >
            <div className="caps">class ≥ 3</div>
            <div style={{ fontSize: 18, fontWeight: 700, marginTop: 4 }}>
              <span className="num-mono">{p.class_3plus_pct.toFixed(0)}</span>
              <span style={{ fontSize: 11, color: "var(--ink-3)", marginLeft: 4 }}>% ของพื้นที่</span>
            </div>
            <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
              ขนาด {formatNumber(p.cells)} cells
            </div>
          </div>
        </div>

        {/* Top risk */}
        <div>
          <div className="caps" style={{ marginBottom: 6 }}>
            ตำบลเสี่ยงสูงตอนนี้
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {topRiskList.map((r) => {
              const t = r.liveTier;
              const v = Math.round(r.liveNorm * 100);
              const isCurrent = r.feature.properties.GID_3 === p.GID_3;
              return (
                <button
                  key={r.feature.properties.GID_3}
                  onClick={() => onPickRow(r.feature.properties.GID_3)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 6px",
                    borderRadius: 8,
                    background: isCurrent ? "rgba(64,224,189,0.08)" : "transparent",
                    color: "var(--ink)",
                    border: 0,
                    textAlign: "left",
                    cursor: "pointer",
                    width: "100%",
                  }}
                >
                  <span style={{ width: 8, height: 8, borderRadius: 999, background: riskMeta[t].color }} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 13, fontWeight: 600 }}>
                      ตำบล{r.feature.properties.NAME_3}
                    </span>
                    <span style={{ display: "block", fontSize: 11, color: "var(--ink-3)" }}>
                      อ.{r.feature.properties.NAME_2} · {thaiName(r.feature.properties.NAME_1)}
                    </span>
                  </span>
                  <span
                    className="num-mono"
                    style={{ fontSize: 14, color: riskMeta[t].color, fontWeight: 600 }}
                  >
                    {v}
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
  value,
  pct,
  extra,
}: {
  name: string;
  en: string;
  cls: string;
  value: number;
  pct: number;
  extra?: string;
}) {
  return (
    <div className="contrib-row">
      <div className="contrib-head">
        <span className="name">
          {name} <small>{en}</small>
          {extra ? (
            <small style={{ color: "var(--ink-3)", marginLeft: 6 }}>· {extra}</small>
          ) : null}
        </span>
        <span className="val num-mono">{value}</span>
      </div>
      <div className="contrib-track">
        <div className={`contrib-fill ${cls}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// keep imports referenced even if not used in this version
void tierFromNorm;
