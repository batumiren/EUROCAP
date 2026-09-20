import { NextRequest, NextResponse } from "next/server";
import { strToU8, zipSync } from "fflate";
import { db } from "@/lib/db";

export const runtime = "nodejs";

const headers = ["ნივთის კოდი", "დასახელება", "ოთახი", "რაოდენობა", "მდგომარეობა", "სტატუსი", "ბოლო შემოწმების თარიღი", "აღწერა / შენიშვნა", "პასუხისმგებელი პირი", "რეგისტრაციის თარიღი", "არქივის მდგომარეობა"];

function formatDate(value: string | null) {
  return value ? new Intl.DateTimeFormat("ka-GE", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Tbilisi" }).format(new Date(value)) : "";
}

function inventoryRows() {
  const items = db.prepare("SELECT i.*,r.name AS room_name FROM inventory i JOIN rooms r ON r.id=i.room_id ORDER BY i.id").all() as Record<string, any>[];
  return items.map((item) => [item.code, item.name, item.room_name, item.quantity, item.condition, item.status, formatDate(item.last_inspected_at), item.notes, item.responsible_person, formatDate(item.registered_at), item.archived_at ? "დაარქივებული" : "აქტიური"]);
}

function csvCell(value: unknown) { return `"${String(value ?? "").replaceAll('"', '""')}"`; }
function xml(value: unknown) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
function columnName(index: number) { let value = ""; for (let current = index + 1; current; current = Math.floor((current - 1) / 26)) value = String.fromCharCode(65 + ((current - 1) % 26)) + value; return value; }

function createXlsx(rows: unknown[][]) {
  const allRows = [headers, ...rows];
  const sheetRows = allRows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((value, columnIndex) => {
    const reference = `${columnName(columnIndex)}${rowIndex + 1}`;
    return typeof value === "number" ? `<c r="${reference}"${rowIndex === 0 ? ' s="1"' : ""}><v>${value}</v></c>` : `<c r="${reference}" t="inlineStr"${rowIndex === 0 ? ' s="1"' : ""}><is><t>${xml(value)}</t></is></c>`;
  }).join("")}</row>`).join("");
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="ინვენტარი" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    "xl/styles.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><name val="Arial"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf fontId="0" fillId="0" borderId="0" xfId="0"/><xf fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`),
    "xl/worksheets/sheet1.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="11" width="22" customWidth="1"/></cols><sheetData>${sheetRows}</sheetData><autoFilter ref="A1:K${allRows.length}"/></worksheet>`),
  };
  return zipSync(files, { level: 6 });
}

export async function GET(request: NextRequest) {
  const format = request.nextUrl.searchParams.get("format");
  const rows = inventoryRows();
  if (format === "csv") {
    const csv = `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
    return new NextResponse(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="EURO-Inventory.csv"' } });
  }
  if (format === "xlsx") {
    return new NextResponse(Buffer.from(createXlsx(rows)), { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": 'attachment; filename="EURO-Inventory.xlsx"' } });
  }
  return NextResponse.json({ error: "აირჩიეთ CSV ან XLSX ფორმატი." }, { status: 400 });
}
