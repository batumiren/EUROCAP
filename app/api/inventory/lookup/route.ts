import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code")?.trim().toUpperCase();
  if (!code) return NextResponse.json({ error: "შეიყვანეთ ნივთის კოდი." }, { status: 400 });
  const item = db.prepare(`SELECT i.*,r.name AS room_name FROM inventory i JOIN rooms r ON r.id=i.room_id
    WHERE upper(i.code)=? AND i.archived_at IS NULL`).get(code);
  if (!item) return NextResponse.json({ error: "ამ კოდით აქტიური ნივთი ვერ მოიძებნა." }, { status: 404 });
  return NextResponse.json({ item });
}
