import { loadThaiWater } from "@/lib/thaiwater-server";

// ThaiWater water-level feed (803 stations, ~1.3 MB), memoised server-side.
// Same JSON shape as upstream so clients parse it the same way.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const r = await loadThaiWater("waterlevel");
  if (!r.ok) return Response.json({ error: r.error }, { status: 502 });
  return new Response(r.body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": r.stale ? "no-store" : "s-maxage=300, stale-while-revalidate=3600",
      "X-Upstream-At": new Date(r.at).toISOString(),
      ...(r.stale ? { "X-Stale": "1" } : {}),
    },
  });
}
