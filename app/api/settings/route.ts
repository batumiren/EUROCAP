import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, getOperator } from "@/lib/db";
import { apiError } from "@/lib/http";

export async function GET() {
  try {
   return NextResponse.json((await getOperator()));
  } catch (error) { return apiError(error); }
}
export async function PATCH(request: NextRequest) {
  try {
    const input = z.object({ name: z.string().trim().min(1), email: z.string().trim().email() }).parse(await request.json());
    (await db.prepare("UPDATE settings SET operator_name=?,operator_email=?,demo_data=0 WHERE id=1").run(input.name, input.email));

    return NextResponse.json({ ok: true });
  } catch (error) { return apiError(error); }
}
