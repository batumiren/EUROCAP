import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { AppError } from "@/lib/services";
import { apiError } from "@/lib/http";
import { IMPORT_MAX_BYTES, importInventoryRows, parseInventoryFile } from "@/lib/inventory-import";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user || user.role !== "admin") return NextResponse.json({ error: "Forbidden." }, { status: user ? 403 : 401 });
    const length = Number(request.headers.get("content-length"));
    if (length > IMPORT_MAX_BYTES + 65536) throw new AppError("ფაილი აღემატება 4 მბ-ს.", 413);
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size > IMPORT_MAX_BYTES) throw new AppError("აირჩიეთ XLSX ან CSV ფაილი, მაქსიმუმ 4 მბ.");
    const rows = await parseInventoryFile(file.name, Buffer.from(await file.arrayBuffer()));
    const apply = form.get("action") === "apply";
    const result = await importInventoryRows(db, rows, apply, String(form.get("revision") || ""));
    return NextResponse.json({ ...result, applied: apply });
  } catch (error) { return apiError(error); }
}
