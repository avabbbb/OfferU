// 从 Run 事件里读上下文占用（后端 kernel.turn_end → payload.context_usage）。
// 没有就返回 null，前端不显示 Context Meter，不编数字。
export interface AgentContextUsage {
  used: number;
  window: number;
  compactAt: number;
  estimated: boolean;
}

export function contextUsageFromEvent(data: unknown): AgentContextUsage | null {
  const payload = (data as { payload?: unknown } | null)?.payload;
  const raw = (payload as { context_usage?: unknown } | null)?.context_usage as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") return null;
  const used = Number(raw.used);
  const window = Number(raw.window);
  if (!Number.isFinite(used) || !Number.isFinite(window) || window <= 0 || used < 0) return null;
  const compactAt = Number(raw.compact_at);
  return {
    used,
    window,
    compactAt: Number.isFinite(compactAt) && compactAt > 0 ? compactAt : window,
    estimated: raw.estimated !== false,
  };
}
