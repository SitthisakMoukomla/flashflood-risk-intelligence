import { NextResponse } from "next/server";

/**
 * Public traffic cameras in the metro region, from the iTIC Foundation /
 * Longdo feed, filtered to the ones that have a picture right now.
 *
 * The feed lists 68 cameras in the region but many are dark: Department of
 * Highways entries answer their snapshot URL with 0 bytes, and roughly half
 * the iTIC Motion cameras are offline at any moment. Each snapshot is
 * probed here (in parallel, 15 s cap) and only cameras returning a real JPEG
 * are published, so the page never shows a grid of broken images. The
 * result is cached for 10 minutes; cameras come and go on that cadence.
 *
 * `live` is the camera's MJPEG stream (multipart/x-mixed-replace), which a
 * plain <img> renders as moving video — used for the selected camera only.
 *
 * iTIC asks that the sponsor text be shown with each camera.
 */

export const runtime = "nodejs";
export const revalidate = 600;
export const maxDuration = 40;

const FEED = "https://camera.longdo.com/feed/?command=json";
const UA = "FlashfloodRiskIntelligence/1.0 (flashflood-risk-intelligence.vercel.app)";
// Bangkok Metropolitan Region (6 provinces) bounding box, from GADM.
const BBOX = { w: 99.831, s: 13.425, e: 100.964, n: 14.273 };
// Generous: the camera relay is in Thailand and slow to first byte from afar.
const PROBE_MS = 15000;
const MIN_JPEG_BYTES = 1000;

export type Camera = {
  id: string;
  title: string;
  lat: number;
  lng: number;
  org: string;
  sponsor: string;
  snapshot: string;
  live: string | null;
  inCity: boolean;
};

type FeedItem = {
  title?: string;
  camid?: string;
  latitude?: string;
  longitude?: string;
  incity?: string;
  organization?: string;
  sponsertext?: string;
  imgurl?: string;
  vdourl?: string;
};

async function hasPicture(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, cache: "no-store", signal: AbortSignal.timeout(PROBE_MS) });
    if (!r.ok) return false;
    const buf = new Uint8Array(await r.arrayBuffer());
    return buf.length >= MIN_JPEG_BYTES && buf[0] === 0xff && buf[1] === 0xd8;
  } catch {
    return false;
  }
}

export async function GET() {
  let items: FeedItem[];
  try {
    const r = await fetch(FEED, { headers: { "User-Agent": UA }, next: { revalidate } });
    if (!r.ok) throw new Error(`feed ${r.status}`);
    items = (await r.json()) as FeedItem[];
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "feed failed" }, { status: 502 });
  }
  const candidates: Camera[] = [];
  for (const c of items) {
    const lat = Number(c.latitude);
    const lng = Number(c.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (lat < BBOX.s || lat > BBOX.n || lng < BBOX.w || lng > BBOX.e) continue;
    if (!c.imgurl || /X\.X\.X\.X/.test(c.imgurl) || !c.camid) continue;
    candidates.push({
      id: c.camid,
      title: (c.title ?? "").replace(/^\([^)]*\)\s*/, "").trim(),
      lat,
      lng,
      org: c.organization ?? "",
      sponsor: c.sponsertext ?? "",
      snapshot: c.imgurl,
      live: c.vdourl && /mjpeg/.test(c.vdourl) ? c.vdourl : null,
      inCity: c.incity === "Y",
    });
  }
  const alive = await Promise.all(candidates.map((c) => hasPicture(c.snapshot)));
  const cameras = candidates.filter((_, i) => alive[i]);
  return NextResponse.json(
    {
      fetchedAt: new Date().toISOString(),
      listed: candidates.length,
      cameras,
      attribution: "กล้อง: มูลนิธิศูนย์ข้อมูลจราจรอัจฉริยะไทย (iTIC) · Longdo · กรมทางหลวง",
    },
    { headers: { "Cache-Control": "s-maxage=600, stale-while-revalidate=3600" } },
  );
}
