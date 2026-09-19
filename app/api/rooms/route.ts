import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiError } from "@/lib/http";
import { AppError } from "@/lib/services";
import { scheduleDataSync } from "@/lib/data-sync";

export async function GET(request: NextRequest) {
  const includeArchived = request.nextUrl.searchParams.get("archived") === "true";
  return NextResponse.json({ rooms: db.prepare(`SELECT r.*,(SELECT count(*) FROM inventory i WHERE i.room_id=r.id AND i.archived_at IS NULL) AS active_items FROM rooms r ${includeArchived ? "" : "WHERE r.archived_at IS NULL"} ORDER BY r.name`).all() });
}
export async function POST(request: NextRequest) {
  try { const { name } = z.object({ name: z.string().trim().min(1) }).parse(await request.json()); const id = Number(db.prepare("INSERT INTO rooms (name) VALUES (?)").run(name).lastInsertRowid); scheduleDataSync(); return NextResponse.json({ id }, { status: 201 }); }
  catch (error) { return apiError(error); }
}
export async function PATCH(request: NextRequest) {
  try {
    const input = z.discriminatedUnion("action", [z.object({ action: z.literal("rename"), id: z.number().int().positive(), name: z.string().trim().min(1) }), z.object({ action: z.literal("archive"), id: z.number().int().positive() })]).parse(await request.json());
    if (input.action === "rename") db.prepare("UPDATE rooms SET name=? WHERE id=?").run(input.name, input.id);
    else {
      const count = (db.prepare("SELECT count(*) AS count FROM inventory WHERE room_id=? AND archived_at IS NULL").get(input.id) as { count: number }).count;
      if (count) throw new AppError("ოთახში აქტიური ინვენტარია და მისი არქივირება შეუძლებელია.");
      db.prepare("UPDATE rooms SET archived_at=? WHERE id=?").run(new Date().toISOString(), input.id);
    }
    scheduleDataSync();
    return NextResponse.json({ ok: true });
  } catch (error) { return apiError(error); }
}
