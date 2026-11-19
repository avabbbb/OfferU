/**
 * Codex 式插话 / 排队（纯函数）。
 *
 * 同一时间只跑一个 Run。Run 在跑时：
 * - Enter = 插话（POST /steer）：这句话在下一步之前交给正在跑的 Run；
 * - Tab = 排队：放进输入框上方的托盘，这一轮结束后按顺序一条条发。
 * 托盘存在 localStorage，刷新不丢；但上次会话留下的条目不会自己发出去（armed=false），要用户点「发送」。
 */

export interface QueuedMessage {
  id: string;
  text: string;
  /** 排队时所在的对话；null = 还没保存的新对话。 */
  conversationId: string | null;
  createdAt: number;
  /** 本次页面里排的才会在 Run 结束后自动发；从存储里读回来的是 false。 */
  armed: boolean;
}

export const QUEUE_STORAGE_KEY = "offeru.agent.queue.v1";
export const QUEUE_MAX_ITEMS = 20;
export const QUEUE_TEXT_MAX = 4000;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type ComposerKeyIntent = "send" | "steer" | "queue" | null;

/** 输入框按键的意图。busy = 有 Run 在跑。 */
export function composerKeyIntent(event: { key: string; shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; isComposing?: boolean }, state: { busy: boolean; hasText: boolean }): ComposerKeyIntent {
  if (event.isComposing) return null;
  if (event.key === "Enter" && !event.shiftKey) return state.busy ? "steer" : "send";
  if (event.key === "Tab" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && state.busy && state.hasText) return "queue";
  return null;
}

let seq = 0;
export function enqueue(items: readonly QueuedMessage[], text: string, conversationId: string | null, now = Date.now()): QueuedMessage[] {
  const clean = text.trim().slice(0, QUEUE_TEXT_MAX);
  if (!clean) return [...items];
  const item: QueuedMessage = { id: `q_${now.toString(36)}_${(seq += 1)}`, text: clean, conversationId, createdAt: now, armed: true };
  return [...items, item].slice(-QUEUE_MAX_ITEMS);
}

/** 插回队首（插话没送到时用：保持它在下一条）。 */
export function enqueueFront(items: readonly QueuedMessage[], text: string, conversationId: string | null, now = Date.now()): QueuedMessage[] {
  const next = enqueue([], text, conversationId, now);
  return [...next, ...items].slice(0, QUEUE_MAX_ITEMS);
}

export function removeQueued(items: readonly QueuedMessage[], id: string): QueuedMessage[] {
  return items.filter((item) => item.id !== id);
}

/** 当前对话可见的条目。 */
export function queuedFor(items: readonly QueuedMessage[], conversationId: string | null): QueuedMessage[] {
  return items.filter((item) => item.conversationId === conversationId);
}

/** Run 结束后自动发的下一条：当前对话里第一条 armed 的。 */
export function nextArmed(items: readonly QueuedMessage[], conversationId: string | null): QueuedMessage | null {
  return items.find((item) => item.armed && item.conversationId === conversationId) ?? null;
}

/** 新对话第一次保存拿到 id：把排在「新对话」下的条目挂过去。 */
export function rebindConversation(items: readonly QueuedMessage[], from: string | null, to: string): QueuedMessage[] {
  if (from === to) return [...items];
  return items.map((item) => (item.conversationId === from ? { ...item, conversationId: to } : item));
}

export function loadQueue(storage: StorageLike | null | undefined): QueuedMessage[] {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(QUEUE_STORAGE_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((raw): QueuedMessage[] => {
      if (!raw || typeof raw !== "object") return [];
      const item = raw as Record<string, unknown>;
      const text = typeof item.text === "string" ? item.text.trim().slice(0, QUEUE_TEXT_MAX) : "";
      if (!text || typeof item.id !== "string") return [];
      const conversationId = typeof item.conversationId === "string" ? item.conversationId : null;
      return [{ id: item.id, text, conversationId, createdAt: Number(item.createdAt) || 0, armed: false }];
    }).slice(-QUEUE_MAX_ITEMS);
  } catch {
    return [];
  }
}

export function saveQueue(storage: StorageLike | null | undefined, items: readonly QueuedMessage[]): void {
  if (!storage) return;
  try {
    if (!items.length) storage.removeItem(QUEUE_STORAGE_KEY);
    else storage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(items.map(({ armed: _armed, ...rest }) => rest)));
  } catch {
    // 隐私模式 / 配额满：托盘只在内存里，照样能用。
  }
}
