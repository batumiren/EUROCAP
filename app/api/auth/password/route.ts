import { NextRequest } from "next/server";
import { AuthError, authError, authJson, changePassword, isSameOrigin, readAuthBody, SESSION_COOKIE, setSessionCookie } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    if (!isSameOrigin(request)) throw new AuthError("Invalid request origin.", 403);
    const body = await readAuthBody(request);
    if (typeof body.username !== "string" || typeof body.currentPassword !== "string" || body.currentPassword.length > 1024 || typeof body.newPassword !== "string") throw new AuthError("username, currentPassword and newPassword are required.", 400);
    const result = await changePassword(request.cookies.get(SESSION_COOKIE)?.value, body.username, body.currentPassword, body.newPassword);
    const response = authJson(result);
    if (result.requiresLogin) setSessionCookie(response, "", 0);
    return response;
  } catch (error) { return authError(error); }
}
