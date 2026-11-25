import { createHash, createHmac, randomUUID, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import { documentSchema, hashSchema, type CredentialDocument } from "@/lib/auth-document";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export type AuthRole = "admin" | "check";
export type AuthUser = { username: AuthRole; role: AuthRole };
export const SESSION_COOKIE = "euro_session";
export const SESSION_SECONDS = 8 * 60 * 60;
export const VERIFIED_USER_HEADER = "x-eurocap-verified-user";
const deriveKey = (password: string, salt: string) => new Promise<Buffer>((resolve, reject) => {
  scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key));
});
const sessionSchema = z.object({ username: z.enum(["admin", "check"]), revision: z.string().uuid(), expires: z.number().int(), version: z.literal(1), nonce: z.string().uuid().optional() }).strict();
type Session = z.infer<typeof sessionSchema>;

export class AuthError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export function normalizeUsername(value: unknown): AuthRole | null {
  if (typeof value !== "string") return null;
  const username = value.toLowerCase();
  return username === "admin" || username === "check" ? username : null;
}

export function roleHome(role: AuthRole) { return role === "admin" ? "/" : "/inspections"; }

export function canAccess(role: AuthRole, pathname: string, method: string): boolean {
  if (role === "admin") return true;
  if (role !== "check") return false;
  if (pathname === "/api/auth/logout") return method === "POST";
  if (pathname === "/api/rooms" || pathname === "/api/inventory/lookup") return method === "GET";
  if (pathname === "/api/inspections") return method === "GET" || method === "POST";
  if (/^\/api\/inspections\/[^/]+$/.test(pathname)) return method === "GET";
  return pathname === "/inspections" && (method === "GET" || method === "HEAD");
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const key = await deriveKey(password, salt);
  return `scrypt$${salt}$${key.toString("hex")}`;
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (!hashSchema.safeParse(hash).success || password.length > 1024) return false;
  const [, salt, expected] = hash.split("$");
  const actual = await deriveKey(password, salt);
  return timingSafeEqual(actual, Buffer.from(expected, "hex"));
}

export function signSession(session: Session, secret: string): string {
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

export function verifySessionToken(token: string | undefined, secret: string, now = Date.now()): Session | null {
  if (!token || token.length > 1024) return null;
  try {
    const parts = token.split(".");
    if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) return null;
    const expected = createHmac("sha256", secret).update(parts[0]).digest();
    const signature = Buffer.from(parts[1], "base64url");
    if (signature.toString("base64url") !== parts[1] || signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;
    const parsed = sessionSchema.safeParse(JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")));
    return parsed.success && parsed.data.expires > now && parsed.data.expires <= now + SESSION_SECONDS * 1000 ? parsed.data : null;
  } catch { return null; }
}

function signingSecret() {
  const secret = process.env.AUTH_SESSION_SECRET;
  if (!secret || !/^[a-f0-9]{64}$/i.test(secret)) throw new AuthError("Authentication storage unavailable.", 503);
  return secret;
}

async function withDocument<T>(operation: (document: CredentialDocument) => Promise<T>, write = false): Promise<T> {
  const use = async (database: typeof db) => {
    const { rows } = await database.query(`SELECT document FROM eurocap_auth WHERE id=1${write ? " FOR UPDATE" : ""}`);
    if (!rows[0]) throw new AuthError("Authentication storage unavailable.", 503);
    const document = documentSchema.parse(rows[0].document);
    const result = await operation(document);
    if (write) await database.query("UPDATE eurocap_auth SET document=$1 WHERE id=1", [document]);
    return result;
  };
  return write ? db.transaction(use, false) : use(db);
}

function activeSession(document: CredentialDocument, token: string, session: Session) {
  return document.users[session.username].revision === session.revision &&
    !document.revoked.some(entry => entry.digest === createHash("sha256").update(token).digest("hex"));
}

export async function getSessionUser(token: string | undefined): Promise<AuthUser | null> {
  if (!token) return null;
  const session = verifySessionToken(token, signingSecret());
  if (!session) return null;
  return withDocument(async document => activeSession(document, token, session)
    ? { username: session.username, role: session.username } : null);
}

// Proxy strips client values and forwards this proof only after checking Neon.
// It is bound to the cookie, short-lived, and never returned as a response header.
export function attestUser(user: AuthUser, token: string, now = Date.now()) {
  const payload = `${user.username}.${now}`;
  const mac = createHmac("sha256", signingSecret()).update(`proxy-v1:${payload}:${token}`).digest("hex");
  return `${payload}.${mac}`;
}

export function readAttestedUser(proof: string | null, token: string | undefined, now = Date.now()): AuthUser | null {
  if (!proof || !token) return null;
  const match = /^(admin|check)\.(\d{13})\.([a-f0-9]{64})$/.exec(proof);
  if (!match || Math.abs(now - Number(match[2])) > 10000) return null;
  const role = match[1] as AuthRole;
  const expected = attestUser({ username: role, role }, token, Number(match[2]));
  return timingSafeEqual(Buffer.from(proof), Buffer.from(expected)) ? { username: role, role } : null;
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  const { cookies, headers } = await import("next/headers");
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return readAttestedUser((await headers()).get(VERIFIED_USER_HEADER), token) ?? getSessionUser(token);
}

export async function revokeSession(token: string | undefined) {
  if (!token) return;
  await withDocument(async document => {
    const session = verifySessionToken(token, signingSecret());
    if (!session) return;
    const digest = createHash("sha256").update(token).digest("hex");
    document.revoked = document.revoked.filter(entry => entry.expires > Date.now() && entry.digest !== digest);
    document.revoked.push({ digest, expires: session.expires });
  }, true);
}

async function reserveAttempt(username: AuthRole | null) {
  const allowed = await withDocument(async document => {
    const attempt = document.attempts[username ?? "unknown"];
    const now = Date.now();
    if (now - attempt.start >= 15 * 60 * 1000) { attempt.start = now; attempt.count = 0; }
    if (attempt.count >= 10) return false;
    attempt.count++;
    return true;
  }, true);
  if (!allowed) throw new AuthError("Too many attempts. Retry in 15 minutes.", 429);
}

export async function authenticate(usernameInput: unknown, password: string) {
  const secret = signingSecret();
  const username = normalizeUsername(usernameInput);
  await reserveAttempt(username);
  return withDocument(async document => {
    const valid = await verifyPassword(password, document.users[username ?? "admin"].hash);
    if (!username || !valid) throw new AuthError("Invalid username or password.", 401);
    const user = { username, role: username };
    const expires = Date.now() + SESSION_SECONDS * 1000;
    const token = signSession({ username, revision: document.users[username].revision, expires, version: 1, nonce: randomUUID() }, secret);
    return { user, token, expires };
  });
}

export async function changePassword(token: string | undefined, usernameInput: unknown, currentPassword: string, newPassword: string) {
  const username = normalizeUsername(usernameInput);
  if (!username) throw new AuthError("Unknown username.", 400);
  if (newPassword.length < 10 || newPassword.length > 1024 || !/[A-Za-z]/.test(newPassword) || !/[0-9]/.test(newPassword) || !/[^A-Za-z0-9]/.test(newPassword)) {
    throw new AuthError("Password must be 10-1024 characters with a letter, number and special character.", 400);
  }
  const session = token ? verifySessionToken(token, signingSecret()) : null;
  if (!session || !token) throw new AuthError("Authentication required.", 401);
  if (session.username !== "admin") throw new AuthError("Forbidden.", 403);
  await reserveAttempt("admin");
  const hash = await hashPassword(newPassword);
  return withDocument(async document => {
    if (!activeSession(document, token, session)) throw new AuthError("Authentication required.", 401);
    if (!await verifyPassword(currentPassword, document.users.admin.hash)) throw new AuthError("Incorrect current admin password.", 401);
    document.users[username] = { hash, revision: randomUUID() };
    return { ok: true, username, requiresLogin: username === "admin" };
  }, true);
}

export function isSameOrigin(request: Request): boolean {
  // Next dev normalizes request.url to localhost; Host preserves the browser's origin.
  // Never accept forwarded-host/proto lists as additional allowed origins.
  const origin = request.headers.get("origin");
  const url = new URL(request.url);
  const host = request.headers.get("host");
  return origin !== null && (origin === url.origin || (host !== null && origin === `${url.protocol}//${host}`));
}

export function authJson(body: object, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

export function authError(error: unknown) {
  return error instanceof AuthError ? authJson({ error: error.message }, error.status) : authJson({ error: "Authentication storage unavailable." }, 503);
}

export function setSessionCookie(response: NextResponse, token: string, expires: number) {
  response.cookies.set(SESSION_COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", expires: new Date(expires), maxAge: token ? SESSION_SECONDS : 0 });
}

export async function readAuthBody(request: NextRequest): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new AuthError("JSON body required.", 400);
  const reader = request.body?.getReader();
  if (!reader) throw new AuthError("JSON body required.", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 8192) { await reader.cancel(); throw new AuthError("Request too large.", 413); }
    chunks.push(value);
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch { throw new AuthError("Invalid JSON body.", 400); }
}
