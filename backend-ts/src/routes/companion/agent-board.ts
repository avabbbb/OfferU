// Node companion side of the Agent board (Python services/agent_board.py +
// agent_integration.py): board JSON in the data dir, PATH lookup, process
// list, OfferU Skill install into each Agent's skill folder, and opening the
// Agent's CLI in a new terminal. Rules and row shape live in @offeru/core.

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONNECT_ACTIONS,
  CoreError,
  HOST_COMMANDS,
  PLAIN_CALL_THROTTLE_SECONDS,
  boardIds,
  boardRow,
  customAgent,
  hostSpec,
  matchClient,
  normalizeBoard,
  requireBoardAgent,
  validateCustomAgent,
  type BoardData,
  type SkillInspection,
} from "@offeru/core";

import type { AgentBoardService } from "../agent-board";

const here = dirname(fileURLToPath(import.meta.url));
/**
 * Canonical Skill text: backend-ts/skill/SKILL.md in the repo; the desktop package ships it
 * next to the bundled server (OFFERU_SKILL_PATH, or skill/SKILL.md beside the bundle).
 */
export const SOURCE_SKILL = [process.env.OFFERU_SKILL_PATH, resolve(here, "../../../skill/SKILL.md"), resolve(here, "skill/SKILL.md")]
  .filter((p): p is string => Boolean(p))
  .find((p) => existsSync(p)) ?? resolve(here, "../../../skill/SKILL.md");
const BACKEND_TS = resolve(here, "../../..");
const VERSION = /^version:\s*(\S+)/m;
const PROCESS_CACHE_MS = 5000;
const TERMINALS: Array<[string, string]> = [["x-terminal-emulator", "-e"], ["gnome-terminal", "--"], ["konsole", "-e"], ["xterm", "-e"]];

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");

/** shutil.which. */
export function which(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!command) return null;
  const exts = process.platform === "win32" ? (env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      try {
        if (lstatSync(candidate).isFile() || existsSync(candidate)) return candidate;
      } catch { /* not here */ }
    }
  }
  return null;
}

/** agent_integration.AgentIntegrationAdapter.skill_root for built-in providers. */
export function builtinSkillRoot(id: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (id === "external") return join(home, ".agents", "skills");
  if (id === "omp" || id === "pi") return join(env.PI_CODING_AGENT_DIR || join(home, `.${id}`, "agent"), "skills");
  if (id === "gemini" || id === "codebuddy") return join(home, `.${id}`, "skills");
  if (id === "codex") return join(env.CODEX_HOME || join(home, ".codex"), "skills");
  if (id === "dsh") return join(env.DSH_HOME || join(home, ".dsh"), "skills");
  if (id === "claude") return join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "skills");
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode", "skills");
}

export interface NodeBoardOptions {
  /** <data>/agent_board.json lives here. */
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** What fills the Skill's <offeru> placeholder: the command that runs `offeru tool ...` for this install. */
  toolCommand?: string;
  /** Override the process listing (tests). */
  processListing?: () => Promise<string>;
  /** Override opening a terminal (tests). */
  openTerminal?: (executable: string) => Promise<void>;
}

export class NodeAgentBoard implements AgentBoardService {
  private processCache: { at: number; tokens: Set<string> } | null = null;
  private lastPlainCall = new Map<string, number>();
  private readonly env: NodeJS.ProcessEnv;
  private readonly home: string;

  constructor(private readonly options: NodeBoardOptions) {
    this.env = options.env ?? process.env;
    this.home = options.home ?? homedir();
  }

  private get path() { return join(this.options.dataDir, "agent_board.json"); }

  private load(): BoardData {
    try {
      return normalizeBoard(JSON.parse(readFileSync(this.path, "utf8")));
    } catch {
      return normalizeBoard({});
    }
  }

  private save(data: BoardData): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    renameSync(tmp, this.path);
  }

  /**
   * Python agent_integration.tool_command: the command of this installation plus --data-dir, so an
   * external Agent reads the same database. Packaged builds run the bundled cli.mjs with the bundled
   * Node (OFFERU_CLI_PATH from the desktop shell); a source checkout goes through npm.
   */
  private toolCommand(): string {
    if (this.options.toolCommand ?? this.env.OFFERU_TOOL_COMMAND) return (this.options.toolCommand ?? this.env.OFFERU_TOOL_COMMAND)!;
    const quote = (value: string) => (process.platform === "win32" ? `'${value.replaceAll("'", "''")}'` : JSON.stringify(value));
    const dataDir = `--data-dir ${quote(this.options.dataDir)}`;
    if (this.env.OFFERU_CLI_PATH) {
      return `${process.platform === "win32" ? "& " : ""}${quote(process.execPath)} ${quote(this.env.OFFERU_CLI_PATH)} ${dataDir}`;
    }
    return `npm --prefix ${JSON.stringify(BACKEND_TS)} run -s cli -- ${dataDir}`;
  }

  /** _installed_content: the Skill with <offeru> filled for this install. */
  skillContent(): string {
    const source = readFileSync(SOURCE_SKILL, "utf8");
    if (!source.includes("<offeru>")) throw new CoreError("OfferU Skill is missing its command placeholder; reinstall OfferU.");
    return source.split("<offeru>").join(this.toolCommand());
  }

  private skillRoot(data: BoardData, id: string): string {
    return customAgent(data, id)?.skill_root ?? builtinSkillRoot(id, this.env, this.home);
  }

  private skillPath(data: BoardData, id: string): string {
    return join(this.skillRoot(data, id), "offeru", "SKILL.md");
  }

  /** AgentIntegrationAdapter.inspect. */
  private inspect(data: BoardData, id: string): SkillInspection {
    const expected = this.skillContent();
    const path = this.skillPath(data, id);
    const result: SkillInspection = {
      skill_status: "NOT_INSTALLED", skill_version: "", skill_hash: "",
      expected_skill_version: VERSION.exec(expected)?.[1] ?? "", expected_skill_hash: sha256(expected),
      can_install: true, can_live_verify: id === "codex", error: "",
    };
    let stat;
    try { stat = lstatSync(path); } catch { return result; }
    if (stat.isSymbolicLink()) return { ...result, skill_status: "ERROR", error: "OfferU Skill 不能使用符号链接，请执行修复。" };
    let installed: string;
    try { installed = readFileSync(path, "utf8"); } catch (error) { return { ...result, skill_status: "ERROR", error: String(error).slice(0, 300) }; }
    const state = !installed.includes("name: offeru") ? "ERROR" : installed === expected ? "INSTALLED" : "OUTDATED";
    return {
      ...result,
      skill_status: state,
      skill_version: VERSION.exec(installed)?.[1] ?? "",
      skill_hash: sha256(installed),
      error: state === "ERROR" ? "目标目录存在非 OfferU Skill；只有明确修复后才会覆盖。" : "",
    };
  }

  /** AgentIntegrationAdapter.install (+ _remove_old_methods). */
  private install(data: BoardData, id: string, action: string): SkillInspection {
    const current = this.inspect(data, id);
    if (current.skill_status === "ERROR" && action !== "repair") throw new CoreError(String(current.error));
    const root = this.skillRoot(data, id);
    const path = this.skillPath(data, id);
    for (const candidate of [path, dirname(path), root]) {
      try { if (lstatSync(candidate).isSymbolicLink()) throw new CoreError("OfferU Skill 目标目录不能使用符号链接"); } catch (error) { if (error instanceof CoreError) throw error; }
    }
    const rel = relative(resolve(root), resolve(path));
    if (rel.startsWith("..") || isAbsolute(rel)) throw new CoreError("OfferU Skill 目标路径越过允许目录");
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, this.skillContent(), "utf8");
    renameSync(tmp, path);
    const base = dirname(path);
    for (const old of ["skills/profile_onboarding/SKILL.md", "skills/research/SKILL.md", "skills/tailor_resume/SKILL.md"]) {
      const target = join(base, old);
      try {
        if (lstatSync(target).isSymbolicLink() || !lstatSync(target).isFile()) continue;
      } catch { continue; }
      unlinkSync(target);
      for (let parent = dirname(target); parent !== base && parent.startsWith(base); parent = dirname(parent)) {
        try { rmdirSync(parent); } catch { break; }
      }
    }
    return this.inspect(data, id);
  }

  private executableFound(data: BoardData, id: string): boolean {
    const custom = customAgent(data, id);
    if (custom) return Boolean(custom.executable && which(custom.executable, this.env));
    if (id === "external") return false;
    return Boolean(which(id, this.env));
  }

  private async processTokens(): Promise<Set<string>> {
    if (this.processCache && Date.now() - this.processCache.at < PROCESS_CACHE_MS) return this.processCache.tokens;
    const listing = await (this.options.processListing ?? defaultProcessListing)();
    const tokens = new Set(listing.toLowerCase().split(/[\s/\\"']+/).filter(Boolean).map((t) => t.replace(/\.(?:exe|cmd|bat|ps1|js|mjs|cjs)$/, "")));
    this.processCache = { at: Date.now(), tokens };
    return tokens;
  }

  private async row(data: BoardData, id: string, tokens?: Set<string>): Promise<Record<string, unknown>> {
    requireBoardAgent(data, id);
    let skill: SkillInspection;
    try { skill = this.inspect(data, id); } catch (error) { skill = { skill_status: "ERROR", error: String((error as Error).message).slice(0, 300) }; }
    return boardRow(data, id, {
      skill, executableFound: this.executableFound(data, id), skillPath: this.skillPath(data, id),
      processTokens: tokens ?? await this.processTokens(), now: new Date(),
    });
  }

  private resolveRoot = (text: string): string | null => {
    const expanded = text === "~" ? this.home : text.startsWith("~/") || text.startsWith("~\\") ? join(this.home, text.slice(2)) : text;
    if (!isAbsolute(expanded)) return null;
    const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
    const rel = relative(real(this.home), real(expanded));
    return rel.startsWith("..") || isAbsolute(rel) ? null : resolve(expanded);
  };

  async list() {
    const data = this.load();
    const tokens = await this.processTokens();
    const agents = [];
    for (const id of boardIds(data)) agents.push(await this.row(data, id, tokens));
    return { agents, live_window_seconds: 600 };
  }

  async add(raw: Record<string, unknown>) {
    const data = this.load();
    const entry = validateCustomAgent(raw, true, this.resolveRoot);
    if (customAgent(data, entry.id)) throw new CoreError(`已经有一个叫 ${entry.id} 的 Agent，可以用编辑修改它`);
    data.custom.push(entry);
    this.save(data);
    return this.row(data, entry.id);
  }

  async update(id: string, raw: Record<string, unknown>) {
    const data = this.load();
    const current = customAgent(data, id);
    if (!current) throw new CoreError("只有你自己添加的 Agent 可以编辑；内置 Agent 只能隐藏");
    const entry = validateCustomAgent({ ...current, ...raw, id }, false, this.resolveRoot);
    data.custom = data.custom.map((item) => (item.id === id ? entry : item));
    this.save(data);
    return this.row(data, id);
  }

  async remove(id: string) {
    const data = this.load();
    if (!customAgent(data, id)) throw new CoreError("只有你自己添加的 Agent 可以删除；内置 Agent 只能隐藏");
    data.custom = data.custom.filter((item) => item.id !== id);
    data.hidden = data.hidden.filter((item) => item !== id);
    delete data.checks[id];
    delete data.calls[id];
    this.save(data);
    return { removed: id };
  }

  async setHidden(id: string, hidden: boolean) {
    const data = this.load();
    requireBoardAgent(data, id);
    data.hidden = [...data.hidden.filter((item) => item !== id), ...(hidden ? [id] : [])];
    this.save(data);
    return this.row(data, id);
  }

  async connect(id: string, action: string) {
    if (!(CONNECT_ACTIONS as readonly string[]).includes(action)) throw new CoreError("连接动作只支持 install、update 或 repair");
    const data = this.load();
    requireBoardAgent(data, id);
    const result = this.install(data, id, action);
    data.checks[id] = { at: nowIso(), action, skill_status: result.skill_status ?? "" };
    this.save(data);
    return this.row(data, id);
  }

  async check(id: string) {
    const data = this.load();
    const row = await this.row(data, id);
    data.checks[id] = { at: nowIso(), action: "check", skill_status: row.skill_status, executable_found: row.executable_found };
    this.save(data);
    return { ...row, last_check: data.checks[id] };
  }

  async recordClientCall(client: string): Promise<string> {
    const text = String(client || "").trim().toLowerCase();
    if (!text) return "";
    const data = this.load();
    const id = matchClient(data, text);
    if (!id) return "";
    const last = this.lastPlainCall.get(id);
    if (last !== undefined && Date.now() - last < PLAIN_CALL_THROTTLE_SECONDS * 1000) return id;
    this.lastPlainCall.set(id, Date.now());
    try {
      data.calls[id] = { at: nowIso(), client: text.slice(0, 120), session_hint: "", thread_id: "" };
      this.save(data);
    } catch { /* bookkeeping must never fail the tool call it rides on */ }
    return id;
  }

  async launch(id: string) {
    const data = this.load();
    requireBoardAgent(data, id);
    const custom = customAgent(data, id);
    let executable: string | null;
    if (custom) {
      executable = custom.executable ? which(custom.executable, this.env) : null;
      if (!executable) throw new CoreError(`本机没找到 ${custom.display_name} 的启动命令。先安装它，或在「编辑」里填好「启动命令名」`);
    } else {
      const command = (HOST_COMMANDS[id] ?? [id])[0];
      executable = which(command, this.env);
      if (!executable) throw new CoreError(`本机没找到 ${command} 命令。先安装这个 Agent，再点「打开对话」`);
    }
    await (this.options.openTerminal ?? ((exe) => openTerminal(exe, this.home)))(executable);
    return { launched: true, executable };
  }
}

function defaultProcessListing(): Promise<string> {
  return new Promise((done) => {
    const [cmd, args] = process.platform === "win32"
      ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Format-List Name,CommandLine | Out-String -Width 8192"]]
      : ["ps", ["-A", "-o", "args="]];
    execFile(cmd, args as string[], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout) => done(error ? "" : String(stdout)));
  });
}

async function openTerminal(executable: string, cwd: string): Promise<void> {
  try {
    if (process.platform === "win32") {
      spawn("cmd.exe", ["/c", "start", "", executable], { cwd, detached: true, stdio: "ignore", windowsHide: false }).unref();
    } else if (process.platform === "darwin") {
      const quoted = `'${executable.replace(/'/g, "'\\''")}'`;
      spawn("osascript", ["-e", `tell application "Terminal" to do script ${JSON.stringify(quoted)}`, "-e", 'tell application "Terminal" to activate'], { cwd, detached: true, stdio: "ignore" }).unref();
    } else {
      const terminal = TERMINALS.map(([name, flag]) => [which(name), flag] as const).find(([path]) => path);
      if (!terminal) throw new CoreError("没找到可用的终端程序（x-terminal-emulator、gnome-terminal、konsole 或 xterm）");
      spawn(terminal[0]!, [terminal[1], executable], { cwd, detached: true, stdio: "ignore" }).unref();
    }
  } catch (error) {
    if (error instanceof CoreError) throw error;
    throw new CoreError(`打不开新的终端窗口：${(error as Error).message}`);
  }
}

export { hostSpec };
