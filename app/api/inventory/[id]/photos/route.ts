import { createHash } from "node:crypto";
import { BlobPreconditionFailedError, del, put } from "@vercel/blob";
import sharp from "sharp";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { syncDataAfterWrite } from "@/lib/data-sync";
import { authenticatePhotoRequest } from "@/lib/photo-auth";
import { listInventoryPhotos, photoBlobPath, retryPhotoCleanup, toPhotoMetadata } from "@/lib/inventory-photo-data";

export const runtime = "nodejs";
const jsonHeaders = { "Cache-Control": "no-store, max-age=0" };
const json = (body: object, status = 200) => NextResponse.json(body, { status, headers: jsonHeaders });

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const claims = authenticatePhotoRequest(request);
  if (!claims) return json({ error: "ფოტოების სანახავად ავტორიზაცია საჭიროა." }, 401);
  const inventoryId = Number((await context.params).id);
  const item = db.prepare("SELECT id FROM inventory WHERE id=?").get(inventoryId);
  if (!item) return json({ error: "ინვენტარის ჩანაწერი ვერ მოიძებნა." }, 404);
  return json({ photos: listInventoryPhotos(db, inventoryId).map(toPhotoMetadata) });
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const claims = authenticatePhotoRequest(request);
  if (!claims) return json({ error: "ფოტოს ატვირთვისთვის ავტორიზაცია საჭიროა." }, 401);
  if (process.env.VERCEL_ENV === "preview") return json({ error: "Preview გარემო მხოლოდ წაკითხვისთვისაა." }, 403);
  let uploadedPath = "";
  let photoId = 0;
  try {
    const inventoryId = Number((await context.params).id);
    await retryPhotoCleanup(db);
    const item = db.prepare("SELECT * FROM inventory WHERE id=?").get(inventoryId) as Record<string, any> | undefined;
    if (!item) return json({ error: "ინვენტარის ჩანაწერი ვერ მოიძებნა." }, 404);
    if (item.archived_at) return json({ error: "დაარქივებულ ჩანაწერზე ფოტოს დამატება შეუძლებელია." }, 400);
    const currentPhotos = listInventoryPhotos(db, inventoryId);
    if (currentPhotos.length >= 30) return json({ error: "ერთ ნივთზე მაქსიმუმ 30 ფოტოს ატვირთვა შეიძლება." }, 400);

    const form = await request.formData();
    const file = form.get("photo");
    const width = Number(form.get("width"));
    const height = Number(form.get("height"));
    const originalName = String(form.get("name") || "photo.jpg").slice(0, 200);
    if (!(file instanceof File) || file.type !== "image/jpeg" || file.size <= 0 || file.size > 512 * 1024) return json({ error: "ფოტო უნდა იყოს 512KB-მდე JPEG ფაილი." }, 400);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 800 || height > 800) return json({ error: "ფოტოს ზომები არასწორია." }, 400);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return json({ error: "JPEG ფაილი არასწორია." }, 400);
    const image = await sharp(bytes).metadata();
    if (image.format !== "jpeg" || !image.width || !image.height || image.width !== width || image.height !== height || image.width > 800 || image.height > 800) return json({ error: "JPEG ფოტოს რეალური ზომები არასწორია." }, 400);

    const existingPaths = new Set(currentPhotos.map((photo) => photo.blob_path));
    for (let suffix = 0; suffix < 1000; suffix++) {
      const path = photoBlobPath(item.code, suffix);
      if (existingPaths.has(path)) continue;
      try {
        await put(path, Buffer.from(bytes), { access: "private", addRandomSuffix: false, allowOverwrite: false, contentType: "image/jpeg", cacheControlMaxAge: 30 * 24 * 60 * 60, maximumSizeInBytes: 512 * 1024 });
        uploadedPath = path;
        break;
      } catch (error) {
        if (error instanceof BlobPreconditionFailedError) continue;
        throw error;
      }
    }
    if (!uploadedPath) throw new Error("Photo filename allocation failed.");
    const filename = uploadedPath.split("/").at(-1)!;
    const uploadedAt = new Date().toISOString();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    photoId = db.transaction(() => {
      const order = (db.prepare("SELECT coalesce(max(sort_order),-1)+1 AS value FROM inventory_photos WHERE inventory_id=?").get(inventoryId) as { value: number }).value;
      const result = db.prepare(`INSERT INTO inventory_photos
        (inventory_id,blob_path,filename,original_name,width,height,byte_size,content_type,uploader,uploaded_at,sha256,sort_order)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(inventoryId, uploadedPath, filename, originalName, width, height, bytes.byteLength, "image/jpeg", claims.name, uploadedAt, sha256, order);
      const id = Number(result.lastInsertRowid);
      db.prepare("INSERT INTO item_history (inventory_id,action,details,reference_type,reference_id,operator_email,created_at) VALUES (?,?,?,?,?,?,?)")
        .run(inventoryId, "ფოტოს დამატება", `${filename}, ${width}×${height}px, ${bytes.byteLength} ბაიტი, SHA-256: ${sha256}`, "photo", id, claims.email, uploadedAt);
      return id;
    })();
    try { await syncDataAfterWrite(); }
    catch (error) {
      db.transaction(() => {
        db.prepare("DELETE FROM item_history WHERE reference_type='photo' AND reference_id=? AND action='ფოტოს დამატება'").run(photoId);
        db.prepare("DELETE FROM inventory_photos WHERE id=?").run(photoId);
      })();
      throw error;
    }
    const photo = db.prepare("SELECT * FROM inventory_photos WHERE id=?").get(photoId) as any;
    uploadedPath = "";
    return json({ photo: toPhotoMetadata(photo) }, 201);
  } catch (error) {
    if (uploadedPath) { try { await del(uploadedPath); } catch (cleanupError) { console.error("EUROCAP failed to clean uploaded photo", cleanupError); } }
    console.error("EUROCAP photo upload failed", error);
    return json({ error: "ფოტოს ატვირთვა ვერ მოხერხდა." }, 500);
  }
}
