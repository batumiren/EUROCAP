import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, expect, it } from "vitest";
import { GET, POST } from "@/app/api/inventory/route";
import { db } from "@/lib/db";
import { resetDatabase } from "./postgres-test";

const item = { name: "სატესტო მერხი", roomId: 1, quantity: 10, condition: "კარგი", status: "გამოყენებაში" };
const route = "https://inventory.test/api/inventory";
const post = (key = randomUUID(), payload = item) => POST(new NextRequest(route, {
  method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(payload),
}));

beforeEach(async () => {
  await resetDatabase();
  await db.query("INSERT INTO rooms (name) VALUES ('408'); INSERT INTO settings (id,operator_name,operator_email) VALUES (1,'Test','test@example.test')");
});

it("commits independent simultaneous saves, including deliberate identical submissions", async () => {
  const responses = await Promise.all([post(), post()]);
  expect(responses.map(response => response.status)).toEqual([201, 201]);
  const { items } = await (await GET(new NextRequest(route))).json();
  expect(items).toHaveLength(20);
  expect(new Set(items.map((row: { code: string }) => row.code)).size).toBe(20);
  expect(items.every((row: { quantity: number }) => row.quantity === 1)).toBe(true);
  expect((await db.query("SELECT * FROM item_history")).rowCount).toBe(20);
});

it("deduplicates simultaneous clicks and a retry after a discarded response", async () => {
  const key = randomUUID();
  const [discarded, second] = await Promise.all([post(key), post(key)]);
  expect(discarded.status).toBe(201); // Simulate the client never receiving this body.
  const receipt = await second.json();
  expect(receipt.created).toBe(10);
  expect(await (await post(key)).json()).toEqual(receipt);
  expect((await post(key, { ...item, quantity: 11 })).status).toBe(409);
  expect((await db.query("SELECT * FROM inventory")).rowCount).toBe(10);
  expect((await db.query("SELECT * FROM item_history")).rowCount).toBe(10);
  expect((await db.query("SELECT * FROM inventory_submissions")).rowCount).toBe(1);
});

it("rolls back items and receipt if a database error prevents writing history, and permits retry", async () => {
  const key = randomUUID();
  await db.query("ALTER TABLE item_history ADD CONSTRAINT reject_test_history CHECK (action <> 'ჩანაწერის შექმნა')");
  try {
    expect((await post(key)).status).toBe(503);
    for (const table of ["inventory", "item_history", "inventory_submissions"]) {
      expect((await db.query(`SELECT * FROM ${table}`)).rowCount).toBe(0);
    }
  } finally { await db.query("ALTER TABLE item_history DROP CONSTRAINT reject_test_history"); }
  expect((await post(key)).status).toBe(201);
  expect((await db.query("SELECT * FROM inventory")).rowCount).toBe(10);
});
