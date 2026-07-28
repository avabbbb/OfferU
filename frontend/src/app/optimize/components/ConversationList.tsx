"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button, Spinner } from "@nextui-org/react";
import { FileText, MessageSquare, Trash2, X } from "lucide-react";
import {
  OptimizeSessionSummary,
  fetchOptimizeSessions,
  deleteOptimizeSession,
} from "@/lib/hooks";

interface ConversationListProps {
  onSelect: (sessionId: string) => void;
  onClose: () => void;
}

function phaseLabel(phase: string): string {
  const map: Record<string, string> = {
    confirming: "确认中",
    analyzing: "分析中",
    framework: "框架确认",
    rewriting: "逐段改写",
    completed: "已完成",
  };
  return map[phase] || phase;
}

function phaseColor(phase: string): string {
  const map: Record<string, string> = {
    confirming: "bg-[var(--surface-muted)] text-[var(--foreground)]",
    analyzing: "bg-[var(--surface-muted)] text-[var(--foreground)]",
    framework: "bg-[var(--surface-muted)] text-[var(--foreground)]",
    rewriting: "bg-[var(--status-blush)] text-[var(--foreground)]",
    completed: "bg-[var(--surface-muted)] text-[var(--foreground)]",
  };
  return map[phase] || "bg-[var(--surface-muted)] text-[var(--foreground)]";
}

function formatTime(iso: string): string {
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

export function ConversationList({ onSelect, onClose }: ConversationListProps) {
  const [sessions, setSessions] = useState<OptimizeSessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const loadSessions = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchOptimizeSessions();
      setSessions(Array.isArray(data) ? data : []);
    } catch (err: any) {
      setError(err.message || "加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSessions();
  }, []);

  const handleDelete = async (sessionId: string) => {
    if (!window.confirm("确定删除此对话？")) return;
    setDeleting(sessionId);
    setDeleteError(null);
    try {
      await deleteOptimizeSession(sessionId);
      setSessions((prev) => prev.filter((s) => s.session_id !== sessionId));
    } catch (err: any) {
      setDeleteError(err.message || "删除失败");
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 border-b border-[var(--border-strong)]/12 p-5 md:p-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="bauhaus-label text-[var(--foreground-muted)]">对话管理</p>
            <h2 className="mt-2 text-2xl font-bold leading-tight md:text-3xl">优化对话记录</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center border border-[var(--border-strong)]/15 bg-[var(--surface-muted)] text-[var(--foreground-muted)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-5 md:p-6 custom-scrollbar">
        {deleteError && (
          <div className="mb-3 border border-[#c95548]/30 bg-[var(--primary-red)]/5 px-3 py-2 text-xs font-medium text-[#c95548]">
            {deleteError}
          </div>
        )}
        {loading ? (
          <div className="flex min-h-48 items-center justify-center gap-3 text-sm font-medium text-[var(--foreground-muted)]">
            <Spinner size="sm" color="warning" />
            <span>正在加载对话列表…</span>
          </div>
        ) : error ? (
          <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-center">
            <p className="text-sm font-medium text-[#c95548]">{error}</p>
            <Button
              size="sm"
              className="bauhaus-button bauhaus-button-outline"
              onPress={() => void loadSessions()}
            >
              重试
            </Button>
          </div>
        ) : sessions.length === 0 ? (
          <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-center">
            <MessageSquare size={36} className="text-[var(--foreground-muted)]" />
            <p className="text-sm font-medium text-[var(--foreground-muted)]">暂无优化对话记录</p>
          </div>
        ) : (
          <div className="space-y-3">
            {sessions.map((session) => (
              <div
                key={session.session_id}
                className="group border border-[var(--border-strong)]/15 bg-white p-4 shadow-[1px_1px_0_0_rgba(18,18,18,0.08)] transition-transform hover:-translate-y-[1px]"
              >
                <div className="flex items-start justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => onSelect(session.session_id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="flex items-center gap-2">
                      <span className={`inline-block px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${phaseColor(session.phase)}`}>
                        {phaseLabel(session.phase)}
                      </span>
                    </div>
                    <h3 className="mt-2 line-clamp-2 text-sm font-semibold text-[var(--foreground)]">
                      {session.title || `对话 ${session.session_id.slice(0, 8)}`}
                    </h3>
                    <p className="mt-1 text-xs text-[var(--foreground-muted)]">
                      {formatTime(session.updated_at || session.created_at)}
                    </p>
                    {session.resume_id && (
                      <div className="mt-2 flex items-center gap-1 text-xs text-[var(--foreground-muted)]">
                        <FileText size={12} />
                        <span>简历 #{session.resume_id}</span>
                      </div>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleDelete(session.session_id);
                    }}
                    disabled={deleting === session.session_id}
                    className="flex h-8 w-8 shrink-0 items-center justify-center border border-[var(--border-strong)]/10 text-[var(--foreground-muted)] transition-colors hover:border-[#c95548] hover:text-[#c95548] disabled:opacity-40"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
