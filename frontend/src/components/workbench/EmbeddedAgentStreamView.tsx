// Migrated from luyishui/OfferU @ 3a446ff, MIT. Tool reducer cases and view
// remain upstream source; the event adapter binds the existing Career Runtime.
import { useEffect, useState } from "react";
import { CheckCircle2, ChevronRight, Loader2, XCircle } from "lucide-react";
import type { ToolExecutionState } from "@/lib/embeddedAgentStream";

// 一组工具从首个开始到最后结束的秒数；运行中的工具按 now 计。
export function toolGroupSeconds(rows: ToolExecutionState[], now: number): number {
  const starts = rows
    .map((tool) => tool.startedAt)
    .filter((value): value is number => typeof value === "number");
  if (starts.length === 0) return 0;
  const ends = rows.map((tool) => tool.endedAt ?? now);
  return Math.max(0, Math.round((Math.max(...ends) - Math.min(...starts)) / 1000));
}

// Notion 式：一组工具折成一行摘要，点开才看逐条。title 可截断，meta 始终完整显示。
export function toolGroupSummary(rows: ToolExecutionState[], now: number): { title: string; meta: string } {
  const current = rows.find((tool) => tool.status === "running");
  const seconds = toolGroupSeconds(rows, now);
  if (current) {
    return { title: current.toolName, meta: "第 " + rows.length + " 步" + (seconds > 0 ? " · " + seconds + " 秒" : "") };
  }
  const failed = rows.filter((tool) => tool.status === "error").length;
  return {
    title: "已执行 " + rows.length + " 步",
    meta: [seconds > 0 ? "耗时 " + seconds + " 秒" : "", failed > 0 ? failed + " 步出错" : ""].filter(Boolean).join(" · "),
  };
}

export function ToolExecutionList({ executions }: { executions: Record<string, ToolExecutionState> }) {
  const rows = Object.values(executions);
  const running = rows.some((tool) => tool.status === "running");
  const failed = rows.some((tool) => tool.status === "error");
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  if (rows.length === 0) return null;
  const summary = toolGroupSummary(rows, now);
  // Tool payloads are LLM-facing: no raw result/summary body is rendered.
  return (
    <div className="agent-tool-group">
      <button
        type="button"
        className="agent-tool-summary"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {running ? (
          <Loader2 size={12} className="shrink-0 animate-spin text-[var(--foreground-muted)]" />
        ) : failed ? (
          <XCircle size={12} className="shrink-0 text-[var(--primary-red)]" />
        ) : (
          <CheckCircle2 size={12} className="shrink-0 text-[var(--primary-green)]" />
        )}
        <span className="min-w-0 flex-1 truncate text-left" title={summary.title}>{summary.title}</span>
        {summary.meta && (
          <span className="shrink-0 tabular-nums text-[length:var(--agent-fs-xs)] text-[var(--foreground-muted)]">{summary.meta}</span>
        )}
        <ChevronRight
          size={12}
          className={"shrink-0 text-[var(--foreground-muted)] transition-transform duration-[var(--dur-quick)] " + (open ? "rotate-90" : "")}
        />
      </button>
      {open && (
        <div className="agent-tool-list" role="list" aria-label="工具调用">
          {rows.map((tool) => {
            const label = tool.status === "running" ? "运行中" : tool.status === "error" ? "出错" : "完成";
            return (
              <div key={tool.id} role="listitem" data-status={tool.status} className="agent-tool-row">
                {tool.status === "running" ? (
                  <Loader2 size={12} className="shrink-0 animate-spin text-[var(--foreground-muted)]" />
                ) : tool.status === "error" ? (
                  <XCircle size={12} className="shrink-0 text-[var(--primary-red)]" />
                ) : (
                  <CheckCircle2 size={12} className="shrink-0 text-[var(--primary-green)]" />
                )}
                <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--agent-fs-xs)] text-[var(--foreground)]" title={tool.toolName}>
                  {tool.toolName}
                </span>
                <span className="shrink-0 text-[length:var(--agent-fs-xs)] text-[var(--foreground-muted)]">{label}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
