import { NextResponse } from "next/server";
import { bmaDate, bmaStatus, num, threshold, type BmaGauge, type BmaPayload, type BmaTide } from "@/lib/bma";

/**
 * BMA canal gauges + today's tide table, slimmed from the 2.7 MB KlongMap
 * relay.
 *
 * The relay payload is over Next's 2 MB data-cache limit, so the slimmed
 * result is memoised here for 5 minutes (per function instance) and the
 * response carries s-maxage for the CDN. If the relay is down, the last
 * good copy is served for up to an hour with `stale: true`, after which
 * the route answers 502 and the page keeps whatever it last showed.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RELAY = "https://flood69.peoplesparty.or.th/api/klongmap";
const UA = "FlashfloodRiskIntelligence/1.0 (flashflood-risk-intelligence.vercel.app)";
const FRESH_MS = 5 * 60_000;
const STALE_MS = 60 * 60_000;
let memo: { at: number; payload: BmaPayload } | null = null;

type RelayStation = {
  water_station_info?: Record<string, unknown>;
  water_level_last?: Record<string, unknown>;
};
type RelayDoc = { waterStation?: RelayStation[]; dailyheightwater?: unknown };

function tideRow(d: Record<string, unknown>): BmaTide {
  return {
    date: bmaDate(d.date_stamp) ?? "",
    highTime: bmaDate(d.daily_time),
    high: num(d.hight_water),
    lowTime: bmaDate(d.daily_time_low),
    low: num(d.low_water),
    nightTime: bmaDate(d.night_time),
    nightHigh: num(d.hight_water_pm),
    nightLowTime: bmaDate(d.night_time_low),
    nightLow: num(d.low_water_pm),
  };
}

export async function GET() {
  const nowMs = Date.now();
  if (memo && nowMs - memo.at < FRESH_MS) {
    return NextResponse.json(memo.payload, { headers: { "Cache-Control": "s-maxage=300, stale-while-revalidate=3600" } });
  }
  let raw: RelayDoc;
  try {
    const r = await fetch(RELAY, { headers: { "User-Agent": UA }, cache: "no-store", signal: AbortSignal.timeout(25_000) });
    if (!r.ok) throw new Error(`relay ${r.status}`);
    raw = (await r.json()) as RelayDoc;
  } catch (e) {
    if (memo && nowMs - memo.at < STALE_MS) {
      return NextResponse.json({ ...memo.payload, stale: true }, { headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : "relay failed" }, { status: 502 });
  }

  const seen = new Set<string>();
  const gauges: BmaGauge[] = [];
  let newest = 0;
  for (const s of raw.waterStation ?? []) {
    const info = s.water_station_info ?? {};
    const last = s.water_level_last ?? {};
    const code = String(info.water_code ?? "");
    const lat = num(info.latitude);
    const lng = num(info.longitude);
    if (!code || seen.has(code) || lat === null || lng === null) continue;
    seen.add(code);
    const name = String(info.water_name ?? code);
    const kind: BmaGauge["kind"] = /ประตูระบายน้ำ|ปตร\.|สถานีสูบ/.test(name) ? "gate" : "gauge";
    const level = num(last.wl_in);
    // Outside-the-gate level only means something at a gate; plain gauges
    // carry 0 in that field.
    const levelOut = kind === "gate" ? (num(last.wl_out01) ?? num(last.wl_out02)) : null;
    let warning = threshold(num(info.warning));
    let critical = threshold(num(info.critical));
    if (warning !== null && critical !== null && critical < warning) warning = critical = null;
    const banks = [num(info.left_bank), num(info.right_bank)].filter((v): v is number => v !== null && v > 0);
    const bank = banks.length ? Math.min(...banks) : null;
    const time = bmaDate(last.site_timestamp);
    const t = time ? Date.parse(time) : NaN;
    // A few loggers run a little ahead of true time; never report a
    // negative age, and don't let one fast clock define the payload time.
    if (Number.isFinite(t) && t <= nowMs) newest = Math.max(newest, t);
    gauges.push({
      code,
      name,
      lat,
      lng,
      kind,
      level,
      levelOut,
      warning,
      critical,
      bank,
      maxToday: num(last.max_in_day),
      time,
      ageMin: Number.isFinite(t) ? Math.max(0, Math.round((nowMs - t) / 60000)) : null,
      // A reading older than a day says nothing about now — a few loggers
      // have been silent for months and would otherwise sit at "critical".
      status: Number.isFinite(t) && nowMs - t > 24 * 3600_000 ? "unknown" : bmaStatus(level, warning, critical, bank),
      overCritical: level !== null && critical !== null ? Math.round((level - critical) * 100) / 100 : null,
    });
  }

  // The relay serialises the tide table as today's single row (an object),
  // though it may one day become a list — accept both.
  const th = raw.dailyheightwater;
  const tide: BmaTide[] = Array.isArray(th)
    ? (th as Record<string, unknown>[]).map(tideRow)
    : th && typeof th === "object" && "date_stamp" in (th as object)
      ? [tideRow(th as Record<string, unknown>)]
      : [];

  const payload: BmaPayload = {
    fetchedAt: new Date(nowMs).toISOString(),
    sourceAt: newest ? new Date(newest).toISOString() : null,
    gauges,
    tide,
    attribution: "สำนักการระบายน้ำ กทม. (KlongMap) ผ่าน relay flood69.peoplesparty.or.th",
  };
  memo = { at: nowMs, payload };
  return NextResponse.json(payload, {
    headers: { "Cache-Control": "s-maxage=300, stale-while-revalidate=3600" },
  });
}
