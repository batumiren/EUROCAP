import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { Client } from "pg";
import { documentSchema } from "../lib/auth-document";
import { hashPassword } from "../lib/auth";

async function main() {
  const [source, confirmation] = process.argv.slice(2);
  const connectionString = process.env.MIGRATION_DATABASE_URL;
  if (!source || confirmation !== "--empty-auth" || !connectionString) throw new Error("Usage: npm run db:migrate-auth -- <private-export.json|--preview-fixture> --empty-auth");
  let document;
  if (source === "--preview-fixture") {
    const url = new URL(connectionString);
    if (url.pathname !== "/eurocap_preview" && !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Preview fixtures require a database named eurocap_preview.");
    const fixturePassword = process.env.PREVIEW_FIXTURE_PASSWORD;
    if (!fixturePassword || fixturePassword.length < 16) throw new Error("Set a unique PREVIEW_FIXTURE_PASSWORD (16+ characters).");
    document = documentSchema.parse({
      version: 1, secret: randomBytes(32).toString("hex"),
      users: { admin: { hash: await hashPassword(fixturePassword), revision: randomUUID() }, check: { hash: await hashPassword(fixturePassword), revision: randomUUID() } },
      revoked: [], attempts: { admin: { start: 0, count: 0 }, check: { start: 0, count: 0 }, unknown: { start: 0, count: 0 } },
    });
  } else {
    document = documentSchema.parse(JSON.parse(readFileSync(source, "utf8")));
  }
  const client = new Client({ connectionString, connectionTimeoutMillis: 10000 });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL search_path TO public");
    await client.query("INSERT INTO eurocap_auth (id,document) VALUES (1,$1)", [document]);
    if (!isDeepStrictEqual((await client.query("SELECT document FROM eurocap_auth WHERE id=1")).rows[0]?.document, document)) {
      throw new Error("Auth migration read-back mismatch.");
    }
    await client.query("COMMIT");
    console.log("Verified 2 accounts, role identities, hashes, revisions, revocations and attempt windows.");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { await client.end(); }
}

main().catch(error => {
  // Never print Zod inputs, PostgreSQL DETAIL, connection URLs or credential values.
  console.error("Authentication migration did not complete:", error?.code ?? error?.name ?? "unknown");
  process.exitCode = 1;
});
