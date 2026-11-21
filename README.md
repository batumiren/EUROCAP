# EURO Inventory

Georgian-language school inventory, room inspections, transfers and history. Inventory and photo metadata live in PostgreSQL; private photo files and authentication storage stay in Vercel Blob.

## Local setup

Use Node.js 24 and a disposable PostgreSQL database. Apply the migration explicitly before starting the app. `backups/latest.json` is a legacy snapshot, not a live backup or runtime dependency. If using it locally, do not point the local app at the production Blob store.

```sh
npm ci
MIGRATION_DATABASE_URL="$LOCAL_DATABASE_URL" npm run db:migrate -- backups/latest.json --empty-target
DATABASE_URL="$LOCAL_DATABASE_URL" npm run dev
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

1. **Preview:** create an empty, separate Neon database. Run `MIGRATION_DATABASE_URL="$PREVIEW_DIRECT_URL" npm run db:migrate -- /secure/path/verified-snapshot.json --empty-target`. Set `PREVIEW_DATABASE_URL` to that database's **pooled SSL** connection string in Vercel's **Preview** environment, scoped to `fix/reliable-inventory-saves`. Use a separate private Blob store/token for Preview authentication; photo writes remain disabled there so a migrated reference cannot delete a production file. Never use Production credentials to test Preview. Redeploy the branch and check concurrent saves, same-key retries, an unavailable-database deployment, and a fresh deployment with the original Preview URL. Compare migrated rows; verify real photo files separately on the production candidate.
2. **Freeze legacy writes:** after approval, put the production site into maintenance and block writes on old deployment URLs as well. Wait for in-flight saves and snapshot syncs. Save a protected copy of the latest GitHub snapshot and reconcile it with live screens, exports, recent entries, and any recoverable local SQLite backups before selecting the final snapshot. The old app can lose writes; a GitHub snapshot alone does not prove those writes are present. Inventory XLSX/CSV alone is not a migration source because it lacks IDs and related tables. Do not proceed if the authoritative data is unresolved.
3. **Migrate once:** create a new, empty production Neon database. From the approved branch, run `MIGRATION_DATABASE_URL="$PROD_DIRECT_URL" npm run db:migrate -- /secure/path/final-snapshot.json --empty-target`. This command refuses a non-empty schema, compares every stored row against the input before committing, and advances ID and barcode sequences. It never runs from build, deploy, or startup.
4. **Connect and switch:** set `DATABASE_URL` to the **pooled SSL** Neon URL in Vercel **Production** only. Keep the current Production `BLOB_READ_WRITE_TOKEN` unchanged. Remove the Production `GITHUB_SYNC_TOKEN` and revoke the old token after legacy writes have stopped; ensure older deployments cannot continue accepting writes, because removing a variable does not alter existing deployment environments. Merge/deploy the approved change. Before reopening, verify room and item counts, a few barcode lookups, Georgian text, history, and a referenced photo. Reopen writes only after those checks.
5. **Rollback:** before reopening writes, a rollback can restore the frozen legacy deployment/data only if the owner accepts that older save behavior temporarily. After any successful Neon writes, do not roll back to SQLite; keep writes frozen and deploy a PostgreSQL-compatible fix or reconcile all Neon changes first.

Use `sslmode=verify-full` for Neon URLs. Keep credentials out of Git and use Neon backups/PITR. The new app fails closed without its configured database and never uploads snapshots to GitHub.

An inventory create request uses a per-submission `Idempotency-Key` UUID. Retrying it returns the committed batch; a new key allows an otherwise identical submission. PostgreSQL sequences may skip numbers after rollback, but barcodes are never duplicated.
