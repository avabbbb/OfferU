"use client";

// 右下角「待确认 / 最近改动」：Agent 可撤销的写直接生效并记在这里，
// 不可逆的写（对外发送、清空、改投递状态、删除）先排在这里等你确认一次。
import { useCallback, useEffect, useState } from "react";
import { ClipboardCheck, Loader2, Undo2, X } from "lucide-react";
import { useSWRConfig } from "swr";
import { agentActionsApi, type AgentActionRecord } from "@/lib/api";
import { resolveApiBase } from "@/lib/apiBase";
import { safeClientErrorMessage } from "@/lib/safe-error";
import { resetOnboardingForFreshStart } from "@/lib/useOnboarding";
import { SHOWCASE } from "@/lib/showcase/router";

const REFRESH_INTERVAL_MS = 5000;
const RECENT_LIMIT = 8;

export function AgentActionsInbox() {
  return SHOWCASE ? null : <Inbox />;
}

function Inbox() {
  const { mutate } = useSWRConfig();
  const [items, setItems] = useState<AgentActionRecord[]>([]);
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setItems((await agentActionsApi.list()).items);
    } catch {
      // Backend not up yet; the next tick retries.
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_INTERVAL_MS);
    const openInbox = () => {
      setOpen(true);
      void load();
    };
    window.addEventListener("offeru-open-agent-actions", openInbox);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("offeru-open-agent-actions", openInbox);
    };
  }, [load]);

  const pending = items.filter((item) => item.status === "pending");
  const recent = items.filter((item) => item.status !== "pending").slice(0, RECENT_LIMIT);

  const decide = async (item: AgentActionRecord, decision: "confirm" | "reject" | "undo") => {
    setBusyId(item.id);
    setError("");
    try {
      if (decision === "undo") {
        const preview = await agentActionsApi.undoPreview(item.id);
        if (preview.changed_after && !window.confirm(preview.message)) return;
      }
      const result = decision === "undo"
        ? await agentActionsApi.undo(item.id)
        : await agentActionsApi.decide(item.id, decision);
      if (!result.ok) throw new Error(result.errors?.join("；") || result.result?.errors?.join("；") || "没能完成");
      if (decision === "confirm" && item.operation === "reset_local_business_data") resetOnboardingForFreshStart();
      await mutate((key) => typeof key === "string" && key.startsWith(resolveApiBase()));
    } catch (cause) {
      setError(safeClientErrorMessage(cause, "操作失败"));
    } finally {
      setBusyId("");
      void load();
    }
  };

  if (!open) {
    if (!pending.length) return null;
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 rounded-full bg-[var(--foreground)] px-4 py-2 text-[12px] font-semibold text-[var(--surface)] shadow-lg"
      >
        <ClipboardCheck size={14} />
        {pending.length} 项等你确认
      </button>
    );
  }

  return (
    <div data-testid="agent-actions-inbox" className="w-[360px] max-w-full rounded-[12px] border border-[var(--border)] bg-[var(--surface)] shadow-xl">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
        <p className="text-[13px] font-semibold text-[var(--foreground)]">Agent 的操作</p>
        <button type="button" aria-label="关闭" onClick={() => setOpen(false)}>
          <X size={14} />
        </button>
      </div>
      <div className="max-h-[60vh] space-y-3 overflow-y-auto px-4 py-3 text-[12px]">
        <section>
          <p className="mb-1.5 font-semibold text-[var(--foreground)]">等你确认</p>
          {pending.length === 0 && <p className="text-[var(--foreground-muted)]">没有要确认的操作。</p>}
          {pending.map((item) => (
            <div key={item.id} className="mb-2 rounded-[8px] border border-[var(--border)] p-2.5">
              <p className="text-[var(--foreground)]">{item.summary || item.operation}</p>
              <p className="mt-0.5 text-[11px] text-[var(--foreground-muted)]">这一步不能撤销，确认后才会执行。</p>
              <div className="mt-2 flex gap-1.5">
                <button
                  type="button"
                  disabled={Boolean(busyId)}
                  onClick={() => void decide(item, "confirm")}
                  className="bauhaus-button bauhaus-button-red !min-h-7 !flex-1 !justify-center !py-1 !text-[11px]"
                >
                  {busyId === item.id ? <Loader2 size={12} className="animate-spin" /> : "确认执行"}
                </button>
                <button
                  type="button"
                  disabled={Boolean(busyId)}
                  onClick={() => void decide(item, "reject")}
                  className="bauhaus-button bauhaus-button-outline !min-h-7 !flex-1 !justify-center !py-1 !text-[11px]"
                >
                  不做
                </button>
              </div>
            </div>
          ))}
        </section>
        {recent.length > 0 && (
          <section>
            <p className="mb-1.5 font-semibold text-[var(--foreground)]">最近的改动</p>
            {recent.map((item) => (
              <div key={item.id} className="flex items-center gap-2 py-1">
                <span className="min-w-0 flex-1 truncate text-[var(--foreground-soft)]">{item.summary || item.operation}</span>
                {item.undoable ? (
                  <button
                    type="button"
                    disabled={Boolean(busyId)}
                    onClick={() => void decide(item, "undo")}
                    className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--primary-blue)]"
                  >
                    <Undo2 size={11} />
                    撤销
                  </button>
                ) : (
                  <span className="shrink-0 text-[11px] text-[var(--foreground-muted)]">{STATUS_LABELS[item.status] || item.status}</span>
                )}
              </div>
            ))}
          </section>
        )}
        {error && <p role="alert" className="text-[var(--primary-red)]">{error}</p>}
      </div>
    </div>
  );
}

const STATUS_LABELS: Record<string, string> = {
  done: "已完成",
  undone: "已撤销",
  rejected: "没做",
  failed: "失败",
};
