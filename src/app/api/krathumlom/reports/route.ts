import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { BlobNotFoundError, BlobPreconditionFailedError, get, put } from "@vercel/blob";
import { validateReportInput, type Report, type ReportStatus } from "@/lib/reports";

/**
 * Staff-reported flood points for /krathumlom.
 *
 *   GET    /api/krathumlom/reports           → { reports }
 *   POST   /api/krathumlom/reports  {input}  → { report, reports }
 *   PATCH  /api/krathumlom/reports  {id, status?, note?, depth_cm?}
 *   DELETE /api/krathumlom/reports?id=…
 *
 * Every call carries `x-staff-code`, compared in constant time against
 * KRATHUMLOM_STAFF_CODE. The whole list lives in one private blob; writes
 * re-read it and send the ETag back with `ifMatch`, retrying on a clash,
 * so concurrent saves from two phones both land.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BLOB_PATH = "krathumlom/reports.json";
const MAX_REPORTS = 5000;

type Doc = { reports: Report[] };

function unauthorized(reason: string, status = 401) {
  return NextResponse.json({ error: reason }, { status });
}

/** null when the code is right; a response to return otherwise. */
function checkStaff(request: Request): NextResponse | null {
  const expected = process.env.KRATHUMLOM_STAFF_CODE;
  if (!expected) return unauthorized("ยังไม่ได้ตั้งรหัสเจ้าหน้าที่บนเซิร์ฟเวอร์ (KRATHUMLOM_STAFF_CODE)", 503);
  const given = request.headers.get("x-staff-code") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return unauthorized("รหัสเจ้าหน้าที่ไม่ถูกต้อง");
  return null;
}

async function readDoc(): Promise<{ doc: Doc; etag: string | null }> {
  try {
    const res = await get(BLOB_PATH, { access: "private", useCache: false });
    if (!res || res.statusCode !== 200) return { doc: { reports: [] }, etag: null };
    const text = await new Response(res.stream).text();
    const parsed = JSON.parse(text) as Partial<Doc>;
    return { doc: { reports: Array.isArray(parsed.reports) ? parsed.reports : [] }, etag: res.blob.etag };
  } catch (e) {
    if (e instanceof BlobNotFoundError) return { doc: { reports: [] }, etag: null };
    throw e;
  }
}

/** Read → mutate → conditional write, retried when someone else wrote in between. */
async function mutate(fn: (doc: Doc) => Doc | NextResponse): Promise<{ doc: Doc } | NextResponse> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { doc, etag } = await readDoc();
    const next = fn(structuredClone(doc));
    if (next instanceof NextResponse) return next;
    try {
      await put(BLOB_PATH, JSON.stringify(next), {
        access: "private",
        contentType: "application/json",
        addRandomSuffix: false,
        allowOverwrite: true,
        cacheControlMaxAge: 60,
        ...(etag ? { ifMatch: etag } : {}),
      });
      return { doc: next };
    } catch (e) {
      if (e instanceof BlobPreconditionFailedError) continue;
      throw e;
    }
  }
  return NextResponse.json({ error: "มีการบันทึกชนกัน ลองใหม่อีกครั้ง" }, { status: 409 });
}

function fail(e: unknown) {
  const msg = e instanceof Error ? e.message : "storage error";
  return NextResponse.json({ error: msg }, { status: 502 });
}

export async function GET(request: Request) {
  const denied = checkStaff(request);
  if (denied) return denied;
  try {
    const { doc } = await readDoc();
    return NextResponse.json(doc, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(request: Request) {
  const denied = checkStaff(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON ไม่ถูกต้อง" }, { status: 400 });
  }
  const v = validateReportInput(body);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
  const now = new Date().toISOString();
  const report: Report = { id: crypto.randomUUID(), ...v.value, status: "open", created_at: now, updated_at: now };
  try {
    const out = await mutate((doc) => {
      if (doc.reports.length >= MAX_REPORTS) return NextResponse.json({ error: "จำนวนรายงานเต็มแล้ว" }, { status: 507 });
      doc.reports.unshift(report);
      return doc;
    });
    if (out instanceof NextResponse) return out;
    return NextResponse.json({ report, reports: out.doc.reports }, { status: 201 });
  } catch (e) {
    return fail(e);
  }
}

export async function PATCH(request: Request) {
  const denied = checkStaff(request);
  if (denied) return denied;
  let body: { id?: string; status?: ReportStatus; note?: string; depth_cm?: number | null; title?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON ไม่ถูกต้อง" }, { status: 400 });
  }
  if (!body.id) return NextResponse.json({ error: "ต้องระบุ id" }, { status: 400 });
  if (body.status !== undefined && body.status !== "open" && body.status !== "resolved")
    return NextResponse.json({ error: "สถานะไม่ถูกต้อง" }, { status: 400 });
  try {
    const out = await mutate((doc) => {
      const r = doc.reports.find((x) => x.id === body.id);
      if (!r) return NextResponse.json({ error: "ไม่พบรายงาน" }, { status: 404 });
      if (body.status !== undefined) r.status = body.status;
      if (typeof body.note === "string") r.note = body.note.trim().slice(0, 1000);
      if (typeof body.title === "string" && body.title.trim().length >= 2) r.title = body.title.trim().slice(0, 120);
      if (body.depth_cm === null) r.depth_cm = null;
      else if (typeof body.depth_cm === "number" && Number.isFinite(body.depth_cm) && body.depth_cm >= 0 && body.depth_cm <= 500)
        r.depth_cm = Math.round(body.depth_cm);
      r.updated_at = new Date().toISOString();
      return doc;
    });
    if (out instanceof NextResponse) return out;
    return NextResponse.json({ reports: out.doc.reports });
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(request: Request) {
  const denied = checkStaff(request);
  if (denied) return denied;
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "ต้องระบุ id" }, { status: 400 });
  try {
    const out = await mutate((doc) => {
      const before = doc.reports.length;
      doc.reports = doc.reports.filter((x) => x.id !== id);
      if (doc.reports.length === before) return NextResponse.json({ error: "ไม่พบรายงาน" }, { status: 404 });
      return doc;
    });
    if (out instanceof NextResponse) return out;
    return NextResponse.json({ reports: out.doc.reports });
  } catch (e) {
    return fail(e);
  }
}
