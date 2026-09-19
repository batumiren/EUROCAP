import { get, put, BlobPreconditionFailedError } from "@vercel/blob";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { openDatabase, requestDatabase, usesCloudStorage } from "@/lib/db";
import { apiError } from "@/lib/http";

const tables = ["rooms", "settings", "inventory", "inspections", "inspection_results",
  "inspection_unexpected_items", "transfers", "item_history", "app_metadata"] as const;
type Snapshot = { format: string; tables: Record<string, Record<string, unknown>[]> };

function restore(database: Database.Database, snapshot: Snapshot) {
  if (snapshot.format !== "EUROCAP-data-v1") throw new Error("Unsupported inventory snapshot");
  database.transaction(() => {
    for (const table of tables) {
      const rows = snapshot.tables[table];
      if (!Array.isArray(rows)) throw new Error(`Missing snapshot table: ${table}`);
      const columns = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      const names = columns.map(column => column.name);
      const insert = database.prepare(`INSERT INTO ${table} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`);
      for (const row of rows) insert.run(...names.map(name => row[name] ?? null));
    }
    if (!database.prepare("SELECT id FROM settings WHERE id=1").get()) throw new Error("Missing operator settings");
  })();
}

function snapshot(database: Database.Database) {
  return JSON.stringify({
    format: "EUROCAP-data-v1", exportedAt: new Date().toISOString(), revision: randomUUID(),
    tables: Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])),
  });
}

// Each request reads the latest durable state into its own SQLite connection.
// A successful mutation is acknowledged only after a conditional cloud write.
// No local disk, background timer, or per-instance cache is authoritative.
export function withDatabase<Args extends unknown[]>(handler: (...args: Args) => Promise<Response>, write = false) {
  return async (...args: Args): Promise<Response> => {
    let database: Database.Database | undefined;
    try {
      if (!usesCloudStorage()) return await handler(...args);
      if (!process.env.BLOB_STORE_ID && !process.env.BLOB_READ_WRITE_TOKEN) {
        return Response.json({ error: "მონაცემთა საცავი არ არის დაკავშირებული." }, { status: 503 });
      }
      // Preview branches must not edit production data, even when sharing a store.
      const environment = process.env.VERCEL_ENV || "development";
      const branch = encodeURIComponent(process.env.VERCEL_GIT_COMMIT_REF || "local");
      const key = environment === "production" ? "eurocap/production/latest.json" : `eurocap/${environment}/${branch}/latest.json`;
      const stored = await get(key, { access: "private", useCache: false });
      if (stored && stored.statusCode !== 200) throw new Error("Unexpected storage response");
      const data: Snapshot = stored
        ? await new Response(stored.stream).json()
        : JSON.parse(fs.readFileSync(path.join(process.cwd(), "backups", "latest.json"), "utf8"));
      database = openDatabase(":memory:", false);
      restore(database, data);
      if (!write) database.pragma("query_only = ON");
      const response = await requestDatabase.run(database, () => handler(...args));
      if (write && response.ok) {
        await put(key, snapshot(database), {
          access: "private", addRandomSuffix: false,
          contentType: "application/json", cacheControlMaxAge: 60,
          // Missing blobs are created atomically; existing ones use compare-and-swap.
          allowOverwrite: Boolean(stored), ...(stored ? { ifMatch: stored.blob.etag } : {}),
        });
      }
      response.headers.set("Cache-Control", "no-store");
      return response;
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError) {
        return Response.json({ error: "მონაცემები შეიცვალა. განაახლეთ გვერდი და გაიმეორეთ ცვლილება." }, { status: 409 });
      }
      return apiError(error);
    } finally {
      database?.close();
    }
  };
}
