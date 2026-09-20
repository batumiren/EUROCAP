import type Database from "better-sqlite3";
import { del } from "@vercel/blob";
import type { InventoryPhoto } from "@/lib/types";

export type StoredInventoryPhoto = {
  id: number;
  inventory_id: number;
  blob_path: string;
  filename: string;
  original_name: string;
  width: number;
  height: number;
  byte_size: number;
  content_type: string;
  uploader: string;
  uploaded_at: string;
  sha256: string;
  sort_order: number;
};

export function toPhotoMetadata(photo: StoredInventoryPhoto): InventoryPhoto {
  return {
    id: photo.id,
    filename: photo.filename,
    originalName: photo.original_name,
    width: photo.width,
    height: photo.height,
    byteSize: photo.byte_size,
    uploader: photo.uploader,
    uploadedAt: photo.uploaded_at,
    sha256: photo.sha256,
  };
}

export function listInventoryPhotos(database: Database.Database, inventoryId: number) {
  return database.prepare("SELECT * FROM inventory_photos WHERE inventory_id=? ORDER BY sort_order,id").all(inventoryId) as StoredInventoryPhoto[];
}

export function photoBlobPath(code: string, suffix: number) {
  return `eurocap/inventory-photos/${code}${suffix === 0 ? "" : `-${suffix}`}.jpg`;
}

export async function retryPhotoCleanup(database: Database.Database) {
  const queued = database.prepare("SELECT blob_path FROM photo_cleanup_queue ORDER BY created_at LIMIT 10").all() as { blob_path: string }[];
  for (const entry of queued) {
    try {
      await del(entry.blob_path);
      database.prepare("DELETE FROM photo_cleanup_queue WHERE blob_path=?").run(entry.blob_path);
    } catch (error) {
      database.prepare("UPDATE photo_cleanup_queue SET attempts=attempts+1,last_error=? WHERE blob_path=?")
        .run(error instanceof Error ? error.message.slice(0, 500) : "Unknown error", entry.blob_path);
    }
  }
}
