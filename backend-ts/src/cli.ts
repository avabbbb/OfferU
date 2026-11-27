#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { NodeAgentBoard } from "./routes/companion/agent-board";
import { dbPath } from "./paths";
import { startHttpServer } from "./server";
import { AGENT_TOOL_SPECS, ALL_TOOL_SPECS, CAPABILITIES, isCoreError, TOOL_GROUPS, TOOL_INSTRUCTIONS, toolBrief, toolManual } from "@offeru/core";

import { nodeConfigRuntime, nodeToolRuntime } from "./node-runtime";
import { CompanionSync } from "./sync";
import { HANDOFF_HOW, HandoffLlm } from "./handoff";
import { callTool, TOOL_NAMES } from "./tools";
import { openStore } from "./store";
import { APP_VERSION } from "./runtime-identity";

const DEFAULT_WEB_ORIGIN = "https://offeru.avabbbb.com";

const HELP = `OfferU TS CLI

usage:
  offeru-ts tool                         tools, grouped, one line each
  offeru-ts tool --json                  the same list as JSON
  offeru-ts tool <name> [<name>…] --help full description and input schema
  offeru-ts tool <name> [json|@file|-]   run a tool; prints JSON, {"error", "code"} + exit 1 on failure
                                         code: invalid | not_found | conflict | forbidden | unsupported |
                                         not_configured (e.g. no search key) | upstream (search provider failed) | internal
      [--answers @answers.json]          no model configured: model calls come back as {"handoff"} for the calling
                                         Agent to answer; rerun with its answers until the tool finishes
  offeru-ts recipe [<id>]                common flows (which tools, in what order, rules)
  offeru-ts sync [status]                end-to-end encrypted S3 / R2 sync: settings, pending changes, last result
  offeru-ts sync now                     pull + push now (same engine and bucket as the workbench, web version included)
  offeru-ts sync configure [json|@file|-] {endpoint, bucket, region, accessKeyId, secretAccessKey, prefix, pathStyle, passphrase} | {"clear":true}
      [--endpoint <url>] [--bucket <name>] [--region <r>] [--prefix <p>] [--access-key-id <id>] [--path-style|--no-path-style]
                                         flags override the JSON; secrets never go on the command line: put them in the
                                         JSON on stdin (-) or in $OFFERU_SYNC_SECRET_ACCESS_KEY / $OFFERU_SYNC_PASSPHRASE
  offeru-ts sync pair [--web-origin <url>] [--json]
                                         a link that connects the web version (default ${DEFAULT_WEB_ORIGIN}) to this
                                         bucket; it opens only with the sync passphrase and expires in 30 minutes.
                                         --json: {url, expires_at}. Not set up yet: {"error", "code":"not_configured"}
  offeru-ts serve
  offeru-ts doctor
  offeru-ts start [--web] [--no-browser]
      serve the built workbench (frontend/dist) and the API on 127.0.0.1:8766, open #/pair/<code>.
      --web connects the hosted web app (https://offeru.avabbbb.com) directly to this local API.
global: --data-dir <dir> (else $OFFERU_DATA_DIR)
        --actor <name> (else $OFFERU_ACTOR, else "agent"): who the change log and the Agent board credit
        --pretty

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

function takeSwitch(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

const AGENT_TOOLS = new Set(AGENT_TOOL_SPECS.map((spec) => spec.name));

/** The built-in Agent's one-line brief, with its tool_manual pointers turned into the CLI's --help. */
function cliBrief(spec: (typeof ALL_TOOL_SPECS)[number]): string {
  return toolBrief(spec)
    .replace(/tool_manual\(names=\["(\w+)"\]\)/g, "offeru tool $1 --help")
    .replace(/tool_manual/g, `offeru tool ${spec.name} --help`);
}

/** `offeru tool`: what an agent reads first. One line per tool, grouped; full schemas only on --help. */
function toolIndex(): string {
  const byName = new Map(ALL_TOOL_SPECS.map((spec) => [spec.name, spec]));
  const seen = new Set<string>();
  const lines = [TOOL_INSTRUCTIONS, ""];
  const line = (name: string) => {
    const spec = byName.get(name);
    if (!spec || seen.has(name)) return;
    seen.add(name);
    lines.push(`  ${name}: ${cliBrief(spec)}${AGENT_TOOLS.has(name) ? "" : "（只给用户本人用）"}`);
  };
  for (const group of TOOL_GROUPS) {
    lines.push(`${group.title}`);
    group.tools.forEach(line);
  }
  const rest = ALL_TOOL_SPECS.filter((spec) => !seen.has(spec.name));
  if (rest.length) {
    lines.push("其他");
    rest.forEach((spec) => line(spec.name));
  }
  lines.push("", `常用流程（offeru recipe <id>）：${CAPABILITIES.filter((cap) => cap.steps.length).map((cap) => `${cap.id} ${cap.title}`).join("；")}`);
  lines.push("参数和字段：offeru tool <name> --help。调用：offeru tool <name> '<json>'，中文或 PowerShell 用 @args.json。");
  return lines.join("\n") + "\n";
}

/**
 * `sync configure` input: JSON (arg, @file or - for stdin) + flags + secrets from env.
 * Secrets have no flags on purpose: argv shows up in `ps` and shell history.
 */
function syncConfigureInput(args: string[]): Record<string, unknown> {
  const flags: Array<[string, string]> = [
    ["--endpoint", "endpoint"], ["--bucket", "bucket"], ["--region", "region"], ["--prefix", "prefix"], ["--access-key-id", "accessKeyId"],
  ];
  const fromFlags: Record<string, unknown> = {};
  for (const [flag, key] of flags) {
    const value = takeFlag(args, flag);
    if (value !== undefined) fromFlags[key] = value;
  }
  if (takeSwitch(args, "--path-style")) fromFlags.pathStyle = true;
  if (takeSwitch(args, "--no-path-style")) fromFlags.pathStyle = false;
  const input = { ...(args[0] ? payloadOf(args[0]) as Record<string, unknown> : {}), ...fromFlags };
  if (!input.secretAccessKey && process.env.OFFERU_SYNC_SECRET_ACCESS_KEY) input.secretAccessKey = process.env.OFFERU_SYNC_SECRET_ACCESS_KEY;
  if (!input.passphrase && process.env.OFFERU_SYNC_PASSPHRASE) input.passphrase = process.env.OFFERU_SYNC_PASSPHRASE;
  return input;
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
  const actor = takeFlag(args, "--actor") || process.env.OFFERU_ACTOR || "agent";
  const command = args.shift() || "help";
  const pretty = args.includes("--pretty");
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

  const answersArg = takeFlag(args, "--answers");
  const asJson = takeSwitch(args, "--json");
  const wantsHelp = takeSwitch(args, "--help") || takeSwitch(args, "-h");
  const print = (value: unknown) => process.stdout.write(JSON.stringify(value, null, pretty || wantsHelp ? 2 : 0) + "\n");

  if (command === "tool" && !args[0]) {
    if (asJson) {
      print(ALL_TOOL_SPECS.map((spec) => ({ name: spec.name, brief: cliBrief(spec), agent: AGENT_TOOLS.has(spec.name) })));
    } else {
      process.stdout.write(toolIndex());
    }
    return 0;
  }

  if (command === "tool" && wantsHelp) {
    const result = toolManual(ALL_TOOL_SPECS, { names: args });
    print(result);
    return result.ok ? 0 : 1;
  }

  if (command === "recipe") {
    const result = toolManual(ALL_TOOL_SPECS, args[0] ? { capability: args[0] } : {});
    print(result.ok && !args[0] ? result.index?.capabilities : result.ok ? result.capability : result);
    return result.ok ? 0 : 1;
  }

  const store = openStore(dbPath());
  // The model the workbench saved (设置 → 模型), loaded before the first call; OFFERU_LLM_* env is the fallback.
  const config = nodeConfigRuntime();
  await config.get().catch(() => undefined);
  const runtime = nodeToolRuntime(store, config);
  try {
    if (command === "sync") {
      const sub = args.shift() || "status";
      const sync = new CompanionSync(store, dirname(dbPath()));
      try {
        if (sub === "pair") {
          const origin = takeFlag(args, "--web-origin") || process.env.OFFERU_WEB_ORIGIN || DEFAULT_WEB_ORIGIN;
          if (!/^https?:\/\/[^/\s]+\/?$/.test(origin)) {
            print({ error: `--web-origin 要是网页版的地址（例如 ${DEFAULT_WEB_ORIGIN}），不带路径`, code: "invalid" });
            return 1;
          }
          const link = await sync.pairing(origin);
          if (!link) {
            print({
              error: "还没有设置同步，生成不了配对链接",
              code: "not_configured",
              hint: "先运行 offeru sync configure（--endpoint/--bucket/--region/--access-key-id，Secret 和口令放 $OFFERU_SYNC_SECRET_ACCESS_KEY / $OFFERU_SYNC_PASSPHRASE 或标准输入的 JSON）",
            });
            return 1;
          }
          if (asJson) print(link);
          else {
            process.stdout.write(link.url + "\n");
            process.stderr.write(`把这条链接发给用户：打开后输入同步口令即可连上，${new Date(link.expires_at).toLocaleString("zh-CN", { hour12: false })} 前有效。\n`);
          }
          return 0;
        }
        const result = sub === "status"
          ? await sync.status()
          : sub === "now"
            ? await sync.syncNow()
            : sub === "configure"
              ? await sync.configure(syncConfigureInput(args))
              : null;
        if (result === null) {
          process.stderr.write(HELP);
          return 2;
        }
        print(result);
        return 0;
      } catch (cause) {
        const code = (cause as { code?: unknown })?.code;
        process.stdout.write(JSON.stringify({ error: cause instanceof Error ? cause.message : String(cause), ...(typeof code === "string" ? { code: `sync_${code}` } : {}) }) + "\n");
        return 1;
      }
    }

    if (command === "tool") {
      const name = args.shift()!;
      try {
        // Agent board bookkeeping: --actor is the calling Agent; never fails the call.
        await new NodeAgentBoard({ dataDir: dirname(dbPath()) }).recordClientCall(actor).catch(() => "");
        // No model configured: the calling Agent is the model (see handoff.ts).
        const handoff = runtime.llm() ? null : new HandoffLlm(answersArg ? payloadOf(answersArg) as Record<string, string> : {});
        if (handoff) runtime.llm = () => handoff;
        let result: unknown;
        try {
          result = await callTool(name, payloadOf(args[0]), runtime, actor);
        } catch (cause) {
          if (!handoff?.pending.length) throw cause;
        }
        // A tool may catch a model failure and go on (evaluate marks the job failed); pending prompts still win.
        if (handoff?.pending.length) result = { handoff: { how: HANDOFF_HOW, pending: handoff.pending } };
        process.stdout.write(JSON.stringify(result, null, pretty ? 2 : 0) + "\n");
        return 0;
      } catch (cause) {
        // {"error", "code"} on stdout, exit 1. code is CoreError.code (invalid / not_found / conflict / forbidden /
        // unsupported / not_configured / upstream); bad JSON args are invalid; anything else is internal.
        const code = isCoreError(cause) ? cause.code : cause instanceof SyntaxError ? "invalid" : "internal";
        const message = cause instanceof SyntaxError ? `参数不是合法 JSON：${cause.message}` : cause instanceof Error ? cause.message : String(cause);
        process.stdout.write(JSON.stringify({ error: message, code }) + "\n");
        return 1;
      }
    }

    if (command === "start") {
      // Python `offeru start` (lite): workbench + API on one origin, :8766, one-time pair link.
      // With --web: expose the local API on :8766 and open https://offeru.avabbbb.com/#/pair/<code>
      // so the hosted web app talks straight to this companion without needing frontend/dist or S3/R2.
      process.env.OFFERU_RUNTIME_MODE ||= "lite";
      const webMode = args.includes("--web");
      const noBrowser = args.includes("--no-browser");
      const webDir = process.env.OFFERU_WEB_DIR || [resolve(here, "web"), resolve(here, "../../frontend/dist")].find((dir) => existsSync(join(dir, "index.html")));
      if (!webDir && !webMode) throw new Error("没找到工作台页面（frontend/dist）。先 npm --prefix frontend run build，加 --web 直连网页版，或设置 OFFERU_WEB_DIR");
      const port = Number(process.env.OFFERU_PORT || 8766);
      const server = startHttpServer(store, port, { webDir: webDir ?? null });
      const info = (server as unknown as { offeruRuntime?: { mintPairCode?: () => string } }).offeruRuntime;
      const localCode = webDir ? info?.mintPairCode?.() : undefined;
      const webCode = info?.mintPairCode?.();
      const localUrl = `http://127.0.0.1:${port}/${localCode ? `#/pair/${localCode}` : ""}`;
      const webOrigin = (process.env.OFFERU_WEB_URL || "https://offeru.avabbbb.com").replace(/\/+$/, "");
      const webUrl = `${webOrigin}/${webCode ? `#/pair/${webCode}` : ""}`;
      if (webDir) process.stdout.write(`OfferU: ${localUrl}\n`);
      process.stdout.write(`Web: ${webUrl}\n`);
      if (!noBrowser) openBrowser(webMode ? webUrl : localUrl);
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
    if (command !== "serve" && command !== "start") store.close();
  }
}

void main().then((code) => {
  if (code !== 0) process.exitCode = code;
}).catch((cause) => {
  process.stderr.write(`OfferU TS CLI: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exitCode = 1;
});
