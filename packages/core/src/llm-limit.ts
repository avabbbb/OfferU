// A shared budget of model requests per provider.
//
// Run admission counts Agent runs, but one run fans out: its own turns, evaluate_jobs (2 at a
// time), tailor_resume's draft + review, plus the resume page and HTTP tools running beside it.
// What a provider rate-limits is requests, so the budget is on requests: every chat / stream
// call through a limited client takes a slot for the provider and gives it back when the answer
// (or the stream) ends. A run waiting on a tool holds no slot.

import type { ChatRequest, ChatResult, LlmChatOptions, LlmClient, LlmMessage, LlmStreamEvent } from "./llm";

/** Concurrent model requests per provider when nothing else is configured. */
export const MODEL_CALLS_PER_PROVIDER = 4;

type Queue = { active: number; waiters: Array<() => void> };

export class ModelCallLimiter {
  private readonly queues = new Map<string, Queue>();

  constructor(private readonly limit: () => number = () => MODEL_CALLS_PER_PROVIDER) {}

  /** Wait for a slot (abortable); resolves to the release function. */
  async acquire(key: string, signal?: AbortSignal): Promise<() => void> {
    let queue = this.queues.get(key);
    if (!queue) this.queues.set(key, (queue = { active: 0, waiters: [] }));
    const q = queue;
    const max = Math.max(1, Math.trunc(this.limit()) || MODEL_CALLS_PER_PROVIDER);
    if (q.active >= max) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => { signal?.removeEventListener("abort", onAbort); resolve(); };
        const onAbort = () => {
          const at = q.waiters.indexOf(wake);
          if (at >= 0) q.waiters.splice(at, 1);
          reject(signal?.reason ?? new Error("aborted"));
        };
        if (signal?.aborted) return onAbort();
        signal?.addEventListener("abort", onAbort, { once: true });
        q.waiters.push(wake);
      });
    }
    q.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      q.active -= 1;
      q.waiters.shift()?.();
    };
  }

  /** In flight / waiting, per provider (status display, tests). */
  snapshot(): Record<string, { active: number; waiting: number }> {
    return Object.fromEntries([...this.queues].map(([key, q]) => [key, { active: q.active, waiting: q.waiters.length }]));
  }
}

const wrapped = new WeakMap<LlmClient, WeakMap<ModelCallLimiter, LlmClient>>();
/** Clients this module produced, with their limiter: wrapping one again would take two slots per call. */
const limitedBy = new WeakMap<LlmClient, ModelCallLimiter>();

/** The same client, every request going through `limiter` under the provider's key. Stable identity per (client, limiter). */
export function limitLlm(client: LlmClient, limiter: ModelCallLimiter): LlmClient {
  if (limitedBy.get(client) === limiter) return client;
  let byLimiter = wrapped.get(client);
  if (!byLimiter) wrapped.set(client, (byLimiter = new WeakMap()));
  const cached = byLimiter.get(limiter);
  if (cached) return cached;
  const key = client.provider || "custom";
  // Inherit every other property (metadata, capabilities a client may carry) from the original.
  const limited = Object.create(client) as LlmClient & { chat: LlmClient["chat"] };
  const chat = client.chat.bind(client);
  limited.chat = async (messages: LlmMessage[], options?: LlmChatOptions) => {
    const release = await limiter.acquire(key, options?.signal);
    try { return await chat(messages, options); } finally { release(); }
  };
  if (client.chatStream) {
    const stream = client.chatStream.bind(client);
    limited.chatStream = async function* (messages: LlmMessage[], options?: LlmChatOptions) {
      const release = await limiter.acquire(key, options?.signal);
      try { yield* stream(messages, options); } finally { release(); }
    };
  }
  if (client.complete) {
    const complete = client.complete.bind(client);
    limited.complete = async (request: ChatRequest): Promise<ChatResult> => {
      const release = await limiter.acquire(key, request.signal);
      try { return await complete(request); } finally { release(); }
    };
  }
  if (client.completeStream) {
    const completeStream = client.completeStream.bind(client);
    limited.completeStream = async function* (request: ChatRequest): AsyncIterable<LlmStreamEvent> {
      const release = await limiter.acquire(key, request.signal);
      try { yield* completeStream(request); } finally { release(); }
    };
  }
  byLimiter.set(limiter, limited);
  limitedBy.set(limited, limiter);
  return limited;
}
