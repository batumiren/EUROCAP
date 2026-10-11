import { NextRequest } from "next/server";
import { AuthError, authError, authJson, isSameOrigin, revokeSession, SESSION_COOKIE, setSessionCookie } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return authError(new AuthError("Invalid request origin.", 403));
  try {
    await revokeSession(request.cookies.get(SESSION_COOKIE)?.value);
    const response = authJson({ ok: true, redirectTo: "/login" });
    setSessionCookie(response, "", 0);
    return response;
  } catch (error) { return authError(error); }
}
