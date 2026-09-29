"use client";

// ผังคลอง — the desktop face of /bmr: a drawing-sheet with the BMA canal
// network as a transit-style diagram (lib/schematic.ts lays it out from data
// alone). Not to scale along a line; it answers "which canal is over, and
// where along it" at a glance, and hands off to the real map for geography.

import { ArrowUpRight, Map as MapIcon, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { BmaPayload } from "@/lib/bma";
import { place, textWidth, type Box } from "@/lib/labels";
import { buildSheet, type HiiInput, type RiverStation, type SheetStation } from "@/lib/schematic";
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
  /** Phone layout: single column, pan-able 1000 px sheet, bottom-sheet detail. */
  compact?: boolean;
  /** Face switcher rendered in the header on phones. */
  toggle?: React.ReactNode;
};

type Pick = { kind: "bma"; s: SheetStation } | { kind: "hii"; r: RiverStation; onRiver: boolean } | null;
type Tip = { x: number; y: number; title: string; lines: string[] } | null;

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
const STATUS_TH: Record<SheetStation["status"], string> = { critical: "วิกฤต", warning: "เตือน", watch: "เฝ้าระวัง", normal: "ปกติ", unknown: "ไม่มีข้อมูล" };
const m2 = (v: number | null) => (v === null ? "—" : `${v.toFixed(2)} ม.`);
const signed = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}`;

export function BmrSheet({ bma, hii, cams, updatedAt, error, onOpen, onMap, compact = false, toggle }: SheetProps) {
  const sheet = useMemo(() => buildSheet(bma?.gauges ?? [], hii, { w: 1000, h: 640, pad: 30 }), [bma, hii]);
  const stations = useMemo(() => [...sheet.loose, ...sheet.canals.flatMap((c) => c.stations)], [sheet]);
  const critical = stations.filter((s) => s.status === "critical").length;
  const topOver = useMemo(
    () => stations.filter((s) => s.status === "critical" && s.over !== null).sort((a, b) => (b.over ?? 0) - (a.over ?? 0)).slice(0, 8),
    [stations],
  );
  const overBank = useMemo(() => [...sheet.river.stations, ...sheet.hii].filter((r) => !r.stale && (r.pct ?? 0) >= 100).sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0)), [sheet]);
  const clock = updatedAt ? new Intl.DateTimeFormat("th-TH", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ }).format(new Date(updatedAt)) : "--:--";

  // ── Labels that do not collide: station dots are taken first, then canal
  // names by size, then the worst-five callouts.
  const labels = useMemo(() => {
    const taken: Box[] = stations.map((s) => ({ x: s.x - radius(s) - 1, y: s.y - radius(s) - 1, w: radius(s) * 2 + 2, h: radius(s) * 2 + 2 }));
    for (const r of [...sheet.river.stations, ...sheet.hii]) taken.push({ x: r.x - 6, y: r.y - 6, w: 12, h: 12 });
    const canalLabels: { name: string; x: number; y: number; rotate: boolean }[] = [];
    const H = 13;
    for (const c of [...sheet.canals].sort((a, b) => b.stations.length - a.stations.length)) {
      const w = textWidth(c.name);
      // Clear the biggest dot on this line, so above/below never touch it.
      const off = Math.max(...c.stations.map(radius)) + 4;
      const cands: (Box & { rotate: boolean })[] =
        c.orient === "h"
          ? [
              { x: c.x1, y: c.y1 - off - H, w, h: H, rotate: false },
              { x: c.x2 - w, y: c.y1 - off - H, w, h: H, rotate: false },
              { x: c.x1, y: c.y1 + off, w, h: H, rotate: false },
              { x: c.x2 - w, y: c.y1 + off, w, h: H, rotate: false },
              { x: c.x2 + 8, y: c.y1 - H / 2, w, h: H, rotate: false },
              { x: c.x1 - w - 8, y: c.y1 - H / 2, w, h: H, rotate: false },
            ]
          : [
              { x: c.x1 + off, y: c.y1, w: H, h: w, rotate: true },
              { x: c.x1 + off, y: c.y2 - w, w: H, h: w, rotate: true },
              { x: c.x1 - off - H, y: c.y1, w: H, h: w, rotate: true },
              { x: c.x1 - off - H, y: c.y2 - w, w: H, h: w, rotate: true },
              { x: c.x1 - w / 2, y: c.y1 - H - 8, w, h: H, rotate: false },
              { x: c.x1 - w / 2, y: c.y2 + 8, w, h: H, rotate: false },
            ];
      const box = place(cands, taken);
      if (!box) continue;
      taken.push(box);
      // Rotated text is anchored at its top-left and turned 90° clockwise, so
      // its x is the box's right edge; upright text sits on its baseline.
      canalLabels.push(box.rotate ? { name: c.name, x: box.x + H - 2, y: box.y, rotate: true } : { name: c.name, x: box.x, y: box.y + H - 2, rotate: false });
    }
    const callouts: { code: string; text: string; x: number; y: number }[] = [];
    // Callouts only have to clear other text: they draw above the dots and
    // the paper halo keeps them legible over a crowded cluster.
    const takenText: Box[] = taken.slice(stations.length + sheet.river.stations.length + sheet.hii.length);
    for (const s of topOver.slice(0, 5)) {
      const text = `${s.label.slice(0, 24)} ${signed(s.over ?? 0)}`;
      const w = textWidth(text, 11.5);
      const r = radius(s);
      const cands: Box[] = [
        { x: s.x + r + 5, y: s.y - 7, w, h: 13 },
        { x: s.x - r - 5 - w, y: s.y - 7, w, h: 13 },
        { x: s.x - w / 2, y: s.y - r - 18, w, h: 13 },
        { x: s.x - w / 2, y: s.y + r + 5, w, h: 13 },
        { x: s.x + r + 4, y: s.y - r - 16, w, h: 13 },
        { x: s.x - r - 4 - w, y: s.y - r - 16, w, h: 13 },
        { x: s.x + r + 4, y: s.y + r + 3, w, h: 13 },
        { x: s.x - r - 4 - w, y: s.y + r + 3, w, h: 13 },
        { x: s.x + r + 22, y: s.y - 7, w, h: 13 },
        { x: s.x - r - 22 - w, y: s.y - 7, w, h: 13 },
      ];
      const box = place(cands, takenText);
      if (!box) continue;
      takenText.push(box);
      callouts.push({ code: s.code, text, x: box.x, y: box.y + 11 });
    }
    return { canalLabels, callouts };
  }, [sheet, stations, topOver]);

  // ── Interaction: hover tooltip (HTML, follows the pointer) and a picked
  // station shown in the side panel; the map is one click further.
  const [tip, setTip] = useState<Tip>(null);
  const [pick, setPick] = useState<Pick>(null);
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    if (!bma) return;
    const t = window.setTimeout(() => setDrawn(true), 30);
    return () => window.clearTimeout(t);
  }, [bma]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPick(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const tipAt = (e: React.MouseEvent, title: string, lines: string[]) => setTip({ x: e.clientX, y: e.clientY, title, lines });

  const stationTip = (s: SheetStation) => [
    `${STATUS_TH[s.status]}${s.level !== null ? ` · ${m2(s.level)}` : ""}`,
    s.over !== null ? `${signed(s.over)} ม. จากเกณฑ์` : "ไม่มีเกณฑ์",
    ...(s.pressure ? ["ประตูกันแม่น้ำอยู่"] : []),
  ];
  const station = (s: SheetStation) => {
    const r = radius(s);
    const picked = pick?.kind === "bma" && pick.s.code === s.code;
    return (
      <g
        key={s.code}
        className={`sh-st${picked ? " is-picked" : ""}`}
        role="button"
        tabIndex={0}
        aria-label={s.name}
        onClick={() => setPick({ kind: "bma", s })}
        onKeyDown={(e) => e.key === "Enter" && setPick({ kind: "bma", s })}
        onMouseEnter={(e) => tipAt(e, s.name, stationTip(s))}
        onMouseMove={(e) => tipAt(e, s.name, stationTip(s))}
        onMouseLeave={() => setTip(null)}
      >
        {picked ? <circle cx={s.x} cy={s.y} r={r + 9} fill="none" stroke="var(--sh-ink)" strokeWidth={1.5} strokeDasharray="3 3" /> : null}
        {s.pressure ? <circle cx={s.x} cy={s.y} r={r + 5} fill="none" stroke="var(--sh-blue)" strokeWidth={2.5} /> : null}
        {s.kind === "gate" ? (
          <rect x={s.x - r} y={s.y - r} width={r * 2} height={r * 2} transform={`rotate(45 ${s.x} ${s.y})`} fill={fill(s)} stroke="var(--sh-ink)" strokeWidth={2} />
        ) : (
          <circle cx={s.x} cy={s.y} r={r} fill={fill(s)} stroke="var(--sh-ink)" strokeWidth={2} />
        )}
      </g>
    );
  };
  const hiiNode = (r: RiverStation, onRiver: boolean) => {
    const picked = pick?.kind === "hii" && pick.r.id === r.id;
    const lines = [`${r.pct !== null ? `${Math.round(r.pct)}% ของตลิ่ง` : "—"}${r.stale ? " · ข้อมูลค้าง" : ""}`, onRiver ? "แม่น้ำเจ้าพระยา · สสน./ชป." : "สสน./ชป."];
    const over = !r.stale && (r.pct ?? 0) >= 100;
    return (
      <g
        key={`h${r.id}`}
        className={`sh-st${picked ? " is-picked" : ""}`}
        role="button"
        tabIndex={0}
        aria-label={r.name}
        onClick={() => setPick({ kind: "hii", r, onRiver })}
        onKeyDown={(e) => e.key === "Enter" && setPick({ kind: "hii", r, onRiver })}
        onMouseEnter={(e) => tipAt(e, r.name, lines)}
        onMouseMove={(e) => tipAt(e, r.name, lines)}
        onMouseLeave={() => setTip(null)}
      >
        {picked ? <circle cx={r.x} cy={r.y} r={14} fill="none" stroke="var(--sh-ink)" strokeWidth={1.5} strokeDasharray="3 3" /> : null}
        {onRiver ? (
          <circle cx={r.x} cy={r.y} r={6} fill={over ? "var(--sh-red)" : "var(--sh-paper)"} stroke="var(--sh-blue)" strokeWidth={2.5} />
        ) : (
          <rect x={r.x - 4.5} y={r.y - 4.5} width={9} height={9} fill={over ? "var(--sh-red)" : "var(--sh-paper)"} stroke="var(--sh-blue)" strokeWidth={2} />
        )}
      </g>
    );
  };

  return (
    <div className={`sheet${drawn ? " is-drawn" : ""}${compact ? " is-compact" : ""}`}>
      {toggle}
      <header className="sh-head">
        <div className="sh-mast">
          <div className="sh-title-row">
            <span className="sh-title">รอระบาย</span>
            <span className="sh-kicker">ผังคลอง กทม.</span>
          </div>
          <span className="sh-slogan">ข้อมูลมีอยู่ทุกที่ เราแค่หยิบมาวางที่เดียว · Geography Lounge</span>
        </div>
        <div className="sh-stamp" role="group" aria-label="สรุป">
          <div><span className="sh-k">อัปเดต</span><span className="sh-v">{clock}</span></div>
          <div><span className="sh-k">เกินวิกฤต</span><span className="sh-v is-red">{bma ? `${critical} จุด` : "—"}</span></div>
          <div><span className="sh-k">ล้นตลิ่ง สสน./ชป.</span><span className="sh-v">{hii.length ? `${overBank.length} สถานี` : "—"}</span></div>
          <div><span className="sh-k">กล้องมีภาพ</span><span className="sh-v">{cams ? `${cams.live}/${cams.listed}` : "—"}</span></div>
        </div>
        <button type="button" className="sh-mapbtn" onClick={onMap}>
          <MapIcon size={16} /> แผนที่จริง
        </button>
      </header>

      <div className="sh-body">
        <div className="sh-canvas" onMouseLeave={() => setTip(null)}>
          {error && !bma ? <div className="sh-err">โหลดข้อมูล สนน. กทม. ไม่ได้: {error}</div> : null}
          {!bma && !error ? <div className="sh-err is-muted">กำลังหยิบข้อมูลมาวาง…</div> : null}
          <svg className="sh-svg" viewBox={`0 0 ${sheet.w} ${sheet.h}`} role="img" aria-label="ผังคลอง กทม. แสดงสถานะสถานีวัดระดับน้ำ">
            {sheet.river.points.length >= 2 ? (
              <g className="sh-river">
                <polyline points={sheet.river.points.map((p) => p.join(",")).join(" ")} fill="none" stroke="var(--sh-blue)" strokeWidth={10} strokeLinecap="round" strokeLinejoin="round" opacity={0.55} />
                <text x={sheet.river.points[0][0] + 10} y={sheet.river.points[0][1] - 8} className="sh-lbl is-blue">แม่น้ำเจ้าพระยา</text>
              </g>
            ) : null}
            {sheet.canals.map((c, i) => (
              <line key={c.name} className="sh-line" style={{ transitionDelay: `${i * 18}ms` }} x1={c.x1} y1={c.y1} x2={c.x2} y2={c.y2} stroke="var(--sh-ink)" strokeWidth={c.stations.length >= 4 ? 6 : 4} strokeLinecap="round" pathLength={1} />
            ))}
            {labels.canalLabels.map((l) => (
              <text key={l.name} x={l.x} y={l.y} className="sh-lbl" transform={l.rotate ? `rotate(90 ${l.x} ${l.y})` : undefined}>
                {l.name}
              </text>
            ))}
            <g className="sh-dots">
              {sheet.hii.map((r) => hiiNode(r, false))}
              {sheet.river.stations.map((r) => hiiNode(r, true))}
              {sheet.loose.map(station)}
              {sheet.canals.flatMap((c) => c.stations.map(station))}
            </g>
            {labels.callouts.map((c) => (
              <text key={c.code} x={c.x} y={c.y} className="sh-callout">{c.text}</text>
            ))}
          </svg>
          {tip ? (
            <div className="sh-tip" style={{ left: tip.x, top: tip.y }} role="tooltip">
              <strong>{tip.title}</strong>
              {tip.lines.map((l, i) => <span key={i}>{l}</span>)}
            </div>
          ) : null}
          <div className="sh-legend">
            <span><i className="sh-sw is-red" /> เกินวิกฤต — ขนาด = เกินมากแค่ไหน</span>
            <span><i className="sh-sw is-amber" /> เตือน/เฝ้าระวัง</span>
            <span><i className="sh-sw" /> ปกติ</span>
            <span><i className="sh-sw is-gate" /> ประตู/สถานีสูบ</span>
            <span><i className="sh-sw is-ring" /> ประตูกันแม่น้ำ (นอก−ใน ≥ 1 ม.)</span>
            <span><i className="sh-sw is-hii" /> สถานี สสน./ชป.</span>
            <span className="sh-note">{compact ? "ลากเพื่อดูทั้งผัง · แตะสถานีเพื่อดูรายละเอียด · ผังไม่ใช่มาตราส่วนจริง" : "ผังไม่ใช่มาตราส่วนจริง — แตะสถานีเพื่อดูรายละเอียด"}</span>
          </div>
        </div>

        <aside className="sh-side">
          {pick ? (
            <div className="sh-box sh-detail" aria-live="polite">
              <div className="sh-box-h sh-detail-h">
                <span>{pick.kind === "bma" ? (pick.s.kind === "gate" ? "ประตู/สถานีสูบ สนน. กทม." : "จุดวัด สนน. กทม.") : pick.onRiver ? "สถานีแม่น้ำ สสน./ชป." : "สถานี สสน./ชป."}</span>
                <button type="button" className="sh-x" onClick={() => setPick(null)} aria-label="ปิด"><X size={14} /></button>
              </div>
              {pick.kind === "bma" ? (
                <div className="sh-detail-b">
                  <div className="sh-detail-name">{pick.s.name}</div>
                  <div className={`sh-badge is-${pick.s.status}`}>{STATUS_TH[pick.s.status]}</div>
                  <div className="sh-big">{pick.s.level !== null ? pick.s.level.toFixed(2) : "—"}<small> ม.รทก.</small></div>
                  <div className="sh-kv">
                    <span>เกณฑ์วิกฤต</span><b>{m2(pick.s.critical)}</b>
                    <span>เกณฑ์เตือน</span><b>{m2(pick.s.warning)}</b>
                    {pick.s.over !== null ? <><span>จากเกณฑ์</span><b className={pick.s.over >= 0 ? "is-red" : ""}>{signed(pick.s.over)} ม.</b></> : null}
                    {pick.s.kind === "gate" ? <><span>นอกประตู (แม่น้ำ)</span><b>{m2(pick.s.levelOut)}</b></> : null}
                    {pick.s.pressure && pick.s.levelOut !== null && pick.s.level !== null ? <><span>ต่างระดับ</span><b className="is-blue">แม่น้ำสูงกว่า {(pick.s.levelOut - pick.s.level).toFixed(2)} ม. — ประตูกันอยู่</b></> : null}
                    <span>ข้อมูลเมื่อ</span><b>{pick.s.ageMin === null ? "—" : `${pick.s.ageMin} นาทีก่อน`}</b>
                  </div>
                  <button type="button" className="sh-mapbtn is-full" onClick={() => onOpen({ kind: "bma", code: pick.s.code })}><ArrowUpRight size={16} /> ดูบนแผนที่จริง</button>
                </div>
              ) : (
                <div className="sh-detail-b">
                  <div className="sh-detail-name">{pick.r.name}</div>
                  <div className={`sh-badge is-${pick.r.stale ? "unknown" : (pick.r.pct ?? 0) >= 100 ? "critical" : (pick.r.pct ?? 0) >= 80 ? "warning" : "normal"}`}>
                    {pick.r.stale ? "ข้อมูลค้าง" : (pick.r.pct ?? 0) >= 100 ? "ล้นตลิ่ง" : (pick.r.pct ?? 0) >= 80 ? "ใกล้ตลิ่ง" : "ปกติ"}
                  </div>
                  <div className="sh-big">{pick.r.pct !== null ? Math.round(pick.r.pct) : "—"}<small> % ของตลิ่ง</small></div>
                  <div className="sh-kv"><span>ลำน้ำ</span><b>{pick.onRiver ? "แม่น้ำเจ้าพระยา" : "คลอง/ลำน้ำสาขา"}</b></div>
                  <button type="button" className="sh-mapbtn is-full" onClick={() => onOpen({ kind: "hii", id: pick.r.id })}><ArrowUpRight size={16} /> ดูบนแผนที่จริง + กราฟ 30 วัน</button>
                </div>
              )}
            </div>
          ) : null}
          <div className="sh-box">
            <div className="sh-box-h">เกินเกณฑ์วิกฤตมากสุด</div>
            {topOver.length === 0 ? <div className="sh-row is-empty">{bma ? "ไม่มีสถานีเกินวิกฤต" : "กำลังโหลด…"}</div> : null}
            {topOver.map((s) => (
              <button key={s.code} type="button" className={`sh-row${pick?.kind === "bma" && pick.s.code === s.code ? " is-on" : ""}`} onClick={() => setPick({ kind: "bma", s })}>
                <span className="sh-row-n">{s.canal}{s.label !== s.canal ? ` · ${s.label}` : ""}</span>
                <span className="sh-row-v is-red">{signed(s.over ?? 0)}</span>
              </button>
            ))}
            <div className="sh-box-h">ล้นตลิ่ง สสน./ชป.</div>
            {overBank.length === 0 ? <div className="sh-row is-empty">{hii.length ? "ไม่มีสถานีล้นตลิ่ง" : "กำลังโหลด…"}</div> : null}
            {overBank.slice(0, 6).map((r) => (
              <button key={r.id} type="button" className={`sh-row${pick?.kind === "hii" && pick.r.id === r.id ? " is-on" : ""}`} onClick={() => setPick({ kind: "hii", r, onRiver: sheet.river.stations.includes(r) })}>
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
