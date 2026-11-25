import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { get } from "@vercel/blob";
import { db } from "@/lib/db";
import { GET } from "@/app/api/inventory/[id]/photos/[photoId]/route";
import { resetDatabase } from "./postgres-test";

vi.mock("@vercel/blob", () => ({
  get: vi.fn(async () => ({ stream: new Response("test image").body, blob: { size: 10 } })),
}));

const hash = "a".repeat(64);
const context = { params: Promise.resolve({ id: "1", photoId: "1" }) };
const request = (headers?: HeadersInit) => new NextRequest("https://inventory.test/api/inventory/1/photos/1", { headers });

beforeEach(async () => {
  vi.clearAllMocks();
  await resetDatabase();
  await db.query(`INSERT INTO rooms (name) VALUES ('Test');
    INSERT INTO inventory (code,name,room_id,quantity,condition,status,registered_at,updated_at)
      VALUES ('EUR-000001','Test',1,1,'კარგი','გამოყენებაში','2026-11-25','2026-11-25');`);
  await db.query(`INSERT INTO inventory_photos (inventory_id,blob_path,filename,original_name,width,height,byte_size,content_type,uploader,uploaded_at,sha256)
    VALUES (1,'eurocap/inventory-photos/EUR-000001-38e95928-14a5-4b70-bcb1-7d4aaf127121.jpg','test.jpg','test.jpg',10,10,10,'image/jpeg','Test','2026-11-25',$1)`, [hash]);
});

it("returns a private ETag and revalidates unchanged photos without reading Blob", async () => {
  const image = await GET(request(), context);
  expect(image.status).toBe(200);
  expect(image.headers.get("cache-control")).toBe("private, no-cache");
  expect(image.headers.get("vary")).toBe("Cookie");
  expect(vi.mocked(get).mock.calls).toHaveLength(1);
  expect(get).toHaveBeenCalledWith(expect.any(String), { access: "private", useCache: true });
  expect((await GET(request({ "If-None-Match": `W/"${hash}"` }), context)).status).toBe(304);
  expect(get).toHaveBeenCalledTimes(1);
});

it("does not reuse a cached photo if its metadata no longer exists", async () => {
  await db.query("DELETE FROM inventory_photos WHERE id=1");
  expect((await GET(request({ "If-None-Match": `"${hash}"` }), context)).status).toBe(404);
  expect(get).not.toHaveBeenCalled();
});

it("does not enable Blob caching for an older mutable key", async () => {
  await db.query("UPDATE inventory_photos SET blob_path='eurocap/inventory-photos/EUR-000001.jpg' WHERE id=1");
  expect((await GET(request(), context)).status).toBe(200);
  expect(get).toHaveBeenCalledWith(expect.any(String), { access: "private", useCache: false });
});
