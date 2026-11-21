import { apiError } from "@/lib/http";
import { createHash, randomUUID } from "node:crypto";
import { del, put } from "@vercel/blob";
import sharp, { type Metadata } from "sharp";
import { NextRequest, NextResponse } from "next/server";
import { db, getOperator } from "@/lib/db";
import { CommitUncertain } from "@/lib/db";
import { AppError } from "@/lib/services";
import { listInventoryPhotos, photoBlobPath, retryPhotoCleanup, toPhotoMetadata } from "@/lib/inventory-photo-data";

export const runtime = "nodejs";
const jsonHeaders = { "Cache-Control": "no-store, max-age=0" };
const json = (body: object, status = 200) => NextResponse.json(body, { status, headers: jsonHeaders });

type UploadMetadata = { originalName?: string };
type PreparedUpload = { bytes: Uint8Array; originalName: string; width: number; height: number; sha256: string; blobPath: string; filename: string };

export async function GET(_: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const inventoryId = Number((await context.params).id);
    const item = await db.prepare("SELECT id FROM inventory WHERE id=?").get(inventoryId);
    if (!item) return json({ error: "ინვენტარის ჩანაწერი ვერ მოიძებნა." }, 404);
    return json({ photos: (await listInventoryPhotos(db, inventoryId)).map(toPhotoMetadata) });
  } catch (error) { return apiError(error); }
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (process.env.VERCEL_ENV === "preview") return json({ error: "Preview გარემო მხოლოდ წაკითხვისთვისაა." }, 403);
  const uploadedPaths: string[] = [];
  try {
    const inventoryId = Number((await context.params).id);
    await retryPhotoCleanup(db);
    const item = await db.prepare("SELECT * FROM inventory WHERE id=?").get(inventoryId);
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
    const currentPhotos = await listInventoryPhotos(db, inventoryId);
    if (currentPhotos.length + files.length > 30) return json({ error: "ერთ ნივთზე მაქსიმუმ 30 ფოტოს ატვირთვა შეიძლება." }, 400);

    const existingPaths = new Set(currentPhotos.map(photo => `eurocap/inventory-photos/${photo.filename}`));
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

      let candidate: string;
      do { candidate = photoBlobPath(item.code, nextSuffix++); } while (existingPaths.has(candidate));
      existingPaths.add(candidate);
      // Never reuse a Blob key: deferred cleanup must not delete a replacement upload.
      const path = candidate.replace(/\.jpg$/, `-${randomUUID()}.jpg`);
      await put(path, Buffer.from(bytes), { access: "private", addRandomSuffix: false, allowOverwrite: false, contentType: "image/jpeg", cacheControlMaxAge: 30 * 24 * 60 * 60, maximumSizeInBytes: 1024 * 1024 });
      uploadedPaths.push(path);
      uploads.push({ bytes, originalName: String(metadata[index]?.originalName || file.name || "photo.jpg").slice(0, 200), width: image.width, height: image.height, sha256: createHash("sha256").update(bytes).digest("hex"), blobPath: path, filename: candidate.split("/").at(-1)! });
    }

    const uploadedAt = new Date().toISOString();
    const photos = await db.transaction(async db => {
      const operator = await getOperator(db);
      const latest = await db.prepare("SELECT archived_at FROM inventory WHERE id=?").get(inventoryId);
      if (!latest || latest.archived_at) throw new AppError("ჩანაწერი აღარ არის აქტიური.");
      const current = await listInventoryPhotos(db, inventoryId);
      if (current.length + uploads.length > 30) throw new AppError("ერთ ნივთზე მაქსიმუმ 30 ფოტოს ატვირთვა შეიძლება.");
      let order = current.reduce((max, photo) => Math.max(max, photo.sort_order), -1) + 1;
      const insert = db.prepare(`INSERT INTO inventory_photos
        (inventory_id,blob_path,filename,original_name,width,height,byte_size,content_type,uploader,uploaded_at,sha256,sort_order)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *`);
      const history = db.prepare("INSERT INTO item_history (inventory_id,action,details,reference_type,reference_id,operator_email,created_at) VALUES (?,?,?,?,?,?,?)");
      const photos = [];
      for (const upload of uploads) {
        const result = await insert.get(inventoryId, upload.blobPath, upload.filename, upload.originalName, upload.width, upload.height, upload.bytes.byteLength, "image/jpeg", operator.operator_name, uploadedAt, upload.sha256, order++);
        await history.run(inventoryId, "ფოტოს დამატება", `${upload.filename}, ${upload.width}×${upload.height}px, ${upload.bytes.byteLength} ბაიტი`, "photo", result.id, operator.operator_email, uploadedAt);
        photos.push(toPhotoMetadata(result as Parameters<typeof toPhotoMetadata>[0]));
      }
      return photos;
    });
    uploadedPaths.length = 0;
    return json({ photos }, 201);
  } catch (error) {
    // A lost COMMIT response may mean these files are already referenced.
    if (!(error instanceof CommitUncertain)) for (const path of uploadedPaths) { try { await del(path); } catch { console.error("EUROCAP failed to clean uploaded photo"); } }
    if (error instanceof AppError) return json({ error: error.message }, error.status);
    console.error("EUROCAP photo upload failed", error);
    return json({ error: "ფოტოების ატვირთვა ვერ მოხერხდა. სცადეთ ხელახლა." }, 500);
  }
}
