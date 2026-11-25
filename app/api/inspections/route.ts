import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiError } from "@/lib/http";
import { saveInspection } from "@/lib/services";

export async function GET(request: NextRequest) {
  try {
    const roomId = request.nextUrl.searchParams.get("roomId");
    if (roomId) {
      const room = (await db.prepare("SELECT * FROM rooms WHERE id=? AND archived_at IS NULL").get(Number(roomId)));
      const items = (await db.prepare("SELECT i.*,r.name AS room_name FROM inventory i JOIN rooms r ON r.id=i.room_id WHERE i.room_id=? AND i.archived_at IS NULL ORDER BY i.name").all(Number(roomId)));
      return NextResponse.json({ room, items });
    }
    return NextResponse.json({ inspections: (await db.prepare("SELECT * FROM inspections ORDER BY created_at DESC").all()) });
  } catch (error) { return apiError(error); }
}

export async function POST(request: NextRequest) {
  try { const result = (await saveInspection(db, await request.json()));  return NextResponse.json(result, { status: 201 }); }
  catch (error) { return apiError(error); }
}
