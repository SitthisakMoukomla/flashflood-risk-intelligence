import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { BlobNotFoundError, get, put } from "@vercel/blob";

/**
 * Photos attached to staff reports.
 *
 *   POST /api/krathumlom/photos   (multipart, field `photo`, x-staff-code) → { id }
 *   GET  /api/krathumlom/photos?id=…                                         → image
 *
 * Uploads need the staff code. Viewing needs only the id — an <img> tag
 * cannot send headers — and ids are random 128-bit values, so a photo is
 * reachable only from the report that references it. The browser resizes
 * before upload (see the dashboard), so the server caps at 3 MB.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 3 * 1024 * 1024;
const TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

function staffOk(request: Request): boolean {
  const expected = process.env.KRATHUMLOM_STAFF_CODE;
  if (!expected) return false;
  const a = Buffer.from(request.headers.get("x-staff-code") ?? "");
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  if (!process.env.KRATHUMLOM_STAFF_CODE) return NextResponse.json({ error: "ยังไม่ได้ตั้งรหัสเจ้าหน้าที่" }, { status: 503 });
  if (!staffOk(request)) return NextResponse.json({ error: "รหัสเจ้าหน้าที่ไม่ถูกต้อง" }, { status: 401 });
  const form = await request.formData();
  const file = form.get("photo");
  if (!(file instanceof File)) return NextResponse.json({ error: "ไม่มีไฟล์รูป" }, { status: 400 });
  const ext = TYPES[file.type];
  if (!ext) return NextResponse.json({ error: "รองรับเฉพาะ JPEG, PNG, WebP" }, { status: 415 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "รูปใหญ่เกิน 3 MB" }, { status: 413 });
  const id = crypto.randomUUID();
  try {
    await put(`krathumlom/photos/${id}.${ext}`, file, {
      access: "private",
      contentType: file.type,
      addRandomSuffix: false,
      cacheControlMaxAge: 31536000,
    });
    return NextResponse.json({ id }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "upload failed" }, { status: 502 });
  }
}

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!/^[a-z0-9-]{8,64}$/.test(id)) return new NextResponse("bad id", { status: 400 });
  for (const ext of Object.values(TYPES)) {
    try {
      const res = await get(`krathumlom/photos/${id}.${ext}`, { access: "private" });
      if (!res || res.statusCode !== 200) continue;
      return new NextResponse(res.stream, {
        headers: {
          "Content-Type": res.blob.contentType,
          "Cache-Control": "private, max-age=86400",
        },
      });
    } catch (e) {
      if (e instanceof BlobNotFoundError) continue;
      return new NextResponse("storage error", { status: 502 });
    }
  }
  return new NextResponse("not found", { status: 404 });
}
