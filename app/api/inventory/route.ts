import { NextRequest, NextResponse } from "next/server";
import { db, nextItemCode } from "@/lib/db";
import { apiError } from "@/lib/http";
import { createInventoryItems } from "@/lib/services";
import { syncDataAfterWrite } from "@/lib/data-sync";

export async function GET(request: NextRequest) {
  const p = request.nextUrl.searchParams;
  const clauses = [p.get("archived") === "true" ? "i.archived_at IS NOT NULL" : "i.archived_at IS NULL"];
  const values: unknown[] = [];
  if (p.get("search")) { clauses.push("(i.code LIKE ? OR i.name LIKE ?)"); values.push(`%${p.get("search")}%`, `%${p.get("search")}%`); }
  for (const [key, column] of [["room", "i.room_id"], ["condition", "i.condition"], ["status", "i.status"]]) {
    if (p.get(key)) { clauses.push(`${column} = ?`); values.push(p.get(key)); }
  }
  const items = db.prepare(`SELECT i.*, r.name AS room_name,(SELECT count(*) FROM inventory_photos p WHERE p.inventory_id=i.id) AS photoCount FROM inventory i JOIN rooms r ON r.id=i.room_id WHERE ${clauses.join(" AND ")} ORDER BY i.id DESC`).all(...values);
  const summary = db.prepare(`SELECT count(*) AS records, coalesce(sum(quantity),0) AS units,
    sum(CASE WHEN condition='საჭიროებს შეკეთებას' THEN 1 ELSE 0 END) AS repairs FROM inventory WHERE archived_at IS NULL`).get();
  return NextResponse.json({ items, summary, nextCode: nextItemCode(db) });
}

export async function POST(request: NextRequest) {
  try {
    const result = createInventoryItems(db, await request.json());
    try { await syncDataAfterWrite(); } catch (syncError) { console.error("GitHub data sync failed:", syncError); }
    return NextResponse.json(result, { status: 201 });
  } catch (error) { return apiError(error); }
}
