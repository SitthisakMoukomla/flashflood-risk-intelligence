import { NextResponse } from "next/server";
import { loadKlongMap } from "@/lib/klongmap-server";

// Thin HTTP face over lib/klongmap-server (memo + stale handling live there).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const r = await loadKlongMap();
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 502 });
  if (r.stale) return NextResponse.json({ ...r.payload, stale: true }, { headers: { "Cache-Control": "no-store" } });
  return NextResponse.json(r.payload, { headers: { "Cache-Control": "s-maxage=300, stale-while-revalidate=3600" } });
}
