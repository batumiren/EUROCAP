import type Database from "better-sqlite3";
import { STATUSES } from "@/lib/types";

const legacyCheck = "CHECK(status IN ('გამოყენებაში','საწყობში','ჩამოწერილი'))";
export const inventoryStatusCheck = `CHECK(status IN (${STATUSES.map(status => `'${status}'`).join(",")}))`;

export function migrateInventoryStatuses(db: Database.Database) {
  const schema = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='inventory'");
  const readSchema = () => (schema.get() as { sql: string } | undefined)?.sql;
  if (!readSchema()?.includes(legacyCheck)) return;

  // Rebuild without renaming the old table, so foreign keys keep targeting inventory.
  const foreignKeys = db.pragma("foreign_keys", { simple: true });
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      const sql = readSchema();
      if (!sql?.includes(legacyCheck)) return;
      const objects = db.prepare("SELECT sql FROM sqlite_schema WHERE tbl_name='inventory' AND type IN ('index','trigger') AND sql IS NOT NULL").all() as { sql: string }[];
      const sequence = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='inventory'").get() as { seq: number } | undefined;
      db.exec(sql.replace(/^CREATE TABLE inventory\b/, "CREATE TABLE inventory_status_new").replace(legacyCheck, inventoryStatusCheck));
      db.exec(`INSERT INTO inventory_status_new SELECT * FROM inventory;
        DROP TABLE inventory;
        ALTER TABLE inventory_status_new RENAME TO inventory;`);
      if (sequence) {
        db.prepare("DELETE FROM sqlite_sequence WHERE name='inventory'").run();
        db.prepare("INSERT INTO sqlite_sequence (name,seq) VALUES ('inventory',?)").run(sequence.seq);
      }
      for (const object of objects) db.exec(object.sql);
      if (db.prepare("PRAGMA foreign_key_check").get()) throw new Error("Inventory status migration failed its foreign key check.");
    }).immediate();
  } finally {
    db.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  }
}
