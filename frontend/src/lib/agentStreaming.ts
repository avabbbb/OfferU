/**
 * 流式输出的纯函数：补齐未闭合的代码块、每帧合并一次增量、思考计时文案。
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * 流到一半的 Markdown 常常停在代码块中间：```js 开了还没关，后面的正文会整段被当成代码，
 * 等下一段到了又跳回去。这里按 CommonMark 的规则数围栏，没闭合就在末尾补一个同样的围栏，
 * 渲染出来和最终结果一致。只在流式时用，最终消息原样渲染。
 */
export function closeOpenFences(text: string): string {
  let open: { char: string; length: number } | null = null;
  for (const line of text.split("\n")) {
    const match = FENCE.exec(line);
    if (!match) continue;
    const marker = match[1];
    if (!open) {
      // 反引号围栏的 info string 里不能再有反引号
      if (marker[0] === "`" && line.slice(match[0].length).includes("`")) continue;
      open = { char: marker[0], length: marker.length };
    } else if (marker[0] === open.char && marker.length >= open.length && !line.slice(match[0].length).trim()) {
      open = null;
    }
  }
  if (!open) return text;
  return `${text}${text.endsWith("\n") ? "" : "\n"}${open.char.repeat(open.length)}`;
}

export interface FrameBatcher<T> {
  /** 记一笔；本帧第一次 push 时排一次 flush。 */
  push(item: T): void;
  /** 立刻把攒着的交出去（非增量事件到了、结束时用，保证顺序）。 */
  flush(): void;
  /** 丢掉攒着的、取消排好的帧。 */
  cancel(): void;
}

type Schedule = (callback: () => void) => number;
type Unschedule = (handle: number) => void;

const defaultSchedule: Schedule = (callback) =>
  typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
    ? window.requestAnimationFrame(callback)
    : (setTimeout(callback, 16) as unknown as number);
const defaultUnschedule: Unschedule = (handle) => {
  if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(handle);
  else clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
};

/**
 * 每帧合并一次：模型一秒能吐几十上百个小增量，每个都 setState 会让长回答的 Markdown 反复重渲染。
 * 攒到下一帧一起交给 onFlush（一帧最多一次 React 更新）。
 */
export function createFrameBatcher<T>(onFlush: (items: T[]) => void, schedule: Schedule = defaultSchedule, unschedule: Unschedule = defaultUnschedule): FrameBatcher<T> {
  let items: T[] = [];
  let handle: number | null = null;
  const flush = () => {
    if (handle !== null) { unschedule(handle); handle = null; }
    if (!items.length) return;
    const taken = items;
    items = [];
    onFlush(taken);
  };
  return {
    push(item) {
      items.push(item);
      if (handle === null) handle = schedule(() => { handle = null; flush(); });
    },
    flush,
    cancel() {
      if (handle !== null) unschedule(handle);
      handle = null;
      items = [];
    },
  };
}

/** 思考块标题：进行中「思考中 · 3 秒」，结束后「已思考 5 秒」。 */
export function thinkingLabel(startedAt: number, endedAt: number | null | undefined, now: number): string {
  const end = endedAt ?? now;
  const seconds = Math.max(0, Math.round((end - startedAt) / 1000));
  if (endedAt == null) return seconds < 1 ? "思考中" : `思考中 · ${formatSeconds(seconds)}`;
  return seconds < 1 ? "已思考" : `已思考 ${formatSeconds(seconds)}`;
}

function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`;
}

/**
 * Run 中断 / 失败时，已经流出来的那段回答怎么留：有字就留成一条本地消息并标明是哪种结束，
 * 没字（或只有空白）就不留。错误文案里提到取消 / 中断的算「中断」，其余算「失败」。
 */
export function partialReplyFrom(streamedText: string, error: unknown): { content: string; partial: "cancelled" | "failed" } | null {
  const content = streamedText.trim();
  if (!content) return null;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return { content, partial: /取消|中断|cancel|interrupt|abort/i.test(message) ? "cancelled" : "failed" };
}
