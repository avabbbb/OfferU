"use client";

// =============================================
// RunReviewPanel — 会话内联的 Proposal v2 协作区
// 对当前活跃 Run：waiting_decision 渲染 Plan Review 分组卡片；
// waiting_input 渲染内置 Ask 卡片。决定/回答后回调父级，
// 由父级沿同一 Run 的事件游标继续展示进度。
// =============================================

import { useCallback, useEffect, useRef, useState } from "react";
import { agentRuntimeApi } from "@/lib/api";
import {
  groupDecisionBody,
  normalizeDecisionPlan,
  type AgentInputAnswerResult,
  type DecisionGroupDecisionResult,
  type DecisionGroupView,
  type DecisionPlanView as DecisionPlanData,
} from "@/lib/decisionPlans";
import { safeClientErrorMessage } from "@/lib/safe-error";
import { AgentAskPanel } from "./AgentAskPanel";
import { DecisionPlanView } from "./DecisionPlanView";

const REFRESH_INTERVAL_MS = 4000;

export interface RunReviewPanelProps {
  runId: string;
  /** 分组决定或 Ask 回答落地后回调（含后端返回的 plan/run/continuation）。 */
  onChanged?: (result: DecisionGroupDecisionResult | AgentInputAnswerResult) => void;
  /** 用户提交“调整意见”的拒绝：把反馈意见转交父级（通常预填进输入框）。 */
  onAdjust?: (groupTitle: string, feedback: string) => void;
  /** 待处理项（待定分组 + 待答 Ask）数量变化；用于锁定对话输入。 */
  onPendingChange?: (pending: number) => void;
}

export function RunReviewPanel({ runId, onChanged, onAdjust, onPendingChange }: RunReviewPanelProps) {
  const [plan, setPlan] = useState<DecisionPlanData | null>(null);
  const [askPending, setAskPending] = useState(0);
  const [busyGroupId, setBusyGroupId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const loadingRef = useRef(false);
  const mountedRef = useRef(false);
  const onPendingChangeRef = useRef(onPendingChange);
  onPendingChangeRef.current = onPendingChange;

  const pendingGroups = plan?.groups.filter((group) => group.status === "pending").length ?? 0;

  useEffect(() => {
    onPendingChangeRef.current?.(pendingGroups + askPending);
  }, [pendingGroups, askPending]);

  const load = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const result = await agentRuntimeApi.decisionPlan(runId);
      if (!mountedRef.current) return;
      setPlan(result.plan ? normalizeDecisionPlan(result.plan) : null);
      setError("");
    } catch (err) {
      if (mountedRef.current) setError(safeClientErrorMessage(err, "变更计划暂时无法读取"));
    } finally {
      loadingRef.current = false;
    }
  }, [runId]);

  useEffect(() => {
    mountedRef.current = true;
    setPlan(null);
    setNotice("");
    setError("");
    void load();
    const refresh = () => {
      if (document.visibilityState !== "hidden") void load();
    };
    const timer = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load]);

  const decide = async (
    group: DecisionGroupView,
    decision: "approve" | "reject",
    feedback?: string,
  ) => {
    if (!plan || busyGroupId) return;
    const decidedPlan = plan;
    setBusyGroupId(group.group_id);
    setError("");
    setNotice("");
    try {
      const result = await agentRuntimeApi.decideDecisionGroup(
        decidedPlan.run_id,
        group.group_id,
        groupDecisionBody(decidedPlan, group, decision),
      );
      if (result.ok === false || result.errors?.length) {
        throw new Error(result.errors?.join("；") || "分组决定未能保存");
      }
      if (result.plan) setPlan(normalizeDecisionPlan(result.plan));
      else void load();
      setNotice(
        decision === "reject"
          ? `已拒绝“${group.title}”；该分组及其依赖后续分组不会执行。`
          : `已批准“${group.title}”；OfferU 正在通过 Operation Registry 执行。`,
      );
      if (feedback) onAdjust?.(group.title, feedback);
      onChanged?.(result);
    } catch (err) {
      setError(
        safeClientErrorMessage(err, decision === "approve" ? "批准分组失败" : "拒绝分组失败"),
      );
    } finally {
      setBusyGroupId(null);
    }
  };

  const visible = Boolean(plan) || askPending > 0 || Boolean(error) || Boolean(notice);

  return (
    <div
      className="space-y-2 border-t border-[var(--border)] bg-[var(--status-blush)]/40 px-3 py-2.5"
      hidden={!visible}
    >
      {error && (
        <p role="alert" className="rounded-md border border-[var(--status-blush)] bg-[var(--status-blush)]/50 px-2 py-1 text-[11px] leading-4 text-[var(--primary-red)]">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[11px] leading-4 text-[var(--foreground-soft)]">
          {notice}
        </p>
      )}
      {plan && (
        <>
          <p className="text-[11px] font-semibold text-[var(--foreground)]">审阅变更计划</p>
          <DecisionPlanView
            plan={plan}
            decidingGroupId={busyGroupId}
            onDecide={(group, decision) => void decide(group, decision)}
            onAdjust={(group, feedback) => void decide(group, "reject", feedback)}
          />
        </>
      )}
      <AgentAskPanel
        runId={runId}
        onPendingChange={setAskPending}
        onAnswered={(result) => {
          setNotice("已提交回答；OfferU 正在继续当前任务。");
          onChanged?.(result);
        }}
      />
    </div>
  );
}
