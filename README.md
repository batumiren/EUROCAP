# EURO Inventory

Georgian-language school inventory, room inspections, transfers and history. Inventory, photo metadata and authentication live in PostgreSQL; private photo files stay in Vercel Blob.

## Local setup

Use Node.js 24 and a disposable PostgreSQL database. Apply the migration explicitly before starting the app. `backups/latest.json` is a legacy snapshot, not a live backup or runtime dependency. If using it locally, do not point the local app at the production Blob store.

```sh
npm ci
MIGRATION_DATABASE_URL="$LOCAL_DATABASE_URL" npm run db:migrate -- backups/latest.json --empty-target
MIGRATION_DATABASE_URL="$LOCAL_DATABASE_URL" PREVIEW_FIXTURE_PASSWORD="$LOCAL_TEST_PASSWORD" \
  npm run db:migrate-auth -- --preview-fixture --empty-auth
DATABASE_URL="$LOCAL_DATABASE_URL" AUTH_SESSION_SECRET="$LOCAL_SESSION_SECRET" npm run dev
```

Tests require a separate loopback PostgreSQL database named `*_test`; test tables are truncated. With PostgreSQL running locally:

```sh
createdb eurocap_test
TEST_DATABASE_URL=postgresql://localhost/eurocap_test npm test
npm run lint
npm run build
```

## Neon preview and production cutover

**Do not merge or change Production settings until the preview checks pass and the owner approves.**

1. **Preview:** create an empty Neon database named `eurocap_preview` in a separate project. Run `MIGRATION_DATABASE_URL="$PREVIEW_DIRECT_URL" npm run db:migrate -- /secure/path/verified-snapshot.json --empty-target`. Use `db:migrate-auth -- --preview-fixture --empty-auth` with `MIGRATION_DATABASE_URL` and a random `PREVIEW_FIXTURE_PASSWORD` (16+ characters). Set `PREVIEW_DATABASE_URL` to its **pooled SSL** URL, and `AUTH_SESSION_SECRET` to 32 random bytes encoded as 64 hex characters. Scope both to **Preview** for `fix/reliable-inventory-saves`. Never use production passwords in Preview. Preview photo writes are disabled; a photo read requiring Blob uses only `PREVIEW_BLOB_READ_WRITE_TOKEN`, with a separate private store if needed.
2. **Freeze legacy writes:** after approval, put the production site into maintenance and block writes on old deployment URLs as well. Wait for in-flight saves and snapshot syncs. Save a protected copy of the latest GitHub snapshot and reconcile it with live screens, exports, recent entries, and any recoverable local SQLite backups before selecting the final snapshot. The old app can lose writes; a GitHub snapshot alone does not prove those writes are present. Inventory XLSX/CSV alone is not a migration source because it lacks IDs and related tables. Do not proceed if the authoritative data is unresolved.
3. **Migrate once:** create a new, empty production Neon database. From the approved branch, run `MIGRATION_DATABASE_URL="$PROD_DIRECT_URL" npm run db:migrate -- /secure/path/final-snapshot.json --empty-target`. This refuses a non-empty schema, compares each stored row before committing, and advances ID and barcode sequences. With legacy logins/password changes/logout also frozen, export `eurocap/auth/credentials-v1.json` from the production private Blob store to a protected local file (`umask 077`; never print the file or commit it). Run `MIGRATION_DATABASE_URL="$PROD_DIRECT_URL" npm run db:migrate-auth -- /secure/path/auth-export.json --empty-auth`. This verifies an exact read-back of hashes, roles, revisions, revocations, and throttling windows without logging them. Do not alter or delete the legacy Blob. No migration runs from build, deploy, or startup.
4. **Connect and switch:** set Vercel **Production** `DATABASE_URL` to the **pooled SSL** Neon URL and `AUTH_SESSION_SECRET` to a fresh 64-character hex secret. A new signing key deliberately expires old sessions; users sign in again with unchanged passwords. Keep the existing Production `BLOB_READ_WRITE_TOKEN` for private photos. After legacy writes are stopped, remove Production `GITHUB_SYNC_TOKEN` and revoke it; older deployments must remain unavailable because removing a variable does not alter their existing environments. Merge/deploy only after final approval. Verify room/item counts, barcode lookups, Georgian text, history, a referenced photo if present, and both roles. Confirm logout and password changes invalidate old sessions. Reopen writes only after those checks.
5. **Rollback:** before reopening writes, a rollback can restore the frozen legacy deployment/data only if the owner accepts the previous save behavior temporarily and restoring the old sync credential is authorized. After any successful Neon writes, including credential changes, do not roll back to SQLite/Blob; keep writes frozen and deploy a PostgreSQL-compatible fix or reconcile all Neon changes first.

Use `sslmode=verify-full` for Neon URLs. Keep credentials out of Git and use Neon backups/PITR. The new app fails closed without its configured database and never uploads snapshots to GitHub.

An inventory create request uses a per-submission `Idempotency-Key` UUID. Retrying it returns the committed batch; a new key allows an otherwise identical submission. PostgreSQL sequences may skip numbers after rollback, but barcodes are never duplicated.
