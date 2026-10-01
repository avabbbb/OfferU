// Migrated from luyishui/OfferU @ 3a446ff, MIT. Tool reducer cases and view
// remain upstream source; the event adapter binds the existing Career Runtime.
export type ToolExecutionStatus = "running" | "done" | "error";

export interface ToolExecutionState {
  id: string;
  toolName: string;
  args?: unknown;
  status: ToolExecutionStatus;
  summary?: string;
  result?: unknown;
  isError?: boolean;
}


export interface AgentStreamState { toolExecutions: Record<string, ToolExecutionState> }
interface AgentStreamEvent {
  type: string; tool_call_id?: string; toolCallId?: string; tool_name?: string;
  toolName?: string; args?: unknown; result?: unknown; is_error?: boolean;
  isError?: boolean; partial_result?: unknown;
}
export function createInitialAgentStreamState(): AgentStreamState { return { toolExecutions: {} }; }
export function agentStreamReducer(state: AgentStreamState, event: AgentStreamEvent): AgentStreamState {
  switch (event.type) {
    case "tool_execution_start":
      return {
        ...state,
        toolExecutions: {
          ...state.toolExecutions,
          [event.tool_call_id || event.toolCallId || nextId("tool")]: {
            id: event.tool_call_id || event.toolCallId || nextId("tool"),
            toolName: event.tool_name || event.toolName || "tool",
            args: event.args,
            status: "running",
          },
        },
      };
    case "tool_execution_update":
      // Tool payloads are LLM-facing; never surface raw serialized results in the UI.
      return updateTool(state, event.tool_call_id || event.toolCallId, {
        result: event.partial_result,
      });
    case "tool_execution_end":
      return updateTool(state, event.tool_call_id || event.toolCallId, {
        toolName: event.tool_name || event.toolName,
        status: event.is_error ? "error" : "done",
        isError: Boolean(event.is_error),
        result: event.result,
      });
    default: return state;
  }
}
let toolSequence = 0;
function nextId(prefix: string) { return `${prefix}-${++toolSequence}`; }
export function applyRuntimeToolEvent(state: AgentStreamState, type: string, record: Record<string, any>): AgentStreamState {
  const payload = record.payload || {};
  const kinds: Record<string, string> = {
    "tool.started": "tool_execution_start", "runtime.tool_started": "tool_execution_start",
    "tool.progress": "tool_execution_update", "runtime.tool_progress": "tool_execution_update",
    "tool.completed": "tool_execution_end", "runtime.tool_completed": "tool_execution_end",
    "tool.failed": "tool_execution_end", "runtime.tool_failed": "tool_execution_end",
  };
  if (!kinds[type] || !payload.tool_call_id) return state;
  return agentStreamReducer(state, {
    type: kinds[type], tool_call_id: payload.tool_call_id,
    tool_name: payload.description || payload.operation || payload.tool_name,
    args: payload.args, result: payload.result, partial_result: payload.partial_result,
    is_error: !!payload.is_error || type.endsWith("failed"),
  });
}
function updateTool(
  state: AgentStreamState,
  id: string | undefined,
  patch: Partial<ToolExecutionState>
): AgentStreamState {
  const toolId = id || nextId("tool");
  const previous = state.toolExecutions[toolId] || {
    id: toolId,
    toolName: patch.toolName || "tool",
    status: "running" as ToolExecutionStatus,
  };
  return {
    ...state,
    toolExecutions: {
      ...state.toolExecutions,
      [toolId]: { ...previous, ...patch, id: toolId, toolName: patch.toolName || previous.toolName },
    },
  };
}

