// The Agent loop: stream one assistant turn, run its tool calls, repeat until
// the model stops calling tools or the step budget runs out. Port of
// backend/app/agent/loop.py (run_agent_loop) as the embedded worker drives it
// (services/embedded_agent_worker.py): sequential tool execution, soft limit
// reminder at `softLimit` turns, hard stop at `hardLimit`, steering messages
// injected at tool boundaries, PII masked on the way out.
//
// Pure TS: the LLM is an injected LlmClient, tools are plain async functions.

import { PiiMasker, restore } from "../desensitize";
import { streamCompletion, type ChatMessage, type ChatToolCall, type LlmClient, type LlmUsage, type ParsedToolCall, type LlmToolSpec } from "../llm";

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

export interface AgentTool extends LlmToolSpec {
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
  | { type: "turn_end"; usage: LlmUsage; messages: ChatMessage[]; timing: TurnTiming }
  | { type: "agent_end" };

/** Per-turn latency, milliseconds from the moment the request is handed to the client. */
export interface TurnTiming {
  /** → first streamed delta of any kind (text, reasoning, tool call); null when none came. */
  ttft_ms: number | null;
  /** → provider stream finished. */
  llm_ms: number;
  /** → tools of this turn finished too. */
  turn_ms: number;
}

/** One turn's usage + timing, as recorded on the run (final_result.llm_stats.turns). */
export interface TurnStats extends TurnTiming {
  input_tokens: number;
  cached_input_tokens: number;
  cache_creation_input_tokens: number;
  output_tokens: number;
  estimated: boolean;
}

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
  /**
   * Session id: makes PII placeholders reproducible for this session, so a
   * resumed session re-sends byte-identical history. Absent: random per loop
   * (still stable across the turns of this loop).
   */
  maskSeed?: string;
  /** Provider prompt-cache routing key / opt-in (ChatRequest.cacheKey). */
  cacheKey?: string;
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
  /** Usage + timing per assistant turn. */
  turnStats: TurnStats[];
}

const ZERO_USAGE: LlmUsage = { input_tokens: 0, output_tokens: 0, total_tokens: 0, estimated: true };

/** Run-level cache / latency summary of the turns (final_result.llm_stats). */
export function summarizeTurnStats(turns: TurnStats[]): Record<string, unknown> {
  const measured = turns.filter((turn) => !turn.estimated && turn.input_tokens > 0);
  const input = measured.reduce((sum, turn) => sum + turn.input_tokens, 0);
  const cached = measured.reduce((sum, turn) => sum + turn.cached_input_tokens, 0);
  const ttfts = turns.map((turn) => turn.ttft_ms).filter((value): value is number => value !== null);
  return {
    turns: turns.length,
    input_tokens: input,
    cached_input_tokens: cached,
    cache_hit_rate: input ? Number((cached / input).toFixed(3)) : null,
    first_ttft_ms: turns[0]?.ttft_ms ?? null,
    avg_ttft_ms: ttfts.length ? Math.round(ttfts.reduce((sum, value) => sum + value, 0) / ttfts.length) : null,
    llm_ms: turns.reduce((sum, turn) => sum + turn.llm_ms, 0),
    per_turn: turns,
  };
}

export const SOFT_LIMIT_REMINDER = "Soft loop limit reached. Please finish the current task or reduce tool usage.";

function textOf(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** Clock for latency telemetry (performance.now in browsers, Node and workerd). */
function clock(): number {
  const perf = (globalThis as { performance?: { now(): number } }).performance;
  return perf ? perf.now() : Date.now();
}

/**
 * Masks the session once per message, in order, and keeps the masked copies:
 * history is append-only within a run, so every turn re-sends the exact bytes
 * it sent before and only masks what is new. Image data urls are never masked.
 */
class SessionMasker {
  private readonly masker: PiiMasker;
  private readonly masked: ChatMessage[] = [];

  constructor(seed?: string) {
    this.masker = new PiiMasker(seed);
  }

  get mapping(): Record<string, string> { return this.masker.mapping; }

  messages(session: ChatMessage[]): ChatMessage[] {
    for (let index = this.masked.length; index < session.length; index += 1) this.masked.push(this.maskOne(session[index]));
    return this.masked.slice(0, session.length);
  }

  private maskOne(message: ChatMessage): ChatMessage {
    const images: string[] = [];
    const stripped = Array.isArray(message.content)
      ? {
        ...message,
        content: message.content.map((part) => {
          if (part.type !== "image_url") return part;
          images.push(part.image_url.url);
          return { type: "image_url" as const, image_url: { url: `__IMG_${images.length - 1}__` } };
        }),
      }
      : message;
    const masked = JSON.parse(this.masker.mask(JSON.stringify(stripped))) as ChatMessage;
    if (Array.isArray(masked.content)) {
      for (const part of masked.content) {
        if (part.type === "image_url") {
          const match = /^__IMG_(\d+)__$/.exec(part.image_url.url);
          if (match) part.image_url.url = images[Number(match[1])];
        }
      }
    }
    return masked;
  }
}

/** JSON value with object keys sorted, so the serialized tool schema never depends on construction order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}

/**
 * Tool specs as the provider sees them, deterministic: sorted by name, schema
 * keys sorted. Tools are the first thing every provider renders, so this is
 * the head of the cacheable prefix.
 */
export function stableToolSpecs(tools: LlmToolSpec[]): LlmToolSpec[] {
  return [...tools]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(({ name, description, parameters }) => ({ name, description, parameters: canonical(parameters) as Record<string, unknown> }));
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
  const specs = stableToolSpecs(options.tools);
  const masker = options.maskPii !== false ? new SessionMasker(options.maskSeed) : null;
  const turnStats: TurnStats[] = [];
  let turns = 0;
  let softInjected = false;
  let lastText = "";
  let lastUsage: LlmUsage | undefined;
  let lastFinish: LoopStopReason = "stop";

  const finish = async (stopReason: LoopStopReason, error?: string): Promise<LoopResult> => {
    await emit({ type: "agent_end" });
    return { messages: session, stopReason, assistantText: lastText, turns, turnStats, ...(error ? { error } : {}), ...(lastUsage ? { usage: lastUsage } : {}) };
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

    const outgoing = masker ? { messages: masker.messages(session), mapping: masker.mapping } : { messages: session, mapping: {} };
    let content = "";
    let toolCalls: ParsedToolCall[] = [];
    let error: string | undefined;
    const started = clock();
    let firstDelta: number | null = null;
    for await (const event of streamCompletion(options.client, {
      messages: [{ role: "system", content: options.systemPrompt }, ...outgoing.messages],
      tools: specs.length ? specs : undefined,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      signal: options.signal,
      ...(options.cacheKey ? { cacheKey: options.cacheKey } : {}),
    })) {
      if (firstDelta === null && event.type !== "done") firstDelta = clock();
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
    const llmDone = clock();
    turns += 1;
    const assistant: ChatMessage = { role: "assistant", content };
    if (toolCalls.length) assistant.tool_calls = toChatToolCalls(toolCalls);
    session.push(assistant);
    lastText = content;

    const turnEnd = (): TurnTiming => {
      const usage = lastUsage ?? ZERO_USAGE;
      const timing: TurnTiming = {
        ttft_ms: firstDelta === null ? null : Math.round(firstDelta - started),
        llm_ms: Math.round(llmDone - started),
        turn_ms: Math.round(clock() - started),
      };
      turnStats.push({
        ...timing,
        input_tokens: usage.input_tokens,
        cached_input_tokens: usage.cached_input_tokens ?? 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        output_tokens: usage.output_tokens,
        estimated: usage.estimated,
      });
      return timing;
    };

    // Persist the tool-call message before running the batch, and after each result, so a process
    // that dies mid-batch leaves a session the host can reconcile on resume instead of replaying writes.
    if (toolCalls.length) await options.onSavePoint?.(session);

    if (lastFinish === "error" || lastFinish === "aborted") {
      await emit({ type: "turn_end", usage: lastUsage ?? ZERO_USAGE, messages: session, timing: turnEnd() });
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
        await options.onSavePoint?.(session);
        if (result.terminate) terminate = true;
        if (options.signal?.aborted && !terminate) break;
      }
      moreToolCalls = !terminate;
    }
    await emit({ type: "turn_end", usage: lastUsage ?? ZERO_USAGE, messages: session, timing: turnEnd() });
    await options.onSavePoint?.(session);
    if (options.signal?.aborted) return finish("aborted");
    pending = options.takeSteering?.() ?? [];
  }
  return finish(lastFinish);
}

export { textOf as chatMessageText };
