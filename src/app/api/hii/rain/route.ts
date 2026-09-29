import { loadThaiWater } from "@/lib/thaiwater-server";

// ThaiWater 24-hour rain feed, memoised server-side (see thaiwater-server).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Upstream is ~4.5 MB (every telemetry field per station), which is also
// Vercel's function response ceiling; keep only what the maps read.
type RainRecord = Record<string, unknown> & { station?: Record<string, unknown> };
function slim(body: string): string {
  const doc = JSON.parse(body) as { data?: RainRecord[] };
  const data = (doc.data ?? []).map((x) => ({
    id: x.id,
    rain_24h: x.rain_24h ?? null,
    rain_1h: x.rain_1h ?? null,
    rainfall_datetime: x.rainfall_datetime,
    agency: { agency_shortname: (x.agency as Record<string, unknown> | undefined)?.agency_shortname },
    geocode: { province_code: (x.geocode as Record<string, unknown> | undefined)?.province_code, province_name: (x.geocode as Record<string, unknown> | undefined)?.province_name },
    station: x.station
      ? { tele_station_name: x.station.tele_station_name, tele_station_lat: x.station.tele_station_lat, tele_station_long: x.station.tele_station_long, tele_station_oldcode: x.station.tele_station_oldcode ?? null }
      : undefined,
  }));
  return JSON.stringify({ data });
}

export async function GET() {
  const r = await loadThaiWater("rain");
  if (!r.ok) return Response.json({ error: r.error }, { status: 502 });
  let body: string;
  try {
    body = slim(r.body);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "bad upstream json" }, { status: 502 });
  }
  return new Response(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": r.stale ? "no-store" : "s-maxage=300, stale-while-revalidate=3600",
      "X-Upstream-At": new Date(r.at).toISOString(),
      ...(r.stale ? { "X-Stale": "1" } : {}),
    },
  });
}
