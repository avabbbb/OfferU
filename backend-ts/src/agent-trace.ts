import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { redactTraceValue, type AgentTraceData, type TraceSink } from "@offeru/core";

import { dbPath } from "./paths";

/** OFFERU_TRACE_DIR, else <data dir>/traces (Python core/trace.py trace_dir). Read per write. */
export function traceDir(): string {
  const configured = process.env.OFFERU_TRACE_DIR?.trim();
  return configured ? resolve(configured) : join(dirname(dbPath()), "traces");
}

let cachedVersion: string | null = null;

/** git short sha of the checkout this companion runs from, "-dirty" with tracked changes; "" outside git. */
export function codeVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  const cwd = dirname(fileURLToPath(import.meta.url));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    const rev = git("rev-parse", "--short", "HEAD");
    const dirty = git("status", "--porcelain", "--untracked-files=no");
    cachedVersion = rev + (dirty ? "-dirty" : "");
  } catch {
    cachedVersion = "";
  }
  return cachedVersion;
}

/** Write <trace dir>/<journey_id|adhoc>/<run_id>.json plus one line in <trace dir>/index.jsonl. */
export function writeTraceFile(data: AgentTraceData, dir = traceDir()): string {
  const folder = join(dir, data.journey_id || "adhoc");
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `${data.run_id}.json`);
  writeFileSync(path, JSON.stringify(redactTraceValue(data, 20000), null, 1), "utf8");
  const index = Object.fromEntries(["run_id", "journey_id", "started_at", "terminal_state", "stop_reason", "model", "code_version"].map((key) => [key, data[key] ?? null]));
  appendFileSync(join(dir, "index.jsonl"), JSON.stringify(index) + "\n", "utf8");
  return path;
}

export function nodeTraceSink(): TraceSink {
  return { codeVersion: codeVersion(), write: (data) => { writeTraceFile(data); } };
}
