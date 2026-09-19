import type Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { CONDITIONS, STATUSES } from "@/lib/types";
import { getOperator, nextItemCode } from "@/lib/db";

export class AppError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const inspectionInput = z.object({
  roomId: z.number().int().positive(),
  items: z.array(z.object({
    inventoryId: z.number().int().positive(),
    openedUpdatedAt: z.string(),
    checked: z.boolean(),
    actualQuantity: z.number().int().min(0).nullable(),
    observedCondition: z.enum(CONDITIONS).nullable(),
    notes: z.string().max(2000).default(""),
  })),
  unexpectedItems: z.array(z.object({
    inventoryId: z.number().int().positive(),
    openedUpdatedAt: z.string(),
  })).default([]),
});

export function saveInspection(database: Database.Database, raw: unknown) {
  const input = inspectionInput.parse(raw);
  const checked = input.items.filter((item) => item.checked);
  if (!checked.length) throw new AppError("შესანახად მონიშნეთ მინიმუმ ერთი ჩანაწერი.");
  if (checked.some((item) => item.actualQuantity === null || !item.observedCondition)) {
    throw new AppError("შემოწმებულ ჩანაწერებში ფაქტობრივი რაოდენობა და მდგომარეობა სავალდებულოა.");
  }

  return database.transaction(() => {
    const room = database.prepare("SELECT name FROM rooms WHERE id = ?").get(input.roomId) as { name: string } | undefined;
    if (!room) throw new AppError("ოთახი ვერ მოიძებნა.", 404);
    const current = database.prepare("SELECT * FROM inventory WHERE room_id = ? AND archived_at IS NULL ORDER BY id").all(input.roomId) as Record<string, unknown>[];
    if (!current.length) throw new AppError("ცარიელი ოთახის შემოწმება ვერ შეინახება.");
    if (current.length !== input.items.length) throw new AppError("ინვენტარი შეიცვალა. განაახლეთ შემოწმების ფორმა.", 409);
    for (const item of input.items) {
      const row = current.find((value) => value.id === item.inventoryId);
      if (!row || row.updated_at !== item.openedUpdatedAt) throw new AppError("ინვენტარი შეიცვალა. განაახლეთ შემოწმების ფორმა.", 409);
    }
    const unexpectedIds = new Set<number>();
    const unexpected = input.unexpectedItems.map((item) => {
      if (unexpectedIds.has(item.inventoryId)) throw new AppError("ერთი და იგივე უცხო ნივთი ორჯერ არის დაფიქსირებული.");
      unexpectedIds.add(item.inventoryId);
      const row = database.prepare(`SELECT i.*,r.name AS room_name FROM inventory i JOIN rooms r ON r.id=i.room_id
        WHERE i.id=? AND i.archived_at IS NULL`).get(item.inventoryId) as Record<string, any> | undefined;
      if (!row || row.updated_at !== item.openedUpdatedAt || row.room_id === input.roomId) {
        throw new AppError("სკანირებული ინვენტარი შეიცვალა. განაახლეთ შემოწმების ფორმა.", 409);
      }
      return row;
    });
    const operator = getOperator(database);
    const now = new Date().toISOString();
    const date = now.slice(0, 10).replaceAll("-", "");
    const time = now.slice(11, 19).replaceAll(":", "");
    const code = `CHK-${date}-${time}-${randomBytes(3).toString("hex").toUpperCase()}`;
    let quantityDiscrepancies = 0;
    let conditionChanges = 0;
    for (const item of checked) {
      const row = current.find((value) => value.id === item.inventoryId)!;
      if (item.actualQuantity !== row.quantity) quantityDiscrepancies++;
      if (item.observedCondition !== row.condition) conditionChanges++;
    }
    const result = database.prepare(`INSERT INTO inspections
      (inspection_code,room_id,room_name_snapshot,operator_name,operator_email,checked_count,expected_count,quantity_discrepancies,condition_changes,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(code, input.roomId, room.name, operator.operator_name, operator.operator_email, checked.length, current.length, quantityDiscrepancies, conditionChanges, now);
    const inspectionId = Number(result.lastInsertRowid);
    const addResult = database.prepare(`INSERT INTO inspection_results
      (inspection_id,inventory_id,item_code_snapshot,item_name_snapshot,room_name_snapshot,expected_quantity,previous_condition,checked,actual_quantity,observed_condition,notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    const addUnexpected = database.prepare(`INSERT INTO inspection_unexpected_items
      (inspection_id,inventory_id,item_code_snapshot,item_name_snapshot,assigned_room_snapshot,scanned_in_room_snapshot)
      VALUES (?,?,?,?,?,?)`);
    const update = database.prepare("UPDATE inventory SET condition = ?, last_inspected_at = ?, updated_at = ? WHERE id = ?");
    const history = database.prepare("INSERT INTO item_history (inventory_id,action,details,reference_type,reference_id,operator_email,created_at) VALUES (?,?,?,?,?,?,?)");
    for (const item of input.items) {
      const row = current.find((value) => value.id === item.inventoryId)!;
      addResult.run(inspectionId, row.id, row.code, row.name, room.name, row.quantity, row.condition, item.checked ? 1 : 0, item.checked ? item.actualQuantity : null, item.checked ? item.observedCondition : null, item.notes);
      if (item.checked) {
        update.run(item.observedCondition, now, now, item.inventoryId);
        history.run(item.inventoryId, "ინვენტარიზაციის შემოწმება", `${code}: ფაქტობრივი რაოდენობა ${item.actualQuantity}`, "inspection", inspectionId, operator.operator_email, now);
      }
    }
    for (const row of unexpected) {
      addUnexpected.run(inspectionId, row.id, row.code, row.name, row.room_name, room.name);
    }
    return { id: inspectionId, code };
  })();
}

const transferInput = z.object({
  inventoryId: z.number().int().positive(), destinationRoomId: z.number().int().positive(),
  quantity: z.number().int().positive(), sender: z.string().trim().min(1), recipient: z.string().trim().min(1), reason: z.string().trim().min(1),
});

export function saveTransfer(database: Database.Database, raw: unknown) {
  const input = transferInput.parse(raw);
  return database.transaction(() => {
    const source = database.prepare(`SELECT i.*, r.name AS room_name FROM inventory i JOIN rooms r ON r.id=i.room_id WHERE i.id=?`).get(input.inventoryId) as Record<string, any> | undefined;
    if (!source || source.archived_at) throw new AppError("აქტიური ჩანაწერი ვერ მოიძებნა.", 404);
    if (source.room_id === input.destinationRoomId) throw new AppError("საწყისი და დანიშნულების ოთახები უნდა განსხვავდებოდეს.");
    if (input.quantity > source.quantity) throw new AppError("რაოდენობა აღემატება ხელმისაწვდომ რაოდენობას.");
    const destination = database.prepare("SELECT * FROM rooms WHERE id=? AND archived_at IS NULL").get(input.destinationRoomId) as { id: number; name: string } | undefined;
    if (!destination) throw new AppError("დანიშნულების აქტიური ოთახი ვერ მოიძებნა.");
    const operator = getOperator(database);
    const now = new Date().toISOString();
    let destinationId = source.id;
    let destinationCode = source.code;
    if (input.quantity === source.quantity) {
      database.prepare("UPDATE inventory SET room_id=?, responsible_person=?, updated_at=? WHERE id=?").run(destination.id, input.recipient, now, source.id);
    } else {
      destinationCode = nextItemCode(database);
      database.prepare("UPDATE inventory SET quantity=quantity-?, updated_at=? WHERE id=?").run(input.quantity, now, source.id);
      const inserted = database.prepare(`INSERT INTO inventory
        (code,name,room_id,quantity,condition,status,notes,responsible_person,registered_at,last_inspected_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,NULL,?)`).run(destinationCode, source.name, destination.id, input.quantity, source.condition, source.status, source.notes, input.recipient, now, now);
      destinationId = Number(inserted.lastInsertRowid);
    }
    const transfer = database.prepare(`INSERT INTO transfers
      (source_inventory_id,destination_inventory_id,source_code_snapshot,destination_code_snapshot,item_name_snapshot,source_room_snapshot,destination_room_snapshot,quantity,sender,recipient,reason,operator_name,operator_email,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(source.id, destinationId, source.code, destinationCode, source.name, source.room_name, destination.name, input.quantity, input.sender, input.recipient, input.reason, operator.operator_name, operator.operator_email, now);
    const transferId = Number(transfer.lastInsertRowid);
    const history = database.prepare("INSERT INTO item_history (inventory_id,action,details,reference_type,reference_id,operator_email,created_at) VALUES (?,?,?,?,?,?,?)");
    const detail = `${source.room_name} → ${destination.name}, რაოდენობა: ${input.quantity}`;
    history.run(source.id, "გადაადგილება", detail, "transfer", transferId, operator.operator_email, now);
    if (destinationId !== source.id) history.run(destinationId, "გადაადგილება", detail, "transfer", transferId, operator.operator_email, now);
    return { id: transferId, destinationInventoryId: destinationId };
  })();
}
