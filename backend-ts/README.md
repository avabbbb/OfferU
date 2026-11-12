# OfferU TS backend (test branch)

This is the first vertical slice of the Python -> TypeScript migration.

## What it does

- Reuses `packages/core` (the same pure rules as the web demo).
- Reads and writes the same SQLite `records` / `changes` schema as
  `backend/app/core/store.py`.
- Serves:

```
GET  /api/health
GET  /api/tools
POST /api/tools/{overview,list,get,save,delete,undo,changes,search}
```

The Node adapter is `src/store.ts`; route logic is `src/server.ts`; tool
dispatch is `src/tools.ts`.

## Run

```bash
cd backend-ts
npm install
OFFERU_TS_PORT=8767 OFFERU_DB_PATH=H:/tmp/offeru-ts/offeru.db npm run dev
```

Default DB: `backend-ts/.data/offeru.db`. It is intentionally separate from the
real local app database unless `OFFERU_DB_PATH` points at it.

## Test

```bash
npm test
npm run typecheck
```

The compatibility check performed during migration: Python writes `profile` and
`job`, TS reads them; TS writes an `event`, Python reads it.

## Not migrated yet

- Pairing/auth for the public showcase bridge
- MCP server and `offeru` CLI
- Email sync, PDF/Playwright rendering, file parsing, job sources
- All Python tools outside the eight core tools
- Production packaging/build (the slice runs through `tsx`)

Python remains the source of truth for those. Do not delete `backend/app/core`
until the TS HTTP/MCP/CLI surfaces pass the same acceptance tests and a backup
round-trip.
