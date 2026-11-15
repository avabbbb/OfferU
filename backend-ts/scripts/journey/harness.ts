// Journey runner on the TS backend — port of backend/scripts/journey/run.py.
//
// Every run gets a fresh <out>/<scenario>-<mode>-a<attempt>-<time>/ directory:
// data/ is OFFERU_DATA_DIR (seed data goes there), traces/ is OFFERU_TRACE_DIR.
// Turns go through the real HTTP routes of the companion app
// (POST /api/agent/runtime/runs, .../abort, GET /api/agent/runs/:id/events) via
// app.request, with the fixed simulated-user lines from scenarios.ts. Never
// touches the user's real data directory.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { todayIso, type LlmClient, type PageRenderer } from "@offeru/core";

import { llmFromEnv } from "../../src/llm-env";
import { dbPath } from "../../src/paths";
import { playwrightRenderer } from "../../src/routes/companion/resume";
import { createCompanionApp } from "../../src/server";
import { openStore } from "../../src/store";
import { ScriptedLlm } from "./mock";
import { buildScenario, type Turn } from "./scenarios";
import { seed, type SeedIds } from "./seed";

export type JourneyMode = "mock" | "real";
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const TERMINAL = new Set(["completed", "waiting_user", "partial", "failed", "cancelled"]);

export interface JourneyOptions {
  scenario: string;
  mode: JourneyMode;
  /** Parent directory for run directories; default <os tmp>/offeru-journey. */
  out?: string;
  attempt?: number;
  /** stub = a fake one-page PDF (no Chromium); playwright = real PDFs. Default: stub for mock, playwright for real. */
  renderer?: "stub" | "playwright";
  /** Only create the isolated directory and seed it (manual testing). */
  seedOnly?: boolean;
  log?: (line: string) => void;
}

export interface TranscriptEntry {
  index: number;
  label: string;
  session: string;
  message: string;
  max_steps: number;
  aborted_by_harness: boolean;
  http_status: number;
  run_id: string;
  seconds: number;
  terminal_state: string | null;
  stop_reason: string | null;
  reply: string;
  errors: string[];
  trace: string;
}

export interface JourneyMeta {
  journey_id: string;
  scenario: string;
  attempt: number;
  mode: JourneyMode | "manual";
  backend: "ts";
  model: string;
  renderer: string;
  started_at: string;
  ended_at?: string;
  data_dir: string;
  seed_ids: SeedIds;
  terminal_states?: Array<string | null>;
  mock_problems?: string[];
}

/** A one-page PDF good enough for "the attachment exists on disk" (C8); no Chromium needed. */
export function stubRenderer(): PageRenderer {
  const pdf = new TextEncoder().encode("%PDF-1.4\n% OfferU journey stub (no Chromium)\n%%EOF\n");
  return { pdf: async () => pdf, png: async () => new Uint8Array(), pageCount: async () => 1 };
}

function isolatedRoot(out: string, tag: string): string {
  const root = resolve(out, tag);
  const forbidden = [REPO_ROOT, process.env.OFFERU_DATA_DIR ? resolve(process.env.OFFERU_DATA_DIR) : "", process.env.OFFERU_REAL_DATA_DIR ? resolve(process.env.OFFERU_REAL_DATA_DIR) : ""].filter(Boolean);
  for (const dir of forbidden) {
    const rel = relative(dir, root);
    if (!rel || (!rel.startsWith("..") && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel))) throw new Error(`拒绝：${root} 在仓库或真实数据目录 ${dir} 里`);
  }
  mkdirSync(join(root, "data"), { recursive: true });
  return root;
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

type App = ReturnType<typeof createCompanionApp>["app"];

async function call(app: App, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await app.request(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  try {
    return { status: response.status, body: text ? JSON.parse(text) : {} };
  } catch {
    return { status: response.status, body: { detail: text.slice(0, 2000) } };
  }
}

/** Abort the run after `seconds` (real-mode parity with Python) or after `tools` completed tool calls, whichever first. */
async function watchAbort(app: App, runId: string, turn: Turn, settled: () => boolean): Promise<boolean> {
  const started = Date.now();
  while (!settled()) {
    let due = Boolean(turn.abort_after && Date.now() - started >= turn.abort_after * 1000);
    if (!due && turn.abort_after_tools) {
      const events = await call(app, "GET", `/api/agent/runs/${runId}/events?limit=1000`);
      const done = events.status === 200 ? (events.body.events as any[]).filter((event) => event.type === "tool.completed" || event.type === "tool.failed").length : 0;
      due = done >= turn.abort_after_tools;
    }
    if (due) {
      await call(app, "POST", `/api/agent/runtime/runs/${runId}/abort`);
      return true;
    }
    await sleep(50);
  }
  return false;
}

export async function runTurns(app: App, turns: Turn[], journeyId: string, root: string, mock: ScriptedLlm | null, log: (line: string) => void): Promise<TranscriptEntry[]> {
  const conversations = new Map<string, string>();
  const transcript: TranscriptEntry[] = [];
  for (const [position, turn] of turns.entries()) {
    const index = position + 1;
    const runId = `run_${randomBytes(12).toString("hex")}`;
    mock?.beginTurn(turn);
    const payload = { message: turn.message, conversation_id: conversations.get(turn.session) ?? null, max_steps: turn.max_steps, journey_id: journeyId, run_id: runId };
    const started = performance.now();
    let settled = false;
    const posted = call(app, "POST", "/api/agent/runtime/runs", payload).finally(() => { settled = true; });
    const aborting = turn.abort_after || turn.abort_after_tools ? watchAbort(app, runId, turn, () => settled) : Promise.resolve(false);
    const [response, aborted] = await Promise.all([posted, aborting]);
    const seconds = Math.round((performance.now() - started) / 100) / 10;
    const body = response.body ?? {};
    const run = body.run ?? {};
    const final = run.final_result ?? {};
    if (body.conversation_id) conversations.set(turn.session, body.conversation_id);
    const rid = run.id || runId;
    const entry: TranscriptEntry = {
      index, label: turn.label, session: turn.session, message: turn.message, max_steps: turn.max_steps,
      aborted_by_harness: aborted, http_status: response.status, run_id: rid, seconds,
      terminal_state: final.terminal_state || (response.status >= 400 ? "failed" : run.status ?? null),
      stop_reason: final.stop_reason ?? null,
      reply: body.assistant_message || String(body.detail || ""),
      errors: body.errors || [],
      trace: join(root, "traces", journeyId, `${rid}.json`),
    };
    transcript.push(entry);
    log(`[${index}/${turns.length}] ${turn.label}: ${entry.terminal_state} / ${entry.stop_reason} (${seconds}s)`);
    writeFileSync(join(root, "transcript.json"), JSON.stringify(transcript, null, 1), "utf8");
  }
  return transcript;
}

/** Run one scenario end to end; returns the run directory (grade it with gradeRun). */
export async function runJourney(options: JourneyOptions): Promise<{ root: string; meta: JourneyMeta; transcript: TranscriptEntry[] }> {
  const log = options.log ?? ((line: string) => console.log(line));
  const attempt = options.attempt ?? 1;
  const tag = `${options.scenario}-${options.mode}-a${attempt}-${stamp()}-${randomBytes(2).toString("hex")}`;
  const root = isolatedRoot(options.out ?? join(tmpdir(), "offeru-journey"), tag);
  const saved = { data: process.env.OFFERU_DATA_DIR, db: process.env.OFFERU_DB_PATH, trace: process.env.OFFERU_TRACE_DIR };
  process.env.OFFERU_DATA_DIR = join(root, "data");
  process.env.OFFERU_TRACE_DIR = join(root, "traces");
  delete process.env.OFFERU_DB_PATH;
  const store = openStore(dbPath());
  try {
    if (resolve(dirname(dbPath())) !== resolve(root, "data")) throw new Error("数据目录没有隔离，停止");
    const today = todayIso();
    const ids = await seed(store, today);
    const rendererKind = options.renderer ?? (options.mode === "mock" ? "stub" : "playwright");
    let llm: LlmClient;
    let mock: ScriptedLlm | null = null;
    if (options.mode === "mock") {
      mock = new ScriptedLlm(ids, today);
      llm = mock;
    } else {
      const real = llmFromEnv();
      if (!real && !options.seedOnly) throw new Error("real 模式要设 OFFERU_LLM_BASE_URL / OFFERU_LLM_API_KEY / OFFERU_LLM_MODEL（见 backend-ts/src/llm-env.ts）");
      llm = real as LlmClient;
    }
    const meta: JourneyMeta = {
      journey_id: tag, scenario: options.scenario, attempt, mode: options.seedOnly ? "manual" : options.mode, backend: "ts",
      model: llm ? `${llm.provider || "custom"}/${llm.model || ""}` : "", renderer: rendererKind,
      started_at: new Date().toISOString(), data_dir: join(root, "data"), seed_ids: ids,
    };
    writeFileSync(join(root, "meta.json"), JSON.stringify(meta, null, 1), "utf8");
    if (options.seedOnly) return { root, meta, transcript: [] };

    const offline = (async () => { throw new Error("journey mock 模式不联网"); }) as never;
    const { app } = createCompanionApp(store, {
      llm: () => llm,
      renderer: rendererKind === "stub" ? stubRenderer() : playwrightRenderer(),
      search: () => null,
      ...(options.mode === "mock" ? { fetch: offline } : {}),
      config: null,
      pairingToken: undefined,
    });
    const turns = buildScenario(options.scenario, ids);
    const transcript = await runTurns(app, turns, tag, root, mock, log);
    meta.ended_at = new Date().toISOString();
    meta.terminal_states = transcript.map((entry) => entry.terminal_state);
    if (mock) meta.mock_problems = mock.problems;
    writeFileSync(join(root, "meta.json"), JSON.stringify(meta, null, 1), "utf8");
    const missing = transcript.filter((entry) => !TERMINAL.has(String(entry.terminal_state)) || !existsSync(entry.trace));
    if (missing.length) log(`没有终态或 trace 的回合：${missing.map((entry) => entry.index).join(", ")}`);
    return { root, meta, transcript };
  } finally {
    store.close();
    for (const [key, value] of [["OFFERU_DATA_DIR", saved.data], ["OFFERU_DB_PATH", saved.db], ["OFFERU_TRACE_DIR", saved.trace]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
