import { NextResponse } from "next/server";

/**
 * Public traffic cameras in the metro region, from the iTIC Foundation /
 * Longdo feed (Department of Highways + iTIC Motion). Each camera exposes a
 * JPEG snapshot the browser can load directly. Placeholder entries (camid
 * "X.X.X.X:YYYY") and cameras outside the metro bounding box are dropped.
 *
 * iTIC asks that the sponsor text be shown with each camera; it is passed
 * through as `sponsor` for the UI to display.
 */

export const runtime = "nodejs";
export const revalidate = 1800;

const FEED = "https://camera.longdo.com/feed/?command=json";
const UA = "FlashfloodRiskIntelligence/1.0 (flashflood-risk-intelligence.vercel.app)";
// Bangkok Metropolitan Region (6 provinces) bounding box, from GADM.
const BBOX = { w: 99.831, s: 13.425, e: 100.964, n: 14.273 };

export type Camera = {
  id: string;
  title: string;
  lat: number;
  lng: number;
  org: string;
  sponsor: string;
  snapshot: string;
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
};

export async function GET() {
  let items: FeedItem[];
  try {
    const r = await fetch(FEED, { headers: { "User-Agent": UA }, next: { revalidate } });
    if (!r.ok) throw new Error(`feed ${r.status}`);
    items = (await r.json()) as FeedItem[];
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "feed failed" }, { status: 502 });
  }
  const cameras: Camera[] = [];
  for (const c of items) {
    const lat = Number(c.latitude);
    const lng = Number(c.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (lat < BBOX.s || lat > BBOX.n || lng < BBOX.w || lng > BBOX.e) continue;
    if (!c.imgurl || /X\.X\.X\.X/.test(c.imgurl) || !c.camid) continue;
    cameras.push({
      id: c.camid,
      title: (c.title ?? "").replace(/^\([^)]*\)\s*/, "").trim(),
      lat,
      lng,
      org: c.organization ?? "",
      sponsor: c.sponsertext ?? "",
      snapshot: c.imgurl,
      inCity: c.incity === "Y",
    });
  }
  return NextResponse.json(
    { fetchedAt: new Date().toISOString(), cameras, attribution: "กล้อง: มูลนิธิศูนย์ข้อมูลจราจรอัจฉริยะไทย (iTIC) · Longdo · กรมทางหลวง" },
    { headers: { "Cache-Control": "s-maxage=1800, stale-while-revalidate=86400" } },
  );
}
