import {
  callCoreTool,
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
  return callCoreTool(name, rawArgs ?? {}, toolDeps(rt, actor, signal), rt.companion?.handlers ?? {});
}
