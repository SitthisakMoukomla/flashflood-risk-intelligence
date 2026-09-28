"use client";

// ป้ายสถานะ — the phone face of /bmr: a departure-board list of the canals
// that are over their line, amber on black, one row per station. Tap a row
// to open the real map at that station.

import { Map as MapIcon } from "lucide-react";
import { useMemo } from "react";
import type { BmaPayload } from "@/lib/bma";
import { canalOf, labelOf, overOf, type HiiInput } from "@/lib/schematic";
import type { FocusTarget } from "./BmrDashboard";

const TZ = "Asia/Bangkok";

export type BoardProps = {
  bma: BmaPayload | null;
  hii: HiiInput[];
  cams: { live: number; listed: number } | null;
  updatedAt: number | null;
  error: string | null;
  onOpen: (t: FocusTarget) => void;
  onMap: () => void;
};

type Row = { key: string; target: FocusTarget; name: string; sub: string; level: string; ref: string; over: string; status: string; tone: "red" | "amber" | "dim" };

export function BmrBoard({ bma, hii, cams, updatedAt, error, onOpen, onMap }: BoardProps) {
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const g of bma?.gauges ?? []) {
      const over = overOf(g);
      const gap = g.kind === "gate" && g.level !== null && g.levelOut !== null ? g.levelOut - g.level : null;
      if (g.status === "critical" || g.status === "warning" || g.status === "watch") {
        out.push({
          key: g.code,
          target: { kind: "bma", code: g.code },
          name: canalOf(g.name),
          sub: labelOf(g.name, canalOf(g.name)),
          level: g.level === null ? "—" : g.level.toFixed(2),
          ref: g.critical !== null ? g.critical.toFixed(2) : g.warning !== null ? g.warning.toFixed(2) : "—",
          over: over === null ? "—" : `${over >= 0 ? "+" : ""}${over.toFixed(2)}`,
          status: g.status === "critical" ? "วิกฤต" : g.status === "warning" ? "เตือน" : "เฝ้าระวัง",
          tone: g.status === "critical" ? "red" : "amber",
        });
      } else if (gap !== null && gap >= 1) {
        out.push({ key: g.code, target: { kind: "bma", code: g.code }, name: canalOf(g.name), sub: labelOf(g.name, canalOf(g.name)), level: g.level === null ? "—" : g.level.toFixed(2), ref: `นอก ${g.levelOut?.toFixed(2)}`, over: "กัน", status: "ประตูปิด", tone: "dim" });
      }
    }
    for (const r of hii) {
      if (r.stale || r.pct === null || r.pct < 90) continue;
      out.push({ key: `h${r.id}`, target: { kind: "hii", id: r.id }, name: r.name, sub: r.onRiver ? "แม่น้ำเจ้าพระยา · สสน./ชป." : "สสน./ชป.", level: "", ref: "ตลิ่ง", over: `${Math.round(r.pct)}%`, status: r.pct >= 100 ? "ล้นตลิ่ง" : "ใกล้ตลิ่ง", tone: r.pct >= 100 ? "red" : "amber" });
    }
    // Tier first; within a tier the BMA canal rows (metres over the line)
    // lead the HII rows (% of bank) — the two scales are not comparable.
    const rank = (r: Row) => (r.tone === "red" ? 2 : r.tone === "amber" ? 1 : 0);
    const src = (r: Row) => (r.target.kind === "bma" ? 1 : 0);
    const num = (r: Row) => Number.parseFloat(r.over.replace("%", "")) || 0;
    return out.sort((a, b) => rank(b) - rank(a) || src(b) - src(a) || num(b) - num(a));
  }, [bma, hii]);
  const critical = (bma?.gauges ?? []).filter((g) => g.status === "critical").length;
  const clock = updatedAt ? new Intl.DateTimeFormat("th-TH", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ }).format(new Date(updatedAt)) : "--:--";

  return (
    <div className="board">
      <header className="bd-head">
        <div className="bd-mast">
          <span className="bd-title">รอระบาย</span>
          <span className="bd-kicker">สถานะคลอง กทม. · ข้อมูลมีอยู่ทุกที่ เราแค่หยิบมาวางที่เดียว</span>
        </div>
        <div className="bd-stats">
          <div><span className="bd-k">เกินวิกฤต</span><span className="bd-v is-red">{bma ? critical : "—"}</span></div>
          <div><span className="bd-k">กล้อง</span><span className="bd-v">{cams ? `${cams.live}/${cams.listed}` : "—"}</span></div>
          <div><span className="bd-k">เวลา</span><span className="bd-v">{clock}</span></div>
        </div>
      </header>
      <div className="bd-cols"><span>คลอง / สถานี · ระดับ / เกณฑ์ (ม.)</span><span>เกิน</span><span>สถานะ</span></div>
      <div className="bd-rows">
        {error && !bma ? <div className="bd-empty">โหลดข้อมูล สนน. กทม. ไม่ได้: {error}</div> : null}
        {!bma && !error ? <div className="bd-empty">กำลังโหลด…</div> : null}
        {bma && rows.length === 0 ? <div className="bd-empty">ไม่มีสถานีเกินเกณฑ์ตอนนี้</div> : null}
        {rows.map((r) => (
          <button key={r.key} type="button" className={`bd-row is-${r.tone}`} onClick={() => onOpen(r.target)}>
            <span className="bd-name">
              <span>{r.name}</span>
              <span className="bd-sub">{r.sub}{r.level ? ` · ${r.level} / ${r.ref}` : r.ref !== "ตลิ่ง" ? ` · ${r.ref}` : ""}</span>
            </span>
            <span className="bd-num is-tone">{r.over}</span>
            <span className="bd-status">{r.status}</span>
          </button>
        ))}
      </div>
      <footer className="bd-foot">
        <button type="button" className="bd-mapbtn" onClick={onMap}><MapIcon size={16} /> แผนที่จริง</button>
        <span>สนน. · สสน. · ชป. · iTIC · ไม่ใช่ประกาศเตือนภัย</span>
      </footer>
    </div>
  );
}
