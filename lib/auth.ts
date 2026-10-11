import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { BlobPreconditionFailedError, get, put } from "@vercel/blob";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export type AuthRole = "admin" | "check";
export type AuthUser = { username: AuthRole; role: AuthRole };
export const SESSION_COOKIE = "euro_session";
export const SESSION_SECONDS = 8 * 60 * 60;
const blobPath = "eurocap/auth/credentials-v1.json";
const deriveKey = (password: string, salt: string) => new Promise<Buffer>((resolve, reject) => {
  scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key));
});
const hashSchema = z.string().regex(/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
const accountSchema = z.object({ hash: hashSchema, revision: z.string().uuid() });
const documentSchema = z.object({
  version: z.literal(1),
  secret: z.string().regex(/^[a-f0-9]{64}$/),
  users: z.object({ admin: accountSchema, check: accountSchema }),
  revoked: z.array(z.object({ digest: z.string(), expires: z.number() })).default([]),
  attempts: z.object({ admin: z.object({ start: z.number(), count: z.number().int().nonnegative() }), check: z.object({ start: z.number(), count: z.number().int().nonnegative() }), unknown: z.object({ start: z.number(), count: z.number().int().nonnegative() }) }),
});
type CredentialDocument = z.infer<typeof documentSchema>;
const sessionSchema = z.object({ username: z.enum(["admin", "check"]), revision: z.string().uuid(), expires: z.number().int(), version: z.literal(1) }).strict();
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
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;
    const parsed = sessionSchema.safeParse(JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")));
    return parsed.success && parsed.data.expires > now && parsed.data.expires <= now + SESSION_SECONDS * 1000 ? parsed.data : null;
  } catch { return null; }
}

function signingSecret(document: CredentialDocument) {
  return process.env.BLOB_READ_WRITE_TOKEN
    ? createHmac("sha256", process.env.BLOB_READ_WRITE_TOKEN).update("eurocap/auth/session-v1").digest("hex")
    : document.secret;
}

async function initialDocument(): Promise<CredentialDocument> {
  const { randomUUID } = await import("node:crypto");
  return { version: 1, secret: randomBytes(32).toString("hex"), revoked: [], users: {
    admin: { hash: await hashPassword("admin"), revision: randomUUID() },
    check: { hash: await hashPassword("check"), revision: randomUUID() },
  }, attempts: { admin: { start: 0, count: 0 }, check: { start: 0, count: 0 }, unknown: { start: 0, count: 0 } } };
}

async function readBlob() {
  const result = await get(blobPath, { access: "private", useCache: false });
  if (!result) return null;
  if (result.statusCode !== 200) throw new Error("Auth storage unavailable");
  return { document: documentSchema.parse(await new Response(result.stream).json()), etag: result.blob.etag };
}

// Local writes are locked across processes and atomically renamed. Never use ephemeral Vercel disk.
async function withDocument<T>(operation: (document: CredentialDocument) => Promise<T>, write = false): Promise<T> {
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    let stored = await readBlob();
    if (!stored) {
      const initial = await initialDocument();
      try {
        await put(blobPath, JSON.stringify(initial), { access: "private", addRandomSuffix: false, allowOverwrite: false, contentType: "application/json" });
      } catch {
        // A concurrent bootstrap may win; only proceed if authoritative credentials now exist.
        stored = await readBlob();
        if (!stored) throw new Error("Auth initialization failed");
      }
      stored ??= await readBlob();
    }
    for (let retry = 0; retry < 5; retry++) {
      if (!stored) throw new Error("Auth storage unavailable");
      const result = await operation(stored.document);
      if (!write) return result;
      try {
        await put(blobPath, JSON.stringify(stored.document), { access: "private", addRandomSuffix: false, ifMatch: stored.etag, contentType: "application/json" });
        return result;
      } catch (error) {
        if (!(error instanceof BlobPreconditionFailedError)) throw error;
        stored = await readBlob();
      }
    }
    throw new AuthError("Authentication busy; retry shortly.", 503);
  }
  if (process.env.VERCEL) throw new AuthError("Private authentication storage is not configured.", 503);
  const directory = path.join(process.cwd(), "data");
  const filename = path.join(directory, "auth.json");
  const lock = path.join(directory, "auth.lock");
  await mkdir(directory, { recursive: true });
  let acquired = false;
  for (let retry = 0; retry < 100; retry++) {
    try { await mkdir(lock); acquired = true; break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  if (!acquired) throw new AuthError("Authentication busy; retry shortly.", 503);
  let temporary: string | undefined;
  try {
    let document: CredentialDocument;
    let initialized = false;
    try { document = documentSchema.parse(JSON.parse(await readFile(filename, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      document = await initialDocument(); initialized = true;
    }
    const result = await operation(document);
    if (write || initialized) {
      temporary = `${filename}.${randomBytes(8).toString("hex")}`;
      const file = await open(/* turbopackIgnore: true */ temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(document)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, filename);
      const directoryHandle = await open(directory, "r");
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    }
    return result;
  } finally {
    if (temporary) await rm(temporary, { force: true });
    await rm(lock, { recursive: true });
  }
}

export async function getSessionUser(token: string | undefined): Promise<AuthUser | null> {
  if (!token || token.length > 1024) return null;
  return withDocument(async document => {
    const session = verifySessionToken(token, signingSecret(document));
    if (!session || document.users[session.username].revision !== session.revision || document.revoked.some(entry => entry.digest === createHash("sha256").update(token).digest("hex"))) return null;
    return { username: session.username, role: session.username };
  });
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  const { cookies } = await import("next/headers");
  return getSessionUser((await cookies()).get(SESSION_COOKIE)?.value);
}

export async function revokeSession(token: string | undefined) {
  if (!token) return;
  await withDocument(async document => {
    const session = verifySessionToken(token, signingSecret(document));
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
  const username = normalizeUsername(usernameInput);
  await reserveAttempt(username);
  return withDocument(async document => {
    const valid = await verifyPassword(password, document.users[username ?? "admin"].hash);
    if (!username || !valid) throw new AuthError("Invalid username or password.", 401);
    const user = { username, role: username };
    const expires = Date.now() + SESSION_SECONDS * 1000;
    const token = signSession({ username, revision: document.users[username].revision, expires, version: 1 }, signingSecret(document));
    return { user, token, expires };
  });
}

export async function changePassword(token: string | undefined, usernameInput: unknown, currentPassword: string, newPassword: string) {
  const username = normalizeUsername(usernameInput);
  if (!username) throw new AuthError("Unknown username.", 400);
  if (newPassword.length < 10 || newPassword.length > 1024 || !/[A-Za-z]/.test(newPassword) || !/[0-9]/.test(newPassword) || !/[^A-Za-z0-9]/.test(newPassword)) {
    throw new AuthError("Password must be 10-1024 characters with a letter, number and special character.", 400);
  }
  const user = await getSessionUser(token);
  if (!user) throw new AuthError("Authentication required.", 401);
  if (user.role !== "admin") throw new AuthError("Forbidden.", 403);
  await reserveAttempt("admin");
  const hash = await hashPassword(newPassword);
  return withDocument(async document => {
    const session = verifySessionToken(token, signingSecret(document));
    if (!session || session.username !== "admin" || session.revision !== document.users.admin.revision) throw new AuthError("Authentication required.", 401);
    if (!await verifyPassword(currentPassword, document.users.admin.hash)) throw new AuthError("Incorrect current admin password.", 401);
    const { randomUUID } = await import("node:crypto");
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
