import { ImageResponse } from "next/og";
import { loadKlongMap } from "@/lib/klongmap-server";
import { buildSheet } from "@/lib/schematic";

// Share card for /bmr: the live canal sheet in miniature with tonight's
// counts, so a pasted link on LINE/Facebook shows the thing itself rather
// than a generic banner. Regenerated every 10 minutes.

export const runtime = "nodejs";
export const revalidate = 600;
export const alt = "รอระบาย — ผังคลอง กทม. สถานะสถานีวัดระดับน้ำ";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const PAPER = "#F3EDE2";
const INK = "#1E2A2E";
const MUTED = "#5B6A70";
const RED = "#B3261E";
const AMBER = "#E9A23B";
const BLUE = "#0B6E8F";

// Satori needs raw font files; Google serves TTF to a non-woff2 UA.
async function font(family: string, weight: number): Promise<ArrayBuffer | null> {
  try {
    const css = await fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weight}&display=swap`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 6.1; rv:5.0)" },
      next: { revalidate: 86400 },
    }).then((r) => r.text());
    const url = css.match(/url\((https:\/\/fonts\.gstatic\.com[^)]+\.ttf)\)/)?.[1];
    if (!url) return null;
    return await fetch(url, { next: { revalidate: 86400 } }).then((r) => r.arrayBuffer());
  } catch {
    return null;
  }
}

export default async function Image() {
  const [km, chakra, bai] = await Promise.all([loadKlongMap(), font("Chakra Petch", 700), font("Bai Jamjuree", 500)]);
  const gauges = km.ok ? km.payload.gauges : [];
  const sheet = buildSheet(gauges, [], { w: 760, h: 470, pad: 20 });
  const stations = [...sheet.loose, ...sheet.canals.flatMap((c) => c.stations)];
  const critical = stations.filter((s) => s.status === "critical").length;
  const worst = stations.filter((s) => s.status === "critical" && s.over !== null).sort((a, b) => (b.over ?? 0) - (a.over ?? 0))[0];
  const when = km.ok && km.payload.sourceAt ? new Intl.DateTimeFormat("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Bangkok" }).format(new Date(km.payload.sourceAt)) : "";
  const fonts = [
    ...(chakra ? [{ name: "Chakra Petch", data: chakra, weight: 700 as const, style: "normal" as const }] : []),
    ...(bai ? [{ name: "Bai Jamjuree", data: bai, weight: 500 as const, style: "normal" as const }] : []),
  ];
  const r = (s: (typeof stations)[number]) => (s.status === "critical" ? 5 + Math.min(6, Math.max(0, s.over ?? 0) * 7) : 3.5);
  const fill = (s: (typeof stations)[number]) => (s.status === "critical" ? RED : s.status === "warning" || s.status === "watch" ? AMBER : s.status === "unknown" ? MUTED : PAPER);

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: PAPER, color: INK, fontFamily: "Bai Jamjuree, sans-serif", padding: 36, position: "relative" }}>
        <div style={{ display: "flex", flexDirection: "column", width: 340, paddingRight: 24, justifyContent: "space-between" }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontFamily: "Chakra Petch", fontSize: 64, fontWeight: 700, lineHeight: 1 }}>รอระบาย</div>
            <div style={{ fontSize: 20, color: MUTED, marginTop: 10, lineHeight: 1.3 }}>ผังคลอง กทม. — ข้อมูลมีอยู่ทุกที่ เราแค่หยิบมาวางที่เดียว</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", border: `2px solid ${INK}`, padding: "14px 18px" }}>
            <div style={{ fontSize: 15, color: MUTED, letterSpacing: 2 }}>เกินเกณฑ์วิกฤต</div>
            <div style={{ fontFamily: "Chakra Petch", fontSize: 56, fontWeight: 700, color: RED, lineHeight: 1 }}>{km.ok ? `${critical} จุด` : "—"}</div>
            {worst ? <div style={{ fontSize: 17, marginTop: 8, lineHeight: 1.35 }}>{`มากสุด ${worst.canal}${worst.label !== worst.canal ? ` · ${worst.label}` : ""} +${(worst.over ?? 0).toFixed(2)} ม.`}</div> : null}
            <div style={{ fontSize: 14, color: MUTED, marginTop: 8 }}>{when ? `สนน. กทม. · ${when}` : "สนน. กทม."}</div>
          </div>
          <div style={{ fontSize: 14, color: MUTED }}>flashflood-risk-intelligence.vercel.app/bmr · Geography Lounge</div>
        </div>
        <svg width={760} height={470} viewBox="0 0 760 470" style={{ position: "absolute", right: 36, top: 80 }}>
          {sheet.canals.map((c) => (
            <line key={c.name} x1={c.x1} y1={c.y1} x2={c.x2} y2={c.y2} stroke={INK} strokeWidth={c.stations.length >= 4 ? 5 : 3.5} strokeLinecap="round" />
          ))}
          {stations.map((s) => (
            <circle key={s.code} cx={s.x} cy={s.y} r={r(s)} fill={fill(s)} stroke={INK} strokeWidth={1.6} />
          ))}
          {stations.filter((s) => s.pressure).map((s) => (
            <circle key={`p${s.code}`} cx={s.x} cy={s.y} r={r(s) + 4} fill="none" stroke={BLUE} strokeWidth={2} />
          ))}
        </svg>
      </div>
    ),
    { ...size, fonts },
  );
}
