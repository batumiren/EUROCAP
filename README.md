# EURO Inventory

Georgian-language local inventory management application for room-based inventory, inspections, transfers, and immutable history.

Room inspections support USB barcode readers that operate as keyboards. Scanning an `EUR-000001`-style item code confirms an expected room record, keeps unscanned expected records visible as missing/unconfirmed, and identifies items assigned to another room. Wrong-room findings are preserved with the inspection snapshot.

## Setup

Requirements: Node.js 20+ and npm.

```bash
npm install
npm run db:init
npm run dev
```

Open `http://localhost:3000`. On the first launch, the empty database receives clearly marked demonstration rooms, inventory, and an editable operator profile. Seeding is idempotent and never replaces existing data.

## Database

SQLite data is stored at `data/euro-inventory.db`. Foreign keys and WAL mode are enabled. To use another location, set `DATABASE_PATH` to an absolute or project-relative SQLite file path before starting the app.

## Checks

```bash
npm test
npx tsc --noEmit
npm run build
```

## V1 limitations

- Local, single-operator use only; there is no authentication or permissions system.
- No authentication, attachments, or public export UI. Protect access appropriately before using real operational data.
- Inventory records are archived rather than deleted; archived records are intentionally read-only.
- Inspection findings never alter stock quantities automatically. Quantity changes use the explicit correction workflow.

## Vercel deployment

Vercel cannot host the local writable SQLite file. Connect a **private Vercel Blob store** to this project (OIDC via `BLOB_STORE_ID` is preferred; `BLOB_READ_WRITE_TOKEN` is also supported). Do not use a public store.

Every API request loads the latest saved state into an isolated in-memory SQLite database. Successful mutations save the complete state with an ETag condition before returning success. Concurrent saves return HTTP 409 rather than overwriting a newer version. Storage failures return an error; nothing is acknowledged as saved only in memory. Git-based background synchronization runs only in local mode.

An empty store starts from `backups/latest.json`, preserving IDs, archived items, rooms, inspections, transfers, and audit history. The first successful edit creates the durable cloud snapshot. Once present, that snapshot is authoritative: deploys never replace it with the bundled backup. Invalid or unavailable cloud data fails closed.

Production uses `eurocap/production/latest.json`. Preview environments use a separate path per Git branch, so preview tests cannot edit production inventory. Local development continues to use `DATABASE_PATH` unless Blob credentials are configured.

This storage model is intended for the existing small inventory dataset: each request downloads the snapshot and each save replaces it atomically. Larger datasets or frequent concurrent writes should move to a managed SQL database. Blob storage quotas apply.
