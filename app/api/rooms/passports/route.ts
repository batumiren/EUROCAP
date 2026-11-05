import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getRoomPassports, renderRoomPassports } from "@/lib/room-passports";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "Forbidden." }, { status: user ? 403 : 401 });
  const value = request.nextUrl.searchParams.get("roomId");
  const roomId = value === null ? undefined : Number(value);
  if (roomId !== undefined && (!Number.isSafeInteger(roomId) || roomId <= 0)) return NextResponse.json({ error: "აირჩიეთ სწორი ოთახი." }, { status: 400 });
  const passports = getRoomPassports(db, roomId);
  if (!passports.length) return NextResponse.json({ error: "აქტიური ოთახი ვერ მოიძებნა." }, { status: 404 });
  return new NextResponse(renderRoomPassports(passports), { headers: {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
  } });
}
