import type { Database } from "@/lib/db";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { CONDITIONS, STATUSES } from "@/lib/types";
import { getOperator } from "@/lib/db";

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

export async function createInventoryItems(database: Database, raw: unknown, requestId: string = randomUUID()) {
  const input = createInventoryInput.parse(raw);
  const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  return database.transaction(async database => {
    const previous = await database.prepare("SELECT payload_hash,result FROM inventory_submissions WHERE request_id=?").get(requestId);
    if (previous) {
      if (previous.payload_hash !== hash) throw new AppError("ამ შენახვის მოთხოვნის მონაცემები შეიცვალა.", 409);
      return previous.result as { id: number; code: string; ids: number[]; codes: string[]; created: number };
    }
    const room = (await database.prepare("SELECT id FROM rooms WHERE id=? AND archived_at IS NULL").get(input.roomId));
    if (!room) throw new AppError("აქტიური ოთახი ვერ მოიძებნა.");

    const now = new Date().toISOString();
    const operator = (await getOperator(database));
    const { rows } = await database.query<{ id: number; code: string }>(`WITH numbers AS MATERIALIZED (
      SELECT nextval('inventory_barcode_seq')::text AS value FROM generate_series(1, $1::integer)
    ), created AS (
      INSERT INTO inventory (code,name,room_id,quantity,condition,status,notes,responsible_person,registered_at,updated_at)
      SELECT 'EUR-' || lpad(value, greatest(6,length(value)), '0'),$2,$3,1,$4,$5,$6,$7,$8,$8 FROM numbers RETURNING id,code
    ), history AS (
      INSERT INTO item_history (inventory_id,action,details,operator_email,created_at)
      SELECT id,'ჩანაწერის შექმნა','რაოდენობა: 1',$9,$8 FROM created
    ) SELECT id,code FROM created ORDER BY id`,
    [input.quantity, input.name, input.roomId, input.condition, input.status, input.notes.trim(), input.responsiblePerson.trim(), now, operator.operator_email]);
    const ids = rows.map(row => row.id);
    const codes = rows.map(row => row.code);
    const result = { id: ids[0], code: codes[0], ids, codes, created: ids.length };
    await database.query("INSERT INTO inventory_submissions (request_id,payload_hash,result) VALUES ($1,$2,$3)", [requestId, hash, result]);
    return result;
  });
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

export async function saveInspection(database: Database, raw: unknown) {
  const input = inspectionInput.parse(raw);
  const checked = input.items.filter((item) => item.checked);
  if (!checked.length) throw new AppError("შესანახად მონიშნეთ მინიმუმ ერთი ჩანაწერი.");
  if (checked.some((item) => item.actualQuantity === null || !item.observedCondition)) {
    throw new AppError("შემოწმებულ ჩანაწერებში ფაქტობრივი რაოდენობა და მდგომარეობა სავალდებულოა.");
  }

  return database.transaction(async database => {
    const room = (await database.prepare("SELECT name FROM rooms WHERE id = ?").get(input.roomId)) as { name: string } | undefined;
    if (!room) throw new AppError("ოთახი ვერ მოიძებნა.", 404);
    const current = (await database.prepare("SELECT * FROM inventory WHERE room_id = ? AND archived_at IS NULL ORDER BY id").all(input.roomId)) as Record<string, unknown>[];
    if (!current.length) throw new AppError("ცარიელი ოთახის შემოწმება ვერ შეინახება.");
    if (current.length !== input.items.length) throw new AppError("ინვენტარი შეიცვალა. განაახლეთ შემოწმების ფორმა.", 409);
    for (const item of input.items) {
      const row = current.find((value) => value.id === item.inventoryId);
      if (!row || row.updated_at !== item.openedUpdatedAt) throw new AppError("ინვენტარი შეიცვალა. განაახლეთ შემოწმების ფორმა.", 409);
    }
    const unexpectedIds = new Set<number>();
    const unexpected = [];
    for (const item of input.unexpectedItems) {
      if (unexpectedIds.has(item.inventoryId)) throw new AppError("ერთი და იგივე უცხო ნივთი ორჯერ არის დაფიქსირებული.");
      unexpectedIds.add(item.inventoryId);
      const row = (await database.prepare(`SELECT i.*,r.name AS room_name FROM inventory i JOIN rooms r ON r.id=i.room_id
        WHERE i.id=? AND i.archived_at IS NULL`).get(item.inventoryId)) as Record<string, any> | undefined;
      if (!row || row.updated_at !== item.openedUpdatedAt || row.room_id === input.roomId) {
        throw new AppError("სკანირებული ინვენტარი შეიცვალა. განაახლეთ შემოწმების ფორმა.", 409);
      }
      unexpected.push(row);
    }
    const operator = (await getOperator(database));
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
    const result = (await database.prepare(`INSERT INTO inspections
      (inspection_code,room_id,room_name_snapshot,operator_name,operator_email,checked_count,expected_count,quantity_discrepancies,condition_changes,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).insert(code, input.roomId, room.name, operator.operator_name, operator.operator_email, checked.length, current.length, quantityDiscrepancies, conditionChanges, now));
    const inspectionId = Number(result.id);
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
      (await addResult.run(inspectionId, row.id, row.code, row.name, room.name, row.quantity, row.condition, item.checked ? 1 : 0, item.checked ? item.actualQuantity : null, item.checked ? item.observedCondition : null, item.notes));
      if (item.checked) {
        (await update.run(item.observedCondition, now, now, item.inventoryId));
        (await history.run(item.inventoryId, "ინვენტარიზაციის შემოწმება", `${code}: ფაქტობრივი რაოდენობა ${item.actualQuantity}`, "inspection", inspectionId, operator.operator_email, now));
      }
    }
    for (const row of unexpected) {
      (await addUnexpected.run(inspectionId, row.id, row.code, row.name, row.room_name, room.name));
    }
    return { id: inspectionId, code };
  });
}

const transferInput = z.object({
  sourceRoomId: z.number().int().positive(),
  inventoryIds: z.array(z.number().int().positive()).min(1).max(500),
  destinationRoomId: z.number().int().positive(),
  reason: z.string().trim().default(""),
});

export async function saveTransfers(database: Database, raw: unknown) {
  const input = transferInput.parse(raw);
  return database.transaction(async database => {
    if (input.sourceRoomId === input.destinationRoomId) throw new AppError("საწყისი და დანიშნულების ოთახები უნდა განსხვავდებოდეს.");
    const ids = [...new Set(input.inventoryIds)];
    const placeholders = ids.map(() => "?").join(",");
    const sources = (await database.prepare(`SELECT i.*,r.name AS room_name FROM inventory i JOIN rooms r ON r.id=i.room_id
      WHERE i.id IN (${placeholders}) AND i.archived_at IS NULL`).all(...ids)) as Record<string, any>[];
    if (sources.length !== ids.length || sources.some(source => source.room_id !== input.sourceRoomId)) {
      throw new AppError("არჩეული ინვენტარი საწყის ოთახში ვერ მოიძებნა.", 404);
    }
    const destination = (await database.prepare("SELECT * FROM rooms WHERE id=? AND archived_at IS NULL").get(input.destinationRoomId)) as { id: number; name: string } | undefined;
    if (!destination) throw new AppError("დანიშნულების აქტიური ოთახი ვერ მოიძებნა.");
    const operator = (await getOperator(database));
    const now = new Date().toISOString();
    const update = database.prepare("UPDATE inventory SET room_id=?,updated_at=? WHERE id=?");
    const insertTransfer = database.prepare(`INSERT INTO transfers
      (source_inventory_id,destination_inventory_id,source_code_snapshot,destination_code_snapshot,item_name_snapshot,source_room_snapshot,destination_room_snapshot,quantity,sender,recipient,reason,operator_name,operator_email,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const history = database.prepare("INSERT INTO item_history (inventory_id,action,details,reference_type,reference_id,operator_email,created_at) VALUES (?,?,?,?,?,?,?)");
    const transferIds: number[] = [];
    for (const source of sources) {
      (await update.run(destination.id, now, source.id));
      const transfer = (await insertTransfer.insert(source.id, source.id, source.code, source.code, source.name, source.room_name, destination.name, source.quantity, "", "", input.reason, operator.operator_name, operator.operator_email, now));
      const transferId = Number(transfer.id);
      (await history.run(source.id, "გადაადგილება", `${source.room_name} → ${destination.name}, რაოდენობა: ${source.quantity}`, "transfer", transferId, operator.operator_email, now));
      transferIds.push(transferId);
    }
    return { ids: transferIds, created: transferIds.length };
  });
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

export async function bulkUpdateInventory(database: Database, raw: unknown) {
  const input = bulkUpdateInput.parse(raw);
  const ids = [...new Set(input.inventoryIds)];
  return database.transaction(async database => {
    const placeholders = ids.map(() => "?").join(",");
    const items = (await database.prepare(`SELECT i.*,r.name AS room_name FROM inventory i JOIN rooms r ON r.id=i.room_id
      WHERE i.id IN (${placeholders}) AND i.archived_at IS NULL`).all(...ids)) as Record<string, any>[];
    if (items.length !== ids.length) throw new AppError("ერთი ან მეტი აქტიური ჩანაწერი ვერ მოიძებნა.", 404);
    const destination = input.roomId === undefined ? undefined : (await database.prepare("SELECT id,name FROM rooms WHERE id=? AND archived_at IS NULL").get(input.roomId)) as { id: number; name: string } | undefined;
    if (input.roomId !== undefined && !destination) throw new AppError("დანიშნულების აქტიური ოთახი ვერ მოიძებნა.");

    const operator = (await getOperator(database));
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
      (await update.run(destination?.id ?? item.room_id, condition, status, responsiblePerson, notes, now, item.id));
      if (roomChanged) {
        const recipient = responsiblePerson || item.responsible_person || operator.operator_name;
        const result = (await transfer.insert(item.id, item.id, item.code, item.code, item.name, item.room_name, destination.name, item.quantity, operator.operator_name, recipient, input.reason, operator.operator_name, operator.operator_email, now));
        (await history.run(item.id, "მასობრივი გადაადგილება", `${item.room_name} → ${destination.name}, რაოდენობა: ${item.quantity}. მიზეზი: ${input.reason}`, "transfer", Number(result.id), operator.operator_email, now));
      }
      if (descriptiveChanged) {
        const changes = [
          condition !== item.condition && `მდგომარეობა: ${item.condition} → ${condition}`,
          status !== item.status && `სტატუსი: ${item.status} → ${status}`,
          responsiblePerson !== item.responsible_person && `პასუხისმგებელი: ${item.responsible_person || "—"} → ${responsiblePerson || "—"}`,
          notes !== item.notes && "შენიშვნა განახლდა",
        ].filter(Boolean).join("; ");
        (await history.run(item.id, "მასობრივი რედაქტირება", `${changes}. მიზეზი: ${input.reason}`, "bulk_update", null, operator.operator_email, now));
      }
      updated++;
    }
    return { updated };
  });
}
