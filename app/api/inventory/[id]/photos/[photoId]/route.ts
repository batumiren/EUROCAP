import { get } from "@vercel/blob";
import { NextRequest, NextResponse } from "next/server";
import { db, getOperator } from "@/lib/db";
import { AppError } from "@/lib/services";
import { retryPhotoCleanup, type StoredInventoryPhoto } from "@/lib/inventory-photo-data";

export const runtime = "nodejs";
const jsonHeaders = { "Cache-Control": "no-store, max-age=0" };
const json = (body: object, status = 200) => NextResponse.json(body, { status, headers: jsonHeaders });

export async function GET(request: NextRequest, context: { params: Promise<{ id: string; photoId: string }> }) {
  try {
    const { id, photoId } = await context.params;
    const photo = await db.prepare("SELECT * FROM inventory_photos WHERE id=? AND inventory_id=?").get(Number(photoId), Number(id)) as StoredInventoryPhoto | undefined;
    if (!photo) return json({ error: "ფოტო ვერ მოიძებნა." }, 404);
    const etag = `"${photo.sha256}"`;
    const headers = { "Cache-Control": "private, no-cache", "ETag": etag, "Vary": "Cookie", "X-Content-Type-Options": "nosniff" };
    if (request.headers.get("if-none-match")?.split(",").some(value => value.trim().replace(/^W\//, "") === etag)) {
      return new NextResponse(null, { status: 304, headers });
    }
    // UUID-suffixed upload keys are immutable. Older keys could have been reused.
    const immutable = /-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.jpg$/i.test(photo.blob_path);
    const previewToken = process.env.VERCEL_ENV === "preview" ? process.env.PREVIEW_BLOB_READ_WRITE_TOKEN : undefined;
    if (process.env.VERCEL_ENV === "preview" && !previewToken) return json({ error: "Preview ფოტოების საცავი არ არის კონფიგურირებული." }, 503);
    const blob = await get(photo.blob_path, { access: "private", useCache: immutable, ...(previewToken ? { token: previewToken } : {}) });
    if (!blob?.stream) return json({ error: "ფოტო ვერ მოიძებნა." }, 404);
    return new NextResponse(blob.stream, { headers: { ...headers, "Content-Length": String(blob.blob.size), "Content-Type": "image/jpeg" } });
  } catch (error) {
    console.error("EUROCAP photo read failed", error);
    return json({ error: "ფოტოს წაკითხვა ვერ მოხერხდა." }, 500);
  }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string; photoId: string }> }) {
  if (process.env.VERCEL_ENV === "preview") return json({ error: "Preview გარემო მხოლოდ წაკითხვისთვისაა." }, 403);
  try {
    const { id, photoId } = await context.params;
    await retryPhotoCleanup(db);
    const inventoryId = Number(id);
    await db.transaction(async db => {
      const photo = await db.prepare(`SELECT p.*,i.archived_at FROM inventory_photos p JOIN inventory i ON i.id=p.inventory_id
        WHERE p.id=? AND p.inventory_id=?`).get(Number(photoId), inventoryId);
      if (!photo) throw new AppError("ფოტო ვერ მოიძებნა.", 404);
      if (photo.archived_at) throw new AppError("დაარქივებული ჩანაწერის ფოტოს წაშლა შეუძლებელია.");
      const operator = await getOperator(db);
      const now = new Date().toISOString();
      await db.prepare("DELETE FROM inventory_photos WHERE id=?").run(photo.id);
      await db.prepare("INSERT INTO photo_cleanup_queue (blob_path,created_at) VALUES (?,?) ON CONFLICT (blob_path) DO NOTHING").run(photo.blob_path, now);
      await db.prepare("INSERT INTO item_history (inventory_id,action,details,reference_type,reference_id,operator_email,created_at) VALUES (?,?,?,?,?,?,?)")
        .run(inventoryId, "ფოტოს წაშლა", photo.filename, "photo", photo.id, operator.operator_email, now);
    });
    try { await retryPhotoCleanup(db); } catch { console.error("Photo cleanup deferred"); }
    return json({ ok: true });
  } catch (error) {
    if (error instanceof AppError) return json({ error: error.message }, error.status);
    console.error("EUROCAP photo deletion failed", error);
    return json({ error: "ფოტოს წაშლა ვერ მოხერხდა." }, 500);
  }
}
