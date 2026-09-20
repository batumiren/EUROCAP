import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { bulkUpdateInventory, saveInspection, saveTransfer } from "@/lib/services";
import { photoBlobPath } from "@/lib/inventory-photo-data";

let roomA: number; let roomB: number; let itemA: number; let itemB: number; let itemC: number;
beforeEach(() => {
  db.exec("DELETE FROM item_history; DELETE FROM transfers; DELETE FROM inspection_unexpected_items; DELETE FROM inspection_results; DELETE FROM inspections; DELETE FROM inventory_photos; DELETE FROM photo_cleanup_queue; DELETE FROM inventory; DELETE FROM rooms; DELETE FROM settings;");
  db.prepare("INSERT INTO settings (id,operator_name,operator_email,demo_data) VALUES (1,'ტესტ ოპერატორი','test@euro.local',0)").run();
  roomA = Number(db.prepare("INSERT INTO rooms (name) VALUES ('ოთახი A')").run().lastInsertRowid);
  roomB = Number(db.prepare("INSERT INTO rooms (name) VALUES ('ოთახი B')").run().lastInsertRowid);
  const now = new Date().toISOString();
  const add = db.prepare("INSERT INTO inventory (code,name,room_id,quantity,condition,status,notes,responsible_person,registered_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
  itemA = Number(add.run("EUR-000001", "კომპიუტერი", roomA, 6, "კარგი", "გამოყენებაში", "", "ანა", now, now).lastInsertRowid);
  itemB = Number(add.run("EUR-000002", "მონიტორი", roomA, 3, "კარგი", "გამოყენებაში", "", "ანა", now, now).lastInsertRowid);
  itemC = Number(add.run("EUR-000003", "პრინტერი", roomB, 1, "კარგი", "გამოყენებაში", "", "გიორგი", now, now).lastInsertRowid);
});

describe("room inspections", () => {
  it("keeps unchecked records unchanged and does not apply quantity discrepancies to stock", () => {
    const items = db.prepare("SELECT * FROM inventory ORDER BY id").all() as any[];
    saveInspection(db, { roomId: roomA, items: [
      { inventoryId: itemA, openedUpdatedAt: items[0].updated_at, checked: true, actualQuantity: 4, observedCondition: "დაზიანებული", notes: "ორი აკლია" },
      { inventoryId: itemB, openedUpdatedAt: items[1].updated_at, checked: false, actualQuantity: null, observedCondition: null, notes: "" },
    ], unexpectedItems: [{ inventoryId: itemC, openedUpdatedAt: items[2].updated_at }] });
    const a = db.prepare("SELECT * FROM inventory WHERE id=?").get(itemA) as any;
    const b = db.prepare("SELECT * FROM inventory WHERE id=?").get(itemB) as any;
    const inspection = db.prepare("SELECT * FROM inspections").get() as any;
    expect(a.quantity).toBe(6);
    expect(a.condition).toBe("დაზიანებული");
    expect(a.last_inspected_at).toBeTruthy();
    expect(b.quantity).toBe(3);
    expect(b.last_inspected_at).toBeNull();
    expect(inspection.checked_count).toBe(1);
    expect(inspection.expected_count).toBe(2);
    expect(inspection.quantity_discrepancies).toBe(1);
    expect((db.prepare("SELECT checked FROM inspection_results WHERE inventory_id=?").get(itemB) as any).checked).toBe(0);
    const unexpected = db.prepare("SELECT * FROM inspection_unexpected_items").get() as any;
    expect(unexpected.item_code_snapshot).toBe("EUR-000003");
    expect(unexpected.assigned_room_snapshot).toBe("ოთახი B");
  });
});

describe("transfers", () => {
  it("preserves total units for full and partial transfers", () => {
    const addPhoto = db.prepare(`INSERT INTO inventory_photos
      (inventory_id,blob_path,filename,original_name,width,height,byte_size,content_type,uploader,uploaded_at,sha256,sort_order)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,0)`);
    const now = new Date().toISOString();
    addPhoto.run(itemA, photoBlobPath("EUR-000001", 0), "EUR-000001.jpg", "კომპიუტერი.jpg", 800, 600, 90000, "image/jpeg", "ტესტი", now, "a".repeat(64));
    addPhoto.run(itemB, photoBlobPath("EUR-000002", 0), "EUR-000002.jpg", "მონიტორი.jpg", 800, 600, 90000, "image/jpeg", "ტესტი", now, "b".repeat(64));
    saveTransfer(db, { inventoryId: itemA, destinationRoomId: roomB, quantity: 6, sender: "ანა", recipient: "გიორგი", reason: "განაწილება" });
    expect((db.prepare("SELECT room_id FROM inventory WHERE id=?").get(itemA) as any).room_id).toBe(roomB);
    saveTransfer(db, { inventoryId: itemB, destinationRoomId: roomB, quantity: 2, sender: "ანა", recipient: "გიორგი", reason: "საჭიროება" });
    const rows = db.prepare("SELECT * FROM inventory ORDER BY id").all() as any[];
    expect(rows.reduce((sum, row) => sum + row.quantity, 0)).toBe(10);
    expect(rows.find(row => row.id === itemB).quantity).toBe(1);
    const split = rows.find(row => ![itemA, itemB, itemC].includes(row.id));
    expect(split.quantity).toBe(2);
    expect(split.last_inspected_at).toBeNull();
    expect(split.code).not.toBe("EUR-000002");
    expect((db.prepare("SELECT count(*) AS count FROM inventory_photos WHERE inventory_id=?").get(itemA) as any).count).toBe(1);
    expect((db.prepare("SELECT count(*) AS count FROM inventory_photos WHERE inventory_id=?").get(itemB) as any).count).toBe(1);
    expect((db.prepare("SELECT count(*) AS count FROM inventory_photos WHERE inventory_id=?").get(split.id) as any).count).toBe(0);
  });

  it("rejects invalid quantity without changing inventory", () => {
    expect(() => saveTransfer(db, { inventoryId: itemA, destinationRoomId: roomB, quantity: 7, sender: "ანა", recipient: "გიორგი", reason: "შეცდომა" })).toThrow("აღემატება");
    expect((db.prepare("SELECT quantity FROM inventory WHERE id=?").get(itemA) as any).quantity).toBe(6);
    expect((db.prepare("SELECT count(*) AS count FROM transfers").get() as any).count).toBe(0);
  });
});

describe("bulk inventory updates", () => {
  it("moves multiple records without changing units and records transfer history", () => {
    const before = (db.prepare("SELECT sum(quantity) AS units FROM inventory").get() as any).units;
    const result = bulkUpdateInventory(db, { inventoryIds: [itemA, itemB], roomId: roomB, condition: "დამაკმაყოფილებელი", responsiblePerson: "მარიამი", reason: "ოთახის მოწყობა" });
    const moved = db.prepare("SELECT * FROM inventory WHERE id IN (?,?) ORDER BY id").all(itemA, itemB) as any[];
    expect(result.updated).toBe(2);
    expect(moved.every((item) => item.room_id === roomB && item.condition === "დამაკმაყოფილებელი" && item.responsible_person === "მარიამი")).toBe(true);
    expect((db.prepare("SELECT sum(quantity) AS units FROM inventory").get() as any).units).toBe(before);
    expect((db.prepare("SELECT count(*) AS count FROM transfers").get() as any).count).toBe(2);
    expect((db.prepare("SELECT count(*) AS count FROM item_history WHERE action='მასობრივი გადაადგილება'").get() as any).count).toBe(2);
  });
});
