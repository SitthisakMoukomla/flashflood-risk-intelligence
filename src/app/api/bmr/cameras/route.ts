import { NextResponse } from "next/server";

/**
 * Public cameras in the metro region, filtered to the ones that have a
 * picture right now. Two sources:
 *
 * 1. iTIC Foundation / Longdo traffic feed — streets, junctions, highways.
 *    The feed lists ~68 cameras in the region but many are dark: Department
 *    of Highways entries answer their snapshot URL with 0 bytes, and roughly
 *    half the iTIC Motion cameras are offline at any moment. Each snapshot is
 *    probed (in parallel, 15 s cap) and only cameras returning a real JPEG
 *    are published. `live` is the MJPEG stream, used for the selected camera.
 *    iTIC asks that the sponsor text be shown with each camera.
 *
 * 2. BMA Department of Drainage and Sewerage (สนน. กทม.) water-level cameras
 *    — six fixed JPEGs on dds.bangkok.go.th/cctv.php, no stream. The files
 *    are only republished while the department's uplink works (they sat
 *    untouched for a month in Sep 2026), so each is HEAD-probed and kept only
 *    when its Last-Modified is within FRESH_MS. Coordinates are the ones the
 *    department's own page puts on its map.
 *
 * The result is cached for 10 minutes; cameras come and go on that cadence.
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
// A drainage-department JPEG older than this is a stuck uplink, not a picture.
const FRESH_MS = 30 * 60 * 1000;

const DDS_ORG = "สำนักการระบายน้ำ กทม.";
// Names, image paths and map coordinates as published on
// https://dds.bangkok.go.th/cctv.php (cctv1.php … cctv6.php).
const DDS_CAMERAS: { id: string; title: string; path: string; lat: number; lng: number }[] = [
  { id: "dds-1", title: "บางเขนใหม่", path: "/cctv-image/cctv1.jpg", lat: 13.8712025, lng: 100.6009522 },
  { id: "dds-2", title: "สะพานพระปิ่นเกล้า", path: "/cctv-image/cctv2.jpg", lat: 13.7638088, lng: 100.4880244 },
  { id: "dds-3", title: "บางนา", path: "/cctv/cctv3.jpg", lat: 13.66605, lng: 100.5814148 },
  { id: "dds-4", title: "คลองสวนแดน 1", path: "/cctv-image/cctv4.jpg", lat: 13.8504178, lng: 100.2143995 },
  { id: "dds-5", title: "คลองชักพระ", path: "/cctv-image/cctv5.jpg", lat: 13.7626065, lng: 100.4419398 },
  { id: "dds-6", title: "คลองทวีวัฒนา", path: "/cctv-image/cctv6.jpg", lat: 13.7471152, lng: 100.3203025 },
];

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
  /** Who runs it: traffic feed or the drainage department. */
  source: "itic" | "dds";
  /** What it looks at. */
  kind: "traffic" | "water";
  /** When the current picture was taken, if the server says (dds only). */
  capturedAt: string | null;
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

/** Last-Modified of a drainage-department JPEG, or null when stale/unreachable. */
async function freshCapture(url: string, now: number): Promise<string | null> {
  try {
    const r = await fetch(url, { method: "HEAD", headers: { "User-Agent": UA }, cache: "no-store", signal: AbortSignal.timeout(PROBE_MS) });
    if (!r.ok) return null;
    const lm = r.headers.get("last-modified");
    const t = lm ? Date.parse(lm) : NaN;
    if (!Number.isFinite(t) || now - t > FRESH_MS) return null;
    return new Date(t).toISOString();
  } catch {
    return null;
  }
}

async function iticCameras(): Promise<{ candidates: Camera[]; error: string | null }> {
  let items: FeedItem[];
  try {
    const r = await fetch(FEED, { headers: { "User-Agent": UA }, next: { revalidate } });
    if (!r.ok) throw new Error(`feed ${r.status}`);
    items = (await r.json()) as FeedItem[];
  } catch (e) {
    return { candidates: [], error: e instanceof Error ? e.message : "feed failed" };
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
      source: "itic",
      kind: "traffic",
      capturedAt: null,
    });
  }
  return { candidates, error: null };
}

export async function GET() {
  const now = Date.now();
  const itic = await iticCameras();
  const dds: Camera[] = DDS_CAMERAS.map((c) => ({
    id: c.id,
    title: c.title,
    lat: c.lat,
    lng: c.lng,
    org: DDS_ORG,
    sponsor: "",
    snapshot: `https://dds.bangkok.go.th${c.path}`,
    live: null,
    inCity: true,
    source: "dds",
    kind: "water",
    capturedAt: null,
  }));
  const [iticAlive, ddsCaptured] = await Promise.all([
    Promise.all(itic.candidates.map((c) => hasPicture(c.snapshot))),
    Promise.all(dds.map((c) => freshCapture(c.snapshot, now))),
  ]);
  const cameras: Camera[] = [
    ...dds.flatMap((c, i) => (ddsCaptured[i] ? [{ ...c, capturedAt: ddsCaptured[i] }] : [])),
    ...itic.candidates.filter((_, i) => iticAlive[i]),
  ];
  if (itic.error && cameras.length === 0) {
    return NextResponse.json({ error: itic.error }, { status: 502 });
  }
  return NextResponse.json(
    {
      fetchedAt: new Date(now).toISOString(),
      listed: itic.candidates.length + dds.length,
      sources: {
        itic: { listed: itic.candidates.length, live: iticAlive.filter(Boolean).length, error: itic.error },
        dds: { listed: dds.length, live: ddsCaptured.filter(Boolean).length },
      },
      cameras,
      attribution: "กล้อง: มูลนิธิศูนย์ข้อมูลจราจรอัจฉริยะไทย (iTIC) · Longdo · กรมทางหลวง · สำนักการระบายน้ำ กทม.",
    },
    { headers: { "Cache-Control": "s-maxage=600, stale-while-revalidate=3600" } },
  );
}
