import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Client } from "pg";

const tables = ["rooms", "settings", "app_metadata", "inventory", "inventory_photos",
  "photo_cleanup_queue", "inspections", "inspection_results", "inspection_unexpected_items",
  "transfers", "item_history"] as const;
const keys: Record<string, string> = { app_metadata: "key", photo_cleanup_queue: "blob_path" };

async function main() {
  const [source, confirmation] = process.argv.slice(2);
  const connectionString = process.env.MIGRATION_DATABASE_URL;
  if (!source || confirmation !== "--empty-target" || !connectionString) {
    throw new Error("Usage: MIGRATION_DATABASE_URL=… npm run db:migrate -- <snapshot.json> --empty-target");
  }
  const snapshot = JSON.parse(readFileSync(source, "utf8"));
  if (snapshot.format !== "EUROCAP-data-v1" || !tables.every(table => Array.isArray(snapshot.tables?.[table])) ||
      snapshot.tables.settings.length !== 1 || snapshot.tables.settings[0].id !== 1) throw new Error("Incomplete EUROCAP snapshot.");
  const client = new Client({ connectionString, connectionTimeoutMillis: 10000 });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL search_path TO public");
    const existing = await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' LIMIT 1");
    if (existing.rowCount) throw new Error("Target public schema is not empty; no rows were changed.");
    await client.query(readFileSync(resolve("migrations/001-inventory.sql"), "utf8"));
    await client.query(readFileSync(resolve("migrations/002-auth.sql"), "utf8"));
    for (const table of tables) {
      const rows = snapshot.tables[table] as Record<string, unknown>[];
      const key = keys[table] ?? "id";
      for (let offset = 0; offset < rows.length; offset += 500) {
        await client.query(`INSERT INTO ${table} SELECT * FROM json_populate_recordset(NULL::${table}, $1::json)`,
          [JSON.stringify(rows.slice(offset, offset + 500))]);
      }
      const actual = (await client.query(`SELECT * FROM ${table}`)).rows;
      const byKey = new Map(actual.map(row => [row[key], row]));
      if (actual.length !== rows.length || rows.some(row => !isDeepStrictEqual(row, byKey.get(row[key])))) throw new Error(`Migrated values do not match source: ${table}`);
      if (key === "id" && table !== "settings") {
        await client.query(`SELECT setval(pg_get_serial_sequence($1,'id'), coalesce(max(id),0)::bigint + 1, false) FROM ${table}`, [table]);
      }
      console.log(`${table}: ${actual.length} rows verified`);
    }
    await client.query(`SELECT setval('inventory_barcode_seq',
      coalesce(max(substring(code FROM 5)::bigint),0) + 1, false) FROM inventory WHERE code ~ '^EUR-[0-9]+$'`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { await client.end(); }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
