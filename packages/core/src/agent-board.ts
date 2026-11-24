// Agent board rules (Python services/agent_board.py + agent_host_registry.py):
// the built-in Skill hosts, custom-Agent validation, client (CLI --actor) → Agent matching,
// the "connected" rule and the row shape the workbench renders. Everything that
// touches the machine (board JSON file, PATH lookup, process list, Skill files,
// opening a terminal) is the companion's BoardHost; the board only exists there,
// so the routes answer 501 on the web / Worker.

import { CoreError } from "./types";

export interface BoardHostSpec { id: string; display_name: string; docs_url: string }

/** agent_host_registry._HOSTS, skill hosts in order. */
export const BOARD_HOSTS: BoardHostSpec[] = [
  { id: "codex", display_name: "Codex", docs_url: "https://developers.openai.com/codex/quickstart/" },
  { id: "claude", display_name: "Claude Code", docs_url: "https://code.claude.com/docs/en/setup" },
  { id: "opencode", display_name: "OpenCode", docs_url: "https://opencode.ai/docs/" },
  { id: "pi", display_name: "Pi Coding Agent", docs_url: "https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent" },
  { id: "omp", display_name: "Oh My Pi", docs_url: "https://github.com/can1357/oh-my-pi" },
  { id: "gemini", display_name: "Gemini CLI", docs_url: "https://github.com/google-gemini/gemini-cli" },
  { id: "codebuddy", display_name: "CodeBuddy CLI", docs_url: "https://www.workbuddy.cn/docs/workbuddy/Overview" },
  { id: "dsh", display_name: "DeepSeek Harness", docs_url: "https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/skills" },
];
/** agent_integration._PROVIDER_IDS: adapters that exist even when not on the board. */
export const INTEGRATION_IDS = ["external", "codex", "opencode", "claude", "omp", "pi", "gemini", "codebuddy", "dsh"];

/** Built-in Agent id → (interactive CLI command, names that identify its running process). */
export const HOST_COMMANDS: Record<string, [string, string[]]> = {
  codex: ["codex", ["codex"]],
  claude: ["claude", ["claude", "claude-code"]],
  opencode: ["opencode", ["opencode"]],
  pi: ["pi", ["pi", "pi-coding-agent"]],
  omp: ["omp", ["omp", "oh-my-pi"]],
  gemini: ["gemini", ["gemini", "gemini-cli"]],
  codebuddy: ["codebuddy", ["codebuddy", "codebuddy-code", "workbuddy"]],
  dsh: ["dsh", ["dsh", "deepseek-harness"]],
};

export const CONNECT_ACTIONS = ["install", "update", "repair"] as const;
export type ConnectAction = (typeof CONNECT_ACTIONS)[number];
export const LIVE_WINDOW_SECONDS = 600;
export const PLAIN_CALL_THROTTLE_SECONDS = 30;

const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const EXECUTABLE = /^[A-Za-z0-9_.-]{1,80}$/;
const CLIENT_SPLIT = /[^a-z0-9]+/;

export interface CustomAgent { id: string; display_name: string; executable: string; skill_root: string }
export interface BoardCall { at?: string; client?: string; session_hint?: string; thread_id?: string }
export interface BoardData {
  custom: CustomAgent[];
  hidden: string[];
  checks: Record<string, Record<string, unknown>>;
  calls: Record<string, BoardCall>;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** agent_board._load: tolerate a missing / damaged file. */
export function normalizeBoard(raw: unknown): BoardData {
  const data = isObject(raw) ? raw : {};
  const pick = (value: unknown) => (isObject(value) ? Object.fromEntries(Object.entries(value).filter(([, v]) => isObject(v))) : {});
  return {
    custom: (Array.isArray(data.custom) ? data.custom : []).filter((item): item is CustomAgent => isObject(item) && Boolean(item.id)),
    hidden: (Array.isArray(data.hidden) ? data.hidden : []).map(String),
    checks: pick(data.checks) as BoardData["checks"],
    calls: pick(data.calls) as BoardData["calls"],
  };
}

export const hostSpec = (id: string): BoardHostSpec | undefined => BOARD_HOSTS.find((host) => host.id === id);
export const customAgent = (data: BoardData, id: string): CustomAgent | undefined => data.custom.find((item) => item.id === id);
export const boardIds = (data: BoardData): string[] => [...BOARD_HOSTS.map((host) => host.id), ...data.custom.map((item) => item.id)];

/** The board must know this Agent (custom or a built-in skill host). */
export function requireBoardAgent(data: BoardData, id: string): void {
  if (customAgent(data, id)) return;
  if (hostSpec(id) && INTEGRATION_IDS.includes(id)) return;
  throw new CoreError(`看板里没有这个 Agent：${id}。先在工作台「设置 → 我的 Agent」里查看`);
}

/**
 * _validate_custom. `resolveRoot` expands ~ and resolves the folder; it returns
 * null when the path is not absolute or not inside the user's home.
 */
export function validateCustomAgent(raw: Record<string, unknown>, creating: boolean, resolveRoot: (text: string) => string | null): CustomAgent {
  const id = String(raw.id ?? "").trim().toLowerCase();
  if (!ID.test(id)) throw new CoreError("Agent id 只能用小写字母、数字、- 和 _，最长 40 个字符");
  if (creating && (hostSpec(id) || INTEGRATION_IDS.includes(id))) throw new CoreError(`${id} 是内置 Agent，已经在看板里，不需要添加`);
  const name = String(raw.display_name ?? "").trim();
  if (name.length < 1 || name.length > 60) throw new CoreError("请填写 Agent 名称（60 字以内）");
  const executable = String(raw.executable ?? "").trim();
  if (executable && !EXECUTABLE.test(executable)) throw new CoreError("启动命令只填命令名（例如 workbuddy），不要带路径或参数");
  const rootText = String(raw.skill_root ?? "").trim();
  const root = rootText ? resolveRoot(rootText) : null;
  if (!root) throw new CoreError("Skill 目录要填你用户目录下的绝对路径，例如 ~/.workbuddy/skills");
  return { id, display_name: name, executable, skill_root: root };
}

const stem = (command: string): string => {
  const base = command.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return (dot > 0 ? base.slice(0, dot) : base).toLowerCase();
};

/** Names that identify this Agent in the process list and in a client / --actor name. */
export function matchNames(data: BoardData, id: string): string[] {
  const custom = customAgent(data, id);
  if (custom) return [...new Set([id, stem(custom.executable ?? "")].filter(Boolean))];
  return (HOST_COMMANDS[id] ?? [id, [id]])[1];
}

/** _match_client: exact id / process name first, else the longest name found in the client string. */
export function matchClient(data: BoardData, client: string): string {
  const ids = [...new Set([...Object.keys(HOST_COMMANDS), ...boardIds(data)])];
  const names = Object.fromEntries(ids.map((id) => [id, matchNames(data, id)]));
  const exact = ids.find((id) => client === id || names[id].includes(client));
  if (exact) return exact;
  const parts = new Set(client.split(CLIENT_SPLIT));
  let best = "";
  let bestLength = 0;
  for (const id of ids) {
    for (const name of names[id]) {
      if ((parts.has(name) || (name.includes("-") && client.includes(name))) && name.length > bestLength) {
        best = id;
        bestLength = name.length;
      }
    }
  }
  return best;
}

export function isLive(at: unknown, now: Date): boolean {
  const when = new Date(String(at ?? ""));
  if (Number.isNaN(when.getTime())) return false;
  return (now.getTime() - when.getTime()) / 1000 <= LIVE_WINDOW_SECONDS;
}

export interface SkillInspection { skill_status: string; error?: string; [key: string]: unknown }

/** One board row (Python _row), from what the companion probed. */
export function boardRow(data: BoardData, id: string, probe: {
  skill: SkillInspection; executableFound: boolean; skillPath: string; processTokens: Set<string>; now: Date;
}): Record<string, unknown> {
  const custom = customAgent(data, id);
  const host = hostSpec(id);
  const running = matchNames(data, id).some((name) => probe.processTokens.has(name));
  const lastCall = data.calls[id] ?? {};
  return {
    id,
    display_name: custom ? custom.display_name : host ? host.display_name : id,
    custom: Boolean(custom),
    hidden: data.hidden.includes(id),
    executable_found: probe.executableFound,
    skill_status: probe.skill.skill_status ?? "ERROR",
    running,
    last_call: lastCall,
    connected: running && isLive(lastCall.at, probe.now),
    skill_path: probe.skillPath,
    error: probe.skill.error ?? "",
    last_check: data.checks[id] ?? {},
    executable: custom ? custom.executable ?? "" : "",
    docs_url: host ? host.docs_url : "",
  };
}
