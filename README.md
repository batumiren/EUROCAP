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

## Inventory photos

Inventory details support multiple private photos stored in Vercel Blob. Configure `BLOB_READ_WRITE_TOKEN`, `EUROCAP_AUTH_SECRET`, and `EUROCAP_PHOTO_PASSWORD`. The photo login uses the operator email configured in Settings and the environment password. Images are resized and JPEG-compressed in the browser before upload; only photo metadata is stored in SQLite and GitHub snapshots.

## Checks

```bash
npm test
npx tsc --noEmit
npm run build
```

## V1 limitations

- Local, single-operator use only; there is no authentication or permissions system.
- No cloud deployment, barcode scanning, attachments, exports, or external integrations.
- Inventory records are archived rather than deleted; archived records are intentionally read-only.
- Inspection findings never alter stock quantities automatically. Quantity changes use the explicit correction workflow.
