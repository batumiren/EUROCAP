import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { migrateInventoryStatuses } from "@/lib/inventory-status-schema";
import { db } from "@/lib/db";
import { createInventoryItems } from "@/lib/services";
import { GET } from "@/app/api/inventory/route";
import { NextRequest } from "next/server";
import { resetDatabase } from "./postgres-test";

const status = "მცირეფასიანი მარაგები";

it("upgrades an existing database without losing inventory IDs, references or indexes", () => {
  const database = new Database(":memory:");
  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        status TEXT NOT NULL CHECK(status IN ('გამოყენებაში','საწყობში','ჩამოწერილი'))
      );
      CREATE INDEX inventory_status_idx ON inventory(status);
      CREATE TABLE photos (inventory_id INTEGER REFERENCES inventory(id));
      INSERT INTO inventory VALUES (7,'საწყობში'),(20,'საწყობში');
      INSERT INTO photos VALUES (7);
      DELETE FROM inventory WHERE id=20;
    `);
    migrateInventoryStatuses(database);
    migrateInventoryStatuses(database);
    expect(database.prepare("SELECT * FROM inventory").all()).toEqual([{ id: 7, status: "საწყობში" }]);
    expect(database.prepare("SELECT * FROM photos").all()).toEqual([{ inventory_id: 7 }]);
    expect(database.pragma("foreign_key_check")).toEqual([]);
    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(database.pragma("index_list('inventory')")).toEqual([expect.objectContaining({ name: "inventory_status_idx" })]);
    expect(database.prepare("INSERT INTO inventory(status) VALUES (?)").run(status).lastInsertRowid).toBe(21);
    expect(() => database.prepare("INSERT INTO inventory(status) VALUES (?)").run("invalid")).toThrow();
  } finally {
    database.close();
  }
});

it("saves the new status and includes it in inventory filter results", async () => {
  await resetDatabase();
  await db.query("INSERT INTO settings (id,operator_name,operator_email) VALUES (1,'Test','test@example.test')");
  const room = (await db.prepare("INSERT INTO rooms(name) VALUES (?)").insert("სტატუსის სატესტო ოთახი"));
  try {
    const fields = { name: "სატესტო ნივთი", roomId: Number(room.id), quantity: 1, condition: "კარგი" };
    const created = (await createInventoryItems(db, { ...fields, status }));
    const other = (await createInventoryItems(db, { ...fields, status: "საწყობში" }));
    const url = new URL("https://inventory.test/api/inventory");
    url.searchParams.set("status", status);
    const response = await GET(new NextRequest(url));
    const { items } = await response.json();
    expect(items).toContainEqual(expect.objectContaining({ code: created.code, status }));
    expect(items).not.toContainEqual(expect.objectContaining({ code: other.code }));
  } finally {
    (await db.prepare("DELETE FROM item_history WHERE inventory_id IN (SELECT id FROM inventory WHERE room_id=?)").run(room.id));
    (await db.prepare("DELETE FROM inventory WHERE room_id=?").run(room.id));
    (await db.prepare("DELETE FROM rooms WHERE id=?").run(room.id));
  }
});
