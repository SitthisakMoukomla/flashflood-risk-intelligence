import { NextResponse } from "next/server";

/**
 * 30 days of 10-minute water levels for one HII/RID station.
 *
 * The public ThaiWater API only returns each station's latest reading;
 * the chart on tiwrm.hii.or.th is fed by this endpoint, which returns
 * [[epoch_ms_UTC, level_msl, bank, ground, "level"], …]. It sends no CORS
 * headers, hence the proxy. 999999 is HII's missing-value sentinel.
 *
 * GET /api/hii/history?code=BKK005  →  { code, points: [[t, level], …], bank }
 */

export const runtime = "nodejs";
export const revalidate = 600;

const BASE = "https://tiwrm.hii.or.th/thaiwater_l5/public/getGraphFirst/";
const UA = "FlashfloodRiskIntelligence/1.0 (flashflood-risk-intelligence.vercel.app)";

export async function GET(request: Request) {
  const code = new URL(request.url).searchParams.get("code") ?? "";
  if (!/^[A-Za-z0-9.\-]{2,16}$/.test(code)) return NextResponse.json({ error: "bad code" }, { status: 400 });
  try {
    const r = await fetch(BASE + encodeURIComponent(code), { headers: { "User-Agent": UA }, next: { revalidate } });
    if (!r.ok) return NextResponse.json({ error: `HII ${r.status}` }, { status: 502 });
    const raw = (await r.json()) as unknown;
    if (!Array.isArray(raw)) return NextResponse.json({ error: "unexpected shape" }, { status: 502 });
    let bank: number | null = null;
    const points: [number, number][] = [];
    for (const row of raw) {
      if (!Array.isArray(row) || row.length < 2) continue;
      const t = Number(row[0]);
      const v = Number(row[1]);
      if (!Number.isFinite(t) || !Number.isFinite(v) || v === 999999) continue;
      points.push([t, v]);
      const b = Number(row[2]);
      if (Number.isFinite(b) && b !== 999999) bank = b;
    }
    return NextResponse.json(
      { code, points, bank, source: "สสน. ThaiWater (tiwrm.hii.or.th)" },
      { headers: { "Cache-Control": "s-maxage=600, stale-while-revalidate=3600" } },
    );
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "HII failed" }, { status: 502 });
  }
}
