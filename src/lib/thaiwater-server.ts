import { THAIWATER_RAIN_24H_URL, THAIWATER_WATERLEVEL_URL } from "./thaiwater";

/**
 * Server-side memo in front of ThaiWater's public feeds. Browsers used to
 * call api-v3.thaiwater.net directly; the feed rate-limits per IP (429), so
 * a few reloads — or a few dozen viewers behind one NAT — went dark. One
 * upstream call per FRESH_MS per function instance instead, and the last
 * good copy is kept for STALE_MS if ThaiWater is down or limiting us.
 */

const UA = "FlashfloodRiskIntelligence/1.0 (flashflood-risk-intelligence.vercel.app)";
const FRESH_MS = 5 * 60_000;
const STALE_MS = 60 * 60_000;

export type Feed = "waterlevel" | "rain";
const URLS: Record<Feed, string> = { waterlevel: THAIWATER_WATERLEVEL_URL, rain: THAIWATER_RAIN_24H_URL };

type Memo = { at: number; body: string };
const memo: Partial<Record<Feed, Memo>> = {};

export type FeedResult = { ok: true; body: string; stale: boolean; at: number } | { ok: false; error: string };

export async function loadThaiWater(feed: Feed): Promise<FeedResult> {
  const now = Date.now();
  const m = memo[feed];
  if (m && now - m.at < FRESH_MS) return { ok: true, body: m.body, stale: false, at: m.at };
  try {
    const r = await fetch(URLS[feed], { headers: { "User-Agent": UA }, cache: "no-store", signal: AbortSignal.timeout(40_000) });
    if (!r.ok) throw new Error(`thaiwater ${r.status}`);
    const body = await r.text();
    // Guard against a 200 that is not the feed (maintenance page etc.).
    if (!body.startsWith("{")) throw new Error("thaiwater: not JSON");
    memo[feed] = { at: now, body };
    return { ok: true, body, stale: false, at: now };
  } catch (e) {
    if (m && now - m.at < STALE_MS) return { ok: true, body: m.body, stale: true, at: m.at };
    return { ok: false, error: e instanceof Error ? e.message : "thaiwater failed" };
  }
}
