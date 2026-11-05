import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { getRoomPassports, renderRoomPassports } from "@/lib/room-passports";

const auth = vi.hoisted(() => ({ user: null as null | { username: string; role: string } }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: async () => auth.user }));
import { GET } from "@/app/api/rooms/passports/route";

let database: Database.Database;
beforeEach(() => {
  auth.user = null;
  database = new Database(":memory:");
  database.exec(`CREATE TABLE rooms (id INTEGER PRIMARY KEY,name TEXT,archived_at TEXT);
    CREATE TABLE inventory (id INTEGER PRIMARY KEY,room_id INTEGER,name TEXT,quantity INTEGER,responsible_person TEXT,archived_at TEXT);
    INSERT INTO rooms VALUES (1,'408',NULL),(2,'409',NULL),(3,'ძველი','2026-01-01'),(4,'ცარიელი',NULL);`);
  const add = database.prepare("INSERT INTO inventory (room_id,name,quantity,responsible_person,archived_at) VALUES (?,?,?,?,?)");
  for (let i = 0; i < 15; i++) add.run(1, "მოსწავლის მერხი", 1, "ანა", null);
  add.run(1, "  მოსწავლის   მერხი  ", 2, "ანა", null);
  add.run(1, "დაფა", 1, "გიორგი", null);
  add.run(1, "არქივის ნივთი", 20, "ანა", "2026-01-01");
  add.run(2, "მოსწავლის მერხი", 3, "", null);
  add.run(3, "ძველი ოთახის ნივთი", 5, "", null);
});
afterEach(() => database.close());

describe("room passports", () => {
  it("groups every active room item without pagination and sums quantities", () => {
    const [passport] = getRoomPassports(database, 1);
    expect(passport.inventory).toHaveLength(2);
    expect(passport.inventory.find(item => item.name === "მოსწავლის მერხი")?.quantity).toBe(17);
    expect(passport.total).toBe(18);
    expect(passport.responsiblePeople).toEqual(["ანა", "გიორგი"]);
    expect(passport.inventory.some(item => item.name === "არქივის ნივთი")).toBe(false);
  });

  it("keeps rooms separate and includes empty active rooms, excluding archived rooms", () => {
    const passports = getRoomPassports(database);
    expect(passports.map(room => room.id)).toEqual([1, 2, 4]);
    expect(passports[1].total).toBe(3);
    expect(passports[2].total).toBe(0);
    expect(getRoomPassports(database, 3)).toEqual([]);
    expect(getRoomPassports(database, 999)).toEqual([]);
  });

  it("renders editable responsible names, signatures and A4 page breaks", () => {
    const html = renderRoomPassports(getRoomPassports(database), new Date("2026-11-06T08:00:00Z"));
    expect(html.match(/<article class="passport">/g)).toHaveLength(3);
    expect(html).toContain("size:A4 portrait");
    expect(html).toContain("break-after:page");
    expect(html).toContain("window.print()");
    expect(html).toContain("პასუხისმგებელი პირის ხელმოწერა");
    expect(html).toContain("ადმინისტრაციის ხელმოწერა");
    expect(html).toContain('contenteditable="plaintext-only"');
    expect(html).toContain("ანა, გიორგი");
    expect(html).toContain("ოთახში აქტიური ინვენტარი არ არის.");
  });

  it("escapes names and responsible people in HTML", () => {
    const html = renderRoomPassports([{ id: 1, name: '<script>alert("room")</script>', responsiblePeople: ['" onfocus="alert(1)'], inventory: [{ name: "<img src=x onerror=alert(1)>", quantity: 1 }], total: 1 }]);
    expect(html).not.toContain('<script>alert("room")');
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&quot;");
  });

  it("denies anonymous users and inspection-only accounts", async () => {
    const request = new NextRequest("https://inventory.test/api/rooms/passports");
    expect((await GET(request)).status).toBe(401);
    auth.user = { username: "check", role: "check" };
    expect((await GET(request)).status).toBe(403);
  });

  it("rejects malformed room IDs for admins", async () => {
    auth.user = { username: "admin", role: "admin" };
    for (const value of ["", "abc", "-1", "1.5", "0"]) {
      expect((await GET(new NextRequest(`https://inventory.test/api/rooms/passports?roomId=${value}`))).status).toBe(400);
    }
  });
});
