import { createHash } from "node:crypto";

import type { LlmChatOptions, LlmClient, LlmMessage } from "@offeru/core";

/**
 * No model configured, but the CLI is driven by an Agent that is a model itself.
 * The tool runs as usual; each model call it makes is handed back to the calling
 * Agent instead of failing with「没配模型」. The Agent answers the prompts and runs
 * the same command again with --answers; calls already answered replay their answer
 * (keyed by a hash of the exact messages), so the tool gets further each round until
 * it finishes and writes like it would with a configured model.
 */
export type HandoffPrompt = { id: string; json: boolean; messages: LlmMessage[] };

export class HandoffPending extends Error {
  constructor(readonly id: string) {
    super(`模型调用 ${id} 交给调用方 Agent 作答`);
    this.name = "HandoffPending";
  }
}

export function promptId(messages: LlmMessage[]): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex").slice(0, 16);
}

export class HandoffLlm implements LlmClient {
  // The calling Agent already has the user's data: no desensitizing placeholders it can't map back.
  readonly local = true;
  readonly provider = "agent";
  readonly model = "calling-agent";
  readonly pending: HandoffPrompt[] = [];

  constructor(private readonly answers: Record<string, string> = {}) {}

  async chat(messages: LlmMessage[], options: LlmChatOptions = {}): Promise<string | null> {
    const id = promptId(messages);
    if (typeof this.answers[id] === "string") return this.answers[id];
    if (!this.pending.some((prompt) => prompt.id === id)) this.pending.push({ id, json: Boolean(options.json), messages });
    throw new HandoffPending(id);
  }
}

export const HANDOFF_HOW = "没配模型，这一步交给你（调用方 Agent）来想：按 pending 里每条的 messages 作答（system 是要求，user 是材料；json=true 时只回严格 JSON，不加代码块）。"
  + "把 {\"<id>\": \"<回答原文>\"} 合并进一个 answers.json（之前轮次的回答也留着），用同样的参数加 --answers @answers.json 再跑一次。"
  + "可能还会给出下一批，直到返回正常结果才算写入完成。";
