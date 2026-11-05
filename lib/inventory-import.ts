import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { readSheet } from "read-excel-file/node";
import { parse } from "csv-parse/sync";
import { CONDITIONS, STATUSES } from "@/lib/types";
import { AppError } from "@/lib/services";
import { getOperator } from "@/lib/db";

export const IMPORT_MAX_BYTES = 4 * 1024 * 1024;
export const inventoryHeaders = ["ნივთის კოდი", "დასახელება", "ოთახი", "რაოდენობა", "მდგომარეობა", "სტატუსი", "ბოლო შემოწმების თარიღი", "აღწერა / შენიშვნა", "პასუხისმგებელი პირი", "რეგისტრაციის თარიღი", "არქივის მდგომარეობა"];
type Cell = string | number | boolean | Date | null;
export type ImportRows = Cell[][];

export async function parseInventoryFile(filename: string, contents: Buffer): Promise<ImportRows> {
  if (!contents.length || contents.length > IMPORT_MAX_BYTES) throw new AppError("აირჩიეთ არაცარიელი ფაილი, მაქსიმუმ 4 მბ.");
  try {
    if (/\.xlsx$/i.test(filename)) {
      let size = 0; let files = 0;
      // Inspect the ZIP directory before the spreadsheet library decompresses it.
      unzipSync(contents, { filter: entry => {
        size += entry.originalSize; files++;
        if (size > 32 * 1024 * 1024 || files > 500) throw new Error("Workbook too large");
        return false;
      } });
      const rows = await readSheet(contents);
      if (rows.length > 10001) throw new Error("Too many rows");
      return rows as ImportRows;
    }
    if (/\.csv$/i.test(filename)) {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(contents);
      const firstLine = text.split(/\r?\n/, 1)[0];
      const delimiter = firstLine.includes(";") && !firstLine.includes(",") ? ";" : ",";
      const rows = parse(text, { bom: true, delimiter, skip_empty_lines: true, max_record_size: 100000, to: 10002 }) as ImportRows;
      if (rows.length > 10001) throw new Error("Too many rows");
      return rows;
    }
  } catch {
    throw new AppError("ფაილი ვერ წაიკითხა. გამოიყენეთ UTF-8 CSV ან XLSX (მაქსიმუმ 10 000 ჩანაწერი). ფორმულების ნაცვლად ჩაწერეთ მნიშვნელობები.");
  }
  throw new AppError("აირჩიეთ XLSX ან CSV ფაილი.");
}

function text(value: Cell | undefined) { return value === null || value === undefined ? "" : String(value); }
const dateFormatter = new Intl.DateTimeFormat("ka-GE", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Tbilisi" });
function importedDate(value: Cell | undefined, previous: string | null, required: boolean) {
  const input = text(value).trim();
  if (previous && input === dateFormatter.format(new Date(previous))) return previous;
  if (!input && !required) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/.test(input)) {
    const date = new Date(input);
    if (!Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === input.slice(0, 10)) return date.toISOString();
  }
  // Existing exports use Georgian medium dates in Asia/Tbilisi.
  const match = input.match(/^(\d{1,2})\s+([^\s]+)\s+(\d{4}),?\s+(\d{1,2}):(\d{2})$/);
  const months = ["იან", "თებ", "მარ", "აპრ", "მაი", "ივნ", "ივლ", "აგვ", "სექ", "ოქტ", "ნოე", "დეკ"];
  if (match) {
    const month = months.indexOf(match[2].replace(/\.$/, "")) + 1;
    const date = new Date(`${match[3]}-${String(month).padStart(2, "0")}-${match[1].padStart(2, "0")}T${match[4].padStart(2, "0")}:${match[5]}:00+04:00`);
    if (month && !Number.isNaN(date.getTime()) && dateFormatter.format(date) === input) return date.toISOString();
  }
  throw new Error("თარიღი უნდა იყოს სწორი Excel თარიღი ან YYYY-MM-DD / ISO ფორმატში.");
}

export function importInventoryRows(database: Database.Database, rows: ImportRows, apply = false, expectedRevision?: string) {
  return database.transaction(() => {
    const headers = (rows[0] ?? []).map(value => text(value).trim());
    if (inventoryHeaders.some(header => headers.filter(value => value === header).length !== 1)) {
      throw new AppError("სვეტების სათაურები არ ემთხვევა ექსპორტს. გამოიყენეთ საიტიდან ჩამოტვირთული ფაილი და არ შეცვალოთ სათაურები.");
    }
    const seen = new Set<string>();
    const plans: Array<{ old: Record<string, any>; values: unknown[]; changed: boolean }> = [];
    const rooms = database.prepare("SELECT id,name,archived_at FROM rooms").all() as Array<{ id: number; name: string; archived_at: string | null }>;
    const now = new Date().toISOString();
    for (let index = 1; index < rows.length; index++) {
      const row = rows[index];
      if (row.every(value => !text(value).trim())) continue;
      const cell = (header: string) => row[headers.indexOf(header)];
      const code = text(cell(inventoryHeaders[0])).trim();
      try {
        if (!code || seen.has(code)) throw new Error("ნივთის კოდი ცარიელია ან მეორდება.");
        seen.add(code);
        const old = database.prepare("SELECT * FROM inventory WHERE code=?").get(code) as Record<string, any> | undefined;
        if (!old) throw new Error("ნივთის კოდი ვერ მოიძებნა. არსებული კოდები არ შეცვალოთ.");
        const name = text(cell(inventoryHeaders[1])).trim();
        const room = rooms.find(room => room.name.toLocaleLowerCase() === text(cell(inventoryHeaders[2])).trim().toLocaleLowerCase());
        const quantityText = text(cell(inventoryHeaders[3])).trim();
        const quantity = Number(quantityText);
        const condition = text(cell(inventoryHeaders[4])).trim();
        const status = text(cell(inventoryHeaders[5])).trim();
        const archive = text(cell(inventoryHeaders[10])).trim();
        if (!name) throw new Error("დასახელება სავალდებულოა.");
        if (!room) throw new Error("ოთახი ვერ მოიძებნა. ჯერ დაამატეთ ოთახი პარამეტრებში.");
        if (!quantityText || !Number.isSafeInteger(quantity) || quantity < 1) throw new Error("რაოდენობა უნდა იყოს დადებითი მთელი რიცხვი.");
        if (!CONDITIONS.includes(condition as typeof CONDITIONS[number])) throw new Error("მდგომარეობა არასწორია.");
        if (!STATUSES.includes(status as typeof STATUSES[number])) throw new Error("სტატუსი არასწორია.");
        if (!["აქტიური", "დაარქივებული"].includes(archive)) throw new Error("არქივის მდგომარეობა უნდა იყოს აქტიური ან დაარქივებული.");
        if (archive === "აქტიური" && room.archived_at) throw new Error("აქტიური ნივთი დაარქივებულ ოთახში ვერ განთავსდება.");
        const values = [name, room.id, quantity, condition, status, importedDate(cell(inventoryHeaders[6]), old.last_inspected_at, false), text(cell(inventoryHeaders[7])).trim(), text(cell(inventoryHeaders[8])).trim(), importedDate(cell(inventoryHeaders[9]), old.registered_at, true), archive === "დაარქივებული" ? old.archived_at || now : null];
        const oldValues = [old.name, old.room_id, old.quantity, old.condition, old.status, old.last_inspected_at, old.notes, old.responsible_person, old.registered_at, old.archived_at];
        plans.push({ old, values, changed: JSON.stringify(values) !== JSON.stringify(oldValues) });
      } catch (error) {
        throw new AppError(`სტრიქონი ${index + 1} (${code || "კოდის გარეშე"}): ${error instanceof Error ? error.message : "არასწორი მონაცემები."}`);
      }
    }
    if (!plans.length) throw new AppError("ფაილში ინვენტარის ჩანაწერები არ არის.");
    const revision = createHash("sha256").update(JSON.stringify(plans.map(plan => plan.old))).digest("hex");
    if (apply && revision !== expectedRevision) throw new AppError("ინვენტარი შეიცვალა. თავიდან შეამოწმეთ ფაილი და დაადასტურეთ იმპორტი.", 409);
    const changes = plans.filter(plan => plan.changed);
    if (apply && changes.length) {
      const operator = getOperator(database);
      const update = database.prepare("UPDATE inventory SET name=?,room_id=?,quantity=?,condition=?,status=?,last_inspected_at=?,notes=?,responsible_person=?,registered_at=?,archived_at=?,updated_at=? WHERE id=?");
      const history = database.prepare("INSERT INTO item_history (inventory_id,action,details,operator_email,created_at) VALUES (?,?,?,?,?)");
      for (const plan of changes) {
        update.run(...plan.values, now, plan.old.id);
        const fields = ["დასახელება", "ოთახი", "რაოდენობა", "მდგომარეობა", "სტატუსი", "ბოლო შემოწმების თარიღი", "აღწერა / შენიშვნა", "პასუხისმგებელი პირი", "რეგისტრაციის თარიღი", "არქივის მდგომარეობა"];
        const previous = [plan.old.name, plan.old.room_id, plan.old.quantity, plan.old.condition, plan.old.status, plan.old.last_inspected_at, plan.old.notes, plan.old.responsible_person, plan.old.registered_at, plan.old.archived_at];
        history.run(plan.old.id, "ფაილიდან იმპორტი", fields.filter((_, index) => previous[index] !== plan.values[index]).join(", "), operator.operator_email, now);
      }
    }
    return { total: plans.length, updated: changes.length, unchanged: plans.length - changes.length, revision };
  })();
}
