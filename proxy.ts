import { NextRequest, NextResponse } from "next/server";
import { authError, authJson, canAccess, getSessionUser, isSameOrigin, roleHome, SESSION_COOKIE } from "@/lib/auth";

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const api = pathname === "/api" || pathname.startsWith("/api/");
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !isSameOrigin(request)) return authJson({ error: "Invalid request origin." }, 403);
  if (pathname === "/api/auth/login") return NextResponse.next();
  try {
    const user = await getSessionUser(request.cookies.get(SESSION_COOKIE)?.value);
    if (pathname === "/login" && (request.method === "GET" || request.method === "HEAD")) return user ? NextResponse.redirect(new URL(roleHome(user.role), request.url)) : NextResponse.next();
    if (!user) return api || pathname === "/_next/image" ? authJson({ error: "Authentication required." }, 401) : NextResponse.redirect(new URL("/login", request.url), 303);
    if (!canAccess(user.role, pathname, request.method)) return api || pathname === "/_next/image" ? authJson({ error: "Forbidden." }, 403) : NextResponse.redirect(new URL(roleHome(user.role), request.url), 303);
    const response = NextResponse.next();
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) { return authError(error); }
}

// Keep image optimization and every API protected; exempt only framework assets and favicon.
export const config = { matcher: ["/((?!_next/static/|_next/webpack-hmr$|favicon.ico$).*)"] };
