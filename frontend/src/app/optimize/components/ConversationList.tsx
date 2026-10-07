"use client";

import { useEffect, useState } from "react";
import { Button, Spinner } from "@heroui/react";
import { History, RefreshCw, X } from "lucide-react";
import { agentRuntimeApi, type AgentRunRecord } from "@/lib/api";
import { safeClientErrorMessage } from "@/lib/safe-error";
import { runStatusLabel, tailorResumeTaskId } from "./runtimeTailorResume";

interface ConversationListProps {
  jobId: number | null;
  onSelect: (runId: string) => void;
  onClose: () => void;
}

function formatTime(iso?: string): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return "刚刚";
    if (diffMin < 60) return `${diffMin} 分钟前`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr} 小时前`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 30) return `${diffDay} 天前`;
    return d.toLocaleDateString("zh-CN");
  } catch {
    return iso;
  }
}

export function ConversationList({ jobId, onSelect, onClose }: ConversationListProps) {
  const [runs, setRuns] = useState<AgentRunRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadRuns = async () => {
    if (!jobId) {
      setRuns([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const result = await agentRuntimeApi.runs({
        task_id: tailorResumeTaskId(jobId),
        limit: 20,
      });
      setRuns((result.runs || []).filter((run) => run.skill_id === "tailor_resume"));
    } catch (err) {
      setError(safeClientErrorMessage(err, "加载历史 Run 失败"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadRuns();
  }, [jobId]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--border)] px-5 py-3">
        <div>
          <p className="text-sm font-semibold text-[var(--foreground)]">历史定制 Run</p>
          <p className="mt-0.5 text-xs text-[var(--foreground-muted)]">这些记录来自统一 Agent Runtime，不再读取旧 Optimize Session。</p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="刷新历史 Run"
            onClick={() => void loadRuns()}
            className="rounded-md p-2 text-[var(--foreground-muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]"
          >
            <RefreshCw size={14} />
          </button>
          <button
            type="button"
            aria-label="关闭历史 Run"
            onClick={onClose}
            className="rounded-md p-2 text-[var(--foreground-muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]"
          >
            <X size={15} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
        {loading ? (
          <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-[var(--foreground-muted)]">
            <Spinner size="sm" color="warning" /> 正在读取 Runtime 历史…
          </div>
        ) : error ? (
          <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-center">
            <p role="alert" className="text-sm text-[var(--primary-red)]">{error}</p>
            <Button size="sm" className="bauhaus-button bauhaus-button-outline" onPress={() => void loadRuns()}>
              重试
            </Button>
          </div>
        ) : runs.length === 0 ? (
          <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-center text-sm text-[var(--foreground-muted)]">
            <History size={30} />
            <p>这个岗位还没有简历定制 Run。</p>
          </div>
        ) : (
          <div className="space-y-2">
            {runs.map((run) => (
              <button
                key={run.id}
                type="button"
                onClick={() => onSelect(run.id)}
                className="w-full rounded-[10px] border border-[var(--border)] bg-white p-3 text-left transition-colors hover:bg-[var(--surface-muted)]"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold text-[var(--foreground)]">{runStatusLabel(run.status)}</span>
                  <span className="text-[11px] text-[var(--foreground-muted)]">{formatTime(run.updated_at || run.created_at)}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-[var(--foreground-muted)]">
                  {run.goal || "岗位简历定制"}
                </p>
                <p className="mt-2 font-mono text-[10px] text-[var(--foreground-muted)]">{run.id}</p>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
