import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiError } from "@/lib/http";
import { syncDataAfterWrite } from "@/lib/data-sync";
import { bulkUpdateInventory } from "@/lib/services";

export async function PATCH(request: NextRequest) {
  try {
    const result = bulkUpdateInventory(db, await request.json());
    try { await syncDataAfterWrite(); } catch (syncError) { console.error("GitHub data sync failed:", syncError); }
    return NextResponse.json(result);
  } catch (error) { return apiError(error); }
}
