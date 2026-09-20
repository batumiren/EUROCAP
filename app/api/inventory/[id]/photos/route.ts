import { createHash } from "node:crypto";
import { BlobPreconditionFailedError, del, put } from "@vercel/blob";
import sharp, { type Metadata } from "sharp";
import { NextRequest, NextResponse } from "next/server";
import { db, getOperator } from "@/lib/db";
import { syncDataAfterWrite } from "@/lib/data-sync";
import { listInventoryPhotos, photoBlobPath, retryPhotoCleanup, toPhotoMetadata } from "@/lib/inventory-photo-data";

export const runtime = "nodejs";
const jsonHeaders = { "Cache-Control": "no-store, max-age=0" };
const json = (body: object, status = 200) => NextResponse.json(body, { status, headers: jsonHeaders });

type UploadMetadata = { originalName?: string };
type PreparedUpload = { bytes: Uint8Array; originalName: string; width: number; height: number; sha256: string; blobPath: string; filename: string };

export async function GET(_: NextRequest, context: { params: Promise<{ id: string }> }) {
  const inventoryId = Number((await context.params).id);
  const item = db.prepare("SELECT id FROM inventory WHERE id=?").get(inventoryId);
  if (!item) return json({ error: "ინვენტარის ჩანაწერი ვერ მოიძებნა." }, 404);
  return json({ photos: listInventoryPhotos(db, inventoryId).map(toPhotoMetadata) });
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (process.env.VERCEL_ENV === "preview") return json({ error: "Preview გარემო მხოლოდ წაკითხვისთვისაა." }, 403);
  const uploadedPaths: string[] = [];
  const insertedIds: number[] = [];
  try {
    const inventoryId = Number((await context.params).id);
    await retryPhotoCleanup(db);
    const item = db.prepare("SELECT * FROM inventory WHERE id=?").get(inventoryId) as Record<string, any> | undefined;
    if (!item) return json({ error: "ინვენტარის ჩანაწერი ვერ მოიძებნა." }, 404);
    if (item.archived_at) return json({ error: "დაარქივებულ ჩანაწერზე ფოტოს დამატება შეუძლებელია." }, 400);

    const form = await request.formData();
    let files = form.getAll("photos").filter((value): value is File => value instanceof File);
    let metadata: UploadMetadata[] = [];
    if (files.length) {
      try { metadata = JSON.parse(String(form.get("metadata") || "[]")) as UploadMetadata[]; }
      catch { return json({ error: "ფოტოების მონაცემები არასწორია." }, 400); }
    } else {
      const single = form.get("photo");
      if (single instanceof File) files = [single];
      metadata = [{ originalName: String(form.get("name") || (single instanceof File ? single.name : "photo.jpg")) }];
    }
    if (!files.length) return json({ error: "აირჩიეთ მინიმუმ ერთი ფოტო." }, 400);
    const currentPhotos = listInventoryPhotos(db, inventoryId);
    if (currentPhotos.length + files.length > 30) return json({ error: "ერთ ნივთზე მაქსიმუმ 30 ფოტოს ატვირთვა შეიძლება." }, 400);

    const existingPaths = new Set(currentPhotos.map((photo) => photo.blob_path));
    const uploads: PreparedUpload[] = [];
    let nextSuffix = 0;
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      if (file.type !== "image/jpeg" || file.size <= 0 || file.size > 1024 * 1024) return json({ error: `${file.name}: ფოტო უნდა იყოს 1MB-მდე JPEG ფაილი.` }, 400);
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return json({ error: `${file.name}: JPEG ფაილი არასწორია.` }, 400);
      let image: Metadata;
      try { image = await sharp(bytes).metadata(); }
      catch { return json({ error: `${file.name}: ფოტოს წაკითხვა ვერ მოხერხდა.` }, 400); }
      if (image.format !== "jpeg" || !image.width || !image.height || image.width > 800 || image.height > 800) return json({ error: `${file.name}: ფოტოს ზომები უნდა იყოს მაქსიმუმ 800×800 პიქსელი.` }, 400);

      let path = "";
      for (; nextSuffix < 1000; nextSuffix++) {
        const candidate = photoBlobPath(item.code, nextSuffix);
        if (existingPaths.has(candidate)) continue;
        try {
          await put(candidate, Buffer.from(bytes), { access: "private", addRandomSuffix: false, allowOverwrite: false, contentType: "image/jpeg", cacheControlMaxAge: 30 * 24 * 60 * 60, maximumSizeInBytes: 1024 * 1024 });
          path = candidate;
          existingPaths.add(candidate);
          uploadedPaths.push(candidate);
          nextSuffix++;
          break;
        } catch (error) {
          if (error instanceof BlobPreconditionFailedError) continue;
          throw error;
        }
      }
      if (!path) throw new Error("Photo filename allocation failed.");
      uploads.push({ bytes, originalName: String(metadata[index]?.originalName || file.name || "photo.jpg").slice(0, 200), width: image.width, height: image.height, sha256: createHash("sha256").update(bytes).digest("hex"), blobPath: path, filename: path.split("/").at(-1)! });
    }

    const operator = getOperator();
    const uploadedAt = new Date().toISOString();
    db.transaction(() => {
      let order = (db.prepare("SELECT coalesce(max(sort_order),-1)+1 AS value FROM inventory_photos WHERE inventory_id=?").get(inventoryId) as { value: number }).value;
      const insert = db.prepare(`INSERT INTO inventory_photos
        (inventory_id,blob_path,filename,original_name,width,height,byte_size,content_type,uploader,uploaded_at,sha256,sort_order)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
      const history = db.prepare("INSERT INTO item_history (inventory_id,action,details,reference_type,reference_id,operator_email,created_at) VALUES (?,?,?,?,?,?,?)");
      for (const upload of uploads) {
        const result = insert.run(inventoryId, upload.blobPath, upload.filename, upload.originalName, upload.width, upload.height, upload.bytes.byteLength, "image/jpeg", operator.operator_name, uploadedAt, upload.sha256, order++);
        const id = Number(result.lastInsertRowid);
        insertedIds.push(id);
        history.run(inventoryId, "ფოტოს დამატება", `${upload.filename}, ${upload.width}×${upload.height}px, ${upload.bytes.byteLength} ბაიტი`, "photo", id, operator.operator_email, uploadedAt);
      }
    })();
    try { await syncDataAfterWrite(); }
    catch (error) {
      db.transaction(() => {
        for (const id of insertedIds) {
          db.prepare("DELETE FROM item_history WHERE reference_type='photo' AND reference_id=? AND action='ფოტოს დამატება'").run(id);
          db.prepare("DELETE FROM inventory_photos WHERE id=?").run(id);
        }
      })();
      throw error;
    }
    const photos = insertedIds.map((id) => toPhotoMetadata(db.prepare("SELECT * FROM inventory_photos WHERE id=?").get(id) as any));
    uploadedPaths.length = 0;
    return json({ photos }, 201);
  } catch (error) {
    for (const path of uploadedPaths) { try { await del(path); } catch (cleanupError) { console.error("EUROCAP failed to clean uploaded photo", cleanupError); } }
    console.error("EUROCAP photo upload failed", error);
    return json({ error: "ფოტოების ატვირთვა ვერ მოხერხდა. სცადეთ ხელახლა." }, 500);
  }
}
