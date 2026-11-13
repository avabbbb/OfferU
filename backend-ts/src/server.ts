import type { Server } from "node:http";

import { createAdaptorServer } from "@hono/node-server";
import { pathToFileURL } from "node:url";

import { pairingToken } from "./pairing";
import { dbPath } from "./paths";
import { createApp, type AppDeps } from "./app";
import { llmFromEnv } from "./llm-env";
import { registerCompanionRoutes } from "./routes/companion";
import { filesDirFor, nodeFileStore, playwrightRenderer } from "./routes/companion/resume";
import { openStore } from "./store";
import type { SqliteCoreStore } from "./store";

export function createAppServer(store: SqliteCoreStore, overrides: Partial<AppDeps> = {}): Server {
  const app = createApp({
    store,
    pairingToken,
    runtime: "node",
    storage: "sqlite",
    llm: "llm" in overrides ? overrides.llm : llmFromEnv(),
    files: "files" in overrides ? overrides.files : nodeFileStore(filesDirFor(dbPath())),
    renderer: "renderer" in overrides ? overrides.renderer : playwrightRenderer(),
    ...overrides,
  });
  registerCompanionRoutes(app);
  return createAdaptorServer({ fetch: app.fetch }) as Server;
}

export function startHttpServer(store: SqliteCoreStore, port = Number(process.env.OFFERU_TS_PORT || 8767)): Server {
  const server = createAppServer(store);
  server.listen(port, "127.0.0.1", () => {
    console.log(`OfferU TS backend on http://127.0.0.1:${port} (${dbPath()})`);
  });
  return server;
}

function main(): void {
  const store = openStore(dbPath());
  const server = startHttpServer(store);
  const shutdown = () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
