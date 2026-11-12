# Python -> TypeScript backend migration

Status: phase 1 complete, phase 2 in progress. Python remains the production
backend until every phase has parity and a data-safety round-trip.

## Order

| Phase | Scope | Exit evidence |
| --- | --- | --- |
| 0 | `packages/core`: shared rules, no React/DOM/Node | frontend + Node consume same package |
| 1 | Node SQLite adapter + `/api/tools/*` | same records/changes schema; cross-read Python/TS; tests |
| 2 | MCP stdio + CLI + pairing/token + HTTP parity | MCP client list/call; CLI JSON; bridge preflight; 403 without token |
| 3 | Domain routes: profile/jobs/events/docs | dual-run against same DB; contract fixtures |
| 4 | Resume/PDF/Playwright, mail/IMAP, job sources | TS route or explicit sidecar; feature flag |
| 5 | Agent runtime/skills/eval surfaces | host matrix + eval gates |
| 6 | Cut over, delete retired Python paths | backup/restore, parity, rollback tested |

## Rules

- `packages/core` owns domain rules; adapters own persistence/transport.
- No route-specific business logic in `server.ts` or `cli.ts`.
- Every migrated tool/route gets a Python/TS shared contract case.
- Do not delete Python until the replacement has the same data, error, and
  recovery behavior. Keep a rollback path.
- Same SQLite schema is the compatibility seam during migration.

## Phase 2 gaps

- `/mcp` Streamable HTTP transport is not implemented yet; stdio MCP and CLI are.
- Only the eight core tools are exposed; the rest still return unsupported.
- TS backend runs through `tsx`; production packaging is not decided.
- `node:sqlite` is experimental on Node 24; revisit `better-sqlite3` if needed.
