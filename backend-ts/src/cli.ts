#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runMcpServer } from "./mcp";
import { NodeAgentBoard } from "./routes/companion/agent-board";
import { dbPath } from "./paths";
import { startHttpServer } from "./server";
import { ALL_TOOL_SPECS } from "@offeru/core";

import { nodeToolRuntime } from "./node-runtime";
import { callTool, TOOL_NAMES } from "./tools";
import { openStore } from "./store";
import { APP_VERSION } from "./runtime-identity";

const HELP = `OfferU TS CLI

usage:
  offeru-ts tool [<name> [json|@file|-]] [--actor name] [--pretty]
      no name: list the tools. Actor: --actor, else $OFFERU_ACTOR, else "agent" (like Python).
  offeru-ts mcp
  offeru-ts serve
  offeru-ts doctor
  offeru-ts start [--no-browser]
      serve the built workbench (frontend/dist) and the API on 127.0.0.1:8766, open #/pair/<code>.
global: --data-dir <dir> (else $OFFERU_DATA_DIR)

tools: ${TOOL_NAMES.join(", ")}
`;

const here = dirname(fileURLToPath(import.meta.url));

function openBrowser(url: string): void {
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true }).unref();
  } catch {
    // the URL is printed; the user opens it
  }
}

function takeFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  args.splice(index, value ? 2 : 1);
  return value;
}

function payloadOf(raw: string | undefined): unknown {
  // utf-8-sig like Python: PowerShell writes a BOM.
  const text = raw === "-"
    ? readFileSync(0, "utf8")
    : raw?.startsWith("@")
      ? readFileSync(raw.slice(1), "utf8")
      : raw || "{}";
  return JSON.parse(text.replace(/^\uFEFF/, "") || "{}");
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  // Python `offeru --data-dir <dir> ...`: the Skill command pins the database of this install.
  const dataDir = takeFlag(args, "--data-dir");
  if (dataDir) process.env.OFFERU_DATA_DIR = dataDir;
  const command = args.shift() || "help";
  const pretty = args.includes("--pretty");
  const actor = takeFlag(args, "--actor") || process.env.OFFERU_ACTOR || "agent";
  const prettyIndex = args.indexOf("--pretty");
  if (prettyIndex >= 0) args.splice(prettyIndex, 1);

  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === "doctor") {
    process.stdout.write(JSON.stringify({
      ok: true,
      service: "OfferU TS",
      version: process.env.OFFERU_VERSION || APP_VERSION,
      runtime: "node",
      database: dbPath(),
      tools: TOOL_NAMES,
    }, null, pretty ? 2 : 0) + "\n");
    return 0;
  }

  if (command === "tool" && !args[0]) {
    for (const spec of ALL_TOOL_SPECS) process.stdout.write(`${spec.name}: ${spec.description}\n`);
    return 0;
  }

  const store = openStore(dbPath());
  const runtime = nodeToolRuntime(store);
  try {
    if (command === "tool") {
      const name = args.shift()!;
      try {
        const result = await callTool(name, payloadOf(args[0]), runtime, actor);
        process.stdout.write(JSON.stringify(result, null, pretty ? 2 : 0) + "\n");
        return 0;
      } catch (cause) {
        // Python: {"error": "..."} on stdout, exit 1; shown to the agent as-is.
        process.stdout.write(JSON.stringify({ error: cause instanceof Error ? cause.message : String(cause) }) + "\n");
        return 1;
      }
    }

    if (command === "mcp") {
      const board = new NodeAgentBoard({ dataDir: dirname(dbPath()) });
      await runMcpServer(runtime, { onClientCall: (client) => board.recordClientCall(client) });
      return 0;
    }

    if (command === "start") {
      // Python `offeru start` (lite): workbench + API on one origin, :8766, one-time pair link.
      process.env.OFFERU_RUNTIME_MODE ||= "lite";
      const noBrowser = args.includes("--no-browser");
      const webDir = process.env.OFFERU_WEB_DIR || [resolve(here, "web"), resolve(here, "../../frontend/dist")].find((dir) => existsSync(join(dir, "index.html")));
      if (!webDir) throw new Error("没找到工作台页面（frontend/dist）。先 npm --prefix frontend run build，或设置 OFFERU_WEB_DIR");
      const port = Number(process.env.OFFERU_PORT || 8766);
      const server = startHttpServer(store, port, { webDir });
      const info = (server as unknown as { offeruRuntime?: { mintPairCode?: () => string } }).offeruRuntime;
      const code = info?.mintPairCode?.();
      const url = `http://127.0.0.1:${port}/${code ? `#/pair/${code}` : ""}`;
      process.stdout.write(`OfferU: ${url}\n`);
      if (!noBrowser) openBrowser(url);
      await new Promise<void>((done) => {
        const close = () => server.close(() => done());
        process.on("SIGINT", close);
        process.on("SIGTERM", close);
      });
      return 0;
    }

    if (command === "serve") {
      const server = startHttpServer(store);
      await new Promise<void>((resolve) => {
        const close = () => server.close(() => resolve());
        process.on("SIGINT", close);
        process.on("SIGTERM", close);
      });
      return 0;
    }

    process.stderr.write(HELP);
    return 2;
  } finally {
    if (command !== "mcp" && command !== "serve" && command !== "start") store.close();
  }
}

void main().then((code) => {
  if (code !== 0) process.exitCode = code;
}).catch((cause) => {
  process.stderr.write(`OfferU TS CLI: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exitCode = 1;
});
