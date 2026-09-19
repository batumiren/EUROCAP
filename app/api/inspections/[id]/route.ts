import { withDatabase } from "@/lib/cloud-db";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

async function handleGET(_: NextRequest, context: { params: Promise<{ id: string }> }) {
  const id = Number((await context.params).id);
  const inspection = db.prepare("SELECT * FROM inspections WHERE id=?").get(id);
  if (!inspection) return NextResponse.json({ error: "შემოწმება ვერ მოიძებნა." }, { status: 404 });
  const results = db.prepare("SELECT * FROM inspection_results WHERE inspection_id=? ORDER BY item_name_snapshot").all(id);
  const unexpectedItems = db.prepare("SELECT * FROM inspection_unexpected_items WHERE inspection_id=? ORDER BY item_name_snapshot").all(id);
  return NextResponse.json({ inspection, results, unexpectedItems });
}

export const GET = withDatabase(handleGET, false);
