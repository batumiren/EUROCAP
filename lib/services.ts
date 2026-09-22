import type Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { CONDITIONS, STATUSES } from "@/lib/types";
import { getOperator, nextItemCode } from "@/lib/db";

export class AppError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const createInventoryInput = z.object({
  name: z.string().trim().min(1),
  roomId: z.number().int().positive(),
  quantity: z.number().int().positive(),
  condition: z.enum(CONDITIONS),
  status: z.enum(STATUSES),
  notes: z.string().default(""),
  responsiblePerson: z.string().default(""),
});

export function createInventoryItems(database: Database.Database, raw: unknown) {
  const input = createInventoryInput.parse(raw);
  return database.transaction(() => {
    const room = database.prepare("SELECT id FROM rooms WHERE id=? AND archived_at IS NULL").get(input.roomId);
    if (!room) throw new AppError("აქტიური ოთახი ვერ მოიძებნა.");

    const now = new Date().toISOString();
    const operator = getOperator(database);
    const insertItem = database.prepare(`INSERT INTO inventory
      (code,name,room_id,quantity,condition,status,notes,responsible_person,registered_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    const insertHistory = database.prepare("INSERT INTO item_history (inventory_id,action,details,operator_email,created_at) VALUES (?,?,?,?,?)");
    const ids: number[] = [];
    const codes: string[] = [];

    for (let index = 0; index < input.quantity; index += 1) {
      const code = nextItemCode(database);
      const inserted = insertItem.run(code, input.name, input.roomId, 1, input.condition, input.status, input.notes.trim(), input.responsiblePerson.trim(), now, now);
      const id = Number(inserted.lastInsertRowid);
      insertHistory.run(id, "ჩანაწერის შექმნა", "რაოდენობა: 1", operator.operator_email, now);
      ids.push(id);
      codes.push(code);
    }

    return { id: ids[0], code: codes[0], ids, codes, created: ids.length };
  })();
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
  sourceRoomId: z.number().int().positive(),
  inventoryIds: z.array(z.number().int().positive()).min(1).max(500),
  destinationRoomId: z.number().int().positive(),
  sender: z.string().trim().min(1),
  recipient: z.string().trim().min(1),
  reason: z.string().trim().default(""),
});

export function saveTransfers(database: Database.Database, raw: unknown) {
  const input = transferInput.parse(raw);
  return database.transaction(() => {
    if (input.sourceRoomId === input.destinationRoomId) throw new AppError("საწყისი და დანიშნულების ოთახები უნდა განსხვავდებოდეს.");
    const ids = [...new Set(input.inventoryIds)];
    const placeholders = ids.map(() => "?").join(",");
    const sources = database.prepare(`SELECT i.*,r.name AS room_name FROM inventory i JOIN rooms r ON r.id=i.room_id
      WHERE i.id IN (${placeholders}) AND i.archived_at IS NULL`).all(...ids) as Record<string, any>[];
    if (sources.length !== ids.length || sources.some(source => source.room_id !== input.sourceRoomId)) {
      throw new AppError("არჩეული ინვენტარი საწყის ოთახში ვერ მოიძებნა.", 404);
    }
    const destination = database.prepare("SELECT * FROM rooms WHERE id=? AND archived_at IS NULL").get(input.destinationRoomId) as { id: number; name: string } | undefined;
    if (!destination) throw new AppError("დანიშნულების აქტიური ოთახი ვერ მოიძებნა.");
    const operator = getOperator(database);
    const now = new Date().toISOString();
    const update = database.prepare("UPDATE inventory SET room_id=?,responsible_person=?,updated_at=? WHERE id=?");
    const insertTransfer = database.prepare(`INSERT INTO transfers
      (source_inventory_id,destination_inventory_id,source_code_snapshot,destination_code_snapshot,item_name_snapshot,source_room_snapshot,destination_room_snapshot,quantity,sender,recipient,reason,operator_name,operator_email,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const history = database.prepare("INSERT INTO item_history (inventory_id,action,details,reference_type,reference_id,operator_email,created_at) VALUES (?,?,?,?,?,?,?)");
    const transferIds: number[] = [];
    for (const source of sources) {
      update.run(destination.id, input.recipient, now, source.id);
      const transfer = insertTransfer.run(source.id, source.id, source.code, source.code, source.name, source.room_name, destination.name, source.quantity, input.sender, input.recipient, input.reason, operator.operator_name, operator.operator_email, now);
      const transferId = Number(transfer.lastInsertRowid);
      history.run(source.id, "გადაადგილება", `${source.room_name} → ${destination.name}, რაოდენობა: ${source.quantity}`, "transfer", transferId, operator.operator_email, now);
      transferIds.push(transferId);
    }
    return { ids: transferIds, created: transferIds.length };
  })();
}

const bulkUpdateInput = z.object({
  inventoryIds: z.array(z.number().int().positive()).min(1).max(500),
  roomId: z.number().int().positive().optional(),
  condition: z.enum(CONDITIONS).optional(),
  status: z.enum(STATUSES).optional(),
  responsiblePerson: z.string().max(500).optional(),
  notes: z.string().max(2000).optional(),
  reason: z.string().trim().min(1),
}).refine((input) => [input.roomId, input.condition, input.status, input.responsiblePerson, input.notes].some((value) => value !== undefined), {
  message: "აირჩიეთ შესაცვლელი მინიმუმ ერთი ველი.",
});

export function bulkUpdateInventory(database: Database.Database, raw: unknown) {
  const input = bulkUpdateInput.parse(raw);
  const ids = [...new Set(input.inventoryIds)];
  return database.transaction(() => {
    const placeholders = ids.map(() => "?").join(",");
    const items = database.prepare(`SELECT i.*,r.name AS room_name FROM inventory i JOIN rooms r ON r.id=i.room_id
      WHERE i.id IN (${placeholders}) AND i.archived_at IS NULL`).all(...ids) as Record<string, any>[];
    if (items.length !== ids.length) throw new AppError("ერთი ან მეტი აქტიური ჩანაწერი ვერ მოიძებნა.", 404);
    const destination = input.roomId === undefined ? undefined : database.prepare("SELECT id,name FROM rooms WHERE id=? AND archived_at IS NULL").get(input.roomId) as { id: number; name: string } | undefined;
    if (input.roomId !== undefined && !destination) throw new AppError("დანიშნულების აქტიური ოთახი ვერ მოიძებნა.");

    const operator = getOperator(database);
    const now = new Date().toISOString();
    const update = database.prepare("UPDATE inventory SET room_id=?,condition=?,status=?,responsible_person=?,notes=?,updated_at=? WHERE id=?");
    const transfer = database.prepare(`INSERT INTO transfers
      (source_inventory_id,destination_inventory_id,source_code_snapshot,destination_code_snapshot,item_name_snapshot,source_room_snapshot,destination_room_snapshot,quantity,sender,recipient,reason,operator_name,operator_email,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const history = database.prepare("INSERT INTO item_history (inventory_id,action,details,reference_type,reference_id,operator_email,created_at) VALUES (?,?,?,?,?,?,?)");
    let updated = 0;
    for (const item of items) {
      const roomChanged = destination !== undefined && destination.id !== item.room_id;
      const condition = input.condition ?? item.condition;
      const status = input.status ?? item.status;
      const responsiblePerson = input.responsiblePerson ?? item.responsible_person;
      const notes = input.notes ?? item.notes;
      const descriptiveChanged = condition !== item.condition || status !== item.status || responsiblePerson !== item.responsible_person || notes !== item.notes;
      if (!roomChanged && !descriptiveChanged) continue;
      update.run(destination?.id ?? item.room_id, condition, status, responsiblePerson, notes, now, item.id);
      if (roomChanged) {
        const recipient = responsiblePerson || item.responsible_person || operator.operator_name;
        const result = transfer.run(item.id, item.id, item.code, item.code, item.name, item.room_name, destination.name, item.quantity, operator.operator_name, recipient, input.reason, operator.operator_name, operator.operator_email, now);
        history.run(item.id, "მასობრივი გადაადგილება", `${item.room_name} → ${destination.name}, რაოდენობა: ${item.quantity}. მიზეზი: ${input.reason}`, "transfer", Number(result.lastInsertRowid), operator.operator_email, now);
      }
      if (descriptiveChanged) {
        const changes = [
          condition !== item.condition && `მდგომარეობა: ${item.condition} → ${condition}`,
          status !== item.status && `სტატუსი: ${item.status} → ${status}`,
          responsiblePerson !== item.responsible_person && `პასუხისმგებელი: ${item.responsible_person || "—"} → ${responsiblePerson || "—"}`,
          notes !== item.notes && "შენიშვნა განახლდა",
        ].filter(Boolean).join("; ");
        history.run(item.id, "მასობრივი რედაქტირება", `${changes}. მიზეზი: ${input.reason}`, "bulk_update", null, operator.operator_email, now);
      }
      updated++;
    }
    return { updated };
  })();
}
