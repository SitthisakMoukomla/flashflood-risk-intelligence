"use client";

import {
  Activity,
  AlertTriangle,
  Building2,
  Flame,
  Gauge,
  Layers,
  LocateFixed,
  MapPin,
  Mountain,
  Radar,
  Search,
  SlidersHorizontal,
  Waves,
} from "lucide-react";
import type * as Leaflet from "leaflet";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  methodSteps,
  riskMeta,
  type RiskClass,
  type RiskZone,
  type SourceNote,
} from "@/lib/risk-intelligence";

type FloodMapProps = {
  copy: {
    generatedAt: string;
    title: string;
    subtitle: string;
    disclaimer: string;
  };
  sources: SourceNote[];
  zones: RiskZone[];
};

type RainLayerPayload = {
  generatedAt: string;
  frameTime: string;
  tileUrl: string;
  source: string;
};

type OverlayKey = "risk" | "burn" | "exposure" | "rain";

const riskOrder: RiskClass[] = ["severe", "high", "watch", "low"];

const overlayOptions: {
  id: OverlayKey;
  label: string;
  icon: typeof Layers;
}[] = [
  { id: "risk", label: "Slope susceptibility", icon: Layers },
  { id: "burn", label: "Burned area", icon: Flame },
  { id: "exposure", label: "Buildings", icon: Building2 },
  { id: "rain", label: "Rainfall trigger", icon: Radar },
];

function formatDate(value: string | null | undefined) {
  if (!value) return "ไม่พบเวลา";
  return new Intl.DateTimeFormat("th-TH", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Bangkok",
  }).format(new Date(value));
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("th-TH").format(value);
}

function popup(title: string, rows: [string, string][]) {
  return `
    <div>
      <div style="font-weight:800;font-size:15px;margin-bottom:8px">${title}</div>
      ${rows
        .map(
          ([label, value]) =>
            `<div style="display:flex;gap:10px;justify-content:space-between;border-top:1px solid rgba(180,227,222,.14);padding:6px 0"><span style="color:#9fb7b3">${label}</span><b style="text-align:right">${value}</b></div>`,
        )
        .join("")}
    </div>
  `;
}

function scoreWidth(score: number, max: number) {
  return `${Math.max(4, Math.min(100, (score / max) * 100))}%`;
}

function metricMax(label: string) {
  if (label === "Terrain") return 40;
  if (label === "Burn") return 25;
  if (label === "Exposure") return 25;
  return 10;
}

function offsetPoint(
  [lat, lng]: [number, number],
  bearingDeg: number,
  distanceKm: number,
): [number, number] {
  const bearing = (bearingDeg * Math.PI) / 180;
  const northKm = Math.cos(bearing) * distanceKm;
  const eastKm = Math.sin(bearing) * distanceKm;

  return [
    lat + northKm / 111,
    lng + eastKm / (111 * Math.cos((lat * Math.PI) / 180)),
  ];
}

function slopeSurface(
  zone: RiskZone,
  scale: number,
  options?: { upstreamShift?: number; widthScale?: number; lengthScale?: number },
) {
  const points: [number, number][] = [];
  const steps = 56;
  const seed = zone.id.length * 0.37;
  const bearing = (zone.terrain.downslopeBearingDeg * Math.PI) / 180;
  const width =
    zone.terrain.slopeWidthKm *
    scale *
    (options?.widthScale ?? 1) *
    (0.86 + zone.exposure.score / 130);
  const downstreamLength =
    zone.terrain.slopeLengthKm *
    scale *
    (options?.lengthScale ?? 1) *
    (0.9 + zone.rain.score / 48);
  const upstreamLength =
    zone.terrain.slopeLengthKm *
    scale *
    0.36 *
    (options?.lengthScale ?? 1) *
    (0.8 + zone.burn.score / 80);
  const center = options?.upstreamShift
    ? offsetPoint(zone.center, zone.terrain.downslopeBearingDeg + 180, options.upstreamShift)
    : zone.center;

  for (let index = 0; index < steps; index += 1) {
    const theta = (index / steps) * Math.PI * 2;
    const longAxis = Math.sin(theta) >= 0 ? downstreamLength : upstreamLength;
    const edgeNoise =
      1 +
      0.08 * Math.sin(theta * 3 + seed) +
      0.05 * Math.cos(theta * 5 + zone.totalScore / 19);
    const crossKm = Math.cos(theta) * width * edgeNoise;
    const downKm = Math.sin(theta) * longAxis * edgeNoise;
    const northKm = Math.cos(bearing) * downKm + Math.cos(bearing + Math.PI / 2) * crossKm;
    const eastKm = Math.sin(bearing) * downKm + Math.sin(bearing + Math.PI / 2) * crossKm;

    points.push([
      center[0] + northKm / 111,
      center[1] + eastKm / (111 * Math.cos((center[0] * Math.PI) / 180)),
    ]);
  }

  return points;
}

export function FloodMap({ copy, sources, zones }: FloodMapProps) {
  const mapElementRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Leaflet.Map | null>(null);
  const leafletRef = useRef<typeof Leaflet | null>(null);
  const riskLayerRef = useRef<Leaflet.LayerGroup | null>(null);
  const burnLayerRef = useRef<Leaflet.LayerGroup | null>(null);
  const exposureLayerRef = useRef<Leaflet.LayerGroup | null>(null);
  const rainLayerRef = useRef<Leaflet.TileLayer | null>(null);

  const [query, setQuery] = useState("");
  const [minimumRisk, setMinimumRisk] = useState<RiskClass>("low");
  const [selectedZone, setSelectedZone] = useState<RiskZone>(zones[0]);
  const [overlays, setOverlays] = useState<Record<OverlayKey, boolean>>({
    risk: true,
    burn: false,
    exposure: false,
    rain: false,
  });
  const [rainLayer, setRainLayer] = useState<RainLayerPayload | null>(null);
  const [rainError, setRainError] = useState<string | null>(null);
  const [isMapReady, setIsMapReady] = useState(false);

  const filteredZones = useMemo(() => {
    const minScore = riskMeta[minimumRisk].minScore;
    const normalizedQuery = query.trim().toLocaleLowerCase("th-TH");

    return zones.filter((zone) => {
      const searchable = [
        zone.name,
        zone.province,
        zone.region,
        zone.tags.join(" "),
        zone.terrain.description,
        zone.burn.description,
        zone.exposure.description,
      ]
        .join(" ")
        .toLocaleLowerCase("th-TH");

      return (
        zone.totalScore >= minScore &&
        (!normalizedQuery || searchable.includes(normalizedQuery))
      );
    });
  }, [minimumRisk, query, zones]);

  const totals = useMemo(() => {
    const severe = zones.filter((zone) => zone.riskClass === "severe").length;
    const highPlus = zones.filter((zone) => zone.totalScore >= riskMeta.high.minScore).length;
    const buildings = zones.reduce((sum, zone) => sum + zone.exposure.buildingCount, 0);

    return { severe, highPlus, buildings };
  }, [zones]);

  useEffect(() => {
    let active = true;

    async function loadRainLayer() {
      try {
        const response = await fetch("/api/rainviewer", { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`Rain context unavailable (${response.status})`);
        }
        const payload = (await response.json()) as RainLayerPayload;
        if (active) {
          setRainLayer(payload);
        }
      } catch (error) {
        if (active) {
          setRainError(error instanceof Error ? error.message : "Rain context unavailable");
        }
      }
    }

    void loadRainLayer();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function setupMap() {
      if (!mapElementRef.current || mapRef.current) return;

      const L = await import("leaflet");
      if (cancelled) return;

      leafletRef.current = L;
      const map = L.map(mapElementRef.current, {
        center: [14.7, 100.4],
        zoom: 6,
        zoomControl: false,
        preferCanvas: true,
      });

      L.control.zoom({ position: "bottomright" }).addTo(map);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 18,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
      }).addTo(map);

      riskLayerRef.current = L.layerGroup().addTo(map);
      burnLayerRef.current = L.layerGroup().addTo(map);
      exposureLayerRef.current = L.layerGroup().addTo(map);
      mapRef.current = map;

      const bounds = L.latLngBounds(zones.map((zone) => zone.center));
      map.fitBounds(bounds.pad(0.16), { animate: false });
      setIsMapReady(true);
    }

    setupMap();

    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      riskLayerRef.current = null;
      burnLayerRef.current = null;
      exposureLayerRef.current = null;
      rainLayerRef.current = null;
      setIsMapReady(false);
    };
  }, [zones]);

  useEffect(() => {
    const L = leafletRef.current;
    const riskLayerGroup = riskLayerRef.current;
    if (!L || !riskLayerGroup || !isMapReady) return;

    riskLayerGroup.clearLayers();
    if (!overlays.risk) return;

    filteredZones.forEach((zone) => {
      const meta = riskMeta[zone.riskClass];
      const ringRows: [string, string][] = [
        ["Susceptibility", `${meta.label} (${zone.totalScore}/100)`],
        ["Terrain", `${zone.terrain.value}, slope ${zone.terrain.maxSlopeDeg}deg`],
        ["Downslope", `${zone.terrain.downslopeBearingDeg}deg bearing`],
        ["Burn", `${zone.burn.value}, ${zone.burn.lastFireWindow}`],
        ["Rain trigger", zone.rain.value],
        ["Buildings", `${formatNumber(zone.exposure.buildingCount)} หลัง`],
      ];

      [
        { scale: 1.12, opacity: 0.16 },
        { scale: 0.74, opacity: 0.22 },
        { scale: 0.42, opacity: selectedZone.id === zone.id ? 0.38 : 0.3 },
      ].forEach((ring) => {
        L.polygon(slopeSurface(zone, ring.scale), {
          color: meta.color,
          fillColor: meta.color,
          fillOpacity: ring.opacity,
          opacity: 0,
          stroke: false,
          weight: 0,
        })
          .bindPopup(popup(zone.name, ringRows))
          .on("click", () => setSelectedZone(zone))
          .addTo(riskLayerGroup);
      });

      const marker = L.circleMarker(zone.center, {
        radius: Math.max(7, zone.totalScore / 9),
        color: "#071318",
        fillColor: meta.color,
        fillOpacity: 0.95,
        opacity: 1,
        weight: 2,
      })
        .bindPopup(
          popup(zone.name, [
            ["Risk", `${meta.label} (${zone.totalScore}/100)`],
            ["จังหวัด", zone.province],
            ["Exposure", `${formatNumber(zone.exposure.buildingCount)} หลัง`],
          ]),
        )
        .on("click", () => setSelectedZone(zone));

      marker.addTo(riskLayerGroup);
    });
  }, [filteredZones, isMapReady, overlays.risk, selectedZone.id]);

  useEffect(() => {
    const L = leafletRef.current;
    const burnLayerGroup = burnLayerRef.current;
    if (!L || !burnLayerGroup || !isMapReady) return;

    burnLayerGroup.clearLayers();
    if (!overlays.burn) return;

    filteredZones.forEach((zone) => {
      L.polygon(
        slopeSurface(zone, 0.52, {
          upstreamShift: Math.max(4, zone.terrain.slopeLengthKm * 0.18),
          widthScale: 0.72,
          lengthScale: 0.62,
        }),
        {
          color: "#ff6b35",
          fillColor: "#ff6b35",
          fillOpacity: Math.min(0.28, 0.07 + zone.burn.score / 110),
          opacity: 0,
          stroke: false,
          weight: 0,
        },
      )
        .bindPopup(
          popup(`${zone.name}: burned area modifier`, [
            ["Score", zone.burn.value],
            ["Fire window", zone.burn.lastFireWindow],
            ["Density", zone.burn.hotspotDensity],
          ]),
        )
        .addTo(burnLayerGroup);
    });
  }, [filteredZones, isMapReady, overlays.burn]);

  useEffect(() => {
    const L = leafletRef.current;
    const exposureLayerGroup = exposureLayerRef.current;
    if (!L || !exposureLayerGroup || !isMapReady) return;

    exposureLayerGroup.clearLayers();
    if (!overlays.exposure) return;

    filteredZones.forEach((zone) => {
      L.circle(zone.center, {
        radius: Math.max(5500, Math.sqrt(zone.exposure.buildingCount) * 520),
        color: "#3b82f6",
        fillColor: "#3b82f6",
        fillOpacity: 0.12,
        opacity: 0,
        stroke: false,
        weight: 0,
      })
        .bindPopup(
          popup(`${zone.name}: building exposure`, [
            ["Buildings", `${formatNumber(zone.exposure.buildingCount)} หลัง`],
            ["Pattern", zone.exposure.settlementPattern],
            ["Score", zone.exposure.value],
          ]),
        )
        .addTo(exposureLayerGroup);
    });
  }, [filteredZones, isMapReady, overlays.exposure]);

  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!L || !map || !isMapReady) return;

    if (rainLayerRef.current) {
      rainLayerRef.current.removeFrom(map);
      rainLayerRef.current = null;
    }

    if (overlays.rain && rainLayer?.tileUrl) {
      rainLayerRef.current = L.tileLayer(rainLayer.tileUrl, {
        opacity: 0.58,
        zIndex: 12,
        attribution: "RainViewer",
      }).addTo(map);
    }
  }, [isMapReady, overlays.rain, rainLayer]);

  const flyToZone = (zone: RiskZone) => {
    setSelectedZone(zone);
    mapRef.current?.flyTo(zone.center, 9, { duration: 0.7 });
  };

  const fitThailand = () => {
    mapRef.current?.flyTo([14.7, 100.4], 6, { duration: 0.7 });
  };

  const toggleOverlay = (id: OverlayKey) => {
    setOverlays((current) => ({ ...current, [id]: !current[id] }));
  };

  const selectedMeta = riskMeta[selectedZone.riskClass];
  const selectedMetrics = [
    selectedZone.terrain,
    selectedZone.burn,
    selectedZone.exposure,
    selectedZone.rain,
  ];

  return (
    <section className="map-shell">
      <div className="map-grid">
        <aside className="side-panel flex min-h-0 flex-col p-5">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-[#40e0bd]">
                MVP 1 / Risk intelligence
              </p>
              <h1 className="text-3xl font-semibold leading-tight">{copy.title}</h1>
              <p className="mt-3 text-sm leading-6 text-[#abc0bd]">{copy.subtitle}</p>
            </div>
            <button
              aria-label="กลับไปมุมมองประเทศไทย"
              className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-white/10 bg-white/5 text-[#dff8f2] transition hover:border-[#40e0bd]/60 hover:bg-[#40e0bd]/10"
              onClick={fitThailand}
              title="มุมมองประเทศไทย"
            >
              <LocateFixed size={18} />
            </button>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-lg border border-white/10 bg-white/[0.04] p-3">
              <Gauge className="mb-3 text-[#40e0bd]" size={17} />
              <div className="text-xl font-semibold">{zones.length}</div>
              <div className="mt-1 text-[11px] leading-4 text-[#9fb7b3]">slope surfaces</div>
            </div>
            <div className="rounded-lg border border-white/10 bg-white/[0.04] p-3">
              <AlertTriangle className="mb-3 text-[#ff9f1c]" size={17} />
              <div className="text-xl font-semibold">{totals.highPlus}</div>
              <div className="mt-1 text-[11px] leading-4 text-[#9fb7b3]">high+</div>
            </div>
            <div className="rounded-lg border border-white/10 bg-white/[0.04] p-3">
              <Building2 className="mb-3 text-[#7dd3fc]" size={17} />
              <div className="text-xl font-semibold">{formatNumber(totals.buildings)}</div>
              <div className="mt-1 text-[11px] leading-4 text-[#9fb7b3]">อาคารใน zone</div>
            </div>
          </div>

          <div className="mt-5 space-y-3">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#8da5a4]" size={16} />
              <input
                aria-label="ค้นหาพื้นที่เสี่ยง"
                className="h-11 w-full rounded-lg border border-white/10 bg-[#071318]/70 pl-10 pr-3 text-sm text-white outline-none transition placeholder:text-[#78928e] focus:border-[#40e0bd]/60"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="ค้นหาจังหวัด ภูมิภาค หรือปัจจัยเสี่ยง"
                value={query}
              />
            </label>

            <div>
              <div className="mb-2 flex items-center gap-2 text-xs font-medium text-[#9fb7b3]">
                <Layers size={14} />
                Layers
              </div>
              <div className="grid grid-cols-2 gap-2">
                {overlayOptions.map((option) => {
                  const Icon = option.icon;
                  const isActive = overlays[option.id];
                  const disabled = option.id === "rain" && !rainLayer;

                  return (
                    <button
                      className={`flex h-10 items-center justify-center gap-2 rounded-lg border px-2 text-xs transition ${
                        isActive
                          ? "border-[#40e0bd]/70 bg-[#40e0bd]/12 text-white"
                          : "border-white/10 bg-white/[0.03] text-[#b9cfcc] hover:border-white/25"
                      } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
                      disabled={disabled}
                      key={option.id}
                      onClick={() => toggleOverlay(option.id)}
                      title={option.label}
                    >
                      <Icon size={14} />
                      <span>{option.label}</span>
                    </button>
                  );
                })}
              </div>
              {rainError ? (
                <div className="mt-2 text-xs leading-5 text-[#ffd166]">{rainError}</div>
              ) : null}
            </div>

            <div>
              <div className="mb-2 flex items-center gap-2 text-xs font-medium text-[#9fb7b3]">
                <SlidersHorizontal size={14} />
                Minimum risk
              </div>
              <div className="grid grid-cols-4 gap-2">
                {riskOrder.map((risk) => {
                  const meta = riskMeta[risk];
                  return (
                    <button
                      className={`h-9 rounded-lg border px-2 text-xs transition ${
                        minimumRisk === risk
                          ? "border-white/60 bg-white/12 text-white"
                          : "border-white/10 bg-white/[0.03] text-[#b9cfcc]"
                      }`}
                      key={risk}
                      onClick={() => setMinimumRisk(risk)}
                      style={{
                        boxShadow:
                          minimumRisk === risk ? `inset 0 -2px 0 ${meta.color}` : undefined,
                      }}
                    >
                      {meta.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="mt-5 min-h-0 flex-1">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Priority areas</h2>
              <span className="rounded-full bg-white/8 px-2 py-1 text-xs text-[#b9cfcc]">
                {filteredZones.length} zones
              </span>
            </div>
            <div className="scroll-area space-y-2 pr-1">
              {filteredZones.map((zone) => {
                const meta = riskMeta[zone.riskClass];
                const selected = selectedZone.id === zone.id;
                return (
                  <button
                    className={`w-full rounded-lg border p-3 text-left transition ${
                      selected
                        ? "border-[#40e0bd]/70 bg-[#40e0bd]/10"
                        : "border-white/10 bg-white/[0.035] hover:border-white/25"
                    }`}
                    key={zone.id}
                    onClick={() => flyToZone(zone)}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-semibold text-white">{zone.name}</div>
                        <div className="mt-1 text-xs text-[#9fb7b3]">
                          {zone.province} / {zone.region}
                        </div>
                      </div>
                      <span
                        className="rounded-full px-2 py-1 text-xs font-semibold text-[#071318]"
                        style={{ background: meta.color }}
                      >
                        {zone.totalScore}
                      </span>
                    </div>
                    <div className="mt-3 grid grid-cols-3 gap-1 text-[11px] text-[#cfe2df]">
                      <span className="rounded-full bg-white/8 px-2 py-1">
                        {zone.terrain.maxSlopeDeg}deg / {zone.terrain.downslopeBearingDeg}deg
                      </span>
                      <span className="rounded-full bg-white/8 px-2 py-1">
                        burn {zone.burn.value}
                      </span>
                      <span className="rounded-full bg-white/8 px-2 py-1">
                        {formatNumber(zone.exposure.buildingCount)}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </aside>

        <div className="leaflet-stage">
          <div className="leaflet-map" ref={mapElementRef} />
          <div className="floating-status">
            <div className="flex min-w-0 items-center gap-3">
              <div className="grid h-9 w-9 place-items-center rounded-lg bg-[#40e0bd]/12 text-[#40e0bd]">
                <Activity size={18} />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-semibold">
                  ข้อมูลฤดูกาล ณ {copy.generatedAt}
                </div>
                <div className="truncate text-xs text-[#9fb7b3]">
                  {copy.disclaimer}
                  {rainLayer ? ` / rainfall trigger ${formatDate(rainLayer.frameTime)}` : ""}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {riskOrder.map((risk) => (
                <div className="flex items-center gap-1 text-xs text-[#d8eee9]" key={risk}>
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ background: riskMeta[risk].color }}
                  />
                  {riskMeta[risk].label}
                </div>
              ))}
            </div>
          </div>
        </div>

        <aside className="detail-panel p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-[#f4b740]">
                Evidence panel
              </p>
              <h2 className="text-2xl font-semibold">{selectedZone.name}</h2>
              <p className="mt-2 text-sm text-[#abc0bd]">
                {selectedZone.province} / {selectedZone.region}
              </p>
            </div>
            <span
              className="rounded-lg px-3 py-2 text-sm font-bold text-[#071318]"
              style={{ background: selectedMeta.color }}
            >
              {selectedMeta.label}
            </span>
          </div>

          <div className="mt-5 grid grid-cols-2 gap-2">
            <div className="rounded-lg border border-white/10 bg-white/[0.04] p-3">
              <div className="text-xs text-[#9fb7b3]">Risk score</div>
              <div className="mt-2 text-3xl font-semibold">{selectedZone.totalScore}</div>
            </div>
            <div className="rounded-lg border border-white/10 bg-white/[0.04] p-3">
              <div className="text-xs text-[#9fb7b3]">Class logic</div>
              <div className="mt-2 text-sm font-semibold leading-6">{selectedMeta.tone}</div>
            </div>
          </div>

          <div className="mt-5 space-y-3">
            {selectedMetrics.map((metric) => {
              const max = metricMax(metric.label);
              return (
                <section
                  className="rounded-lg border border-white/10 bg-white/[0.035] p-3"
                  key={metric.label}
                >
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <h3 className="flex items-center gap-2 text-sm font-semibold">
                      {metric.label === "Terrain" ? <Mountain size={15} /> : null}
                      {metric.label === "Burn" ? <Flame size={15} /> : null}
                      {metric.label === "Exposure" ? <Building2 size={15} /> : null}
                      {metric.label === "Rain" ? <Waves size={15} /> : null}
                      {metric.label}
                    </h3>
                    <span className="font-mono text-xs text-[#d8eee9]">{metric.value}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-white/10">
                    <div
                      className="h-full rounded-full bg-[#40e0bd]"
                      style={{ width: scoreWidth(metric.score, max) }}
                    />
                  </div>
                  <p className="mt-2 text-xs leading-5 text-[#adc5c1]">{metric.description}</p>
                </section>
              );
            })}
          </div>

          <div className="mt-5 space-y-4">
            <section>
              <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                <MapPin size={15} /> Zone evidence
              </h3>
              <dl className="grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-lg bg-white/[0.035] p-3">
                  <dt className="text-[#9fb7b3]">Elevation</dt>
                  <dd className="mt-1 font-semibold">{selectedZone.terrain.elevationRangeM}</dd>
                </div>
                <div className="rounded-lg bg-white/[0.035] p-3">
                  <dt className="text-[#9fb7b3]">Max slope</dt>
                  <dd className="mt-1 font-semibold">{selectedZone.terrain.maxSlopeDeg}deg</dd>
                </div>
                <div className="rounded-lg bg-white/[0.035] p-3">
                  <dt className="text-[#9fb7b3]">Downslope</dt>
                  <dd className="mt-1 font-semibold">{selectedZone.terrain.downslopeBearingDeg}deg</dd>
                </div>
                <div className="rounded-lg bg-white/[0.035] p-3">
                  <dt className="text-[#9fb7b3]">Fire window</dt>
                  <dd className="mt-1 font-semibold">{selectedZone.burn.lastFireWindow}</dd>
                </div>
                <div className="rounded-lg bg-white/[0.035] p-3">
                  <dt className="text-[#9fb7b3]">Buildings</dt>
                  <dd className="mt-1 font-semibold">
                    {formatNumber(selectedZone.exposure.buildingCount)}
                  </dd>
                </div>
              </dl>
            </section>

            <section>
              <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                <AlertTriangle size={15} /> Operation note
              </h3>
              <p className="text-sm leading-6 text-[#c3d8d5]">{selectedZone.operatingNote}</p>
            </section>

            <section>
              <h3 className="mb-2 text-sm font-semibold">Method</h3>
              <div className="space-y-2">
                {methodSteps.map((step, index) => (
                  <div className="flex gap-2 text-xs leading-5 text-[#b9cfcc]" key={step}>
                    <span className="font-mono text-[#40e0bd]">{index + 1}</span>
                    <span>{step}</span>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <h3 className="mb-3 text-sm font-semibold">Sources</h3>
              <div className="space-y-2">
                {sources.map((source) => (
                  <a
                    className="source-link"
                    href={source.href}
                    key={source.href}
                    rel="noreferrer"
                    target="_blank"
                  >
                    <div className="text-sm font-semibold">{source.label}</div>
                    <div className="mt-1 text-xs leading-5 text-[#9fb7b3]">{source.note}</div>
                  </a>
                ))}
              </div>
            </section>
          </div>
        </aside>
      </div>
    </section>
  );
}
