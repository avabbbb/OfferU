// Cloudflare Worker entry: the same Hono app, stateless (storage "none").
//
// The Worker never stores user data and never sees API keys (decision
// 2026-11-15): records live in the browser (IndexedDB) or on the local
// companion (SQLite). It exists for things a static page cannot do itself,
// e.g. fetching a job page that does not send CORS headers. Route modules
// that need a store answer 501 here via CoreError("unsupported").
//
// No node:* imports anywhere reachable from this file (checked by
// `wrangler deploy --dry-run`).

import { CoreError, type CoreStore } from "@offeru/core";

import { createApp } from "./app";

const unsupported = (): never => {
  throw new CoreError("云端 Worker 不保存数据：数据在你的浏览器或本机 OfferU 里", "unsupported");
};

/** A CoreStore that refuses everything: the Worker is stateless by design. */
export const noStore: CoreStore = {
  all: async () => unsupported(),
  get: async () => unsupported(),
  first: async () => unsupported(),
  put: async () => unsupported(),
  remove: async () => unsupported(),
  changes: async () => unsupported(),
  getChange: async () => unsupported(),
  lastChange: async () => unsupported(),
  addChange: async () => unsupported(),
  updateChange: async () => unsupported(),
  transaction: async () => unsupported(),
};

export const app = createApp({ store: noStore, runtime: "worker", storage: "none" });

export default {
  fetch: app.fetch,
};
