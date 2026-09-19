import { db } from "../lib/db";

const tables = db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table'").get() as { count: number };
console.log(`EURO Inventory database ready (${tables.count} tables).`);
