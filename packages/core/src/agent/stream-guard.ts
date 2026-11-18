// First-byte / idle timeouts and staged retry for one streamed Agent turn
// (Flovart browserAgentKernel.ts createBrowserAgentStream: first byte 90s,
// idle 60s, up to 2 retries before the first byte on 408/429/5xx/network/
// stall). Works on any LlmClient through streamCompletion, so it covers the
// OpenAI-compatible and Anthropic paths alike.
//
// A retry only happens while nothing has reached the user yet (no text or
// tool-call delta): replaying after output would duplicate text and could
// repeat tool calls. After output starts, an idle stall ends the turn with
// finishReason "error" and the host fails the run (resumable).

import { streamCompletion, type ChatRequest, type LlmClient, type LlmStreamEvent } from "../llm";

export interface StreamGuardPolicy {
  /** No event at all within this long → stalled before the first byte. */
  firstByteMs: number;
  /** Gap between two events after the first one. */
  idleMs: number;
  /** Retries before the first byte (so attempts = retries + 1). */
  retries: number;
  /** Wait before retry n (index n−1); the last value repeats. */
  backoffMs: number[];
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_STREAM_GUARD: StreamGuardPolicy = { firstByteMs: 90_000, idleMs: 60_000, retries: 2, backoffMs: [1_000, 3_000] };

export type StreamRetryReason = "first_byte_timeout" | "upstream_error" | "network_error";

const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529]);
const TRANSIENT = /\b(408|429|50[0-4]|52[0-9])\b|timed? ?out|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|network|socket hang up|overloaded|rate.?limit|temporarily|限流|过载|超时/i;

class StallError extends Error {
  constructor(readonly phase: "first_byte" | "idle", ms: number) {
    super(phase === "first_byte" ? `模型 ${Math.round(ms / 1000)} 秒没有返回任何内容` : `模型输出中断：${Math.round(ms / 1000)} 秒没有新内容`);
  }
}

function linkedController(parent?: AbortSignal): { controller: AbortController; release(): void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (parent?.aborted) controller.abort();
  parent?.addEventListener("abort", onAbort);
  return { controller, release: () => parent?.removeEventListener("abort", onAbort) };
}

async function nextWithin<T>(iterator: AsyncIterator<T>, ms: number, phase: "first_byte" | "idle"): Promise<IteratorResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stall = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new StallError(phase, ms)), ms); });
  try {
    return await Promise.race([iterator.next(), stall]);
  } finally {
    clearTimeout(timer);
  }
}

function retryReason(event: Extract<LlmStreamEvent, { type: "done" }>): StreamRetryReason | null {
  const result = event.result;
  if (result.finishReason !== "error") return null;
  if (result.errorStatus !== undefined) return RETRY_STATUS.has(result.errorStatus) ? "upstream_error" : null;
  return TRANSIENT.test(result.error || "") ? "network_error" : null;
}

/**
 * streamCompletion with timeouts and retries. `onRetry` is told before each
 * retry (attempt is 1-based for the retry). Yields the same events.
 */
export async function* guardedStream(
  llm: LlmClient,
  request: ChatRequest,
  policy: StreamGuardPolicy = DEFAULT_STREAM_GUARD,
  onRetry?: (info: { attempt: number; reason: StreamRetryReason; error: string }) => void | Promise<void>,
): AsyncIterable<LlmStreamEvent> {
  const sleep = policy.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt += 1) {
    const { controller, release } = linkedController(request.signal);
    const iterator = streamCompletion(llm, { ...request, signal: controller.signal })[Symbol.asyncIterator]();
    let emitted = false;
    let first = true;
    let retry: { reason: StreamRetryReason; error: string } | null = null;
    try {
      for (;;) {
        let step: IteratorResult<LlmStreamEvent>;
        try {
          step = await nextWithin(iterator, first ? policy.firstByteMs : policy.idleMs, first ? "first_byte" : "idle");
        } catch (cause) {
          controller.abort();
          void iterator.return?.(undefined);
          if (request.signal?.aborted) {
            yield { type: "done", result: { provider: llm.provider || "", model: request.model || llm.model || "", content: "", reasoning: "", toolCalls: [], finishReason: "aborted", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, estimated: true } } };
            return;
          }
          const message = cause instanceof Error ? cause.message : String(cause);
          if (!emitted && (cause instanceof StallError || TRANSIENT.test(message))) {
            retry = { reason: cause instanceof StallError ? "first_byte_timeout" : "network_error", error: message };
            break;
          }
          yield { type: "done", result: { provider: llm.provider || "", model: request.model || llm.model || "", content: "", reasoning: "", toolCalls: [], finishReason: "error", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, estimated: true }, error: message } };
          return;
        }
        first = false;
        if (step.done) return;
        const event = step.value;
        if (event.type === "done" && !emitted && !request.signal?.aborted) {
          const reason = retryReason(event);
          if (reason) {
            retry = { reason, error: event.result.error || `HTTP ${event.result.errorStatus}` };
            break;
          }
        }
        if (event.type === "text_delta" || event.type === "tool_call_delta") emitted = true;
        yield event;
      }
    } finally {
      release();
    }
    if (!retry) return;
    if (attempt >= policy.retries || request.signal?.aborted) {
      yield { type: "done", result: { provider: llm.provider || "", model: request.model || llm.model || "", content: "", reasoning: "", toolCalls: [], finishReason: "error", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, estimated: true }, error: `${retry.error}（已重试 ${attempt} 次）` } };
      return;
    }
    await onRetry?.({ attempt: attempt + 1, ...retry });
    await sleep(policy.backoffMs[Math.min(attempt, policy.backoffMs.length - 1)] ?? 0);
  }
}
