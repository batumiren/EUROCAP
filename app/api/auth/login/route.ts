import { NextRequest } from "next/server";
import { authenticate, AuthError, authError, authJson, isSameOrigin, readAuthBody, roleHome, setSessionCookie } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    if (!isSameOrigin(request)) throw new AuthError("Invalid request origin.", 403);
    const body = await readAuthBody(request);
    if (typeof body.username !== "string" || body.username.length > 128 || typeof body.password !== "string" || body.password.length > 1024) throw new AuthError("Invalid credentials format.", 400);
    const session = await authenticate(body.username, body.password);
    const response = authJson({ ok: true, user: session.user, redirectTo: roleHome(session.user.role) });
    setSessionCookie(response, session.token, session.expires);
    return response;
  } catch (error) { return authError(error); }
}
