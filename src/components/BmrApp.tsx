"use client";

// /bmr entry: the canal sheet on wide screens, the status board on phones,
// and the full map dashboard behind either when a station is tapped (or on
// request). Owns the two payloads the sheet and board need; the dashboard
// keeps its own loader since it also needs rain, cameras and tiles.

import { useCallback, useEffect, useState } from "react";
import type { BmaPayload } from "@/lib/bma";
import type { HiiInput } from "@/lib/schematic";
import { bankPercentOf, THAIWATER_WATERLEVEL_URL, type ThaiWaterLevelStation } from "@/lib/thaiwater";
import { BmrBoard } from "./BmrBoard";
import { BmrDashboard, type FocusTarget } from "./BmrDashboard";
import { BmrSheet } from "./BmrSheet";

const REFRESH_MS = 10 * 60 * 1000;
const BOX = { w: 99.831, s: 13.425, e: 100.964, n: 14.273 };
const inBox = (lat: number, lng: number) => lat >= BOX.s && lat <= BOX.n && lng >= BOX.w && lng <= BOX.e;

export function BmrApp() {
  const [view, setView] = useState<"sheet" | "map">("sheet");
  const [focus, setFocus] = useState<FocusTarget | null>(null);
  const [narrow, setNarrow] = useState<boolean | null>(null);
  const [bma, setBma] = useState<BmaPayload | null>(null);
  const [bmaErr, setBmaErr] = useState<string | null>(null);
  const [water, setWater] = useState<ThaiWaterLevelStation[] | null>(null);
  const [cams, setCams] = useState<{ live: number; listed: number } | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 899px)");
    const apply = () => setNarrow(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  const load = useCallback(async () => {
    await Promise.all([
      fetch("/api/bmr/klongmap", { cache: "no-store" })
        .then(async (r) => {
          const j = (await r.json()) as BmaPayload & { error?: string };
          if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
          setBma(j);
          setBmaErr(null);
        })
        .catch((e) => setBmaErr(e instanceof Error ? e.message : "relay failed")),
      fetch(THAIWATER_WATERLEVEL_URL, { cache: "no-store" })
        .then(async (r) => {
          if (!r.ok) return;
          const all = (await r.json()).data as ThaiWaterLevelStation[];
          setWater(all.filter((s) => Number.isFinite(s.station?.tele_station_lat) && Number.isFinite(s.station?.tele_station_long) && inBox(s.station.tele_station_lat, s.station.tele_station_long)));
        })
        .catch(() => {}),
    ]);
    setUpdatedAt(Date.now());
    // The camera probe can take 15–40 s cold; it must not hold the clock.
    void fetch("/api/bmr/cameras")
      .then(async (r) => {
        if (!r.ok) return;
        const j = (await r.json()) as { cameras: unknown[]; listed?: number };
        setCams({ live: j.cameras.length, listed: j.listed ?? j.cameras.length });
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    const id = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, [load]);

  // HII rows the sheet/board understand; staleness against the last
  // refresh so the derivation stays pure.
  const hii: HiiInput[] = (water ?? []).map((s) => {
    const t = Date.parse((s.waterlevel_datetime ?? "").replace(" ", "T") + "+07:00");
    return {
      id: s.id,
      name: s.station.tele_station_name?.th ?? `สถานี ${s.id}`,
      lat: s.station.tele_station_lat,
      lng: s.station.tele_station_long,
      pct: bankPercentOf(s),
      stale: !Number.isFinite(t) || (updatedAt ?? 0) - t > 24 * 3600_000,
      onRiver: /เจ้าพระยา/.test(s.river_name ?? ""),
    };
  });

  const open = (t: FocusTarget) => {
    setFocus(t);
    setView("map");
  };
  const back = () => {
    setView("sheet");
    setFocus(null);
  };

  if (view === "map") return <BmrDashboard focus={focus} onBack={back} />;
  if (narrow === null) return <div className="sheet" aria-busy="true" />;
  const props = { bma, hii, cams, updatedAt, error: bmaErr, onOpen: open, onMap: () => setView("map") };
  return narrow ? <BmrBoard {...props} /> : <BmrSheet {...props} />;
}
