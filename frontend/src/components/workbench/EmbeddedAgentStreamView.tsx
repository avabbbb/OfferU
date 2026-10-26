// Migrated from luyishui/OfferU @ 3a446ff, MIT. Tool reducer cases and view
// remain upstream source; the event adapter binds the existing Career Runtime.
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import type { ToolExecutionState } from "@/lib/embeddedAgentStream";

export function ToolExecutionList({ executions }: { executions: Record<string, ToolExecutionState> }) {
  const rows = Object.values(executions);
  if (rows.length === 0) return null;
  // Tool payloads are LLM-facing: no raw result/summary body is rendered.
  return (
    <div className="agent-tool-group" role="list" aria-label="工具调用">
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
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--foreground)]" title={tool.toolName}>
              {tool.toolName}
            </span>
            <span className="shrink-0 text-[10.5px] text-[var(--foreground-muted)]">{label}</span>
          </div>
        );
      })}
    </div>
  );
}
