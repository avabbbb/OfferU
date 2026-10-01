// Migrated from luyishui/OfferU @ 3a446ff, MIT. Tool reducer cases and view
// remain upstream source; the event adapter binds the existing Career Runtime.
import { Chip } from "@nextui-org/react";
import { CheckCircle2, Loader2, Wrench, XCircle } from "lucide-react";
import type { ToolExecutionState } from "@/lib/embeddedAgentStream";
export function ToolExecutionList({ executions }: { executions: Record<string, ToolExecutionState> }) {
  const rows = Object.values(executions);
  if (rows.length === 0) return null;
  return (
    <div className="space-y-2">
      {rows.map((tool) => (
        <div key={tool.id} className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs text-[var(--foreground-soft)]">
          <div className="flex items-center gap-2 font-semibold text-[var(--foreground)]">
            {tool.status === "running" ? <Loader2 size={13} className="animate-spin" /> : tool.status === "error" ? <XCircle size={13} className="text-[#D02020]" /> : <CheckCircle2 size={13} className="text-[#207A3A]" />}
            <Wrench size={13} />
            <span className="break-all">{tool.toolName}</span>
            <Chip size="sm" className="ml-auto border border-[var(--border)] bg-[var(--surface-muted)] text-[10px] text-[var(--foreground)]">
              {tool.status === "running" ? "运行中" : tool.status === "error" ? "出错" : "完成"}
            </Chip>
          </div>
          {/* Tool payloads are LLM-facing: no raw result/summary body is rendered. */}
        </div>
      ))}
    </div>
  );
}

