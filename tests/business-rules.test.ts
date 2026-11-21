import { resetDatabase } from "./postgres-test";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { bulkUpdateInventory, createInventoryItems, saveInspection, saveTransfers } from "@/lib/services";
import { photoBlobPath } from "@/lib/inventory-photo-data";

let roomA: number; let roomB: number; let itemA: number; let itemB: number; let itemC: number;
beforeEach(async () => {
  await resetDatabase();
  (await db.prepare("INSERT INTO settings (id,operator_name,operator_email,demo_data) VALUES (1,'ტესტ ოპერატორი','test@euro.local',0)").run());
  roomA = Number((await db.prepare("INSERT INTO rooms (name) VALUES ('ოთახი A')").insert()).id);
  roomB = Number((await db.prepare("INSERT INTO rooms (name) VALUES ('ოთახი B')").insert()).id);
  const now = new Date().toISOString();
  const add = db.prepare("INSERT INTO inventory (code,name,room_id,quantity,condition,status,notes,responsible_person,registered_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
  itemA = Number((await add.insert("EUR-000001", "კომპიუტერი", roomA, 6, "კარგი", "გამოყენებაში", "", "ანა", now, now)).id);
  itemB = Number((await add.insert("EUR-000002", "მონიტორი", roomA, 3, "კარგი", "გამოყენებაში", "", "ანა", now, now)).id);
  itemC = Number((await add.insert("EUR-000003", "პრინტერი", roomB, 1, "კარგი", "გამოყენებაში", "", "გიორგი", now, now)).id);
});

describe("room inspections", () => {
  it("keeps unchecked records unchanged and does not apply quantity discrepancies to stock", async () => {
    const items = (await db.prepare("SELECT * FROM inventory ORDER BY id").all()) as any[];
    (await saveInspection(db, { roomId: roomA, items: [
      { inventoryId: itemA, openedUpdatedAt: items[0].updated_at, checked: true, actualQuantity: 4, observedCondition: "დაზიანებული", notes: "ორი აკლია" },
      { inventoryId: itemB, openedUpdatedAt: items[1].updated_at, checked: false, actualQuantity: null, observedCondition: null, notes: "" },
    ], unexpectedItems: [{ inventoryId: itemC, openedUpdatedAt: items[2].updated_at }] }));
    const a = (await db.prepare("SELECT * FROM inventory WHERE id=?").get(itemA)) as any;
    const b = (await db.prepare("SELECT * FROM inventory WHERE id=?").get(itemB)) as any;
    const inspection = (await db.prepare("SELECT * FROM inspections").get()) as any;
    expect(a.quantity).toBe(6);
    expect(a.condition).toBe("დაზიანებული");
    expect(a.last_inspected_at).toBeTruthy();
    expect(b.quantity).toBe(3);
    expect(b.last_inspected_at).toBeNull();
    expect(inspection.checked_count).toBe(1);
    expect(inspection.expected_count).toBe(2);
    expect(inspection.quantity_discrepancies).toBe(1);
    expect(((await db.prepare("SELECT checked FROM inspection_results WHERE inventory_id=?").get(itemB)) as any).checked).toBe(0);
    const unexpected = (await db.prepare("SELECT * FROM inspection_unexpected_items").get()) as any;
    expect(unexpected.item_code_snapshot).toBe("EUR-000003");
    expect(unexpected.assigned_room_snapshot).toBe("ოთახი B");
  });
});

describe("inventory creation", () => {
  it("creates one sequentially coded record per requested unit", async () => {
    const result = (await createInventoryItems(db, {
      name: "სკამი",
      roomId: roomA,
      quantity: 10,
      condition: "კარგი",
      status: "გამოყენებაში",
      notes: "ახალი პარტია",
      responsiblePerson: "ანა",
    }));
    const rows = (await db.prepare("SELECT * FROM inventory WHERE id IN (SELECT unnest(?::integer[])) ORDER BY id").all(result.ids)) as any[];

    expect(result.created).toBe(10);
    expect(result.codes).toEqual(Array.from({ length: 10 }, (_, index) => `EUR-${String(index + 4).padStart(6, "0")}`));
    expect(rows).toHaveLength(10);
    expect(rows.every((row) => row.name === "სკამი" && row.quantity === 1 && row.room_id === roomA)).toBe(true);
    expect(((await db.prepare("SELECT count(*)::integer AS count FROM item_history WHERE inventory_id IN (SELECT unnest(?::integer[]))").get(result.ids)) as any).count).toBe(10);
  });
});

describe("transfers", () => {
  it("moves selected records together and allows an empty reason", async () => {
    const addPhoto = db.prepare(`INSERT INTO inventory_photos
      (inventory_id,blob_path,filename,original_name,width,height,byte_size,content_type,uploader,uploaded_at,sha256,sort_order)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,0)`);
    const now = new Date().toISOString();
    (await addPhoto.run(itemA, photoBlobPath("EUR-000001", 0), "EUR-000001.jpg", "კომპიუტერი.jpg", 800, 600, 90000, "image/jpeg", "ტესტი", now, "a".repeat(64)));
    const result = (await saveTransfers(db, { sourceRoomId: roomA, inventoryIds: [itemA, itemB], destinationRoomId: roomB }));
    const rows = (await db.prepare("SELECT * FROM inventory ORDER BY id").all()) as any[];

    expect(result.created).toBe(2);
    expect(rows.reduce((sum, row) => sum + row.quantity, 0)).toBe(10);
    expect(rows).toHaveLength(3);
    expect(rows.filter(row => [itemA, itemB].includes(row.id)).every(row => row.room_id === roomB && row.responsible_person === "ანა")).toBe(true);
    expect(((await db.prepare("SELECT count(*)::integer AS count FROM transfers WHERE reason='' ").get()) as any).count).toBe(2);
    expect(((await db.prepare("SELECT count(*)::integer AS count FROM inventory_photos WHERE inventory_id=?").get(itemA)) as any).count).toBe(1);
  });

  it("stores optional comments without sender or recipient fields", async () => {
    (await saveTransfers(db, { sourceRoomId: roomA, inventoryIds: [itemA], destinationRoomId: roomB, reason: "ოთახის განახლება" }));
    expect((await db.prepare("SELECT sender,recipient,reason FROM transfers").get())).toEqual({ sender: "", recipient: "", reason: "ოთახის განახლება" });
  });

  it("rejects a mixed-room selection without moving any records", async () => {
    await expect(saveTransfers(db, { sourceRoomId: roomA, inventoryIds: [itemA, itemC], destinationRoomId: roomB, sender: "ანა", recipient: "გიორგი", reason: "" })).rejects.toThrow("საწყის ოთახში");
    expect(((await db.prepare("SELECT room_id FROM inventory WHERE id=?").get(itemA)) as any).room_id).toBe(roomA);
    expect(((await db.prepare("SELECT count(*)::integer AS count FROM transfers").get()) as any).count).toBe(0);
  });
});

describe("bulk inventory updates", () => {
  it("moves multiple records without changing units and records transfer history", async () => {
    const before = ((await db.prepare("SELECT sum(quantity)::integer AS units FROM inventory").get()) as any).units;
    const result = (await bulkUpdateInventory(db, { inventoryIds: [itemA, itemB], roomId: roomB, condition: "დამაკმაყოფილებელი", responsiblePerson: "მარიამი", reason: "ოთახის მოწყობა" }));
    const moved = (await db.prepare("SELECT * FROM inventory WHERE id IN (?,?) ORDER BY id").all(itemA, itemB)) as any[];
    expect(result.updated).toBe(2);
    expect(moved.every((item) => item.room_id === roomB && item.condition === "დამაკმაყოფილებელი" && item.responsible_person === "მარიამი")).toBe(true);
    expect(((await db.prepare("SELECT sum(quantity)::integer AS units FROM inventory").get()) as any).units).toBe(before);
    expect(((await db.prepare("SELECT count(*)::integer AS count FROM transfers").get()) as any).count).toBe(2);
    expect(((await db.prepare("SELECT count(*)::integer AS count FROM item_history WHERE action='მასობრივი გადაადგილება'").get()) as any).count).toBe(2);
  });
});
