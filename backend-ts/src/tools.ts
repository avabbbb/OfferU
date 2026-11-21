import {
  AGENT_ACTOR,
  AGENT_RECORD_TOOLS,
  bindAgentTools,
  callCoreTool,
  CORE_HANDLERS,
  type AgentTool,
  nowIso,
  todayIso,
  TOOL_NAMES,
  TOOL_SPECS,
  type CoreStore,
  type HttpFetch,
  type LlmClient,
  type SearchClient,
  type ToolDeps,
  type ToolHandler,
} from "@offeru/core";

/**
 * What a runtime gives the shared tools. HTTP (/api/tools), MCP and the CLI all
 * build one and dispatch through @offeru/core callCoreTool, so the three surfaces
 * list and run exactly the same 21 tools as Python app/core/tools.py.
 *
 * - llm / search are read per call (the user may change their key at any time).
 * - companion: Node-only handlers (read_file, find_files); absent on the Worker,
 *   where those tools answer CoreError("unsupported").
 */
export type ToolRuntime = {
  store: CoreStore;
  llm?: () => LlmClient | null;
  search?: () => SearchClient | null;
  fetch?: HttpFetch;
  /** Runtime-agnostic handlers other domains register (tailor_resume, export_resume_pdf, email_sync...). */
  toolHandlers?: Record<string, ToolHandler>;
  companion?: {
    handlers: Record<string, ToolHandler>;
    readFile?: ToolDeps["readFile"];
  };
};

/** GET /api/tools — same shape as Python: {name, description, input: JSON schema}. */
export const TOOL_LIST = TOOL_SPECS.map((spec) => ({ name: spec.name, description: spec.description, input: spec.inputSchema }));
export { TOOL_NAMES };

const isStore = (value: ToolRuntime | CoreStore): value is CoreStore => typeof (value as CoreStore).transaction === "function";

export function toolDeps(runtime: ToolRuntime, actor: string, signal?: AbortSignal): ToolDeps {
  return {
    store: runtime.store,
    ctx: { actor, now: nowIso(), today: todayIso() },
    llm: runtime.llm?.() ?? null,
    search: runtime.search?.() ?? null,
    fetch: runtime.fetch,
    readFile: runtime.companion?.readFile,
    signal,
  };
}

/**
 * Run one tool. `actor` is who is calling: "你" (the user, workbench default),
 * an agent's name, or "agent". Only "你" may confirm memories or move a job backwards.
 */
export async function callTool(name: string, rawArgs: unknown, runtime: ToolRuntime | CoreStore, actor = "你", signal?: AbortSignal): Promise<unknown> {
  const rt = isStore(runtime) ? { store: runtime } : runtime;
  return callCoreTool(name, rawArgs ?? {}, toolDeps(rt, actor, signal), handlersOf(rt));
}

function handlersOf(runtime: ToolRuntime): Record<string, ToolHandler> {
  return { ...runtime.toolHandlers, ...runtime.companion?.handlers };
}

/** Tool names this runtime can actually run (core + other domains + companion). */
export function runnableTools(runtime: ToolRuntime): string[] {
  const handlers = { ...CORE_HANDLERS, ...handlersOf(runtime) };
  return TOOL_NAMES.filter((name) => Boolean(handlers[name]));
}

/**
 * The built-in Agent's tools beyond the record tools it already has
 * (Python agent.loop_tools offers every TOOLS entry). Only tools this runtime
 * can run are offered, so the browser / Worker agent never sees read_file /
 * find_files, and tailor_resume / export_resume_pdf / email_sync appear once
 * their domains register handlers. Runs as the Agent actor ("助手"): its
 * memories stay unconfirmed, job status only moves forward. Errors go back to
 * the model as "ERROR: …" (bindAgentTools); the run's abort signal reaches
 * long tools (evaluate_jobs).
 */
export function agentExtraTools(runtime: ToolRuntime): AgentTool[] {
  const skip = new Set<string>(AGENT_RECORD_TOOLS);
  const runnable = new Set(runnableTools(runtime));
  return TOOL_SPECS.filter((spec) => runnable.has(spec.name) && !skip.has(spec.name)).map((spec) => {
    const toolSpec = { name: spec.name, description: spec.description, parameters: spec.inputSchema as Record<string, unknown> };
    return {
      ...toolSpec,
      execute: (args, context) => bindAgentTools([toolSpec], (name, input) => callTool(name, input, runtime, AGENT_ACTOR, context.signal))[0].execute(args, context),
    } satisfies AgentTool;
  });
}
