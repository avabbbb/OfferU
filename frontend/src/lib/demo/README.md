# Showcase demo core (test branch)

`VITE_SHOWCASE=true` normally replays `snapshot.json`. This directory adds a
real browser-side store for the core loop, so the static demo can create,
edit, delete, search and undo records without a Python backend.

## What is shared

- `src/lib/domain/` is pure TypeScript: validation, labels, overview buckets,
  status rules, change log and undo. No React, DOM, IndexedDB or fetch.
- `src/lib/demo/store.ts` is the browser adapter (localforage/IndexedDB).
- `src/lib/demo/seed.ts` is fictional demo data.
- A future Node adapter can implement `CoreStore` and reuse the same domain
  code; do not put browser APIs into `src/lib/domain/`.

## Supported tools only

`overview`, `list`, `get`, `save`, `delete`, `undo`, `changes`, `search`.

Everything else throws `DEMO_UNSUPPORTED`; never return a fake success. AI,
email sync, file reads, PDF export, browser extension and external agents are
deliberately unsupported in the static demo. The local bridge is the only way
to use a real backend.

## Drift control

Python `backend/app/core/tools.py` remains the source of truth. Before changing
one of the eight supported tools, update the matching behavior here and its
test in `domain/operations.test.ts`. The demo must stay a subset; do not add
best-effort behavior that only exists in the browser.

## Data and privacy

Demo records are fictional and stored as plaintext IndexedDB under
`offeru-demo`. The API key vault is separate: `keyVault.ts` encrypts a
remembered provider key with a non-extractable device key before writing it to
IndexedDB; memory-only is the default. The mode bar offers a clear/reset
action. Do not add real identity numbers, phone numbers, resumes or provider
keys to seed data.

## Local bridge

The mode bar can pair with `http://127.0.0.1:8766`. The backend requires
`X-OfferU-Pairing` for bridge origins; the token is displayed at
`/api/pairing` and kept in memory only. Without pairing, the page never talks
to the loopback backend.

## Built-in browser Agent

`src/lib/demo/agent.ts` runs a tiny OpenAI-compatible function-calling loop in
the page. It exposes six tools only: `overview`, `list`, `get`, `save`,
`search`, `undo`. Tool calls go through the same demo core as the UI, with the
actor fixed to `Agent`, so status moves follow the forward-only guard.

`keyVault.ts` keeps an optional remembered provider key encrypted with a
non-extractable AES-GCM device key. The config (base URL/model) is plaintext;
the key is not. This is an at-rest protection only; the page cannot defend
against same-origin XSS. The default is memory-only; the user must opt in.

The provider must allow browser CORS. The demo never proxies model requests and
never sends the key to OfferU. The chat log is plaintext demo data and is cleared
by the mode bar reset.

## Data package and WebDAV snapshot

The mode bar exposes a JSON package (`offeru-demo-*.json`) built from the demo
store snapshot. It contains records and changes, not API keys or Agent chat.
Importing replaces the whole demo state (no field-level merge) and keeps one
pre-import snapshot in `offeru-demo-sync` for recovery.

WebDAV sync follows Flovart's pattern: browser-side `PROPFIND`/`MKCOL`/`GET`/
`PUT` with optional Basic auth. The remote file is `offeru-demo.json`; upload
overwrites the remote, download overwrites the local snapshot. The password is
memory-only. The WebDAV server must allow CORS and those methods. This is a
manual snapshot sync, not background sync and not conflict-free merging.
