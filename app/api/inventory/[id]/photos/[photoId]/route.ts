import { del, get } from "@vercel/blob";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { syncDataAfterWrite } from "@/lib/data-sync";
import { authenticatePhotoRequest } from "@/lib/photo-auth";
import { retryPhotoCleanup, type StoredInventoryPhoto } from "@/lib/inventory-photo-data";

export const runtime = "nodejs";
const jsonHeaders = { "Cache-Control": "no-store, max-age=0" };
const json = (body: object, status = 200) => NextResponse.json(body, { status, headers: jsonHeaders });

export async function GET(request: NextRequest, context: { params: Promise<{ id: string; photoId: string }> }) {
  const claims = authenticatePhotoRequest(request);
  if (!claims) return json({ error: "ფოტოს სანახავად ავტორიზაცია საჭიროა." }, 401);
  try {
    const { id, photoId } = await context.params;
    const photo = db.prepare("SELECT * FROM inventory_photos WHERE id=? AND inventory_id=?").get(Number(photoId), Number(id)) as StoredInventoryPhoto | undefined;
    if (!photo) return json({ error: "ფოტო ვერ მოიძებნა." }, 404);
    const blob = await get(photo.blob_path, { access: "private", useCache: false });
    if (!blob?.stream) return json({ error: "ფოტო ვერ მოიძებნა." }, 404);
    return new NextResponse(blob.stream, { headers: { "Cache-Control": "private, max-age=300", "Content-Length": String(blob.blob.size), "Content-Type": "image/jpeg", "ETag": blob.blob.etag, "Vary": "Authorization", "X-Content-Type-Options": "nosniff" } });
  } catch (error) {
    console.error("EUROCAP photo read failed", error);
    return json({ error: "ფოტოს წაკითხვა ვერ მოხერხდა." }, 500);
  }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string; photoId: string }> }) {
  const claims = authenticatePhotoRequest(request);
  if (!claims) return json({ error: "ფოტოს წასაშლელად ავტორიზაცია საჭიროა." }, 401);
  if (process.env.VERCEL_ENV === "preview") return json({ error: "Preview გარემო მხოლოდ წაკითხვისთვისაა." }, 403);
  try {
    const { id, photoId } = await context.params;
    await retryPhotoCleanup(db);
    const inventoryId = Number(id);
    const photo = db.prepare(`SELECT p.*,i.archived_at FROM inventory_photos p JOIN inventory i ON i.id=p.inventory_id
      WHERE p.id=? AND p.inventory_id=?`).get(Number(photoId), inventoryId) as (StoredInventoryPhoto & { archived_at: string | null }) | undefined;
    if (!photo) return json({ error: "ფოტო ვერ მოიძებნა." }, 404);
    if (photo.archived_at) return json({ error: "დაარქივებული ჩანაწერის ფოტოს წაშლა შეუძლებელია." }, 400);
    const now = new Date().toISOString();
    const historyId = db.transaction(() => {
      db.prepare("DELETE FROM inventory_photos WHERE id=?").run(photo.id);
      db.prepare("INSERT OR REPLACE INTO photo_cleanup_queue (blob_path,created_at,attempts,last_error) VALUES (?,?,0,NULL)").run(photo.blob_path, now);
      const result = db.prepare("INSERT INTO item_history (inventory_id,action,details,reference_type,reference_id,operator_email,created_at) VALUES (?,?,?,?,?,?,?)")
        .run(inventoryId, "ფოტოს წაშლა", `${photo.filename}, SHA-256: ${photo.sha256}`, "photo", photo.id, claims.email, now);
      return Number(result.lastInsertRowid);
    })();
    try { await syncDataAfterWrite(); }
    catch (error) {
      db.transaction(() => {
        db.prepare(`INSERT INTO inventory_photos (id,inventory_id,blob_path,filename,original_name,width,height,byte_size,content_type,uploader,uploaded_at,sha256,sort_order)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(photo.id, photo.inventory_id, photo.blob_path, photo.filename, photo.original_name, photo.width, photo.height, photo.byte_size, photo.content_type, photo.uploader, photo.uploaded_at, photo.sha256, photo.sort_order);
        db.prepare("DELETE FROM photo_cleanup_queue WHERE blob_path=?").run(photo.blob_path);
        db.prepare("DELETE FROM item_history WHERE id=?").run(historyId);
      })();
      throw error;
    }
    let cleanupPending = false;
    try {
      await del(photo.blob_path);
      db.prepare("DELETE FROM photo_cleanup_queue WHERE blob_path=?").run(photo.blob_path);
      try { await syncDataAfterWrite(); } catch (syncError) { console.error("EUROCAP photo cleanup snapshot sync failed", syncError); }
    } catch (error) {
      cleanupPending = true;
      db.prepare("UPDATE photo_cleanup_queue SET attempts=attempts+1,last_error=? WHERE blob_path=?").run(error instanceof Error ? error.message.slice(0, 500) : "Unknown error", photo.blob_path);
      console.error("EUROCAP photo Blob deletion failed", error);
    }
    return json({ ok: true, cleanupPending });
  } catch (error) {
    console.error("EUROCAP photo deletion failed", error);
    return json({ error: "ფოტოს წაშლა ვერ მოხერხდა." }, 500);
  }
}
