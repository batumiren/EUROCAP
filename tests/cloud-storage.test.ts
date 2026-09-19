import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { BlobPreconditionFailedError, get, put } from "@vercel/blob";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { withDatabase } from "@/lib/cloud-db";
import { GET as inventoryGET, POST as inventoryPOST } from "@/app/api/inventory/route";
import { GET as roomsGET } from "@/app/api/rooms/route";
import { readJsonResponse } from "@/components/ui";

vi.mock("@vercel/blob", async importOriginal => ({ ...await importOriginal<typeof import("@vercel/blob")>(), get: vi.fn(), put: vi.fn() }));

const backup = JSON.parse(fs.readFileSync("backups/latest.json", "utf8"));
let durable: string | null;
let version: number;
beforeEach(() => {
  vi.stubEnv("VERCEL", "1"); vi.stubEnv("VERCEL_ENV", "production"); vi.stubEnv("BLOB_STORE_ID", "test-store");
  durable = null; version = 0;
  vi.mocked(get).mockImplementation(async () => durable === null ? null : ({
    statusCode: 200, stream: new Response(durable).body!, headers: new Headers(),
    blob: { etag: String(version) },
  }) as any);
  vi.mocked(put).mockImplementation(async (_key, body, options) => {
    if (durable !== null && (!options.allowOverwrite || options.ifMatch !== String(version))) throw new BlobPreconditionFailedError();
    durable = String(body); version++;
    return { etag: String(version) } as any;
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

const roomCount = withDatabase(async () => Response.json(db.prepare("SELECT count(*) AS count FROM rooms").get()));
const addRoom = withDatabase(async (name: string) => {
  db.prepare("INSERT INTO rooms (name) VALUES (?)").run(name);
  return Response.json({ ok: true });
}, true);

describe("durable cloud inventory", () => {
  it("restores the saved inventory and all history without creating a filesystem database", async () => {
    const mkdir = vi.spyOn(fs, "mkdirSync");
    const response = await inventoryGET(new NextRequest("https://example.test/api/inventory"));
    const result = await response.json();
    expect(response.status).toBe(200);
    expect(result.items.length).toBe(backup.tables.inventory.filter((i: any) => !i.archived_at).length);
    expect(mkdir).not.toHaveBeenCalled(); mkdir.mockRestore();
    expect((await (await roomsGET(new NextRequest("https://example.test/api/rooms"))).json()).rooms).toHaveLength(10);
    expect(put).not.toHaveBeenCalled();
  });
  it("persists edits across independent requests and preserves every historical table", async () => {
    expect((await addRoom("Cloud persistence test")).status).toBe(200);
    expect((await (await roomCount()).json()).count).toBe(11);
    for (const table of ["inventory", "inspections", "inspection_results", "inspection_unexpected_items", "transfers", "item_history"]) {
      expect(JSON.parse(durable!).tables[table]).toEqual(backup.tables[table]);
    }
    expect(get).toHaveBeenLastCalledWith("eurocap/production/latest.json", { access: "private", useCache: false });
  });
  it("saves a new inventory record and its audit history before acknowledging success", async () => {
    const response = await inventoryPOST(new NextRequest("https://example.test/api/inventory", { method: "POST", body: JSON.stringify({
      name: "Cloud test item", roomId: backup.tables.rooms[0].id, quantity: 2, condition: "კარგი", status: "საწყობში",
    }) }));
    expect(response.status).toBe(201);
    const { id } = await response.json();
    const saved = JSON.parse(durable!);
    expect(saved.tables.inventory.find((item: any) => item.id === id).name).toBe("Cloud test item");
    expect(saved.tables.item_history.at(-1).inventory_id).toBe(id);
  });
  it("rejects a competing edit rather than losing the successful edit", async () => {
    await addRoom("Initial cloud room");
    const results = await Promise.all([addRoom("Concurrent A"), addRoom("Concurrent B")]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    expect((await (await roomCount()).json()).count).toBe(12);
  });
  it("does not acknowledge success or retain unsaved data when cloud storage fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(put).mockRejectedValueOnce(new Error("Storage unavailable"));
    expect((await addRoom("Must not appear")).status).toBe(500);
    expect((await (await roomCount()).json()).count).toBe(10);
    log.mockRestore();
  });
  it("fails closed on corrupt stored data instead of reverting to the backup", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    durable = "invalid";
    expect((await addRoom("Must not overwrite")).status).toBe(500);
    expect(put).not.toHaveBeenCalled(); expect(durable).toBe("invalid");
    log.mockRestore();
  });
  it("does not save failed mutations", async () => {
    const failed = withDatabase(async () => {
      db.prepare("INSERT INTO rooms (name) VALUES ('Not saved')").run();
      return Response.json({ error: "Invalid operation" }, { status: 400 });
    }, true);
    expect((await failed()).status).toBe(400); expect(put).not.toHaveBeenCalled();
  });
  it("isolates preview branches from production", async () => {
    vi.stubEnv("VERCEL_ENV", "preview"); vi.stubEnv("VERCEL_GIT_COMMIT_REF", "fix/inventory");
    await roomCount();
    expect(get).toHaveBeenCalledWith("eurocap/preview/fix%2Finventory/latest.json", expect.anything());
  });
  it("returns a helpful error when Vercel has no storage connection", async () => {
    vi.stubEnv("BLOB_STORE_ID", ""); vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    expect((await roomCount()).status).toBe(503); expect(get).not.toHaveBeenCalled();
  });
});

describe("API response errors", () => {
  it("handles the empty HTTP 500 response seen on the original deployment", async () => {
    await expect(readJsonResponse(new Response(null, { status: 500 }))).rejects.toThrow("HTTP 500");
  });
  it("preserves actionable server messages", async () => {
    await expect(readJsonResponse(Response.json({ error: "Refresh before saving" }, { status: 409 }))).rejects.toThrow("Refresh before saving");
  });
});
