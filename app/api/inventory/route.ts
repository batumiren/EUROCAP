import { NextRequest, NextResponse } from "next/server";
import { db, nextItemCode } from "@/lib/db";
import { apiError } from "@/lib/http";
import { createInventoryItems } from "@/lib/services";
import { z } from "zod";

export async function GET(request: NextRequest) {
  try {
  const p = request.nextUrl.searchParams;
  const clauses = [p.get("archived") === "true" ? "i.archived_at IS NOT NULL" : "i.archived_at IS NULL"];
  const values: unknown[] = [];
  if (p.get("search")) { clauses.push("(i.code LIKE ? OR i.name LIKE ?)"); values.push(`%${p.get("search")}%`, `%${p.get("search")}%`); }
  for (const [key, column] of [["room", "i.room_id"], ["condition", "i.condition"], ["status", "i.status"]]) {
    if (p.get(key)) { clauses.push(`${column} = ?`); values.push(p.get(key)); }
  }
  const items = (await db.prepare(`SELECT i.*, r.name AS room_name,(SELECT count(*)::integer FROM inventory_photos p WHERE p.inventory_id=i.id) AS "photoCount" FROM inventory i JOIN rooms r ON r.id=i.room_id WHERE ${clauses.join(" AND ")} ORDER BY i.id DESC`).all(...values));
  const summary = (await db.prepare(`SELECT count(*)::integer AS records, coalesce(sum(quantity),0)::double precision AS units,
    count(*) FILTER (WHERE condition='საჭიროებს შეკეთებას')::integer AS repairs FROM inventory WHERE archived_at IS NULL`).get());
  return NextResponse.json({ items, summary, nextCode: (await nextItemCode(db)) });
  } catch (error) { return apiError(error); }
}

export async function POST(request: NextRequest) {
  try {
    const key = z.string().uuid().parse(request.headers.get("Idempotency-Key"));
    const result = await createInventoryItems(db, await request.json(), key);
    return NextResponse.json(result, { status: 201 });
  } catch (error) { return apiError(error); }
}
