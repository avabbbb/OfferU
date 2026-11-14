// The Agent loop: stream one assistant turn, run its tool calls, repeat until
// the model stops calling tools or the step budget runs out. Port of
// backend/app/agent/loop.py (run_agent_loop) as the embedded worker drives it
// (services/embedded_agent_worker.py): sequential tool execution, soft limit
// reminder at `softLimit` turns, hard stop at `hardLimit`, steering messages
// injected at tool boundaries, PII masked on the way out.
//
// Pure TS: the LLM is an injected LlmClient, tools are plain async functions.

import { desensitize, restore } from "../desensitize";
import type { ChatMessage, ChatToolCall, LlmClient, LlmUsage, ParsedToolCall, ToolSpec } from "../llm";

export interface AgentToolContext {
  callId: string;
  signal?: AbortSignal;
}

export interface AgentToolResult {
  /** What the model reads (JSON text, or "ERROR: ..."). */
  text: string;
  isError: boolean;
  /** End this turn after the tool (e.g. request_user_input). */
  terminate?: boolean;
  details?: unknown;
}

export interface AgentTool extends ToolSpec {
  execute(args: Record<string, unknown>, context: AgentToolContext): Promise<AgentToolResult>;
}

/** Tool result in the shape Python's ToolResultMessage.model_dump() emits on tool events. */
export interface ToolResultView {
  role: "toolResult";
  tool_call_id: string;
  tool_name: string;
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
  is_error: boolean;
}

export type LoopEvent =
  | { type: "agent_start" }
  | { type: "turn_start" }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_execution_start"; tool_call_id: string; tool_name: string; args: Record<string, unknown> }
  | { type: "tool_execution_end"; tool_call_id: string; tool_name: string; args: Record<string, unknown>; result: ToolResultView; is_error: boolean }
  | { type: "turn_end"; usage: LlmUsage; messages: ChatMessage[] }
  | { type: "agent_end" };

export interface LoopOptions {
  client: LlmClient;
  systemPrompt: string;
  /** The session so far, ending with the new user message. */
  messages: ChatMessage[];
  tools: AgentTool[];
  softLimit: number;
  hardLimit: number;
  emit?: (event: LoopEvent) => void | Promise<void>;
  signal?: AbortSignal;
  /** Drained between turns; non-empty means another turn even without tool calls. */
  takeSteering?: () => ChatMessage[];
  /** Called after every turn with the full session (Python SAVE_POINT hook). */
  onSavePoint?: (messages: ChatMessage[]) => void | Promise<void>;
  model?: string;
  reasoningEffort?: "" | "low" | "medium" | "high";
  /** Mask phone / email / id numbers before the request (default true, like Python). */
  maskPii?: boolean;
}

export type LoopStopReason = "stop" | "tool_calls" | "length" | "hard_loop_limit" | "error" | "aborted" | string;

export interface LoopResult {
  /** Full session after the run. */
  messages: ChatMessage[];
  stopReason: LoopStopReason;
  /** Text of the last assistant message. */
  assistantText: string;
  /** Assistant turns used. */
  turns: number;
  error?: string;
  usage?: LlmUsage;
}

export const SOFT_LIMIT_REMINDER = "Soft loop limit reached. Please finish the current task or reduce tool usage.";

function textOf(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** Mask everything but image data urls; return the mapping to restore model output. */
function maskMessages(messages: ChatMessage[]): { messages: ChatMessage[]; mapping: Record<string, string> } {
  const images: string[] = [];
  const stripped = messages.map((message) => (Array.isArray(message.content)
    ? {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== "image_url") return part;
        images.push(part.image_url.url);
        return { type: "image_url" as const, image_url: { url: `__IMG_${images.length - 1}__` } };
      }),
    }
    : message));
  const { text, mapping } = desensitize(JSON.stringify(stripped));
  const masked = JSON.parse(text) as ChatMessage[];
  for (const message of masked) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "image_url") {
        const match = /^__IMG_(\d+)__$/.exec(part.image_url.url);
        if (match) part.image_url.url = images[Number(match[1])];
      }
    }
  }
  return { messages: masked, mapping };
}

function toChatToolCalls(calls: ParsedToolCall[]): ChatToolCall[] {
  return calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }));
}

function resultView(callId: string, name: string, result: AgentToolResult): ToolResultView {
  return {
    role: "toolResult",
    tool_call_id: callId,
    tool_name: name,
    content: [{ type: "text", text: result.text }],
    details: result.details ?? null,
    is_error: result.isError,
  };
}

function toolMessage(callId: string, name: string, result: AgentToolResult): ChatMessage {
  const text = result.isError && !result.text.startsWith("ERROR:") ? `ERROR: ${result.text}` : result.text;
  return { role: "tool", tool_call_id: callId, name, content: text };
}

export async function runAgentLoop(options: LoopOptions): Promise<LoopResult> {
  const emit = async (event: LoopEvent) => { await options.emit?.(event); };
  const session: ChatMessage[] = [...options.messages];
  const toolsByName = new Map(options.tools.map((tool) => [tool.name, tool]));
  const specs: ToolSpec[] = options.tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  const mask = options.maskPii !== false;
  let turns = 0;
  let softInjected = false;
  let lastText = "";
  let lastUsage: LlmUsage | undefined;
  let lastFinish: LoopStopReason = "stop";

  const finish = async (stopReason: LoopStopReason, error?: string): Promise<LoopResult> => {
    await emit({ type: "agent_end" });
    return { messages: session, stopReason, assistantText: lastText, turns, ...(error ? { error } : {}), ...(lastUsage ? { usage: lastUsage } : {}) };
  };

  await emit({ type: "agent_start" });
  let pending: ChatMessage[] = options.takeSteering?.() ?? [];
  let moreToolCalls = true;
  while (moreToolCalls || pending.length) {
    if (turns >= options.hardLimit) return finish("hard_loop_limit");
    await emit({ type: "turn_start" });
    if (turns >= options.softLimit && !softInjected) {
      pending = [{ role: "user", content: SOFT_LIMIT_REMINDER }, ...pending];
      softInjected = true;
    }
    session.push(...pending);
    pending = [];

    if (options.signal?.aborted) {
      lastFinish = "aborted";
      return finish("aborted");
    }

    const outgoing = mask ? maskMessages(session) : { messages: session, mapping: {} };
    let content = "";
    let toolCalls: ParsedToolCall[] = [];
    let error: string | undefined;
    for await (const event of options.client.stream({
      messages: [{ role: "system", content: options.systemPrompt }, ...outgoing.messages],
      tools: specs.length ? specs : undefined,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      signal: options.signal,
    })) {
      if (event.type === "text_delta") await emit({ type: "text_delta", text: event.text });
      else if (event.type === "thinking_delta") await emit({ type: "thinking_delta", text: event.text });
      else if (event.type === "done") {
        const result = event.result;
        // Restore complete text / arguments locally; streamed deltas stay masked.
        content = restore(result.content, outgoing.mapping);
        toolCalls = result.toolCalls.map((call) => {
          const args = JSON.parse(restore(JSON.stringify(call.args), outgoing.mapping)) as Record<string, unknown>;
          return { ...call, args, arguments: JSON.stringify(args) };
        });
        lastFinish = result.finishReason;
        lastUsage = result.usage;
        error = result.error;
      }
    }
    turns += 1;
    const assistant: ChatMessage = { role: "assistant", content };
    if (toolCalls.length) assistant.tool_calls = toChatToolCalls(toolCalls);
    session.push(assistant);
    lastText = content;

    if (lastFinish === "error" || lastFinish === "aborted") {
      await emit({ type: "turn_end", usage: lastUsage ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0, estimated: true }, messages: session });
      return finish(lastFinish, error);
    }

    moreToolCalls = false;
    if (toolCalls.length) {
      let terminate = false;
      for (let index = 0; index < toolCalls.length; index += 1) {
        const call = toolCalls[index];
        await emit({ type: "tool_execution_start", tool_call_id: call.id, tool_name: call.name, args: call.args });
        let result: AgentToolResult;
        if (terminate) {
          result = { text: "Skipped because the tool paused this Run", isError: true, terminate: true };
        } else {
          const tool = toolsByName.get(call.name);
          if (!tool) result = { text: `Tool ${call.name} not found`, isError: true };
          else if (options.signal?.aborted) result = { text: "Operation aborted", isError: true };
          else if ("_raw" in call.args && Object.keys(call.args).length === 1) {
            result = { text: `ERROR: 工具参数不是合法 JSON：${String(call.args._raw).slice(0, 200)}`, isError: true };
          } else {
            try {
              result = await tool.execute(call.args, { callId: call.id, signal: options.signal });
            } catch (cause) {
              result = { text: `ERROR: ${cause instanceof Error ? cause.message : String(cause)}`, isError: true };
            }
          }
        }
        await emit({ type: "tool_execution_end", tool_call_id: call.id, tool_name: call.name, args: call.args, result: resultView(call.id, call.name, result), is_error: result.isError });
        session.push(toolMessage(call.id, call.name, result));
        if (result.terminate) terminate = true;
        if (options.signal?.aborted && !terminate) break;
      }
      moreToolCalls = !terminate;
    }
    await emit({ type: "turn_end", usage: lastUsage ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0, estimated: true }, messages: session });
    await options.onSavePoint?.(session);
    if (options.signal?.aborted) return finish("aborted");
    pending = options.takeSteering?.() ?? [];
  }
  return finish(lastFinish);
}

export { textOf as chatMessageText };
