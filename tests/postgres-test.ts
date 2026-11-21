import { readFileSync } from "node:fs";
import { beforeAll } from "vitest";
import { db } from "@/lib/db";

// Only disposable loopback databases with the reserved suffix may be truncated.
beforeAll(async () => {
  const url = new URL(process.env.TEST_DATABASE_URL ?? "postgresql://localhost/eurocap_test");
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || !url.pathname.endsWith("_test")) {
    throw new Error("Tests require a disposable loopback TEST_DATABASE_URL ending in _test.");
  }
  process.env.DATABASE_URL = url.toString();
  delete process.env.VERCEL_ENV;
  const existing = await db.query("SELECT to_regclass('public.inventory') AS inventory");
  if (!existing.rows[0].inventory) {
    await db.query(readFileSync("migrations/001-inventory.sql", "utf8"));
  }
});

export async function resetDatabase() {
  await db.query(`TRUNCATE inventory_submissions,item_history,transfers,inspection_unexpected_items,
    inspection_results,inspections,inventory_photos,photo_cleanup_queue,inventory,rooms,settings,app_metadata RESTART IDENTITY;
    ALTER SEQUENCE inventory_barcode_seq RESTART WITH 4`);
}
