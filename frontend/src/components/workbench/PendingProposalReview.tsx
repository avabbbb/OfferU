"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, ClipboardCheck, Loader2, RefreshCw, X } from "lucide-react";
import {
  bridgeProposalApi,
  type AgentPendingProposal,
  type AgentPendingProposalAction,
} from "@/lib/api";
import { safeClientErrorMessage } from "@/lib/safe-error";

const REFRESH_INTERVAL_MS = 5000;

export function PendingProposalReview() {
  const [items, setItems] = useState<AgentPendingProposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyActionId, setBusyActionId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [open, setOpen] = useState(false);

  const pendingActionCount = useMemo(
    () => items.reduce((total, item) => total + item.steps.length, 0),
    [items],
  );

  const loadPending = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const result = await bridgeProposalApi.listPending();
      setItems(result.items || []);
      setError("");
    } catch (err) {
      setError(safeClientErrorMessage(err, "待确认请求暂时无法读取"));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPending();
    const timer = window.setInterval(() => void loadPending(true), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [loadPending]);

  const decide = async (
    proposal: AgentPendingProposal,
    action: AgentPendingProposalAction,
    approve: boolean,
  ) => {
    if (busyActionId) return;
    const actionKey = `${proposal.runId}:${action.actionId}`;
    setBusyActionId(actionKey);
    setError("");
    setNotice("");
    try {
      const result = await bridgeProposalApi.decide(
        proposal.runId,
        action.actionId,
        approve,
      );
      if (result.approved !== approve || result.errors?.length) {
        throw new Error(result.errors?.join("；") || "该动作的决定未能保存");
      }

      setItems((current) => current.flatMap((item) => {
        if (item.runId !== proposal.runId) return [item];
        const remainingSteps = item.steps.filter((step) => step.actionId !== action.actionId);
        return remainingSteps.length ? [{ ...item, steps: remainingSteps }] : [];
      }));
      setNotice(
        approve
          ? `已批准“${action.summary || action.operation}”；OfferU 已通过 Operation Registry 处理该动作。`
          : `已拒绝“${action.summary || action.operation}”；该动作不会执行。`,
      );
      await loadPending(true);
    } catch (err) {
      setError(safeClientErrorMessage(err, approve ? "批准动作失败" : "拒绝动作失败"));
    } finally {
      setBusyActionId(null);
    }
  };

  if (pendingActionCount === 0 && !error && !open) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] max-w-[calc(100vw-2rem)]">
      <div className="pointer-events-auto flex flex-col items-end gap-2">
        {(pendingActionCount > 0 || error) && (
          <button
            type="button"
            aria-controls="offeru-pending-proposals"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            className={`inline-flex min-h-10 items-center gap-2 rounded-full border px-4 py-2 text-[12px] font-semibold shadow-lg transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${
              error
                ? "border-[var(--status-blush)] bg-[var(--surface)] text-[var(--primary-red)]"
                : "border-[var(--border-strong)] bg-[var(--foreground)] text-[var(--background)]"
            }`}
          >
            {error ? <AlertCircle size={14} /> : <ClipboardCheck size={14} />}
            {error ? "待确认状态未同步" : `待你确认 ${pendingActionCount} 项`}
          </button>
        )}

        {open && (
          <section
            id="offeru-pending-proposals"
            aria-label="外部 Agent 待确认请求"
            className="max-h-[min(78vh,720px)] w-[min(440px,calc(100vw-2rem))] overflow-hidden rounded-xl border border-[var(--border-strong)] bg-[var(--background)] shadow-[0_16px_48px_var(--shadow-medium)]"
          >
            <header className="flex items-start justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
              <div>
                <h2 className="text-[13px] font-semibold text-[var(--foreground)]">待你确认的 Agent 动作</h2>
                <p className="mt-1 text-[11px] leading-4 text-[var(--foreground-muted)]">
                  每次只处理所选动作。批准后由 Operation Registry 执行；拒绝后不会执行。
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  aria-label="刷新待确认请求"
                  onClick={() => void loadPending()}
                  disabled={loading}
                  className="rounded-md p-1.5 text-[var(--foreground-muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)] disabled:opacity-50"
                >
                  {loading
                    ? <Loader2 size={14} className="animate-spin" />
                    : <RefreshCw size={14} />}
                </button>
                <button
                  type="button"
                  aria-label="关闭待确认请求"
                  onClick={() => setOpen(false)}
                  className="rounded-md p-1.5 text-[var(--foreground-muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]"
                >
                  <X size={14} />
                </button>
              </div>
            </header>

            <div className="custom-scrollbar max-h-[calc(min(78vh,720px)-68px)] space-y-3 overflow-y-auto p-3">
              {error && (
                <div role="alert" className="rounded-lg border border-[var(--status-blush)] bg-[var(--status-blush)]/50 px-3 py-2 text-[11.5px] leading-5 text-[var(--primary-red)]">
                  {error}
                </div>
              )}
              {notice && (
                <div role="status" className="flex items-start gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-[11.5px] leading-5 text-[var(--foreground-soft)]">
                  <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-[var(--primary-green)]" />
                  <span>{notice}</span>
                </div>
              )}
              {items.length === 0 && !error && (
                <p className="rounded-lg border border-dashed border-[var(--border)] px-3 py-4 text-center text-[12px] text-[var(--foreground-muted)]">
                  {loading ? "正在读取待确认请求…" : "目前没有待确认动作。"}
                </p>
              )}

              {items.map((proposal) => (
                <article key={proposal.runId} className="space-y-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
                  <div>
                    <p className="text-[12px] font-semibold leading-5 text-[var(--foreground)]">
                      {proposal.goal || "外部 Agent 请求执行一项操作"}
                    </p>
                    <p className="mt-0.5 break-all font-mono text-[9.5px] text-[var(--foreground-muted)]">
                      Run {proposal.runId}
                    </p>
                  </div>

                  {proposal.steps.map((action) => {
                    const actionKey = `${proposal.runId}:${action.actionId}`;
                    const actionBusy = busyActionId === actionKey;
                    return (
                      <div key={action.actionId} className="rounded-md border border-[var(--border)] bg-[var(--background)] p-2.5">
                        <p className="text-[11px] font-semibold text-[var(--foreground)]">
                          {action.summary || action.operation}
                        </p>
                        <p className="mt-1 text-[10px] text-[var(--foreground-muted)]">
                          Operation: <code>{action.operation}</code>
                        </p>
                        <details className="mt-2">
                          <summary className="cursor-pointer text-[10.5px] font-medium text-[var(--foreground-soft)]">
                            查看脱敏后的执行参数
                          </summary>
                          <pre className="custom-scrollbar mt-1 max-h-28 overflow-auto rounded bg-[var(--surface-muted)] p-2 text-[9.5px] leading-4 text-[var(--foreground-soft)]">
                            {JSON.stringify(action.args || {}, null, 2)}
                          </pre>
                        </details>
                        <div className="mt-2 flex justify-end gap-1.5">
                          <button
                            type="button"
                            aria-label={`拒绝：${action.operation}`}
                            onClick={() => void decide(proposal, action, false)}
                            disabled={Boolean(busyActionId)}
                            className="bauhaus-button bauhaus-button-outline !min-h-8 !justify-center !px-3 !py-1 !text-[11px] disabled:opacity-50"
                          >
                            {actionBusy ? <Loader2 size={12} className="animate-spin" /> : null}
                            拒绝
                          </button>
                          <button
                            type="button"
                            aria-label={`批准：${action.operation}`}
                            onClick={() => void decide(proposal, action, true)}
                            disabled={Boolean(busyActionId)}
                            className="bauhaus-button bauhaus-button-red !min-h-8 !justify-center !px-3 !py-1 !text-[11px] disabled:opacity-50"
                          >
                            {actionBusy ? <Loader2 size={12} className="animate-spin" /> : null}
                            执行此动作
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </article>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
