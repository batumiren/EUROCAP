import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiError } from "@/lib/http";
import { bulkUpdateInventory } from "@/lib/services";

export async function PATCH(request: NextRequest) {
  try {
    const result = (await bulkUpdateInventory(db, await request.json()));

    return NextResponse.json(result);
  } catch (error) { return apiError(error); }
}
