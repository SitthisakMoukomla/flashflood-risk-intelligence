import { NextResponse } from "next/server";

/**
 * OpenStreetMap Nominatim proxy, restricted to Thailand.
 *
 * Proxied rather than called from the browser so we can:
 *  - send a descriptive User-Agent + Referer (required by Nominatim's usage
 *    policy; anonymous browser calls get blocked),
 *  - cache responses so repeated queries don't hit the 1 req/s limit,
 *  - keep a single origin in the client (no CORS surprises).
 *
 * GET /api/geocode?q=แม่สรวย        → forward search
 * GET /api/geocode?lat=..&lon=..    → reverse geocode
 */

const UA = "FlashfloodRiskIntelligence/1.0 (flashflood-risk-intelligence.vercel.app)";

export const revalidate = 3600;

type NominatimPlace = {
  place_id: number;
  lat: string;
  lon: string;
  display_name: string;
  name?: string;
  type?: string;
  addresstype?: string;
  address?: Record<string, string>;
  boundingbox?: [string, string, string, string];
};

/** Build a short Thai label + a full address line from Nominatim's address parts. */
function shape(p: NominatimPlace) {
  const a = p.address ?? {};
  const primary =
    p.name ||
    a.village ||
    a.hamlet ||
    a.suburb ||
    a.subdistrict ||
    a.town ||
    a.city_district ||
    a.municipality ||
    a.city ||
    a.county ||
    a.state ||
    p.display_name.split(",")[0];

  // Nominatim's Thai hierarchy: subdistrict(ตำบล) → county/city(อำเภอ) → state(จังหวัด)
  const tambon = a.subdistrict ?? a.village ?? a.suburb ?? null;
  const amphoe = a.county ?? a.city_district ?? a.town ?? a.city ?? a.municipality ?? null;
  const province = a.state ?? a.province ?? null;

  const parts = [tambon, amphoe, province].filter(
    (v, i, arr): v is string => Boolean(v) && arr.indexOf(v) === i && v !== primary,
  );

  return {
    id: p.place_id,
    lat: Number(p.lat),
    lon: Number(p.lon),
    label: primary,
    detail: parts.join(" · "),
    full: p.display_name,
    kind: p.addresstype ?? p.type ?? null,
    tambon,
    amphoe,
    province,
  };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q")?.trim();
  const lat = searchParams.get("lat");
  const lon = searchParams.get("lon");

  try {
    if (lat && lon) {
      const url = new URL("https://nominatim.openstreetmap.org/reverse");
      url.searchParams.set("lat", lat);
      url.searchParams.set("lon", lon);
      url.searchParams.set("format", "jsonv2");
      url.searchParams.set("addressdetails", "1");
      url.searchParams.set("accept-language", "th");
      url.searchParams.set("zoom", "14"); // ~subdistrict level

      const r = await fetch(url, {
        headers: { "User-Agent": UA, Referer: "https://flashflood-risk-intelligence.vercel.app" },
        next: { revalidate: 3600 },
      });
      if (!r.ok) throw new Error(`Nominatim reverse ${r.status}`);
      const place = (await r.json()) as NominatimPlace;
      if (!place || !place.lat) {
        return NextResponse.json({ result: null });
      }
      return NextResponse.json(
        { result: shape(place) },
        { headers: { "Cache-Control": "s-maxage=3600, stale-while-revalidate=86400" } },
      );
    }

    if (!q || q.length < 2) {
      return NextResponse.json({ results: [] });
    }

    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("q", q);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("countrycodes", "th"); // Thailand only
    url.searchParams.set("limit", "8");
    url.searchParams.set("accept-language", "th");

    const r = await fetch(url, {
      headers: { "User-Agent": UA, Referer: "https://flashflood-risk-intelligence.vercel.app" },
      next: { revalidate: 3600 },
    });
    if (!r.ok) throw new Error(`Nominatim search ${r.status}`);
    const places = (await r.json()) as NominatimPlace[];

    return NextResponse.json(
      { results: places.map(shape) },
      { headers: { "Cache-Control": "s-maxage=3600, stale-while-revalidate=86400" } },
    );
  } catch (error) {
    return NextResponse.json(
      {
        results: [],
        error: error instanceof Error ? error.message : "geocode failed",
      },
      { status: 502 },
    );
  }
}
