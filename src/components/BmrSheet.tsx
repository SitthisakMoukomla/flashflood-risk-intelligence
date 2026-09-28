"use client";

// ผังคลอง — the desktop face of /bmr: a drawing-sheet with the BMA canal
// network as a transit-style diagram (see lib/schematic.ts for how it is
// laid out from data alone). Nothing here is to scale along a line; the
// sheet exists to answer "which canal is over, and where along it" at a
// glance, and hands off to the real map for anything geographic.

import { Map as MapIcon } from "lucide-react";
import { useMemo } from "react";
import type { BmaPayload } from "@/lib/bma";
import { buildSheet, type HiiInput, type SheetStation } from "@/lib/schematic";
import type { FocusTarget } from "./BmrDashboard";

const TZ = "Asia/Bangkok";

export type SheetProps = {
  bma: BmaPayload | null;
  hii: HiiInput[];
  cams: { live: number; listed: number } | null;
  updatedAt: number | null;
  error: string | null;
  onOpen: (t: FocusTarget) => void;
  onMap: () => void;
};

function radius(s: SheetStation): number {
  if (s.status === "critical") return 7 + Math.min(9, Math.max(0, s.over ?? 0) * 10);
  if (s.status === "warning" || s.status === "watch") return 6;
  return 5;
}
function fill(s: SheetStation): string {
  if (s.status === "critical") return "var(--sh-red)";
  if (s.status === "warning" || s.status === "watch") return "var(--sh-amber)";
  if (s.status === "unknown") return "var(--sh-muted)";
  return "var(--sh-paper)";
}

export function BmrSheet({ bma, hii, cams, updatedAt, error, onOpen, onMap }: SheetProps) {
  const sheet = useMemo(() => buildSheet(bma?.gauges ?? [], hii, { w: 1000, h: 640, pad: 30 }), [bma, hii]);
  const stations = useMemo(() => [...sheet.loose, ...sheet.canals.flatMap((c) => c.stations)], [sheet]);
  const critical = stations.filter((s) => s.status === "critical").length;
  const topOver = useMemo(
    () => stations.filter((s) => s.status === "critical" && s.over !== null).sort((a, b) => (b.over ?? 0) - (a.over ?? 0)).slice(0, 8),
    [stations],
  );
  const callouts = topOver.slice(0, 5);
  const overBank = useMemo(() => [...sheet.river.stations, ...sheet.hii].filter((r) => !r.stale && (r.pct ?? 0) >= 100).sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0)), [sheet]);
  const clock = updatedAt ? new Intl.DateTimeFormat("th-TH", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ }).format(new Date(updatedAt)) : "--:--";

  const station = (s: SheetStation) => (
    <g key={s.code} className="sh-st" role="button" tabIndex={0} onClick={() => onOpen({ kind: "bma", code: s.code })} onKeyDown={(e) => e.key === "Enter" && onOpen({ kind: "bma", code: s.code })}>
      <title>{`${s.name}\n${s.level !== null ? `${s.level.toFixed(2)} ม.` : "—"}${s.over !== null ? ` (${s.over >= 0 ? "+" : ""}${s.over.toFixed(2)} จากเกณฑ์)` : ""}${s.pressure ? "\nประตูกันแม่น้ำอยู่" : ""}`}</title>
      {s.pressure ? <circle cx={s.x} cy={s.y} r={radius(s) + 5} fill="none" stroke="var(--sh-blue)" strokeWidth={2.5} /> : null}
      {s.kind === "gate" ? (
        <rect x={s.x - radius(s)} y={s.y - radius(s)} width={radius(s) * 2} height={radius(s) * 2} transform={`rotate(45 ${s.x} ${s.y})`} fill={fill(s)} stroke="var(--sh-ink)" strokeWidth={2} />
      ) : (
        <circle cx={s.x} cy={s.y} r={radius(s)} fill={fill(s)} stroke="var(--sh-ink)" strokeWidth={2} />
      )}
    </g>
  );

  return (
    <div className="sheet">
      <header className="sh-head">
        <div className="sh-mast">
          <div className="sh-title-row">
            <span className="sh-title">รอระบาย</span>
            <span className="sh-kicker">ผังคลอง กทม. · แผ่น 1/1</span>
          </div>
          <span className="sh-slogan">ข้อมูลมีอยู่ทุกที่ เราแค่หยิบมาวางที่เดียว · Geography Lounge</span>
        </div>
        <div className="sh-stamp" role="group" aria-label="สรุป">
          <div><span className="sh-k">เวลา</span><span className="sh-v">{clock}</span></div>
          <div><span className="sh-k">เกินวิกฤต</span><span className="sh-v is-red">{bma ? `${critical} จุด` : "—"}</span></div>
          <div><span className="sh-k">ล้นตลิ่ง สสน./ชป.</span><span className="sh-v">{hii.length ? `${overBank.length} สถานี` : "—"}</span></div>
          <div><span className="sh-k">กล้องมีภาพ</span><span className="sh-v">{cams ? `${cams.live}/${cams.listed}` : "—"}</span></div>
        </div>
        <button type="button" className="sh-mapbtn" onClick={onMap}>
          <MapIcon size={16} /> แผนที่จริง
        </button>
      </header>

      <div className="sh-body">
        <div className="sh-canvas">
          {error && !bma ? <div className="sh-err">โหลดข้อมูล สนน. กทม. ไม่ได้: {error}</div> : null}
          <svg className="sh-svg" viewBox={`0 0 ${sheet.w} ${sheet.h}`} role="img" aria-label="ผังคลอง กทม. แสดงสถานะสถานีวัดระดับน้ำ">
            {sheet.river.points.length >= 2 ? (
              <g>
                <polyline points={sheet.river.points.map((p) => p.join(",")).join(" ")} fill="none" stroke="var(--sh-blue)" strokeWidth={14} strokeLinecap="round" strokeLinejoin="round" opacity={0.85} />
                <text x={sheet.river.points[0][0] + 12} y={sheet.river.points[0][1] + 4} className="sh-lbl is-blue">แม่น้ำเจ้าพระยา</text>
              </g>
            ) : null}
            {sheet.canals.map((c) => (
              <g key={c.name}>
                <line x1={c.x1} y1={c.y1} x2={c.x2} y2={c.y2} stroke="var(--sh-ink)" strokeWidth={c.stations.length >= 4 ? 6 : 4} strokeLinecap="round" />
                {c.orient === "h" ? (
                  <text x={c.x1} y={c.y1 - 9} className="sh-lbl">{c.name}</text>
                ) : (
                  <text x={c.x1 + 9} y={c.y1 + 4} className="sh-lbl" transform={`rotate(90 ${c.x1 + 9} ${c.y1 + 4})`}>{c.name}</text>
                )}
              </g>
            ))}
            {sheet.hii.map((r) => (
              <g key={`h${r.id}`} className="sh-st" role="button" tabIndex={0} onClick={() => onOpen({ kind: "hii", id: r.id })} onKeyDown={(e) => e.key === "Enter" && onOpen({ kind: "hii", id: r.id })}>
                <title>{`${r.name} (สสน./ชป.)\n${r.pct !== null ? `${Math.round(r.pct)}% ของตลิ่ง` : "—"}${r.stale ? " · ค้าง" : ""}`}</title>
                <rect x={r.x - 4} y={r.y - 4} width={8} height={8} fill={r.stale ? "var(--sh-paper)" : (r.pct ?? 0) >= 100 ? "var(--sh-red)" : "var(--sh-paper)"} stroke="var(--sh-blue)" strokeWidth={2} />
              </g>
            ))}
            {sheet.river.stations.map((r) => (
              <g key={`r${r.id}`} className="sh-st" role="button" tabIndex={0} onClick={() => onOpen({ kind: "hii", id: r.id })} onKeyDown={(e) => e.key === "Enter" && onOpen({ kind: "hii", id: r.id })}>
                <title>{`${r.name} (แม่น้ำเจ้าพระยา)\n${r.pct !== null ? `${Math.round(r.pct)}% ของตลิ่ง` : "—"}`}</title>
                <circle cx={r.x} cy={r.y} r={6} fill={(r.pct ?? 0) >= 100 && !r.stale ? "var(--sh-red)" : "var(--sh-paper)"} stroke="var(--sh-blue)" strokeWidth={2.5} />
              </g>
            ))}
            {sheet.loose.map(station)}
            {sheet.canals.flatMap((c) => c.stations.map(station))}
            {callouts.map((s, i) => (
              <text key={`c${s.code}`} x={s.x + radius(s) + 5} y={s.y - radius(s) - 3 + (i % 2) * 24} className="sh-callout">
                {`${s.label.slice(0, 26)} +${(s.over ?? 0).toFixed(2)}`}
              </text>
            ))}
          </svg>
          <div className="sh-legend">
            <span><i className="sh-sw is-red" /> เกินวิกฤต — ขนาด = เกินมากแค่ไหน</span>
            <span><i className="sh-sw is-amber" /> เตือน/เฝ้าระวัง</span>
            <span><i className="sh-sw" /> ปกติ</span>
            <span><i className="sh-sw is-gate" /> ประตู/สถานีสูบ</span>
            <span><i className="sh-sw is-ring" /> ประตูกันแม่น้ำ (นอก−ใน ≥ 1 ม.)</span>
            <span><i className="sh-sw is-hii" /> สถานี สสน./ชป.</span>
            <span className="sh-note">ผังไม่ใช่มาตราส่วนจริง — แตะสถานีเพื่อเปิดแผนที่</span>
          </div>
        </div>

        <aside className="sh-side">
          <div className="sh-box">
            <div className="sh-box-h">เกินเกณฑ์วิกฤตมากสุด</div>
            {topOver.length === 0 ? <div className="sh-row is-empty">{bma ? "ไม่มีสถานีเกินวิกฤต" : "กำลังโหลด…"}</div> : null}
            {topOver.map((s) => (
              <button key={s.code} type="button" className="sh-row" onClick={() => onOpen({ kind: "bma", code: s.code })}>
                <span className="sh-row-n">{s.canal}{s.label !== s.canal ? ` · ${s.label}` : ""}</span>
                <span className="sh-row-v is-red">+{(s.over ?? 0).toFixed(2)}</span>
              </button>
            ))}
            <div className="sh-box-h">ล้นตลิ่ง สสน./ชป.</div>
            {overBank.length === 0 ? <div className="sh-row is-empty">{hii.length ? "ไม่มีสถานีล้นตลิ่ง" : "กำลังโหลด…"}</div> : null}
            {overBank.slice(0, 6).map((r) => (
              <button key={r.id} type="button" className="sh-row" onClick={() => onOpen({ kind: "hii", id: r.id })}>
                <span className="sh-row-n">{r.name}</span>
                <span className="sh-row-v is-red">{Math.round(r.pct ?? 0)}%</span>
              </button>
            ))}
          </div>
          <p className="sh-foot">สนน. กทม. · สสน. · ชป. · iTIC · Copernicus<br />เครื่องมือแสดงข้อมูล ไม่ใช่ประกาศเตือนภัย</p>
        </aside>
      </div>
    </div>
  );
}
