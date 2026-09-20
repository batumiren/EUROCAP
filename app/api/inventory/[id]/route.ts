import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, getOperator } from "@/lib/db";
import { apiError } from "@/lib/http";
import { AppError } from "@/lib/services";
import { CONDITIONS, STATUSES } from "@/lib/types";
import { syncDataAfterWrite } from "@/lib/data-sync";

export async function GET(_: NextRequest, context: { params: Promise<{ id: string }> }) {
  const id = Number((await context.params).id);
  const item = db.prepare("SELECT i.*,r.name AS room_name,(SELECT count(*) FROM inventory_photos p WHERE p.inventory_id=i.id) AS photoCount FROM inventory i JOIN rooms r ON r.id=i.room_id WHERE i.id=?").get(id);
  if (!item) return NextResponse.json({ error: "ჩანაწერი ვერ მოიძებნა." }, { status: 404 });
  const inspections = db.prepare(`SELECT ir.*,ins.inspection_code,ins.created_at,ins.operator_email FROM inspection_results ir JOIN inspections ins ON ins.id=ir.inspection_id WHERE ir.inventory_id=? ORDER BY ins.created_at DESC`).all(id);
  const transfers = db.prepare("SELECT * FROM transfers WHERE source_inventory_id=? OR destination_inventory_id=? ORDER BY created_at DESC").all(id, id);
  const history = db.prepare("SELECT * FROM item_history WHERE inventory_id=? ORDER BY created_at DESC").all(id);
  return NextResponse.json({ item, inspections, transfers, history });
}

const editSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("edit"), name: z.string().trim().min(1), condition: z.enum(CONDITIONS), status: z.enum(STATUSES), notes: z.string(), responsiblePerson: z.string() }),
  z.object({ action: z.literal("correctQuantity"), quantity: z.number().int().positive(), reason: z.string().trim().min(1) }),
  z.object({ action: z.literal("archive") }),
]);

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const id = Number((await context.params).id); const input = editSchema.parse(await request.json());
    db.transaction(() => {
      const item = db.prepare("SELECT * FROM inventory WHERE id=?").get(id) as Record<string, any> | undefined;
      if (!item) throw new AppError("ჩანაწერი ვერ მოიძებნა.", 404);
      if (item.archived_at) throw new AppError("დაარქივებული ჩანაწერი მხოლოდ ისტორიის სანახავადაა.");
      const now = new Date().toISOString(); const operator = getOperator(); let details = ""; let action = "";
      if (input.action === "edit") {
        db.prepare("UPDATE inventory SET name=?,condition=?,status=?,notes=?,responsible_person=?,updated_at=? WHERE id=?").run(input.name, input.condition, input.status, input.notes.trim(), input.responsiblePerson.trim(), now, id);
        action = "ჩანაწერის რედაქტირება"; details = "განახლდა დასახელება, მდგომარეობა, სტატუსი ან აღწერითი ველები";
      } else if (input.action === "correctQuantity") {
        db.prepare("UPDATE inventory SET quantity=?,updated_at=? WHERE id=?").run(input.quantity, now, id);
        action = "რაოდენობის კორექტირება"; details = `${item.quantity} → ${input.quantity}. მიზეზი: ${input.reason}`;
      } else {
        db.prepare("UPDATE inventory SET archived_at=?,updated_at=? WHERE id=?").run(now, now, id);
        action = "ჩანაწერის არქივირება"; details = "ჩანაწერი გადატანილია არქივში";
      }
      db.prepare("INSERT INTO item_history (inventory_id,action,details,operator_email,created_at) VALUES (?,?,?,?,?)").run(id, action, details, operator.operator_email, now);
    })();
    try { await syncDataAfterWrite(); } catch (syncError) { console.error("GitHub data sync failed:", syncError); }
    return NextResponse.json({ ok: true });
  } catch (error) { return apiError(error); }
}
