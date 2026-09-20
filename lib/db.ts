import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const isVercelRuntime = Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
const defaultPath = isVercelRuntime
  ? path.join("/tmp", "euro-inventory.db")
  : path.join(process.cwd(), "data", "euro-inventory.db");

function openDatabase() {
  const databasePath = process.env.DATABASE_PATH || defaultPath;
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK(length(trim(name)) > 0),
      archived_at TEXT
    );
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      operator_name TEXT NOT NULL,
      operator_email TEXT NOT NULL,
      demo_data INTEGER NOT NULL DEFAULT 1 CHECK(demo_data IN (0, 1))
    );
    CREATE TABLE IF NOT EXISTS app_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL CHECK(length(trim(name)) > 0),
      room_id INTEGER NOT NULL REFERENCES rooms(id),
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      condition TEXT NOT NULL CHECK(condition IN ('კარგი','დამაკმაყოფილებელი','დაზიანებული','საჭიროებს შეკეთებას')),
      status TEXT NOT NULL CHECK(status IN ('გამოყენებაში','საწყობში','ჩამოწერილი')),
      notes TEXT NOT NULL DEFAULT '',
      responsible_person TEXT NOT NULL DEFAULT '',
      registered_at TEXT NOT NULL,
      last_inspected_at TEXT,
      archived_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS inventory_room_idx ON inventory(room_id, archived_at);
    CREATE TABLE IF NOT EXISTS inventory_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inventory_id INTEGER NOT NULL REFERENCES inventory(id),
      blob_path TEXT NOT NULL UNIQUE,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      width INTEGER NOT NULL CHECK(width > 0 AND width <= 800),
      height INTEGER NOT NULL CHECK(height > 0 AND height <= 800),
      byte_size INTEGER NOT NULL CHECK(byte_size > 0),
      content_type TEXT NOT NULL CHECK(content_type = 'image/jpeg'),
      uploader TEXT NOT NULL,
      uploaded_at TEXT NOT NULL,
      sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS inventory_photos_item_idx ON inventory_photos(inventory_id, sort_order, id);
    CREATE TABLE IF NOT EXISTS photo_cleanup_queue (
      blob_path TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS inspections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inspection_code TEXT NOT NULL UNIQUE,
      room_id INTEGER NOT NULL REFERENCES rooms(id),
      room_name_snapshot TEXT NOT NULL,
      operator_name TEXT NOT NULL,
      operator_email TEXT NOT NULL,
      checked_count INTEGER NOT NULL,
      expected_count INTEGER NOT NULL,
      quantity_discrepancies INTEGER NOT NULL,
      condition_changes INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inspection_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inspection_id INTEGER NOT NULL REFERENCES inspections(id),
      inventory_id INTEGER NOT NULL REFERENCES inventory(id),
      item_code_snapshot TEXT NOT NULL,
      item_name_snapshot TEXT NOT NULL,
      room_name_snapshot TEXT NOT NULL,
      expected_quantity INTEGER NOT NULL,
      previous_condition TEXT NOT NULL,
      checked INTEGER NOT NULL CHECK(checked IN (0, 1)),
      actual_quantity INTEGER CHECK(actual_quantity >= 0),
      observed_condition TEXT,
      notes TEXT NOT NULL DEFAULT '',
      UNIQUE(inspection_id, inventory_id)
    );
    CREATE TABLE IF NOT EXISTS inspection_unexpected_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inspection_id INTEGER NOT NULL REFERENCES inspections(id),
      inventory_id INTEGER NOT NULL REFERENCES inventory(id),
      item_code_snapshot TEXT NOT NULL,
      item_name_snapshot TEXT NOT NULL,
      assigned_room_snapshot TEXT NOT NULL,
      scanned_in_room_snapshot TEXT NOT NULL,
      UNIQUE(inspection_id, inventory_id)
    );
    CREATE TABLE IF NOT EXISTS transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_inventory_id INTEGER NOT NULL REFERENCES inventory(id),
      destination_inventory_id INTEGER NOT NULL REFERENCES inventory(id),
      source_code_snapshot TEXT NOT NULL,
      destination_code_snapshot TEXT NOT NULL,
      item_name_snapshot TEXT NOT NULL,
      source_room_snapshot TEXT NOT NULL,
      destination_room_snapshot TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      sender TEXT NOT NULL,
      recipient TEXT NOT NULL,
      reason TEXT NOT NULL,
      operator_name TEXT NOT NULL,
      operator_email TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS item_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inventory_id INTEGER NOT NULL REFERENCES inventory(id),
      action TEXT NOT NULL,
      details TEXT NOT NULL,
      reference_type TEXT,
      reference_id INTEGER,
      operator_email TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  restoreDeploymentSnapshot(db);
  seed(db);
  expandDemoData(db);
  ensureDemoActiveCount(db);
  return db;
}

function restoreDeploymentSnapshot(db: Database.Database) {
  if (!isVercelRuntime) return;
  try {
    const count = (db.prepare("SELECT count(*) AS count FROM inventory").get() as { count: number }).count;
    if (count > 0) return;
    const snapshotPath = path.join(process.cwd(), "backups", "latest.json");
    if (!fs.existsSync(snapshotPath)) return;
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as { tables?: Record<string, Record<string, unknown>[]> };
    const tableOrder = ["rooms", "settings", "inventory", "inventory_photos", "photo_cleanup_queue", "inspections", "inspection_results", "inspection_unexpected_items", "transfers", "item_history", "app_metadata"];
    db.transaction(() => {
      for (const table of tableOrder) {
        const rows = snapshot.tables?.[table] ?? [];
        for (const row of rows) {
          const columns = Object.keys(row);
          if (!columns.length) continue;
          const names = columns.map((column) => `"${column}"`).join(",");
          const placeholders = columns.map(() => "?").join(",");
          db.prepare(`INSERT INTO "${table}" (${names}) VALUES (${placeholders})`).run(...columns.map((column) => row[column]));
        }
      }
    })();
  } catch (error) {
    console.error("Deployment snapshot restore failed:", error);
  }
}

function seed(db: Database.Database) {
  const roomCount = (db.prepare("SELECT count(*) AS count FROM rooms").get() as { count: number }).count;
  if (roomCount > 0) return;

  const now = new Date().toISOString();
  db.transaction(() => {
    const addRoom = db.prepare("INSERT INTO rooms (name) VALUES (?)");
    const roomIds = ["კომპიუტერული ლაბორატორია", "მასწავლებლების ოთახი", "საწყობი"].map(
      (name) => Number(addRoom.run(name).lastInsertRowid),
    );
    db.prepare("INSERT INTO settings (id, operator_name, operator_email, demo_data) VALUES (1, ?, ?, 1)").run(
      "დემო ოპერატორი",
      "operator@euro.local",
    );
    const addItem = db.prepare(`INSERT INTO inventory
      (code,name,room_id,quantity,condition,status,notes,responsible_person,registered_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    const items = [
      ["EUR-000001", "სტაციონარული კომპიუტერი", roomIds[0], 1, "კარგი", "გამოყენებაში", "ინდივიდუალური სამუშაო სადგური", "ნინო მაისურაძე"],
      ["EUR-000002", "კომპიუტერის მონიტორი", roomIds[0], 8, "კარგი", "გამოყენებაში", "იდენტური მონიტორების ჯგუფი", "ნინო მაისურაძე"],
      ["EUR-000003", "სამუშაო მაგიდა", roomIds[1], 4, "დამაკმაყოფილებელი", "გამოყენებაში", "", "გიორგი კაპანაძე"],
      ["EUR-000004", "საოფისე სკამი", roomIds[2], 12, "საჭიროებს შეკეთებას", "საწყობში", "ორი სკამი შესაკეთებელია", ""],
      ["EUR-000005", "ლაზერული პრინტერი", roomIds[1], 1, "დაზიანებული", "გამოყენებაში", "ქაღალდის მიმწოდებლის ხარვეზი", "გიორგი კაპანაძე"],
    ];
    for (const item of items) addItem.run(...item, now, now);
  })();
}

function expandDemoData(db: Database.Database) {
  const expanded = db.prepare("SELECT value FROM app_metadata WHERE key='demo_dataset_100'").get();
  if (expanded) return;
  const settings = db.prepare("SELECT demo_data FROM settings WHERE id=1").get() as { demo_data: number } | undefined;
  if (!settings || settings.demo_data !== 1) return;

  const roomNames = [
    "კომპიუტერული ლაბორატორია", "მასწავლებლების ოთახი", "საწყობი", "ბიბლიოთეკა",
    "დირექტორის კაბინეტი", "საკონფერენციო დარბაზი", "ფიზიკის ლაბორატორია",
    "ქიმიის ლაბორატორია", "სპორტული დარბაზი", "სააქტო დარბაზი",
  ];
  const itemNames = [
    "საოფისე სკამი", "მოსწავლის მერხი", "ჭკვიანი დაფა", "მულტიმედიური პროექტორი",
    "პორტატიული კომპიუტერი", "სტაციონარული კომპიუტერი", "კომპიუტერის მონიტორი", "კლავიატურა",
    "კომპიუტერის მაუსი", "ლაზერული პრინტერი", "ფერადი პრინტერი", "დოკუმენტების სკანერი",
    "სამუშაო მაგიდა", "საკონფერენციო მაგიდა", "წიგნების კარადა", "დოკუმენტების კარადა",
    "საპროექციო ეკრანი", "ხმის გამაძლიერებელი", "მიკროფონი", "უსადენო მარშრუტიზატორი",
    "ქსელური გამანაწილებელი", "უწყვეტი კვების წყარო", "საბუნებისმეტყველო მიკროსკოპი",
    "ლაბორატორიული სასწორი", "სპორტული ლეიბი", "კალათბურთის ბურთი", "ფეხბურთის ბურთი",
    "კონდიციონერი", "ელექტრო გამათბობელი", "საინფორმაციო დაფა", "ვიდეოკამერა",
    "ციფრული ფოტოაპარატი", "მაგიდის სანათი", "საკლასო დაფა", "წყლის დისპენსერი",
  ];
  const people = ["ნინო მაისურაძე", "გიორგი კაპანაძე", "ანა ბერიძე", "ლევან მჭედლიშვილი", "მარიამ ქავთარაძე", "დავით წიკლაური", "თამარ ჩხეიძე", "ირაკლი დოლიძე"];
  const conditions = ["კარგი", "კარგი", "კარგი", "დამაკმაყოფილებელი", "დაზიანებული", "საჭიროებს შეკეთებას"];
  const statuses = ["გამოყენებაში", "გამოყენებაში", "გამოყენებაში", "საწყობში"];
  const groupedItems = new Set(["საოფისე სკამი", "მოსწავლის მერხი", "კლავიატურა", "კომპიუტერის მაუსი", "კალათბურთის ბურთი", "ფეხბურთის ბურთი", "სპორტული ლეიბი"]);

  db.transaction(() => {
    db.prepare("UPDATE inventory SET name='სტაციონარული კომპიუტერი' WHERE code='EUR-000001' AND name='Dell OptiPlex კომპიუტერი'").run();
    db.prepare("UPDATE inventory SET name='კომპიუტერის მონიტორი' WHERE code='EUR-000002' AND name='LG მონიტორი 24\"'").run();
    db.prepare("UPDATE inventory SET name='ლაზერული პრინტერი' WHERE code='EUR-000005' AND name='HP LaserJet პრინტერი'").run();
    const addRoom = db.prepare("INSERT OR IGNORE INTO rooms (name) VALUES (?)");
    for (const name of roomNames) addRoom.run(name);
    const rooms = db.prepare(`SELECT id,name FROM rooms WHERE name IN (${roomNames.map(() => "?").join(",")}) ORDER BY id`).all(...roomNames) as { id: number; name: string }[];
    const count = (db.prepare("SELECT count(*) AS count FROM inventory").get() as { count: number }).count;
    const maxCode = (db.prepare("SELECT max(CAST(substr(code,5) AS INTEGER)) AS value FROM inventory WHERE code GLOB 'EUR-[0-9]*'").get() as { value: number | null }).value ?? 0;
    const addItem = db.prepare(`INSERT INTO inventory
      (code,name,room_id,quantity,condition,status,notes,responsible_person,registered_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    for (let index = count; index < 100; index++) {
      const baseName = itemNames[index % itemNames.length];
      const room = rooms[index % rooms.length];
      const quantity = groupedItems.has(baseName) ? 2 + ((index * 3) % 19) : 1;
      const condition = conditions[index % conditions.length];
      const status = statuses[index % statuses.length];
      const timestamp = new Date(Date.now() - (100 - index) * 86_400_000).toISOString();
      const notes = condition === "საჭიროებს შეკეთებას" ? "საჭიროა ტექნიკური დათვალიერება" : index % 7 === 0 ? "დემონსტრაციული ინვენტარის ჩანაწერი" : "";
      const code = `EUR-${String(maxCode + index - count + 1).padStart(6, "0")}`;
      addItem.run(code, `${baseName} №${index + 1}`, room.id, quantity, condition, status, notes, people[index % people.length], timestamp, timestamp);
    }
    db.prepare("INSERT INTO app_metadata (key,value) VALUES ('demo_dataset_100',?)").run(new Date().toISOString());
  })();
}

function ensureDemoActiveCount(db: Database.Database) {
  const completed = db.prepare("SELECT value FROM app_metadata WHERE key='demo_dataset_100_active'").get();
  if (completed) return;
  const settings = db.prepare("SELECT demo_data FROM settings WHERE id=1").get() as { demo_data: number } | undefined;
  if (!settings || settings.demo_data !== 1) return;

  db.transaction(() => {
    const activeCount = (db.prepare("SELECT count(*) AS count FROM inventory WHERE archived_at IS NULL").get() as { count: number }).count;
    const rooms = db.prepare("SELECT id FROM rooms WHERE archived_at IS NULL ORDER BY id").all() as { id: number }[];
    const addItem = db.prepare(`INSERT INTO inventory
      (code,name,room_id,quantity,condition,status,notes,responsible_person,registered_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    for (let index = activeCount; index < 100; index++) {
      const now = new Date().toISOString();
      addItem.run(nextItemCode(db), `დამატებითი საოფისე სკამი №${index + 1}`, rooms[index % rooms.length].id, 4, "კარგი", "გამოყენებაში", "დამატებულია სატესტო მონაცემების შესავსებად", "თამარ ჩხეიძე", now, now);
    }
    db.prepare("INSERT INTO app_metadata (key,value) VALUES ('demo_dataset_100_active',?)").run(new Date().toISOString());
  })();
}

const globalDb = globalThis as unknown as { euroDb?: Database.Database };
export const db = globalDb.euroDb ?? openDatabase();
globalDb.euroDb = db;

export function getOperator(database = db) {
  return database.prepare("SELECT operator_name, operator_email, demo_data FROM settings WHERE id = 1").get() as {
    operator_name: string;
    operator_email: string;
    demo_data: number;
  };
}

export function nextItemCode(database: Database.Database) {
  const row = database.prepare("SELECT max(CAST(substr(code, 5) AS INTEGER)) AS value FROM inventory WHERE code GLOB 'EUR-[0-9]*'").get() as { value: number | null };
  return `EUR-${String((row.value ?? 0) + 1).padStart(6, "0")}`;
}
