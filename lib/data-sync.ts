import type Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";

const tables = [
  "rooms", "settings", "inventory", "inspections", "inspection_results",
  "inspection_unexpected_items", "transfers", "item_history", "app_metadata",
] as const;
const backupDirectory = path.join(process.cwd(), "backups");
const backupPath = path.join(backupDirectory, "latest.json");
let syncTimer: NodeJS.Timeout | undefined;

export function createDataSnapshot(database: Database.Database = db) {
  const data = Object.fromEntries(tables.map((table) => [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  fs.mkdirSync(backupDirectory, { recursive: true });
  const temporaryPath = `${backupPath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify({ format: "EUROCAP-data-v1", exportedAt: new Date().toISOString(), tables: data }, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, backupPath);
  return backupPath;
}

export function syncDataToGitHub(database: Database.Database = db) {
  createDataSnapshot(database);
  execFileSync("git", ["add", "backups/latest.json"], { cwd: process.cwd(), stdio: "ignore" });
  const changed = execFileSync("git", ["diff", "--cached", "--name-only", "--", "backups/latest.json"], { cwd: process.cwd(), encoding: "utf8" }).trim();
  if (!changed) return false;
  execFileSync("git", ["commit", "-m", "data: sync inventory snapshot", "--", "backups/latest.json"], { cwd: process.cwd(), stdio: "ignore" });
  execFileSync("git", ["push", "origin", "main"], { cwd: process.cwd(), stdio: "ignore" });
  return true;
}

export function scheduleDataSync(database: Database.Database = db) {
  if (process.env.NODE_ENV === "test") return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = undefined;
    try {
      syncDataToGitHub(database);
    } catch (error) {
      console.error("GitHub data synchronization failed:", error);
    }
  }, 1500);
}
