import { withDatabase } from "@/lib/cloud-db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, getOperator } from "@/lib/db";
import { apiError } from "@/lib/http";
import { scheduleDataSync } from "@/lib/data-sync";

async function handleGET() { return NextResponse.json(getOperator()); }
async function handlePATCH(request: NextRequest) {
  try {
    const input = z.object({ name: z.string().trim().min(1), email: z.string().trim().email() }).parse(await request.json());
    db.prepare("UPDATE settings SET operator_name=?,operator_email=?,demo_data=0 WHERE id=1").run(input.name, input.email);
    scheduleDataSync();
    return NextResponse.json({ ok: true });
  } catch (error) { return apiError(error); }
}

export const GET = withDatabase(handleGET, false);
export const PATCH = withDatabase(handlePATCH, true);
