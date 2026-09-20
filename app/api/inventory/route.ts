import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, getOperator, nextItemCode } from "@/lib/db";
import { apiError } from "@/lib/http";
import { CONDITIONS, STATUSES } from "@/lib/types";
import { syncDataAfterWrite } from "@/lib/data-sync";

const createSchema = z.object({
  name: z.string().trim().min(1), roomId: z.number().int().positive(), quantity: z.number().int().positive(),
  condition: z.enum(CONDITIONS), status: z.enum(STATUSES), notes: z.string().default(""), responsiblePerson: z.string().default(""),
});

export async function GET(request: NextRequest) {
  const p = request.nextUrl.searchParams;
  const clauses = [p.get("archived") === "true" ? "i.archived_at IS NOT NULL" : "i.archived_at IS NULL"];
  const values: unknown[] = [];
  if (p.get("search")) { clauses.push("(i.code LIKE ? OR i.name LIKE ?)"); values.push(`%${p.get("search")}%`, `%${p.get("search")}%`); }
  for (const [key, column] of [["room", "i.room_id"], ["condition", "i.condition"], ["status", "i.status"]]) {
    if (p.get(key)) { clauses.push(`${column} = ?`); values.push(p.get(key)); }
  }
  const items = db.prepare(`SELECT i.*, r.name AS room_name FROM inventory i JOIN rooms r ON r.id=i.room_id WHERE ${clauses.join(" AND ")} ORDER BY i.id DESC`).all(...values);
  const summary = db.prepare(`SELECT count(*) AS records, coalesce(sum(quantity),0) AS units,
    sum(CASE WHEN condition='საჭიროებს შეკეთებას' THEN 1 ELSE 0 END) AS repairs FROM inventory WHERE archived_at IS NULL`).get();
  return NextResponse.json({ items, summary, nextCode: nextItemCode(db) });
}

export async function POST(request: NextRequest) {
  try {
    const input = createSchema.parse(await request.json());
    const room = db.prepare("SELECT id FROM rooms WHERE id=? AND archived_at IS NULL").get(input.roomId);
    if (!room) return NextResponse.json({ error: "აქტიური ოთახი ვერ მოიძებნა." }, { status: 400 });
    const result = db.transaction(() => {
      const now = new Date().toISOString(); const code = nextItemCode(db); const operator = getOperator();
      const inserted = db.prepare(`INSERT INTO inventory (code,name,room_id,quantity,condition,status,notes,responsible_person,registered_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(code, input.name, input.roomId, input.quantity, input.condition, input.status, input.notes.trim(), input.responsiblePerson.trim(), now, now);
      const id = Number(inserted.lastInsertRowid);
      db.prepare("INSERT INTO item_history (inventory_id,action,details,operator_email,created_at) VALUES (?,?,?,?,?)").run(id, "ჩანაწერის შექმნა", `რაოდენობა: ${input.quantity}`, operator.operator_email, now);
      return { id, code };
    })();
    try { await syncDataAfterWrite(); } catch (syncError) { console.error("GitHub data sync failed:", syncError); }
    return NextResponse.json(result, { status: 201 });
  } catch (error) { return apiError(error); }
}
