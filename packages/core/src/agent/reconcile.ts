// Resume after a crash in the middle of a tool batch.
//
// The loop saves the session after the assistant message that asks for tools and after every
// tool result (loop.ts onSavePoint), so a stored session that ends inside a batch says exactly
// which calls returned. For each call that did not, the change log answers whether its write
// committed (ChangeRow.op = "<run>:<call>"): committed → a synthesized "already done" result
// with its change ids, so the model does not call it again; not committed → an "interrupted,
// not executed" result, so the model checks state before retrying. Nothing is re-executed here.

import type { ChatMessage } from "../llm";

export type CommittedLookup = (callId: string) => Promise<number[]>;

export type Reconciled = { messages: ChatMessage[]; committed: string[]; interrupted: string[] };

/** Index of the assistant message whose tool batch is still open (missing results), or -1. */
function openBatch(messages: ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "tool") continue;
    if (message.role !== "assistant" || !message.tool_calls?.length) return -1;
    const answered = new Set(messages.slice(index + 1).map((item) => item.tool_call_id));
    return message.tool_calls.some((call) => !answered.has(call.id)) ? index : -1;
  }
  return -1;
}

export async function reconcileToolBatch(messages: ChatMessage[], committedChanges: CommittedLookup): Promise<Reconciled> {
  const index = openBatch(messages);
  if (index < 0) return { messages, committed: [], interrupted: [] };
  const assistant = messages[index];
  const answered = new Set(messages.slice(index + 1).map((item) => item.tool_call_id));
  const out = [...messages];
  const committed: string[] = [];
  const interrupted: string[] = [];
  for (const call of assistant.tool_calls ?? []) {
    if (answered.has(call.id)) continue;
    const name = call.function?.name ?? "";
    const changeIds = await committedChanges(call.id);
    if (changeIds.length) {
      committed.push(call.id);
      out.push({ role: "tool", tool_call_id: call.id, name, content: JSON.stringify({
        ok: true,
        recovered: true,
        change_ids: changeIds,
        message: "进程在这个工具返回结果之前退出了，但它的写入已经提交（见 change_ids）。不要重复调用；需要细节就 get / changes 读回来。",
      }) });
    } else {
      interrupted.push(call.id);
      out.push({ role: "tool", tool_call_id: call.id, name, content: JSON.stringify({
        ok: false,
        error: {
          code: "interrupted",
          message: "进程在这个工具执行完之前退出了，没有找到它提交的写入，可以认为没有执行。",
          retryable: true,
          suggestedAction: "先用 get / list 确认当前状态，确实还需要再调用。",
        },
      }) });
    }
  }
  return { messages: out, committed, interrupted };
}
