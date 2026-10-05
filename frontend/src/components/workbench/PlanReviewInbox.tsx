"use client";

// =============================================
// Plan Review 收件箱（Proposal v2）
// 轮询 GET /api/agent/runtime/decision-plans/pending，按语义分组审阅。
// 批准/拒绝只走桌面 Tauri 命令（携带审批能力），浏览器无法批准。
// 与旧版 PendingProposalReview 并存：旧组件只在仍有遗留步骤提案时显示。
// =============================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ClipboardCheck, Loader2, RefreshCw, X } from "lucide-react";
import { agentRuntimeApi } from "@/lib/api";
import {
  groupDecisionBody,
  normalizeDecisionPlan,
  type DecisionGroupView,
  type DecisionPlanView as DecisionPlanData,
} from "@/lib/decisionPlans";
import { safeClientErrorMessage } from "@/lib/safe-error";
import { DecisionPlanView, describeDecisionOutcome } from "./DecisionPlanView";

const REFRESH_INTERVAL_MS = 5000;

export function PlanReviewInbox() {
  const [plans, setPlans] = useState<DecisionPlanData[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyGroupId, setBusyGroupId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [open, setOpen] = useState(false);
  const loadingRef = useRef(false);
  const mountedRef = useRef(false);

  const pendingCount = useMemo(
    () =>
      plans.reduce(
        (total, plan) => total + plan.groups.filter((group) => group.status === "pending").length,
        0,
      ),
    [plans],
  );

  const loadPlans = useCallback(async (quiet = false) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    if (!quiet) setLoading(true);
    try {
      const result = await agentRuntimeApi.decisionPlansPending();
      if (mountedRef.current) {
        setPlans((result.plans || []).map(normalizeDecisionPlan));
        setError("");
      }
    } catch (err) {
      if (mountedRef.current) setError(safeClientErrorMessage(err, "待审阅计划暂时无法读取"));
    } finally {
      loadingRef.current = false;
      if (!quiet && mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void loadPlans();
    const refresh = () => {
      if (document.visibilityState !== "hidden") void loadPlans(true);
    };
    const timer = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [loadPlans]);

  const decide = async (
    plan: DecisionPlanData,
    group: DecisionGroupView,
    decision: "approve" | "reject",
    feedback?: string,
  ) => {
    if (busyGroupId) return;
    setBusyGroupId(group.group_id);
    setError("");
    setNotice("");
    try {
      const result = await agentRuntimeApi.decideDecisionGroup(
        plan.run_id,
        group.group_id,
        groupDecisionBody(plan, group, decision),
      );
      if (result.ok === false || result.errors?.length) {
        throw new Error(result.errors?.join("；") || "分组决定未能保存");
      }
      setPlans((current) =>
        current.map((item) => (item.plan_id === plan.plan_id && result.plan ? normalizeDecisionPlan(result.plan) : item)),
      );
      setNotice(
        describeDecisionOutcome(group.title, decision, result.receipts)
        + (feedback ? "调整意见已随拒绝记录。" : ""),
      );
      await loadPlans(true);
    } catch (err) {
      setError(
        safeClientErrorMessage(err, decision === "approve" ? "批准分组失败" : "拒绝分组失败"),
      );
    } finally {
      setBusyGroupId(null);
    }
  };

  if (plans.length === 0 && !error && !open) return null;

  return (
    <div className="pointer-events-auto flex flex-col items-end gap-2">
      {(plans.length > 0 || error) && (
        <button
          type="button"
          aria-controls="offeru-plan-review"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className={`inline-flex min-h-10 items-center gap-2 rounded-full border px-4 py-2 text-[12px] font-semibold shadow-lg transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${
            error
              ? "border-[var(--status-blush)] bg-[var(--surface)] text-[var(--primary-red)]"
              : "border-[var(--border-strong)] bg-[var(--foreground)] text-[var(--background)]"
          }`}
        >
          {error ? <AlertCircle size={14} /> : <ClipboardCheck size={14} />}
          {error ? "计划审阅未同步" : pendingCount ? `待审阅计划 · ${pendingCount} 项待决定` : `${plans.length} 个计划进行中`}
        </button>
      )}

      {open && (
        <section
          id="offeru-plan-review"
          aria-label="Agent 变更计划审阅"
          className="max-h-[min(78vh,720px)] w-[min(460px,calc(100vw-2rem))] overflow-hidden rounded-xl border border-[var(--border-strong)] bg-[var(--background)] shadow-[0_16px_48px_var(--shadow-medium)]"
        >
          <header className="flex items-start justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
            <div>
              <h2 className="text-[13px] font-semibold text-[var(--foreground)]">审阅 Agent 变更计划</h2>
              <p className="mt-1 text-[11px] leading-4 text-[var(--foreground-muted)]">
                以语义分组决定；批准后由 Operation Registry 逐个执行并记录回执。
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                aria-label="刷新待审阅计划"
                onClick={() => void loadPlans()}
                disabled={loading}
                className="rounded-md p-1.5 text-[var(--foreground-muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)] disabled:opacity-50"
              >
                {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              </button>
              <button
                type="button"
                aria-label="关闭计划审阅"
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
              <div role="status" className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-[11.5px] leading-5 text-[var(--foreground-soft)]">
                {notice}
              </div>
            )}
            {plans.length === 0 && !error && (
              <p className="rounded-lg border border-dashed border-[var(--border)] px-3 py-4 text-center text-[12px] text-[var(--foreground-muted)]">
                {loading ? "正在读取待审阅计划…" : "目前没有待审阅计划。"}
              </p>
            )}
            {plans.map((plan) => (
              <DecisionPlanView
                key={plan.plan_id}
                plan={plan}
                showRunMeta
                decidingGroupId={busyGroupId}
                onDecide={(group, decision) => void decide(plan, group, decision)}
                onAdjust={(group, feedback) => void decide(plan, group, "reject", feedback)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
