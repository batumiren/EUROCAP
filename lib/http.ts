import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AppError } from "@/lib/services";

export function apiError(error: unknown) {
  if (error instanceof AppError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof ZodError) return NextResponse.json({ error: "შეამოწმეთ შევსებული ველები." }, { status: 400 });
  const code = (error as { code?: string } | null)?.code;
  if (code === "23505") return NextResponse.json({ error: "ამ მნიშვნელობის ჩანაწერი უკვე არსებობს." }, { status: 409 });
  console.error("Inventory request failed", error instanceof Error ? error.name : "Unknown", code);
  return NextResponse.json({ error: "მოთხოვნის შედეგი ვერ დადასტურდა. სცადეთ ხელახლა." }, { status: 503 });
}
