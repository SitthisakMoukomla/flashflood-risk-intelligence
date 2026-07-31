"use client";

import { ArrowLeft, RefreshCw, Waves } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  bankPercentColor,
  bankPercentLabel,
  MAESAI_CHAIN,
  MAESAI_CODES,
  parseMaeSaiLog,
  type MaeSaiLogEntry,
} from "@/lib/maesai";

const WATERLEVEL_URL =
  "https://api-v3.thaiwater.net/api/v1/thaiwater30/public/waterlevel";
const LOG_URL = "/data/maesai_log.jsonl";

type Row = {
  code: string;
  role: string;
  note: string;
  km: number;
  name: string | null;
  sp: number | null;
  deltaCm: number | null;
  msl: number | null;
  dt: string | null;
};

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmtTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat("th-TH", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "Asia/Bangkok",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function MaeSaiWatch() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [log, setLog] = useState<MaeSaiLogEntry[]>([]);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const r = await fetch(WATERLEVEL_URL, { cache: "no-store" });
      if (!r.ok) throw new Error(`HII ${r.status}`);
      const data = (await r.json()).data as Record<string, never>[];
      const byCode = new Map<string, Record<string, never>>();
      for (const s of data) {
        const code = (s as never as { station?: { tele_station_oldcode?: string } })
          .station?.tele_station_oldcode;
        if (code && MAESAI_CODES.has(code)) byCode.set(code, s);
      }
      setRows(
        MAESAI_CHAIN.map((meta) => {
          const s = byCode.get(meta.code) as
            | {
                storage_percent?: unknown;
                waterlevel_msl?: unknown;
                waterlevel_msl_previous?: unknown;
                waterlevel_datetime?: string;
                station?: { tele_station_name?: { th?: string } };
              }
            | undefined;
          const cur = num(s?.waterlevel_msl);
          const prev = num(s?.waterlevel_msl_previous);
          return {
            ...meta,
            name: s?.station?.tele_station_name?.th ?? null,
            sp: num(s?.storage_percent),
            msl: cur,
            deltaCm: cur !== null && prev !== null ? (cur - prev) * 100 : null,
            dt: s?.waterlevel_datetime ?? null,
          };
        }),
      );
      setUpdatedAt(new Date());
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "โหลดข้อมูลไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // The gauges push roughly every 10 minutes.
    const id = window.setInterval(load, 10 * 60_000);
    const onVis = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load]);

  useEffect(() => {
    fetch(LOG_URL, { cache: "no-store" })
      .then((r) => (r.ok ? r.text() : ""))
      .then((t) => setLog(parseMaeSaiLog(t)))
      .catch(() => setLog([]));
  }, []);

  const bridge = rows?.find((r) => r.code === "MYA004") ?? null;
  const upstreamRising = (rows ?? [])
    .filter((r) => r.km < 0)
    .filter((r) => (r.deltaCm ?? 0) >= 1).length;

  /** Per-station history series from the JSONL log. */
  const series = useMemo(() => {
    const m = new Map<string, { t: number; sp: number }[]>();
    for (const e of log) {
      const t = Date.parse(e.t);
      if (!Number.isFinite(t)) continue;
      for (const r of e.readings) {
        if (r.sp == null) continue;
        if (!m.has(r.code)) m.set(r.code, []);
        m.get(r.code)!.push({ t, sp: r.sp });
      }
    }
    return m;
  }, [log]);

  const span = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const pts of series.values()) {
      for (const p of pts) {
        lo = Math.min(lo, p.t);
        hi = Math.max(hi, p.t);
      }
    }
    return Number.isFinite(lo) && hi > lo ? { lo, hi } : null;
  }, [series]);

  return (
    <div className="ms-page">
      <header className="ms-head">
        <Link href="/" className="ms-back" aria-label="กลับไปที่แผนที่">
          <ArrowLeft size={18} />
        </Link>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 className="ms-title">
            <Waves size={19} style={{ color: "var(--accent)", flex: "none" }} />
            เฝ้าระวังแม่สาย
          </h1>
          <p className="ms-sub">แม่น้ำสาย · ต้นน้ำ → สะพานมิตรภาพ · ข้อมูล สสน. (HII)</p>
        </div>
        <button className="ms-refresh" onClick={() => void load()} disabled={busy} aria-label="รีเฟรช">
          <RefreshCw size={16} style={{ animation: busy ? "ff-spin 1s linear infinite" : undefined }} />
        </button>
      </header>

      {err ? <div className="ms-err">โหลดข้อมูลไม่สำเร็จ: {err}</div> : null}

      {/* Headline: the bridge itself */}
      {bridge ? (
        <section
          className="ms-hero"
          style={{
            borderColor: bridge.sp !== null ? `${bankPercentColor(bridge.sp)}66` : "var(--hairline-2)",
            background:
              bridge.sp !== null
                ? `radial-gradient(ellipse 120% 140% at 12% -20%, ${bankPercentColor(bridge.sp)}33, transparent 62%), rgba(120,200,200,0.04)`
                : undefined,
          }}
        >
          <div className="ms-hero-label">สะพานมิตรภาพแม่น้ำสายแห่งที่ 1</div>
          <div className="ms-hero-row">
            <div
              className="num-mono ms-hero-num"
              style={{ color: bridge.sp !== null ? bankPercentColor(bridge.sp) : "var(--ink-3)" }}
            >
              {bridge.sp !== null ? bridge.sp.toFixed(0) : "—"}
              <span className="ms-hero-unit">% ของตลิ่ง</span>
            </div>
            <div className="ms-hero-side">
              <div
                className="ms-hero-state"
                style={{ color: bridge.sp !== null ? bankPercentColor(bridge.sp) : "var(--ink-3)" }}
              >
                {bridge.sp !== null ? bankPercentLabel(bridge.sp) : "ไม่มีข้อมูล"}
              </div>
              <div className="ms-hero-delta">
                {bridge.deltaCm === null
                  ? "—"
                  : `${bridge.deltaCm >= 1 ? "▲" : bridge.deltaCm <= -1 ? "▼" : "•"} ${
                      bridge.deltaCm >= 0 ? "+" : ""
                    }${bridge.deltaCm.toFixed(0)} ซม. จากค่าก่อนหน้า`}
              </div>
              {bridge.dt ? <div className="ms-hero-time num-mono">{bridge.dt}</div> : null}
            </div>
          </div>
          {upstreamRising > 0 ? (
            <div className="ms-alert">
              ต้นน้ำกำลังเพิ่มขึ้น {upstreamRising} สถานี — น้ำมีแนวโน้มเดินทางมาถึงสะพาน
            </div>
          ) : null}
        </section>
      ) : (
        <section className="ms-hero ms-skeleton">กำลังโหลดข้อมูลสถานี…</section>
      )}

      {/* The chain, laid out as a river running down the page */}
      <h2 className="ms-h2">ลำดับสถานีตามลำน้ำ</h2>
      <ol className="ms-chain">
        {(rows ?? MAESAI_CHAIN.map((c) => ({ ...c, name: null, sp: null, deltaCm: null, msl: null, dt: null }))).map(
          (r, i, arr) => {
            const color = r.sp !== null ? bankPercentColor(r.sp) : "var(--ink-4)";
            const isBridge = r.code === "MYA004";
            const rising = (r.deltaCm ?? 0) >= 1;
            const falling = (r.deltaCm ?? 0) <= -1;
            return (
              <li key={r.code} className={`ms-node${isBridge ? " is-bridge" : ""}`}>
                <div className="ms-rail" aria-hidden>
                  <span className="ms-dot" style={{ background: color }} />
                  {i < arr.length - 1 ? <span className="ms-line" /> : null}
                </div>
                <div className="ms-node-body">
                  <div className="ms-node-top">
                    <span className="ms-node-name">{r.name ?? r.role}</span>
                    <span className="num-mono ms-node-sp" style={{ color }}>
                      {r.sp !== null ? `${r.sp.toFixed(0)}%` : "—"}
                    </span>
                  </div>
                  <div className="ms-node-meta">
                    <span>
                      {r.km < 0 ? "▲ " : r.km > 0 ? "▼ " : ""}
                      {r.role} · {r.note}
                    </span>
                    <span
                      className="num-mono"
                      style={{
                        color: rising ? "var(--r-high)" : falling ? "var(--accent)" : "var(--ink-3)",
                      }}
                    >
                      {r.deltaCm === null
                        ? "—"
                        : `${rising ? "▲" : falling ? "▼" : "•"} ${r.deltaCm >= 0 ? "+" : ""}${r.deltaCm.toFixed(0)} ซม.`}
                    </span>
                  </div>
                  {r.sp !== null ? (
                    <div className="ms-bar">
                      <div
                        className="ms-bar-fill"
                        style={{ width: `${Math.min(100, Math.max(0, r.sp))}%`, background: color }}
                      />
                      <span className="ms-bar-bank" title="ระดับตลิ่ง" />
                    </div>
                  ) : null}
                </div>
              </li>
            );
          },
        )}
      </ol>

      {/* History we're collecting ourselves, because HII exposes only the latest value */}
      <h2 className="ms-h2">ประวัติที่บันทึกไว้</h2>
      {span && log.length >= 2 ? (
        <section className="ms-card">
          <div className="ms-chart-meta">
            <span>{log.length} จุดข้อมูล</span>
            <span className="num-mono">
              {fmtTime(new Date(span.lo).toISOString())} – {fmtTime(new Date(span.hi).toISOString())}
            </span>
          </div>
          <svg viewBox="0 0 320 120" className="ms-chart" preserveAspectRatio="none" role="img"
               aria-label="กราฟระดับน้ำเทียบตลิ่งย้อนหลัง">
            {[0, 25, 50, 75, 100].map((g) => (
              <line key={g} x1="0" x2="320" y1={120 - g * 1.1} y2={120 - g * 1.1}
                    stroke="rgba(120,200,200,0.12)" strokeWidth="0.5" />
            ))}
            {/* 100% = bank line */}
            <line x1="0" x2="320" y1={120 - 100 * 1.1} y2={120 - 100 * 1.1}
                  stroke="rgba(215,48,39,0.5)" strokeWidth="0.8" strokeDasharray="3 3" />
            {MAESAI_CHAIN.map((meta) => {
              const pts = series.get(meta.code) ?? [];
              if (pts.length < 2) return null;
              const d = pts
                .map((p, i) => {
                  const x = ((p.t - span.lo) / (span.hi - span.lo)) * 320;
                  const y = 120 - Math.min(110, p.sp * 1.1);
                  return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
                })
                .join(" ");
              const last = pts[pts.length - 1];
              return (
                <path key={meta.code} d={d} fill="none"
                      stroke={bankPercentColor(last.sp)}
                      strokeWidth={meta.code === "MYA004" ? 2 : 1.2}
                      strokeOpacity={meta.code === "MYA004" ? 1 : 0.65}
                      strokeLinejoin="round" strokeLinecap="round" />
              );
            })}
          </svg>
          <div className="ms-legend">
            {MAESAI_CHAIN.map((meta) => {
              const pts = series.get(meta.code) ?? [];
              const last = pts[pts.length - 1];
              return (
                <span key={meta.code} className="ms-legend-item">
                  <span
                    className="ms-legend-sw"
                    style={{
                      background: last ? bankPercentColor(last.sp) : "var(--ink-4)",
                      height: meta.code === "MYA004" ? 3 : 2,
                    }}
                  />
                  {meta.role}
                </span>
              );
            })}
          </div>
        </section>
      ) : (
        <section className="ms-card ms-empty">
          กำลังเริ่มเก็บสถิติ ({log.length} จุด) — ระบบบันทึกค่าทุก 30 นาทีโดยอัตโนมัติ
          กราฟจะขึ้นเมื่อมีข้อมูลอย่างน้อย 2 ช่วงเวลา
        </section>
      )}

      <section className="ms-note">
        <p>
          <b>%ตลิ่ง</b> คือระดับน้ำเทียบกับตลิ่งที่ต่ำที่สุดของสถานีนั้น — ถึง 100% หมายถึงน้ำเสมอตลิ่ง
          เกินกว่านั้นคือล้นตลิ่ง · <b>▲▼</b> เทียบกับค่าที่สถานีส่งมาก่อนหน้า
        </p>
        <p>
          <b>ยังไม่แสดงเวลาที่น้ำจะถึงสะพาน</b> — API สาธารณะของ สสน. ให้เฉพาะค่าล่าสุดของแต่ละสถานี
          (endpoint กราฟย้อนหลังใช้งานไม่ได้) จึงยังไม่มีสถิติมาสอบเทียบว่าน้ำจากต้นน้ำใช้เวลาเดินทางกี่ชั่วโมง
          ระบบกำลังเก็บสถิติเองอยู่ เมื่อผ่านช่วงฝนตกจริงสักระยะจึงจะคำนวณได้อย่างมีหลักฐาน
        </p>
        <p className="ms-disclaim">
          เป็นเครื่องมือแสดงข้อมูล ไม่ใช่ประกาศเตือนภัยทางการ
          {updatedAt ? ` · อัปเดตล่าสุด ${fmtTime(updatedAt.toISOString())}` : ""}
        </p>
      </section>
    </div>
  );
}
