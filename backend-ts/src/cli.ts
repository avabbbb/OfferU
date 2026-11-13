#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { runMcpServer } from "./mcp";
import { dbPath } from "./paths";
import { startHttpServer } from "./server";
import { callTool, SUPPORTED_TOOLS } from "./tools";
import { openStore } from "./store";

const HELP = `OfferU TS CLI

usage:
  offeru-ts tool <name> [json|@file|-] [--actor name] [--pretty]
  offeru-ts mcp
  offeru-ts serve
  offeru-ts doctor

tools: ${SUPPORTED_TOOLS.join(", ")}
`;

function takeFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  args.splice(index, value ? 2 : 1);
  return value;
}

function payloadOf(raw: string | undefined): unknown {
  const text = raw === "-"
    ? readFileSync(0, "utf8")
    : raw?.startsWith("@")
      ? readFileSync(raw.slice(1), "utf8")
      : raw || "{}";
  return JSON.parse(text);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const command = args.shift() || "help";
  const pretty = args.includes("--pretty");
  const actor = takeFlag(args, "--actor") || "你";
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
      version: "0.1.0",
      runtime: "node",
      database: dbPath(),
      tools: SUPPORTED_TOOLS,
    }, null, pretty ? 2 : 0) + "\n");
    return 0;
  }

  const store = openStore(dbPath());
  try {
    if (command === "tool") {
      const name = args.shift();
      if (!name) {
        process.stderr.write("缺少工具名。\n" + HELP);
        return 2;
      }
      try {
        const result = await callTool(name, payloadOf(args[0]), store, actor);
        process.stdout.write(JSON.stringify(result, null, pretty ? 2 : 0) + "\n");
        return 0;
      } catch (cause) {
        process.stdout.write(JSON.stringify({
          ok: false,
          error: cause instanceof Error ? cause.message : "工具调用失败",
        }, null, pretty ? 2 : 0) + "\n");
        return 1;
      }
    }

    if (command === "mcp") {
      await runMcpServer(store);
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
    if (command !== "mcp" && command !== "serve") store.close();
  }
}

void main().then((code) => {
  if (code !== 0) process.exitCode = code;
}).catch((cause) => {
  process.stderr.write(`OfferU TS CLI: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exitCode = 1;
});
