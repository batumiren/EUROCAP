import { withDatabase } from "@/lib/cloud-db";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiError } from "@/lib/http";
import { saveTransfer } from "@/lib/services";
import { scheduleDataSync } from "@/lib/data-sync";

async function handleGET(request: NextRequest) {
  const p = request.nextUrl.searchParams; const clauses: string[] = []; const values: unknown[] = [];
  if (p.get("search")) { clauses.push("(source_code_snapshot LIKE ? OR destination_code_snapshot LIKE ? OR item_name_snapshot LIKE ?)"); values.push(...Array(3).fill(`%${p.get("search")}%`)); }
  if (p.get("room")) { clauses.push("(source_room_snapshot LIKE ? OR destination_room_snapshot LIKE ?)"); values.push(`%${p.get("room")}%`, `%${p.get("room")}%`); }
  if (p.get("date")) { clauses.push("substr(created_at,1,10)=?"); values.push(p.get("date")); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return NextResponse.json({ transfers: db.prepare(`SELECT * FROM transfers ${where} ORDER BY created_at DESC`).all(...values) });
}
async function handlePOST(request: NextRequest) {
  try { const result = saveTransfer(db, await request.json()); scheduleDataSync(); return NextResponse.json(result, { status: 201 }); }
  catch (error) { return apiError(error); }
}

export const GET = withDatabase(handleGET, false);
export const POST = withDatabase(handlePOST, true);
