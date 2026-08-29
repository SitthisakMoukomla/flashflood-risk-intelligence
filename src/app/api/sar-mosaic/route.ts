import { NextResponse } from "next/server";

/**
 * Registers a Sentinel-1 GRD mosaic on Microsoft Planetary Computer and
 * hands the frontend an XYZ template for it.
 *
 * The flood layer shows a derived mask; this shows the radar itself, so a
 * user can see whether a blue polygon sits on a river or on a field. PC's
 * mosaic endpoint needs a `searchid` registered from a CQL2 query, and
 * those ids are not permanent, so we re-register on a cadence rather than
 * hardcoding one.
 *
 * No key or account is involved — sentinel-1-grd is an open collection.
 */

const REGISTER = "https://planetarycomputer.microsoft.com/api/data/v1/mosaic/register";
const TILE_BASE = "https://planetarycomputer.microsoft.com/api/data/v1/mosaic";
// Thailand plus a margin, matching the rest of the app's extent.
const BBOX = [97.2, 5.5, 105.8, 20.6];
// A week: Sentinel-1 revisits a given place every 1-3 days, so a shorter
// window leaves holes and a longer one buries the recent passes.
const WINDOW_DAYS = 7;

export const revalidate = 3600; // re-register hourly; ids outlive that comfortably

export async function GET() {
  const end = new Date();
  const start = new Date(end.getTime() - WINDOW_DAYS * 86400_000);
  const body = {
    collections: ["sentinel-1-grd"],
    bbox: BBOX,
    datetime: `${start.toISOString()}/${end.toISOString()}`,
    "filter-lang": "cql2-json",
    filter: { op: "=", args: [{ property: "sar:instrument_mode" }, "IW"] },
    sortby: [{ field: "datetime", direction: "desc" }],
  };

  try {
    const reg = await fetch(REGISTER, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      next: { revalidate },
    });
    if (!reg.ok) {
      return NextResponse.json(
        { error: `register failed: ${reg.status}` },
        { status: 502 },
      );
    }
    const json = (await reg.json()) as { searchid?: string; id?: string };
    const searchId = json.searchid ?? json.id;
    if (!searchId) {
      return NextResponse.json({ error: "no searchid returned" }, { status: 502 });
    }

    // VV backscatter, 0-600 stretched to grey: open water goes near-black
    // because a smooth surface reflects the pulse away from the sensor.
    const params = new URLSearchParams({
      collection: "sentinel-1-grd",
      assets: "vv",
      rescale: "0,600",
      colormap_name: "gray",
    });
    return NextResponse.json({
      searchId,
      tileUrl: `${TILE_BASE}/${searchId}/tiles/WebMercatorQuad/{z}/{x}/{y}@1x?${params}`,
      windowDays: WINDOW_DAYS,
      generatedAt: new Date().toISOString(),
      attribution: "Sentinel-1 GRD · Microsoft Planetary Computer",
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "register failed" },
      { status: 502 },
    );
  }
}
