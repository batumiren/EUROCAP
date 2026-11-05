import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { db } from "@/lib/db";
import { GET as exportInventory } from "@/app/api/inventory/export/route";
import { importInventoryRows, inventoryHeaders, parseInventoryFile, type ImportRows } from "@/lib/inventory-import";

let roomA: number; let roomB: number;
beforeEach(() => {
  db.exec("DELETE FROM item_history; DELETE FROM transfers; DELETE FROM inspection_unexpected_items; DELETE FROM inspection_results; DELETE FROM inspections; DELETE FROM inventory_photos; DELETE FROM photo_cleanup_queue; DELETE FROM inventory; DELETE FROM rooms; DELETE FROM settings;");
  db.prepare("INSERT INTO settings (id,operator_name,operator_email,demo_data) VALUES (1,'ტესტი','test@example.com',0)").run();
  roomA = Number(db.prepare("INSERT INTO rooms (name) VALUES ('408')").run().lastInsertRowid);
  roomB = Number(db.prepare("INSERT INTO rooms (name) VALUES ('409')").run().lastInsertRowid);
  const insert = db.prepare("INSERT INTO inventory (code,name,room_id,quantity,condition,status,notes,responsible_person,registered_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
  for (const code of ["EUR-000001", "EUR-000002"]) insert.run(code, "სკამი", roomA, 1, "კარგი", "გამოყენებაში", 'შენიშვნა, "ტესტი"\nმეორე ხაზი', "ანა", "2026-10-01T12:34:56.789Z", "2026-10-01T12:34:56.789Z");
});

async function exported(format: string) {
  const response = await exportInventory(new NextRequest(`https://inventory.test/api/inventory/export?format=${format}`));
  return Buffer.from(await response.arrayBuffer());
}
async function rows() { return parseInventoryFile("inventory.csv", await exported("csv")); }
function apply(data: ImportRows) {
  const preview = importInventoryRows(db, data);
  return importInventoryRows(db, data, true, preview.revision);
}

describe("inventory spreadsheet import", () => {
  it.each(["csv", "xlsx"])("round-trips unchanged exported %s without modifying timestamps or history", async format => {
    const data = await parseInventoryFile(`inventory.${format}`, await exported(format));
    expect(data[0]).toEqual(inventoryHeaders);
    expect(apply(data)).toMatchObject({ updated: 0, unchanged: 2 });
    expect((db.prepare("SELECT registered_at FROM inventory LIMIT 1").get() as any).registered_at).toBe("2026-10-01T12:34:56.789Z");
    expect((db.prepare("SELECT count(*) AS count FROM item_history").get() as any).count).toBe(0);
  });

  it("updates changed XLSX data using existing codes", async () => {
    const files = unzipSync(await exported("xlsx"));
    files["xl/worksheets/sheet1.xml"] = strToU8(strFromU8(files["xl/worksheets/sheet1.xml"]).replace("სკამი", "მერხი"));
    const data = await parseInventoryFile("edited.xlsx", Buffer.from(zipSync(files)));
    expect(apply(data)).toMatchObject({ updated: 1, unchanged: 1 });
    expect((db.prepare("SELECT name FROM inventory WHERE code='EUR-000001'").get() as any).name).toBe("მერხი");
  });

  it("previews without writes and applies edited fields without deleting omitted inventory or history", async () => {
    const item = db.prepare("SELECT id FROM inventory WHERE code='EUR-000001'").get() as { id: number };
    db.prepare("INSERT INTO inventory_photos (inventory_id,blob_path,filename,original_name,width,height,byte_size,content_type,uploader,uploaded_at,sha256,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,0)").run(item.id, "photos/test.jpg", "test.jpg", "test.jpg", 100, 100, 1000, "image/jpeg", "ტესტი", new Date().toISOString(), "a".repeat(64));
    db.prepare("INSERT INTO item_history (inventory_id,action,details,operator_email,created_at) VALUES (?,?,?,?,?)").run(item.id, "არსებული ისტორია", "არ წაიშალოს", "test@example.com", new Date().toISOString());
    const data = await rows();
    data.pop();
    data[1][1] = "მოსწავლის მერხი"; data[1][2] = "409"; data[1][3] = 10;
    data[1][6] = "2026-10-05"; data[1][7] = "ახალი შენიშვნა"; data[1][10] = "დაარქივებული";
    const preview = importInventoryRows(db, data);
    expect(preview.updated).toBe(1);
    expect((db.prepare("SELECT name FROM inventory LIMIT 1").get() as any).name).toBe("სკამი");
    importInventoryRows(db, data, true, preview.revision);
    expect(db.prepare("SELECT name,room_id,quantity,notes,last_inspected_at FROM inventory WHERE code='EUR-000001'").get()).toMatchObject({ name: "მოსწავლის მერხი", room_id: roomB, quantity: 10, notes: "ახალი შენიშვნა", last_inspected_at: "2026-10-05T00:00:00.000Z" });
    expect((db.prepare("SELECT count(*) AS count FROM inventory").get() as any).count).toBe(2);
    expect((db.prepare("SELECT count(*) AS count FROM item_history").get() as any).count).toBe(2);
    expect((db.prepare("SELECT count(*) AS count FROM inventory_photos WHERE inventory_id=?").get(item.id) as any).count).toBe(1);
  });

  it("rejects invalid, unknown and duplicate rows atomically", async () => {
    for (const invalid of ["duplicate", "unknown", "quantity", "room", "header"]) {
      const data = await rows(); data[1][1] = "არ უნდა შეინახოს";
      if (invalid === "duplicate") data[2][0] = data[1][0];
      if (invalid === "unknown") data[2][0] = "EUR-999999";
      if (invalid === "quantity") data[2][3] = -1;
      if (invalid === "room") data[2][2] = "უცნობი ოთახი";
      if (invalid === "header") data[0][1] = "wrong";
      expect(() => importInventoryRows(db, data, true, "irrelevant")).toThrow();
      expect((db.prepare("SELECT name FROM inventory LIMIT 1").get() as any).name).toBe("სკამი");
    }
  });

  it("rejects stale previews", async () => {
    const data = await rows(); data[1][1] = "მერხი";
    const preview = importInventoryRows(db, data);
    db.prepare("UPDATE inventory SET notes='newer change' WHERE code='EUR-000001'").run();
    expect(() => importInventoryRows(db, data, true, preview.revision)).toThrow("ინვენტარი შეიცვალა");
  });

  it("supports UTF-8 semicolon CSV with quoted multiline cells and rejects other extensions", async () => {
    const csv = `\uFEFF${inventoryHeaders.map(header => `"${header}"`).join(";")}\r\n"EUR-000001";"სკამი";"408";1;"კარგი";"გამოყენებაში";;"ხაზი 1\nხაზი 2";"ანა";"2026-10-01";"აქტიური"`;
    const data = await parseInventoryFile("edited.csv", Buffer.from(csv));
    expect(data[1][7]).toBe("ხაზი 1\nხაზი 2");
    expect(apply(data).updated).toBe(1);
    await expect(parseInventoryFile("file.xls", Buffer.from(csv))).rejects.toThrow("XLSX ან CSV");
  });
});
