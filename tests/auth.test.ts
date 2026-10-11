import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const storage = vi.hoisted(() => ({ content: null as string | null, revision: 0, failPasswordSave: false, conflict: false }));
vi.mock("@vercel/blob", () => {
  class BlobPreconditionFailedError extends Error {}
  return {
    BlobPreconditionFailedError,
    get: vi.fn(async () => storage.content === null ? null : {
      statusCode: 200, stream: new Response(storage.content).body, blob: { etag: `W/"${storage.revision}"` },
    }),
    put: vi.fn(async (_path: string, content: string, options: { allowOverwrite?: boolean; ifMatch?: string }) => {
      if (storage.content !== null && options.allowOverwrite === false) throw new Error("Already exists");
      if (options.ifMatch && options.ifMatch !== `"${storage.revision}"`) throw new BlobPreconditionFailedError();
      if (storage.conflict && options.ifMatch) { storage.conflict = false; storage.revision++; throw new BlobPreconditionFailedError(); }
      if (storage.failPasswordSave && storage.content && JSON.stringify(JSON.parse(content).users) !== JSON.stringify(JSON.parse(storage.content).users)) throw new Error("Storage offline");
      storage.content = content; storage.revision++;
      return { etag: String(storage.revision) };
    }),
  };
});

import { authenticate, canAccess, changePassword, getSessionUser, hashPassword, isSameOrigin, normalizeUsername, SESSION_COOKIE, SESSION_SECONDS, signSession, verifyPassword, verifySessionToken } from "@/lib/auth";
import { proxy, config } from "@/proxy";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as passwordEndpoint } from "@/app/api/auth/password/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { get, put } from "@vercel/blob";

beforeEach(() => {
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-only-not-a-real-blob-token");
  storage.content = null; storage.revision = 0; storage.failPasswordSave = false; storage.conflict = false;
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllEnvs());

function request(path: string, method = "GET", token?: string, body?: object) {
  return new NextRequest(`https://inventory.example${path}`, { method, headers: {
    origin: "https://inventory.example", "content-type": "application/json", ...(token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}),
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
}

describe("auth primitives", () => {
  it("normalizes usernames only, rejects unknown users", () => {
    expect(normalizeUsername("AdMiN")).toBe("admin");
    expect(normalizeUsername("CHECK")).toBe("check");
    expect(normalizeUsername(" admin")).toBeNull();
    expect(normalizeUsername("owner")).toBeNull();
    expect(normalizeUsername(null)).toBeNull();
  });
  it("uses salted scrypt and case-sensitive verification", async () => {
    const hash = await hashPassword("Secret-password1!");
    expect(hash).not.toBe(await hashPassword("Secret-password1!"));
    expect(await verifyPassword("Secret-password1!", hash)).toBe(true);
    expect(await verifyPassword("secret-password1!", hash)).toBe(false);
    expect(await verifyPassword("anything", "invalid")).toBe(false);
  });
  it("validates signatures, payloads, expiry and malformed cookies", () => {
    const now = Date.now();
    const payload = { username: "admin" as const, revision: randomUUID(), expires: now + 1000, version: 1 as const };
    const token = signSession(payload, "test-secret");
    expect(verifySessionToken(token, "test-secret", now)).toEqual(payload);
    expect(verifySessionToken(token, "wrong-secret", now)).toBeNull();
    expect(verifySessionToken(token, "test-secret", now + 1000)).toBeNull();
    expect(verifySessionToken(signSession({ ...payload, expires: now + SESSION_SECONDS * 1000 + 1 }, "test-secret"), "test-secret", now)).toBeNull();
    expect(verifySessionToken(signSession({ ...payload, username: "owner" } as never, "test-secret"), "test-secret", now)).toBeNull();
    for (const invalid of [undefined, "", "x.y", `${token}.extra`, "!".repeat(2000)]) expect(verifySessionToken(invalid, "test-secret")).toBeNull();
  });
  it("restricts check to the exact page/method/API allowlist", () => {
    for (const [path, method] of [["/inspections", "GET"], ["/api/rooms", "GET"], ["/api/inventory/lookup", "GET"], ["/api/inspections", "GET"], ["/api/inspections", "POST"], ["/api/inspections/12", "GET"], ["/api/auth/logout", "POST"]]) expect(canAccess("check", path, method)).toBe(true);
    for (const [path, method] of [["/", "GET"], ["/inspections/12", "GET"], ["/inspections", "POST"], ["/api/rooms", "POST"], ["/api/inspections/12", "DELETE"], ["/api/inventory/1/photos/2", "GET"], ["/api/auth/password", "POST"], ["/_next/image", "GET"]]) expect(canAccess("check", path, method)).toBe(false);
    expect(canAccess("admin", "/api/inventory", "DELETE")).toBe(true);
    expect(canAccess("owner" as never, "/inspections", "GET")).toBe(false);
  });
  it("rejects missing, foreign and forwarded-host spoofed origins", () => {
    expect(isSameOrigin(request("/api/auth/login", "POST"))).toBe(true);
    expect(isSameOrigin(new Request("http://localhost:3000/api/auth/login", { headers: { origin: "http://127.0.0.1:3000", host: "127.0.0.1:3000" } }))).toBe(true);
    for (const origin of ["https://attacker.example", "null", "https://inventory.example.attacker.example"]) {
      expect(isSameOrigin(new Request("https://inventory.example/api/auth/login", { headers: { origin, "x-forwarded-host": "attacker.example" } }))).toBe(false);
    }
    expect(isSameOrigin(new Request("https://inventory.example"))).toBe(false);
  });
});

describe("private credential storage and sessions", () => {
  it("bootstraps once without overwrite under concurrent logins", async () => {
    const sessions = await Promise.all([authenticate("ADMIN", "admin"), authenticate("check", "check")]);
    expect(await getSessionUser(sessions[0].token)).toEqual({ username: "admin", role: "admin" });
    expect(await getSessionUser(sessions[1].token)).toEqual({ username: "check", role: "check" });
    expect(vi.mocked(put).mock.calls.filter(call => call[2]?.allowOverwrite === false).length).toBeGreaterThanOrEqual(1);
    expect(vi.mocked(get).mock.calls.every(call => call[1].useCache === false && call[1].access === "private")).toBe(true);
    expect(storage.content).not.toContain('"hash":"admin"');
  });
  it("retries conditional write conflicts and invalidates target sessions", async () => {
    const admin = await authenticate("admin", "admin");
    const check = await authenticate("check", "check");
    storage.conflict = true;
    expect(await changePassword(admin.token, "CHECK", "admin", "New-password123!")).toEqual({ ok: true, username: "check", requiresLogin: false });
    expect(await getSessionUser(check.token)).toBeNull();
    expect(await getSessionUser(admin.token)).not.toBeNull();
    await expect(authenticate("check", "check")).rejects.toMatchObject({ status: 401 });
    expect((await authenticate("ChEcK", "New-password123!")).user.role).toBe("check");
  });
  it("invalidates admin sessions and requires old admin confirmation", async () => {
    const admin = await authenticate("admin", "admin");
    await expect(changePassword(admin.token, "admin", "ADMIN", "New-password123!")).rejects.toMatchObject({ status: 401 });
    await expect(changePassword(admin.token, "admin", "admin", "short")).rejects.toMatchObject({ status: 400 });
    expect((await changePassword(admin.token, "admin", "admin", "New-password123!")).requiresLogin).toBe(true);
    expect(await getSessionUser(admin.token)).toBeNull();
  });
  it("never reports successful password updates when durable save fails", async () => {
    const admin = await authenticate("admin", "admin");
    storage.failPasswordSave = true;
    await expect(changePassword(admin.token, "check", "admin", "New-password123!")).rejects.toThrow("Storage offline");
    expect((await authenticate("check", "check")).user.role).toBe("check");
  });
  it("persists a bounded per-account attempt limit", async () => {
    for (let i = 0; i < 10; i++) await expect(authenticate("admin", "wrong")).rejects.toMatchObject({ status: 401 });
    await expect(authenticate("ADMIN", "admin")).rejects.toMatchObject({ status: 429 });
    expect(JSON.parse(storage.content!).attempts.admin.count).toBe(10);
  });
  it("does not replace corrupt existing credentials or fall back when Blob fails", async () => {
    storage.content = '{"version":1,"users":{}}';
    await expect(authenticate("admin", "admin")).rejects.toThrow();
    expect(put).not.toHaveBeenCalled();
    vi.mocked(get).mockRejectedValueOnce(new Error("Storage offline"));
    expect((await proxy(request("/api/rooms", "GET", "malformed.cookie"))).status).toBe(503);
  });
  it("refuses ephemeral Vercel local storage when the token is absent", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    vi.stubEnv("VERCEL", "1");
    await expect(authenticate("admin", "admin")).rejects.toMatchObject({ status: 503 });
    expect(put).not.toHaveBeenCalled();
  });
});

describe("proxy and API contracts", () => {
  it("matches all protected routes, images and prefetches but not framework assets", () => {
    for (const url of ["/", "/api/rooms", "/api/inventory/1/photos/2", "/_next/image?url=x", "/settings", "/login"]) expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(true);
    expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url: "/_next/static/chunk.js" })).toBe(false);
    expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url: "/settings", headers: { "next-router-prefetch": "1" } })).toBe(true);
  });
  it("returns JSON 401 for anonymous APIs/images and redirects pages", async () => {
    expect((await proxy(request("/api/rooms"))).status).toBe(401);
    expect((await proxy(request("/_next/image"))).status).toBe(401);
    expect((await proxy(request("/"))).headers.get("location")).toBe("https://inventory.example/login");
    expect((await proxy(request("/login"))).status).toBe(200);
    const check = await authenticate("check", "check");
    expect((await proxy(request("/login", "GET", check.token))).headers.get("location")).toBe("https://inventory.example/inspections");
    expect((await proxy(request("/api/settings", "GET", check.token))).status).toBe(403);
    expect((await proxy(request("/api/inspections", "POST", check.token))).status).toBe(200);
  });
  it("revalidates authoritative revisions on every protected request", async () => {
    const check = await authenticate("check", "check");
    expect((await proxy(request("/api/rooms", "GET", check.token))).status).toBe(200);
    const document = JSON.parse(storage.content!); document.users.check.revision = randomUUID(); storage.content = JSON.stringify(document);
    expect((await proxy(request("/api/rooms", "GET", check.token))).status).toBe(401);
  });
  it("sets httpOnly cookies and exposes only safe login data; clears on logout", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const response = await login(request("/api/auth/login", "POST", undefined, { username: "ADMIN", password: "admin" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, user: { username: "admin", role: "admin" }, redirectTo: "/" });
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=lax");
    expect(response.headers.get("set-cookie")).toContain("Secure");
    const session = await authenticate("check", "check");
    expect((await logout(request("/api/auth/logout", "POST", session.token))).headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await getSessionUser(session.token)).toBeNull();
    const foreign = request("/api/auth/login", "POST", undefined, { username: "admin", password: "admin" }); foreign.headers.set("origin", "https://attacker.example");
    expect((await login(foreign)).status).toBe(403);
  });
  it("denies check password changes even when handler is invoked directly", async () => {
    const check = await authenticate("check", "check");
    expect((await passwordEndpoint(request("/api/auth/password", "POST", check.token, { username: "check", currentPassword: "admin", newPassword: "New-password123!" }))).status).toBe(403);
  });
});
