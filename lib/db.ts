import { Pool, type PoolClient, type QueryResultRow } from "pg";

export class DatabaseUnavailable extends Error {}
export class CommitUncertain extends DatabaseUnavailable {}

let pool: Pool | undefined;
function getPool() {
  const url = process.env.VERCEL_ENV === "preview" ? process.env.PREVIEW_DATABASE_URL : process.env.DATABASE_URL;
  if (!url) throw new DatabaseUnavailable("Inventory PostgreSQL URL is not configured.");
  if (!pool) {
    pool = new Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 5000, allowExitOnIdle: true });
    pool.on("error", error => console.error("Idle inventory connection failed", error.name));
  }
  return pool;
}

export class Database {
  constructor(private readonly client?: PoolClient) {}

  async query<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) {
    return (this.client ?? getPool()).query<T>(sql, params);
  }

  // Static application SQL with positional binding; no user input is interpolated.
  prepare(sql: string) {
    let index = 0;
    const statement = sql.replace(/\?/g, () => `$${++index}`);
    return {
      all: async (...params: unknown[]) => (await this.query(statement, params)).rows,
      get: async (...params: unknown[]) => (await this.query(statement, params)).rows[0],
      run: (...params: unknown[]) => this.query(statement, params),
      insert: async (...params: unknown[]) => (await this.query<{ id: number }>(`${statement} RETURNING id`, params)).rows[0],
    };
  }

  async transaction<T>(operation: (tx: Database) => Promise<T>, serializeInventory = true): Promise<T> {
    if (this.client) throw new Error("Nested inventory transaction");
    const client = await getPool().connect();
    let discard = false;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '8s'");
      await client.query("SET LOCAL statement_timeout = '15s'");
      // Serialize inventory mutations (including room changes) across app instances.
      if (serializeInventory) await client.query("SELECT pg_advisory_xact_lock(1798468271)");
      const result = await operation(new Database(client));
      try {
        if ((await client.query("COMMIT")).command !== "COMMIT") throw new Error("Inventory transaction did not commit.");
      }
      catch { discard = true; throw new CommitUncertain("Inventory commit could not be confirmed."); }
      return result;
    } catch (error) {
      if (!discard) {
        try { await client.query("ROLLBACK"); }
        catch { discard = true; }
      }
      throw error;
    } finally { client.release(discard); }
  }
}

export const db = new Database();

export async function getOperator(database = db) {
  const operator = (await database.query<{ operator_name: string; operator_email: string; demo_data: number }>(
    "SELECT operator_name,operator_email,demo_data FROM settings WHERE id=1"
  )).rows[0];
  if (!operator) throw new DatabaseUnavailable("Inventory operator settings missing.");
  return operator;
}

export async function nextItemCode(database = db) {
  const { value } = (await database.query<{ value: string }>(
    "SELECT (last_value + CASE WHEN is_called THEN 1 ELSE 0 END)::text AS value FROM inventory_barcode_seq"
  )).rows[0];
  return `EUR-${value.padStart(6, "0")}`;
}
