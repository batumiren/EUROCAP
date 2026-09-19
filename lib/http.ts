import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AppError } from "@/lib/services";

export function apiError(error: unknown) {
  console.error(error);
  if (error instanceof AppError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof ZodError) return NextResponse.json({ error: "შეამოწმეთ შევსებული ველები." }, { status: 400 });
  if (error instanceof Error && error.message.includes("UNIQUE constraint")) return NextResponse.json({ error: "ამ მნიშვნელობის ჩანაწერი უკვე არსებობს." }, { status: 409 });
  return NextResponse.json({ error: "მოთხოვნის შესრულება ვერ მოხერხდა." }, { status: 500 });
}
