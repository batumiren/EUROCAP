import { apiError } from "@/lib/http";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET(_: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const id = Number((await context.params).id);
    const inspection = (await db.prepare("SELECT * FROM inspections WHERE id=?").get(id));
    if (!inspection) return NextResponse.json({ error: "შემოწმება ვერ მოიძებნა." }, { status: 404 });
    const results = (await db.prepare("SELECT * FROM inspection_results WHERE inspection_id=? ORDER BY item_name_snapshot").all(id));
    const unexpectedItems = (await db.prepare("SELECT * FROM inspection_unexpected_items WHERE inspection_id=? ORDER BY item_name_snapshot").all(id));
    return NextResponse.json({ inspection, results, unexpectedItems });
  } catch (error) { return apiError(error); }
}
