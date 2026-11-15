import type { Server } from "node:http";

import { createAdaptorServer } from "@hono/node-server";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { pairingToken } from "./pairing";
import { dbPath } from "./paths";
import type { Hono } from "hono";

import { createApp, type AppDeps, type AppEnv } from "./app";
import { nodeTraceSink } from "./agent-trace";
import { SqliteAgentRunStore } from "./agent-store";
import { nodeToolRuntime } from "./node-runtime";
import { agentHost } from "./routes/agent";
import { registerCompanionRoutes } from "./routes/companion";
import { nodeAttachmentFiles, popplerPdfText } from "./routes/companion/attachments";
import { NodeAgentBoard } from "./routes/companion/agent-board";
import { nodeBackupFiles } from "./routes/companion/backups";
import { nodeBossLogin } from "./routes/companion/boss-cli";
import { exportResumePdf, filesDirFor, nodeFileStore, nodeSchoolLogos, playwrightRenderer } from "./routes/companion/resume";
import { ConfigRuntime } from "./routes/config";
import { nodeConfigFile } from "./routes/companion/config-file";
import { llmFromEnv } from "./llm-env";
import { openStore } from "./store";
import { CompanionSync } from "./sync";
import type { SqliteCoreStore } from "./store";

/** The companion's AppDeps: SQLite store plus every Node-only capability; `overrides` replace any of them (tests, the journey harness). */
export function companionDeps(store: SqliteCoreStore, overrides: Partial<AppDeps> = {}): AppDeps {
  const { search, fetch, companion } = nodeToolRuntime(store);
  const config = new ConfigRuntime(nodeConfigFile(join(dirname(dbPath()), "offeru-ts-config.json")), (input, init) => globalThis.fetch(input, init), (name) => process.env[name]);
  void config.get().catch(() => undefined);
  const exportsDir = join(dirname(dbPath()), "exports");
  const deps: AppDeps = {
    store,
    pairingToken,
    runtime: "node",
    storage: "sqlite",
    // The model comes from the user's saved settings (/api/config); OFFERU_LLM_* env vars are a dev fallback only.
    llm: () => config.llm() ?? llmFromEnv(),
    config,
    search,
    fetch,
    // export_resume_pdf / draft_email attachments print with whatever renderer this app ends up with.
    companion: {
      ...companion,
      exportResumePdf: (id, name) => exportResumePdf({ store, files: deps.files, renderer: deps.renderer }, exportsDir, id, name),
      // Python ExportIn only exposes id; the JD-named attachment comes from draft_email.
      handlers: { ...companion.handlers, export_resume_pdf: (args) => exportResumePdf({ store, files: deps.files, renderer: deps.renderer }, exportsDir, Number(args.id)) },
    },
    files: "files" in overrides ? overrides.files : nodeFileStore(filesDirFor(dbPath())),
    renderer: "renderer" in overrides ? overrides.renderer : playwrightRenderer(),
    schoolLogos: "schoolLogos" in overrides ? overrides.schoolLogos : nodeSchoolLogos(),
    bossLogin: nodeBossLogin(),
    attachmentFiles: nodeAttachmentFiles(dbPath()),
    pdfText: popplerPdfText(),
    backups: nodeBackupFiles(dbPath()),
    agentBoard: new NodeAgentBoard({ dataDir: dirname(dbPath()) }),
    agentRuns: new SqliteAgentRunStore(store),
    agentTrace: nodeTraceSink(),
    sync: new CompanionSync(store, dirname(dbPath())),
    ...overrides,
  };
  return deps;
}

/** createApp + the companion-only routes, with interrupted runs marked resumable. */
export function createCompanionApp(store: SqliteCoreStore, overrides: Partial<AppDeps> = {}): { app: Hono<AppEnv>; deps: AppDeps } {
  const deps = companionDeps(store, overrides);
  const app = createApp(deps);
  registerCompanionRoutes(app);
  // Runs that were executing when the last process died become resumable.
  void agentHost(deps).state.recoverInterrupted().catch((cause) => console.error("agent recovery failed", cause));
  return { app, deps };
}

export function createAppServer(store: SqliteCoreStore, overrides: Partial<AppDeps> = {}): Server {
  const { app } = createCompanionApp(store, overrides);
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
