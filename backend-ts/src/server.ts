import type { Server } from "node:http";

import { createAdaptorServer } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { pairingToken } from "./pairing";
import { dbPath } from "./paths";
import { createApp, type AppDeps } from "./app";
import { SqliteAgentRunStore } from "./agent-store";
import { nodeToolRuntime } from "./node-runtime";
import { agentHost } from "./routes/agent";
import { registerCompanionRoutes } from "./routes/companion";
import { nodeAttachmentFiles, popplerPdfText } from "./routes/companion/attachments";
import { NodeAgentBoard } from "./routes/companion/agent-board";
import { nodeBackupFiles } from "./routes/companion/backups";
import { nodeBossLogin } from "./routes/companion/boss-cli";
import { filesDirFor, nodeFileStore, nodeSchoolLogos, playwrightRenderer } from "./routes/companion/resume";
import { ConfigRuntime } from "./routes/config";
import { nodeConfigFile } from "./routes/companion/config-file";
import { nodeConsentFile } from "./routes/companion/consent-file";
import { llmFromEnv } from "./llm-env";
import { openStore } from "./store";
import { nodeRuntimeInfo } from "./runtime-identity";
import { CompanionSync } from "./sync";
import type { SqliteCoreStore } from "./store";

export interface ServerOptions {
  /** Serve this built workbench (frontend/dist) at / with an index.html fallback (lite `offeru-ts start`). */
  webDir?: string | null;
}

export function createAppServer(store: SqliteCoreStore, overrides: Partial<AppDeps> = {}, options: ServerOptions = {}): Server {
  const { search, fetch, companion } = nodeToolRuntime(store);
  const config = new ConfigRuntime(nodeConfigFile(join(dirname(dbPath()), "offeru-ts-config.json"), join(dirname(dbPath()), "config.json")), (input, init) => globalThis.fetch(input, init), (name) => process.env[name]);
  void config.get().catch(() => undefined);
  const deps: AppDeps = {
    store,
    pairingToken,
    runtime: "node",
    storage: "sqlite",
    // The model comes from the user's saved settings (/api/config); OFFERU_LLM_* env vars are a dev fallback only.
    llm: (choice) => config.llm(choice) ?? llmFromEnv(),
    config,
    search,
    fetch,
    companion,
    files: "files" in overrides ? overrides.files : nodeFileStore(filesDirFor(dbPath())),
    renderer: "renderer" in overrides ? overrides.renderer : playwrightRenderer(),
    schoolLogos: "schoolLogos" in overrides ? overrides.schoolLogos : nodeSchoolLogos(),
    bossLogin: nodeBossLogin(),
    attachmentFiles: nodeAttachmentFiles(dbPath()),
    pdfText: popplerPdfText(),
    backups: nodeBackupFiles(dbPath()),
    agentBoard: new NodeAgentBoard({ dataDir: dirname(dbPath()) }),
    agentRuns: new SqliteAgentRunStore(store),
    sync: new CompanionSync(store, dirname(dbPath())),
    consent: nodeConsentFile(join(dirname(dbPath()), "platform-consent.json")),
    runtimeInfo: nodeRuntimeInfo(process.env, () => process.env.OFFERU_APPROVAL_TOKEN || pairingToken()),
    approvalToken: process.env.OFFERU_APPROVAL_TOKEN ? () => process.env.OFFERU_APPROVAL_TOKEN! : null,
    ...overrides,
  };
  const app = createApp(deps);
  registerCompanionRoutes(app);
  if (options.webDir) {
    const root = options.webDir;
    app.use("/*", serveStatic({ root }));
    // Client-side routes (#/pair/... is a hash, but /jobs etc. may be deep-linked): index.html.
    app.get("*", async (c, next) => (c.req.path.startsWith("/api/") ? next() : serveStatic({ root, path: "index.html" })(c, next)));
  }
  // Runs that were executing when the last process died become resumable.
  void agentHost(deps).state.recoverInterrupted().catch((cause) => console.error("agent recovery failed", cause));
  const server = createAdaptorServer({ fetch: app.fetch }) as Server & { offeruRuntime?: AppDeps["runtimeInfo"] };
  server.offeruRuntime = deps.runtimeInfo;
  return server;
}

export function startHttpServer(store: SqliteCoreStore, port = Number(process.env.OFFERU_TS_PORT || process.env.OFFERU_PORT || 8767), options: ServerOptions = {}): Server {
  const server = createAppServer(store, {}, options);
  server.listen(port, "127.0.0.1", () => {
    console.log(`OfferU TS backend on http://127.0.0.1:${port} (${dbPath()})`);
  });
  return server;
}

export function main(): void {
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
