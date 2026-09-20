import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getOperator } from "@/lib/db";
import { createPhotoSession, passwordsMatch } from "@/lib/photo-auth";

const headers = { "Cache-Control": "no-store, max-age=0" };
const globalRateLimit = globalThis as unknown as { eurocapPhotoLogins?: Map<string, { count: number; resetAt: number }> };
const attempts = globalRateLimit.eurocapPhotoLogins ?? new Map<string, { count: number; resetAt: number }>();
globalRateLimit.eurocapPhotoLogins = attempts;

export async function POST(request: NextRequest) {
  try {
    const client = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
    const now = Date.now();
    const attempt = attempts.get(client);
    if (attempt && attempt.resetAt > now && attempt.count >= 5) return NextResponse.json({ error: "ცდების ლიმიტი ამოიწურა. სცადეთ მოგვიანებით." }, { status: 429, headers });
    if (attempt && attempt.resetAt <= now) attempts.delete(client);
    const currentCount = attempt && attempt.resetAt > now ? attempt.count : 0;
    const parsed = z.object({ email: z.string().trim().email(), password: z.string().min(1) }).safeParse(await request.json());
    if (!parsed.success) { attempts.set(client, { count: currentCount + 1, resetAt: now + 15 * 60 * 1000 }); return NextResponse.json({ error: "ელფოსტა ან პაროლი არასწორია." }, { status: 401, headers }); }
    const input = parsed.data;
    const operator = getOperator();
    if (input.email.toLocaleLowerCase("en-US") !== operator.operator_email.toLocaleLowerCase("en-US") || !passwordsMatch(input.password)) {
      attempts.set(client, { count: currentCount + 1, resetAt: now + 15 * 60 * 1000 });
      return NextResponse.json({ error: "ელფოსტა ან პაროლი არასწორია." }, { status: 401, headers });
    }
    attempts.delete(client);
    const session = { role: "admin" as const, name: operator.operator_name, email: operator.operator_email };
    return NextResponse.json({ session: { ...session, token: createPhotoSession(session) } }, { headers });
  } catch (error) {
    console.error("EUROCAP photo login failed", error);
    return NextResponse.json({ error: "ფოტოებზე ავტორიზაცია ვერ მოხერხდა." }, { status: 500, headers });
  }
}
