import type Database from "better-sqlite3";

export type RoomPassport = {
  id: number;
  name: string;
  responsiblePeople: string[];
  inventory: Array<{ name: string; quantity: number }>;
  total: number;
};

export function getRoomPassports(database: Database.Database, roomId?: number): RoomPassport[] {
  const rooms = database.prepare(`SELECT id,name FROM rooms WHERE archived_at IS NULL${roomId === undefined ? "" : " AND id=?"} ORDER BY name COLLATE NOCASE`).all(...(roomId === undefined ? [] : [roomId])) as Array<{ id: number; name: string }>;
  const items = database.prepare(`SELECT i.room_id,i.name,i.quantity,i.responsible_person FROM inventory i JOIN rooms r ON r.id=i.room_id
    WHERE i.archived_at IS NULL AND r.archived_at IS NULL${roomId === undefined ? "" : " AND i.room_id=?"} ORDER BY i.id`).all(...(roomId === undefined ? [] : [roomId])) as Array<{ room_id: number; name: string; quantity: number; responsible_person: string }>;
  const passports = new Map(rooms.map(room => [room.id, { ...room, responsiblePeople: [], inventory: [], total: 0 } as RoomPassport]));
  const groups = new Map<number, Map<string, { name: string; quantity: number }>>();
  for (const item of items) {
    const passport = passports.get(item.room_id)!;
    const name = item.name.trim().replace(/\s+/g, " ");
    const key = name.toLocaleLowerCase("ka-GE");
    if (!groups.has(item.room_id)) groups.set(item.room_id, new Map());
    const group = groups.get(item.room_id)!;
    const existing = group.get(key);
    if (existing) existing.quantity += item.quantity;
    else group.set(key, { name, quantity: item.quantity });
    passport.total += item.quantity;
    const responsible = item.responsible_person.trim();
    if (responsible && !passport.responsiblePeople.includes(responsible)) passport.responsiblePeople.push(responsible);
  }
  for (const passport of passports.values()) passport.inventory = Array.from(groups.get(passport.id)?.values() ?? []).sort((a, b) => a.name.localeCompare(b.name, "ka"));
  return Array.from(passports.values());
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function renderRoomPassports(passports: RoomPassport[], now = new Date()) {
  const date = escapeHtml(new Intl.DateTimeFormat("ka-GE", { dateStyle: "long", timeZone: "Asia/Tbilisi" }).format(now));
  const pages = passports.map(room => `<article class="passport">
    <header><p class="brand">EURO Inventory</p><h1>ოთახის პასპორტი</h1><h2>ოთახი: ${escapeHtml(room.name)}</h2><p>შედგენის თარიღი: ${date}</p></header>
    <div class="responsible"><strong>პასუხისმგებელი პირი:</strong><div contenteditable="plaintext-only" role="textbox" aria-label="პასუხისმგებელი პირი — ${escapeHtml(room.name)}" class="editable">${escapeHtml(room.responsiblePeople.join(", "))}</div></div>
    <table><thead><tr><th class="number">№</th><th>დასახელება</th><th class="quantity">რაოდენობა</th></tr></thead><tbody>
    ${room.inventory.length ? room.inventory.map((item, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(item.name)}</td><td class="quantity">${item.quantity}</td></tr>`).join("") : '<tr><td colspan="3" class="empty">ოთახში აქტიური ინვენტარი არ არის.</td></tr>'}
    </tbody></table>
    <p class="total">სულ ერთეული: ${room.total}</p>
    <div class="signatures"><p>პასუხისმგებელი პირის ხელმოწერა:<span></span></p><p>ადმინისტრაციის ხელმოწერა:<span></span></p><p>ხელმოწერის თარიღი:<span></span></p></div>
  </article>`).join("");
  return `<!DOCTYPE html><html lang="ka"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ოთახის პასპორტი — EURO Inventory</title>
  <style>
    *{box-sizing:border-box}body{margin:0;background:#eef2f6;color:#111827;font:14px Arial,sans-serif;line-height:1.5}.toolbar{max-width:210mm;margin:20px auto;padding:16px;background:white;border:1px solid #d1d5db;border-radius:8px}.toolbar p{margin:8px 0 0;color:#4b5563}button{border:0;border-radius:6px;background:#1d4ed8;color:white;font:inherit;font-weight:bold;padding:10px 18px;cursor:pointer}.passport{max-width:210mm;margin:20px auto;padding:18mm;background:white;box-shadow:0 2px 10px #0001}.brand{font-weight:bold;letter-spacing:1px;color:#475569}h1{font-size:25px;margin:6px 0}h2{font-size:19px;margin:6px 0}header p{margin:6px 0}.responsible{margin:24px 0 20px}.editable{min-height:30px;padding:5px 0;border-bottom:1px solid #64748b;white-space:pre-wrap;overflow-wrap:anywhere}.editable:focus{outline:2px solid #93c5fd}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{border:1px solid #94a3b8;padding:9px;text-align:left;overflow-wrap:anywhere}th{background:#f1f5f9}.number{width:42px}.quantity{width:100px;text-align:center}.empty{text-align:center}.total{text-align:right;font-size:16px;font-weight:bold}.signatures{margin-top:32px;break-inside:avoid}.signatures p{margin:22px 0}.signatures span{display:block;border-bottom:1px solid #64748b;max-width:340px;height:24px}tr{break-inside:avoid}thead{display:table-header-group}
    @page{size:A4 portrait;margin:15mm}@media print{body{background:white}.toolbar{display:none}.passport{max-width:none;margin:0;padding:0;box-shadow:none;break-after:page}.passport:last-child{break-after:auto}.editable:focus{outline:none}th{background:transparent}header{break-inside:avoid}}
  </style></head><body><div class="toolbar"><button id="print" type="button">ბეჭდვა / PDF შენახვა</button><p>თითოეული ოთახი იწყება ახალ გვერდზე. ბეჭდვამდე შეგიძლიათ შეცვალოთ პასუხისმგებელი პირის სახელი. ეს ცვლილება საიტზე არ ინახება.</p><p>მოცემულია ოთახების სრული აქტიური ინვენტარი; ძებნისა და სხვა ფილტრების შეზღუდვები არ გამოიყენება.</p></div>${pages}<script>document.getElementById("print").addEventListener("click",function(){window.print()});</script></body></html>`;
}
