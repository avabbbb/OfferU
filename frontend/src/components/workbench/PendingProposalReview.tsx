"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, ClipboardCheck, Loader2, RefreshCw, X } from "lucide-react";
import {
  agentPlansApi,
  bridgeProposalApi,
  type AgentConfirmationGroup,
  type AgentPendingProposal,
  type AgentPendingProposalAction,
  type AgentPlanContinuation,
  type AgentPlanNode,
  type AgentPlanReceipt,
  type AgentProposalPlan,
} from "@/lib/api";
import { safeClientErrorMessage } from "@/lib/safe-error";
import { resetOnboardingForFreshStart } from "@/lib/useOnboarding";
import { resolveApiBase } from "@/lib/apiBase";
import { useSWRConfig } from "swr";

const REFRESH_INTERVAL_MS = 5000;
const TERMINAL_PLAN_STATES = new Set(["completed", "rejected", "replaced"]);
const PLAN_STATUS_LABELS: Record<string, string> = {
  sealed: "待审核",
  executing: "执行中",
  paused: "已暂停",
  completed: "已完成",
  rejected: "已拒绝",
  blocked: "受阻",
  needs_reconciliation: "需要核对执行结果",
  replaced: "已被新计划替代",
};
const GROUP_STATUS_LABELS: Record<string, string> = {
  pending: "待审核",
  approved: "已批准",
  executing: "执行中",
  paused: "已暂停",
  completed: "已完成",
  rejected: "已拒绝",
  blocked: "受阻",
  needs_reconciliation: "需要核对执行结果",
  stale: "内容已变化，请重新审核",
  replaced: "已被新组替代",
};
const NODE_STATUS_LABELS: Record<string, string> = {
  pending: "待执行",
  executing: "执行中",
  completed: "已完成",
  failed: "执行失败",
  rejected: "已拒绝",
  replaced: "已被替代",
  blocked: "受阻",
  uncertain: "结果不确定",
};

function statusLabel(status: string, labels: Record<string, string>) {
  return labels[status] || status.replaceAll("_", " ");
}

function affectedEntityLabel(entity: unknown): string | null {
  const labels: Record<string, string> = {
    resume: "简历",
    resume_section: "简历模块",
    target_role: "目标岗位",
    resume_proposal: "简历提案",
    job: "岗位",
    profile: "档案",
    application: "申请",
    interview: "面试",
  };
  if (typeof entity === "string") {
    const value = entity.trim();
    const match = value.match(/^(resume|job|profile|application|interview)(?:\s*[:#_-]?\s*)(.*)$/i);
    if (match) return `${labels[match[1].toLowerCase()]}${match[2] ? ` ${match[2]}` : ""}`;
    return value || null;
  }
  if (!entity || typeof entity !== "object") return null;
  const value = entity as Record<string, unknown>;
  const kind = String(value.kind || "").toLowerCase();
  const label = labels[kind];
  const title = String(value.title || value.name || "").trim();
  const id = typeof value.id === "string" || typeof value.id === "number" ? String(value.id) : "";
  if (label && title) return `${label}${id ? ` ${id}` : ""} · ${title}`;
  if (label && id) return `${label} ${id}`;
  if (label) return label;
  if (title) return title;
  return id ? `记录 ${id}` : null;
}

function groupRiskLabel(risk?: string) {
  const value = String(risk || "").toLowerCase();
  if (/(external|submit|send|contact|l3)/.test(value)) return "外部动作";
  if (/(prepare|draft|l1)/.test(value)) return "准备";
  return "需要审核";
}

function planNeedsReview(plan: AgentProposalPlan) {
  return !TERMINAL_PLAN_STATES.has(plan.status);
}

function displayedGroupStatus(plan: AgentProposalPlan, group: AgentConfirmationGroup) {
  if (group.status !== "pending") return group.status;
  if (plan.status === "replaced") return "replaced";
  if (["completed", "rejected", "blocked", "paused", "needs_reconciliation"].includes(plan.status)) return plan.status;
  return group.status;
}

function requestRunReviewRefresh(runId: string) {
  // Read-only invalidation signal: the recipient must GET the same Run again.
  // It carries no decision, digest, authorization or receipt data.
  window.dispatchEvent(new CustomEvent("offeru-run-review-refresh", { detail: { run_id: runId } }));
}

function groupHasReviewableDiff(group: AgentConfirmationGroup) {
  return group.nodes.length > 0 && group.nodes.every((node) => {
    const display = node.display;
    return Boolean(display && (
      (Array.isArray(display.changes) && display.changes.length > 0)
      || (Object.prototype.hasOwnProperty.call(display, "before")
        && Object.prototype.hasOwnProperty.call(display, "after"))
    ));
  });
}

function validDecisionTarget(plan: AgentProposalPlan, group: AgentConfirmationGroup) {
  return /^plan_[0-9a-f]{32}$/.test(plan.id)
    && /^group_[0-9a-f]{32}$/.test(group.id)
    && /^[0-9a-f]{64}$/.test(plan.digest)
    && /^[0-9a-f]{64}$/.test(group.digest);
}

function fieldLabel(value: string) {
  const known: Record<string, string> = {
    company: "公司",
    content: "内容",
    content_json: "内容",
    description: "描述",
    visible: "显示",
    sort_order: "顺序",
    role_name: "目标岗位",
    role_level: "级别",
    fit: "定位",
    location: "地点",
    role: "岗位",
    section: "简历部分",
    summary: "摘要",
    text: "文本",
    title: "标题",
    value: "内容",
  };
  return known[value] || value.replaceAll("_", " ");
}

function ReviewValue({ value }: { value: unknown }): JSX.Element {
  if (value === null || value === undefined || value === "") {
    return <span className="text-[var(--foreground-muted)]">（空）</span>;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return <span className="whitespace-pre-wrap break-words">{String(value)}</span>;
  }
  if (Array.isArray(value)) {
    return value.length ? (
      <ul className="list-disc space-y-1 pl-4">
        {value.map((item, index) => <li key={index}><ReviewValue value={item} /></li>)}
      </ul>
    ) : <span className="text-[var(--foreground-muted)]">（空）</span>;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.length ? (
      <dl className="space-y-1.5">
        {entries.map(([key, entry]) => (
          <div key={key} className="grid grid-cols-[minmax(4rem,auto)_1fr] gap-2">
            <dt className="font-medium text-[var(--foreground-muted)]">{fieldLabel(key)}</dt>
            <dd className="min-w-0"><ReviewValue value={entry} /></dd>
          </div>
        ))}
      </dl>
    ) : <span className="text-[var(--foreground-muted)]">（空）</span>;
  }
  return <span className="text-[var(--foreground-muted)]">未提供</span>;
}

function ChangeView({
  before,
  after,
  evidence,
  rationale,
  title,
}: {
  before: unknown;
  after: unknown;
  evidence?: unknown;
  rationale?: unknown;
  title?: string;
}) {
  return (
    <div className="space-y-2 rounded-md border border-[var(--border)] bg-[var(--background)] p-2.5">
      {title && <p className="text-[11px] font-semibold text-[var(--foreground)]">{title}</p>}
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="min-w-0 rounded bg-[var(--surface-muted)] p-2">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--foreground-muted)]">修改前</p>
          <div className="text-[11px] leading-5 text-[var(--foreground-soft)]"><ReviewValue value={before} /></div>
        </div>
        <div className="min-w-0 rounded border border-[var(--primary-green)]/30 bg-[var(--surface-muted)] p-2">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--primary-green)]">修改后</p>
          <div className="text-[11px] leading-5 text-[var(--foreground)]"><ReviewValue value={after} /></div>
        </div>
      </div>
      {evidence !== undefined && evidence !== null && (
        <div className="text-[10.5px] leading-5 text-[var(--foreground-soft)]">
          <span className="font-semibold text-[var(--foreground)]">证据：</span><ReviewValue value={evidence} />
        </div>
      )}
      {rationale !== undefined && rationale !== null && rationale !== "" && (
        <p className="text-[10.5px] leading-5 text-[var(--foreground-soft)]">
          <span className="font-semibold text-[var(--foreground)]">理由：</span><ReviewValue value={rationale} />
        </p>
      )}
    </div>
  );
}

function nodeReceipts(node: AgentPlanNode, responseReceipts: AgentPlanReceipt[] = []) {
  const known = [...(node.receipts || []), ...(node.receipt ? [node.receipt] : [])];
  const receipts = known.length ? known : responseReceipts.filter((receipt) => receipt.node_id === node.id);
  return receipts.filter((receipt, index) => receipts.findIndex((item) => item.id === receipt.id) === index);
}

function receiptLabel(receipt: AgentPlanReceipt) {
  const effect = receipt.effect_state ? ` · ${statusLabel(receipt.effect_state, {
    no_effect: "无副作用",
    committed: "已提交",
    partial: "部分完成",
    unknown: "副作用未知",
  })}` : "";
  return `${statusLabel(receipt.status, NODE_STATUS_LABELS)}${effect}`;
}

function continuationLabel(continuation: AgentPlanContinuation) {
  if (continuation.receiver === "ui_result_projection") {
    return statusLabel(continuation.status, {
      pending: "等待将结果存回原任务",
      delivering: "正在将结果存回原任务",
      delivered: "结果已存回原任务（未自动恢复 Agent 推理）",
      failed: "原任务回执投影失败，可重试",
    });
  }
  return statusLabel(continuation.status, {
    pending: "回执待处理",
    delivering: "正在保存回执",
    delivered: "回执已保存（接收方式未提供）",
    failed: "回执保存失败，可重试",
  });
}

function OperationDetails({ renderDetails }: { renderDetails: () => JSX.Element }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)} className="rounded border border-[var(--border)] bg-[var(--background)] px-2.5 py-2">
      <summary className="cursor-pointer text-[10px] font-medium text-[var(--foreground-soft)]">操作细节</summary>
      {open ? renderDetails() : null}
    </details>
  );
}

export function PendingProposalReview() {
  const { mutate } = useSWRConfig();
  const [plans, setPlans] = useState<AgentProposalPlan[]>([]);
  const [selectedPlan, setSelectedPlan] = useState<AgentProposalPlan | null>(null);
  const [planListReady, setPlanListReady] = useState(false);
  const [planLoading, setPlanLoading] = useState(true);
  const [planError, setPlanError] = useState("");
  const [items, setItems] = useState<AgentPendingProposal[]>([]);
  const [unavailable, setUnavailable] = useState<Array<AgentPendingProposal & { reason: string }>>([]);
  const [legacyLoading, setLegacyLoading] = useState(true);
  const [legacyError, setLegacyError] = useState("");
  const [busyDecisionId, setBusyDecisionId] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [busyActionId, setBusyActionId] = useState<string | null>(null);
  const [decisionResults, setDecisionResults] = useState<Record<string, {
    receipts: AgentPlanReceipt[];
    continuation?: AgentPlanContinuation | null;
    runStatus?: string;
  }>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [open, setOpen] = useState(false);
  const [legacyOpen, setLegacyOpen] = useState(false);
  const loadingPlans = useRef(false);
  const loadingPending = useRef(false);
  const mounted = useRef(false);
  const selectedPlanId = useRef<string | null>(null);
  const planSelectionVersion = useRef(0);
  const autoOpenedPlanId = useRef<string | null>(null);

  const pendingGroups = useMemo(
    () => plans.flatMap((plan) => planNeedsReview(plan) ? (plan.groups || []).filter((group) => group.status === "pending") : []),
    [plans],
  );
  const matchedPlanRunIds = useMemo(() => new Set(plans.map((plan) => plan.run_id)), [plans]);
  const legacyItems = useMemo(
    () => planListReady ? items.filter((item) => !matchedPlanRunIds.has(item.runId)) : [],
    [items, matchedPlanRunIds, planListReady],
  );
  const compatibilityItems = useMemo(
    () => planListReady ? items.filter((item) => matchedPlanRunIds.has(item.runId)) : [],
    [items, matchedPlanRunIds, planListReady],
  );
  const pendingActionCount = useMemo(
    () => legacyItems.reduce((total, item) => total + item.steps.length, 0),
    [legacyItems],
  );

  const loadPlans = useCallback(async (quiet = false) => {
    if (loadingPlans.current) return;
    const selectionVersion = planSelectionVersion.current;
    loadingPlans.current = true;
    if (!quiet) setPlanLoading(true);
    try {
      const result = await agentPlansApi.list();
      if (!mounted.current || selectionVersion !== planSelectionVersion.current) return;
      const nextPlans = result.items || [];
      const requestedPlan = selectedPlanId.current
        ? nextPlans.find((plan) => plan.id === selectedPlanId.current)
        : undefined;
      const target = requestedPlan || nextPlans.find(planNeedsReview) || nextPlans[0];
      if (!mounted.current) return;
      setPlans(nextPlans);
      setPlanListReady(true);
      setPlanError("");
      if (!target) {
        selectedPlanId.current = null;
        setSelectedPlan(null);
        return;
      }
      selectedPlanId.current = target.id;
      try {
        const detail = await agentPlansApi.get(target.id);
        if (!mounted.current || selectionVersion !== planSelectionVersion.current) return;
        setSelectedPlan(detail);
        if (autoOpenedPlanId.current !== detail.id && !TERMINAL_PLAN_STATES.has(detail.status)) {
          setOpen(true);
          autoOpenedPlanId.current = detail.id;
        }
      } catch (detailError) {
        if (mounted.current && selectionVersion === planSelectionVersion.current) {
          setSelectedPlan(target);
          setPlanError(safeClientErrorMessage(detailError, "计划详情暂时无法读取"));
        }
      }
    } catch (err) {
      if (mounted.current && selectionVersion === planSelectionVersion.current) {
        setPlanListReady(false);
        setPlanError(safeClientErrorMessage(err, "新计划审批状态暂时无法读取"));
      }
    } finally {
      loadingPlans.current = false;
      if (!quiet && mounted.current && selectionVersion === planSelectionVersion.current) setPlanLoading(false);
    }
  }, []);

  const loadPending = useCallback(async (quiet = false) => {
    if (loadingPending.current) return;
    loadingPending.current = true;
    if (!quiet) setLegacyLoading(true);
    try {
      const result = await bridgeProposalApi.listPending();
      if (mounted.current) {
        setItems(result.items || []);
        setUnavailable(result.unavailable || []);
        setLegacyError("");
      }
    } catch (err) {
      if (mounted.current) setLegacyError(safeClientErrorMessage(err, "旧版兼容请求暂时无法读取"));
    } finally {
      loadingPending.current = false;
      if (!quiet && mounted.current) setLegacyLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void loadPlans();
    void loadPending();
    const refresh = () => {
      if (document.visibilityState !== "hidden") {
        void loadPlans(true);
        void loadPending(true);
      }
    };
    const timer = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [loadPending, loadPlans]);

  const selectPlan = useCallback(async (planId: string) => {
    const selectionVersion = ++planSelectionVersion.current;
    selectedPlanId.current = planId;
    autoOpenedPlanId.current = planId;
    setOpen(true);
    setPlanLoading(true);
    setPlanListReady(false);
    setPlanError("");
    try {
      const detail = await agentPlansApi.get(planId);
      if (mounted.current && selectionVersion === planSelectionVersion.current) {
        setSelectedPlan(detail);
        setPlanListReady(true);
        setPlans((current) => [detail, ...current.filter((plan) => plan.id !== detail.id)]);
      }
    } catch (err) {
      if (mounted.current && selectionVersion === planSelectionVersion.current) {
        setPlanError(safeClientErrorMessage(err, "计划详情暂时无法读取"));
      }
    } finally {
      if (mounted.current && selectionVersion === planSelectionVersion.current) setPlanLoading(false);
    }
  }, []);

  const openPlanReviewRequest = useCallback(async (request: { run_id?: string; plan_id?: string }) => {
    setOpen(true);
    if (request.plan_id) {
      await selectPlan(request.plan_id);
      return;
    }
    if (!request.run_id) return;
    const selectionVersion = ++planSelectionVersion.current;
    setPlanLoading(true);
    setPlanListReady(false);
    setPlanError("");
    try {
      const result = await agentPlansApi.list({ run_id: request.run_id });
      if (!mounted.current || selectionVersion !== planSelectionVersion.current) return;
      const runPlans = result.items || [];
      const target = runPlans.find(planNeedsReview) || runPlans[0];
      setPlans((current) => [
        ...runPlans,
        ...current.filter((plan) => !runPlans.some((item) => item.id === plan.id)),
      ]);
      setPlanListReady(true);
      if (!target) {
        setSelectedPlan(null);
        setPlanError("此 Run 当前没有可打开的计划。");
        return;
      }
      selectedPlanId.current = target.id;
      autoOpenedPlanId.current = target.id;
      const detail = await agentPlansApi.get(target.id);
      if (mounted.current && selectionVersion === planSelectionVersion.current) setSelectedPlan(detail);
    } catch (err) {
      if (mounted.current && selectionVersion === planSelectionVersion.current) {
        setPlanError(safeClientErrorMessage(err, "无法打开该 Run 的计划审核"));
      }
    } finally {
      if (mounted.current && selectionVersion === planSelectionVersion.current) setPlanLoading(false);
    }
  }, [selectPlan]);

  useEffect(() => {
    const handleOpenPlanReview = (event: Event) => {
      const detail = (event as CustomEvent<{ run_id?: string; plan_id?: string }>).detail || {};
      void openPlanReviewRequest(detail);
    };
    window.addEventListener("offeru-open-plan-review", handleOpenPlanReview);
    return () => window.removeEventListener("offeru-open-plan-review", handleOpenPlanReview);
  }, [openPlanReviewRequest]);

  useEffect(() => {
    const handleOpenPendingProposals = () => {
      setOpen(true);
      void loadPlans(true);
      void loadPending(true);
    };
    window.addEventListener("offeru-open-pending-proposals", handleOpenPendingProposals);
    return () => window.removeEventListener("offeru-open-pending-proposals", handleOpenPendingProposals);
  }, [loadPending, loadPlans]);

  const decideGroup = async (
    plan: AgentProposalPlan,
    group: AgentConfirmationGroup,
    approve: boolean,
  ) => {
    if (busyDecisionId || group.status !== "pending" || !["sealed", "executing"].includes(plan.status) || !validDecisionTarget(plan, group)) return;
    const decisionId = `decision_${crypto.randomUUID().replaceAll("-", "")}`;
    setBusyDecisionId(group.id);
    setError("");
    setNotice("");
    try {
      const result = await agentPlansApi.decideGroup(plan.id, group.id, {
        approve,
        plan_digest: plan.digest,
        group_digest: group.digest,
        decision_id: decisionId,
      });
      if (!result.ok || result.errors?.length) {
        throw new Error(result.errors?.join("；") || "该决策组的决定未能保存");
      }
      let resetNotice = "";
      const resetNode = group.nodes.length === 1 && group.nodes[0].operation === "reset_local_business_data"
        ? group.nodes[0] : null;
      if (approve && resetNode && result.receipts?.some((receipt) => receipt.node_id === resetNode.id
        && receipt.status === "completed" && receipt.effect_state === "committed")) {
        resetOnboardingForFreshStart();
        resetNotice = "职业工作区已全清，重置回执与备份保留。";
        try {
          await mutate((key) => typeof key === "string" && key.startsWith(resolveApiBase()));
        } catch {
          resetNotice += "部分页面缓存未能刷新，请重新打开。";
        }
      }
      setDecisionResults((current) => ({
        ...current,
        [group.id]: {
          receipts: result.receipts || [],
          continuation: result.continuation,
          runStatus: result.run_status,
        },
      }));
      setNotice(resetNotice || (approve
        ? `已批准“${group.title || group.summary}”整组改动，包含 ${group.nodes.length} 个 Operation。正在等待执行回执。`
        : `已拒绝“${group.title || group.summary}”整组改动；组内节点不会执行。`));
      if (result.successor_plan_id) {
        const successorId = result.successor_plan_id;
        planSelectionVersion.current += 1;
        selectedPlanId.current = successorId;
        autoOpenedPlanId.current = successorId;
        setOpen(true);
        setPlanError("");
        setNotice(`“${group.title || group.summary}”已采用。剩余未执行组已更新为新版本，请审核当前展示的改动。`);
        if (result.successor_plan?.id === successorId) {
          const successor = result.successor_plan;
          setPlans((current) => [successor, ...current.filter((item) => item.id !== successor.id)]);
          setSelectedPlan(successor);
          setPlanListReady(true);
          setPlanLoading(false);
        } else {
          setSelectedPlan(null);
          setPlanListReady(false);
          setPlanLoading(true);
          await selectPlan(successorId);
        }
      } else if (result.refresh_error) {
        setNotice(`“${group.title || group.summary}”已采用并保留结果。剩余组需要重新准备，当前内容不能沿用旧批准。`);
      }
      await loadPlans(true);
      await loadPending(true);
    } catch (err) {
      setError(safeClientErrorMessage(err, approve ? "批准整组改动失败" : "拒绝整组改动失败"));
      await loadPlans(true);
    } finally {
      setBusyDecisionId(null);
      requestRunReviewRefresh(plan.run_id);
    }
  };

  const decideLegacyAction = async (
    proposal: AgentPendingProposal,
    action: AgentPendingProposalAction,
    approve: boolean,
  ) => {
    if (busyActionId || !planListReady || matchedPlanRunIds.has(proposal.runId)) return;
    const actionKey = `${proposal.runId}:${action.actionId}`;
    setBusyActionId(actionKey);
    setError("");
    setNotice("");
    try {
      const result = await bridgeProposalApi.decide(proposal.runId, action.actionId, approve);
      if (result.approved !== approve || result.errors?.length) {
        throw new Error(result.errors?.join("；") || "该旧版兼容动作的决定未能保存");
      }
      setItems((current) => current.flatMap((item) => {
        if (item.runId !== proposal.runId) return [item];
        const remainingSteps = item.steps.filter((step) => step.actionId !== action.actionId);
        return remainingSteps.length ? [{ ...item, steps: remainingSteps }] : [];
      }));
      setNotice(approve
        ? `已批准旧版兼容动作“${action.summary || action.operation}”。`
        : `已拒绝旧版兼容动作“${action.summary || action.operation}”。`);
      await loadPending(true);
    } catch (err) {
      setError(safeClientErrorMessage(err, approve ? "批准旧版兼容动作失败" : "拒绝旧版兼容动作失败"));
    } finally {
      setBusyActionId(null);
      requestRunReviewRefresh(proposal.runId);
    }
  };

  const shouldShow = pendingGroups.length > 0 || plans.length > 0 || pendingActionCount > 0
    || compatibilityItems.length > 0 || unavailable.length > 0 || planError || legacyError || open;
  if (!shouldShow) return null;

  return (
    <div className="pointer-events-auto flex flex-col items-end gap-2">
      {(pendingGroups.length > 0 || pendingActionCount > 0 || unavailable.length > 0 || error || planError || legacyError || plans.length > 0) && (
        <button
          type="button"
          aria-controls="offeru-pending-proposals"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className={`inline-flex min-h-10 items-center gap-2 rounded-full border px-4 py-2 text-[12px] font-semibold shadow-lg transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${
            planError || legacyError || error
              ? "border-[var(--status-blush)] bg-[var(--surface)] text-[var(--primary-red)]"
              : "border-[var(--border-strong)] bg-[var(--foreground)] text-[var(--background)]"
          }`}
        >
          {planError || legacyError || error ? <AlertCircle size={14} /> : <ClipboardCheck size={14} />}
          {planError || legacyError || error
            ? "待审核状态未同步"
            : pendingGroups.length > 0
            ? `待你审核 ${pendingGroups.length} 个改动组`
            : pendingActionCount > 0 ? `旧版兼容请求 ${pendingActionCount} 项` : plans.length ? `计划记录 ${plans.length} 项` : "审批状态"}
        </button>
      )}

        {open && (
          <section
            id="offeru-pending-proposals"
            aria-label="Agent 计划审核"
            className="max-h-[min(82vh,760px)] w-[min(720px,calc(100vw-2rem))] overflow-hidden rounded-xl border border-[var(--border-strong)] bg-[var(--background)] shadow-[0_16px_48px_var(--shadow-medium)]"
          >
            <header className="flex items-start justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
              <div>
                <h2 className="text-[13px] font-semibold text-[var(--foreground)]">审核一组具体改动</h2>
                <p className="mt-1 text-[11px] leading-4 text-[var(--foreground-muted)]">
                  批准当前展示内容；执行结果会逐项记录。
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  aria-label="刷新计划审核状态"
                  onClick={() => { void loadPlans(); void loadPending(); }}
                  disabled={planLoading || legacyLoading}
                  className="rounded-md p-1.5 text-[var(--foreground-muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)] disabled:opacity-50"
                >
                  {planLoading || legacyLoading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                </button>
                <button
                  type="button"
                  aria-label="关闭计划审核"
                  onClick={() => setOpen(false)}
                  className="rounded-md p-1.5 text-[var(--foreground-muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]"
                >
                  <X size={14} />
                </button>
              </div>
            </header>

            <div className="custom-scrollbar max-h-[calc(min(82vh,760px)-68px)] space-y-3 overflow-y-auto p-3">
              {(planError || error) && (
                <div role="alert" className="rounded-lg border border-[var(--status-blush)] bg-[var(--status-blush)]/50 px-3 py-2 text-[11.5px] leading-5 text-[var(--primary-red)]">
                  {error || planError}
                </div>
              )}
              {legacyError && (
                <div role="alert" className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-[11px] leading-5 text-[var(--foreground-muted)]">
                  {legacyError}
                </div>
              )}
              {notice && (
                <div role="status" className="flex items-start gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-[11.5px] leading-5 text-[var(--foreground-soft)]">
                  <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-[var(--primary-green)]" />
                  <span>{notice}</span>
                </div>
              )}

              {!planListReady && (
                <p className="rounded-lg border border-dashed border-[var(--border)] px-3 py-3 text-center text-[11px] text-[var(--foreground-muted)]">
                  {planError ? "计划状态未同步，旧版批准入口已暂时关闭。" : "正在核对计划状态…"}
                </p>
              )}

              {plans.length > 1 && (
                <nav aria-label="计划记录" className="flex flex-wrap gap-1.5">
                  {plans.map((plan) => (
                    <button
                      key={plan.id}
                      type="button"
                      aria-pressed={selectedPlan?.id === plan.id}
                      onClick={() => void selectPlan(plan.id)}
                      disabled={planLoading || Boolean(busyDecisionId)}
                      className={`rounded-md border px-2.5 py-1.5 text-[10.5px] ${selectedPlan?.id === plan.id ? "border-[var(--primary-blue)] bg-[var(--primary-blue)]/10 text-[var(--foreground)]" : "border-[var(--border)] text-[var(--foreground-muted)]"}`}
                    >
                      {plan.title || plan.id.slice(0, 18)} · {statusLabel(plan.status, PLAN_STATUS_LABELS)}
                    </button>
                  ))}
                </nav>
              )}

              {!selectedPlan && planLoading && (
                <p role="status" className="rounded-md border border-dashed border-[var(--border)] px-3 py-3 text-center text-[11px] text-[var(--foreground-muted)]">
                  正在载入新版本的审核内容…
                </p>
              )}

              {selectedPlan && (
                <article className="space-y-3 rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] p-3">
                  <header className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="text-[12px] font-semibold leading-5 text-[var(--foreground)]">{selectedPlan.title || "Agent 准备的计划"}</h3>
                      <p className="mt-0.5 break-all text-[9.5px] text-[var(--foreground-muted)]">
                        {statusLabel(selectedPlan.status, PLAN_STATUS_LABELS)} · Run {selectedPlan.run_id}
                      </p>
                    </div>
                    <span className="rounded-full border border-[var(--border)] px-2 py-1 text-[9.5px] text-[var(--foreground-soft)]">
                      第 {selectedPlan.revision} 版
                    </span>
                  </header>

                  {(selectedPlan.groups || []).length === 0 && (
                    <p className="rounded-md border border-dashed border-[var(--border)] px-3 py-3 text-center text-[11px] text-[var(--foreground-muted)]">
                      {planLoading ? "正在读取计划详情…" : "此计划没有可展示的改动组。"}
                    </p>
                  )}

                  {(selectedPlan.groups || []).map((group) => {
                    const busy = busyDecisionId === group.id;
                    const targetValid = validDecisionTarget(selectedPlan, group);
                    const reviewable = groupHasReviewableDiff(group);
                    const groupStatus = displayedGroupStatus(selectedPlan, group);
                    const terminalGroup = ["completed", "rejected", "replaced"].includes(groupStatus);
                    const canDecideGroup = ["sealed", "executing"].includes(selectedPlan.status);
                    const canApprove = planListReady && !planError && !planLoading && canDecideGroup
                      && group.status === "pending" && targetValid && reviewable
                      && ["sealed", "executing"].includes(selectedPlan.status);
                    const canReject = planListReady && !planError && !planLoading && canDecideGroup
                      && group.status === "pending" && targetValid;
                    const feedback = decisionResults[group.id];
                    const responseReceipts = feedback?.receipts || [];
                    const continuations = [
                      ...(selectedPlan.continuations || []).filter((item) => item.group_id === group.id),
                      ...(feedback?.continuation ? [feedback.continuation] : []),
                    ].filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index);
                    const runStatus = feedback?.runStatus;
                    const entityLabels = (group.affected_entities || [])
                      .map(affectedEntityLabel)
                      .filter((label): label is string => Boolean(label));
                    const groupReceipts = group.nodes.flatMap((node) => nodeReceipts(node, responseReceipts));
                    const changeCount = group.nodes.reduce((count, node) => count + Math.max(1, node.display?.changes?.length || 0), 0);
                    const defaultExpanded = !terminalGroup;
                    const isExpanded = expandedGroups[group.id] ?? defaultExpanded;
                    return (
                      <details
                        key={group.id}
                        open={isExpanded}
                        onToggle={(event) => {
                          const nextExpanded = event.currentTarget.open;
                          setExpandedGroups((current) => {
                            if (nextExpanded === defaultExpanded) {
                              if (current[group.id] === undefined) return current;
                              const next = { ...current };
                              delete next[group.id];
                              return next;
                            }
                            if (current[group.id] === nextExpanded) return current;
                            return { ...current, [group.id]: nextExpanded };
                          });
                        }}
                        className="rounded-md border border-[var(--border)] bg-[var(--background)]"
                      >
                        <summary className="flex cursor-pointer list-none flex-wrap items-start justify-between gap-2 p-2.5">
                          <div className="min-w-0">
                            <h4 className="text-[11.5px] font-semibold text-[var(--foreground)]">{group.title || group.summary}</h4>
                            <p className="mt-0.5 text-[10.5px] leading-4 text-[var(--foreground-soft)]">{group.summary}</p>
                            <p className="mt-0.5 text-[9.5px] text-[var(--foreground-muted)]">
                              {changeCount} 项改动
                              {terminalGroup && ` · 结果：${groupReceipts.length ? groupReceipts.map(receiptLabel).join("、") : statusLabel(groupStatus, GROUP_STATUS_LABELS)}`}
                            </p>
                          </div>
                          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                            <span className="rounded-full border border-[var(--border)] px-2 py-1 text-[9.5px] text-[var(--foreground-muted)]">
                              {statusLabel(groupStatus, GROUP_STATUS_LABELS)}
                            </span>
                            {group.risk && <span className="rounded bg-[var(--surface-muted)] px-2 py-1 text-[9px] text-[var(--foreground-muted)]">{groupRiskLabel(group.risk)}</span>}
                          </div>
                        </summary>
                        <div className="space-y-2 border-t border-[var(--border)] p-2.5">
                          {group.rationale && <p className="text-[10.5px] leading-5 text-[var(--foreground-soft)]"><b className="text-[var(--foreground)]">为什么一起审核：</b>{group.rationale}</p>}
                          {entityLabels.length > 0 && (
                            <p className="text-[9.5px] text-[var(--foreground-muted)]">影响范围：{entityLabels.join("、")}</p>
                        )}

                        <div className="space-y-2">
                          {group.nodes.map((node) => {
                            const changes = node.display?.changes || [];
                            const receipts = nodeReceipts(node, responseReceipts);
                            return (
                              <div key={node.id} className="space-y-2 rounded-md border border-[var(--border)] bg-[var(--surface)] p-2.5">
                                <div className="flex flex-wrap items-start justify-between gap-2">
                                  <div className="min-w-0">
                                    <p className="text-[11px] font-semibold text-[var(--foreground)]">{node.summary || node.operation}</p>
                                    <p className="mt-0.5 text-[9.5px] text-[var(--foreground-muted)]">{statusLabel(node.status, NODE_STATUS_LABELS)}</p>
                                  </div>
                                </div>

                                {changes.length > 0 ? changes.map((change, index) => (
                                  <ChangeView
                                    key={`${node.id}:change:${index}`}
                                    title={change.summary || change.target}
                                    before={change.before}
                                    after={change.after}
                                    evidence={change.evidence}
                                    rationale={change.rationale}
                                  />
                                )) : node.display
                                  && Object.prototype.hasOwnProperty.call(node.display, "before")
                                  && Object.prototype.hasOwnProperty.call(node.display, "after") ? (
                                  <ChangeView
                                    before={node.display.before}
                                    after={node.display.after}
                                    evidence={node.display.evidence}
                                    rationale={node.display.rationale}
                                  />
                                ) : (
                                  <p className="rounded border border-dashed border-[var(--status-blush)] px-2.5 py-2 text-[10px] text-[var(--primary-red)]">
                                    缺少可审核的修改前后内容，当前组不能批准。
                                  </p>
                                )}

                                {receipts.map((receipt) => (
                                  <p key={receipt.id} className="text-[9.5px] text-[var(--foreground-muted)]">
                                    执行回执：{receiptLabel(receipt)}{receipt.audit_ref ? ` · 审计 ${receipt.audit_ref}` : ""}
                                  </p>
                                ))}

                                <OperationDetails renderDetails={() => (
                                  <>
                                  <p className="mt-1.5 text-[10px] text-[var(--foreground-muted)]">Operation：<code>{node.operation}</code></p>
                                  {node.dependency_node_ids?.length ? <p className="mt-1 text-[9.5px] text-[var(--foreground-muted)]">依赖节点：{node.dependency_node_ids.join("、")}</p> : null}
                                  {(node.redacted_args || node.redactedArgs) && (
                                    <pre className="custom-scrollbar mt-1.5 max-h-28 overflow-auto whitespace-pre-wrap rounded bg-[var(--surface-muted)] p-2 text-[9px] leading-4 text-[var(--foreground-soft)]">
                                      {JSON.stringify(node.redacted_args || node.redactedArgs, null, 2)}
                                    </pre>
                                  )}
                                  </>
                                )} />
                              </div>
                            );
                          })}
                        </div>

                        {(continuations.length > 0 || runStatus || group.status === "approved" || group.status === "executing") && (
                          <div className="rounded-md bg-[var(--surface-muted)] px-2.5 py-2 text-[10px] leading-4 text-[var(--foreground-soft)]">
                            <p className="font-semibold text-[var(--foreground)]">原任务回执</p>
                            {continuations.length ? continuations.map((continuation) => (
                              <p key={continuation.id}>{continuationLabel(continuation)}{continuation.error ? `：${continuation.error}` : ""}</p>
                            )) : <p>{runStatus ? `原任务状态：${statusLabel(runStatus, {})}（不代表 Agent 已自动续跑）` : "等待可验证的原任务回执；目前没有收到结果。"}</p>}
                          </div>
                        )}

                        {group.status === "pending" && canDecideGroup && (
                          <div className="flex flex-wrap items-center justify-end gap-1.5 border-t border-[var(--border)] pt-2">
                            {!targetValid && <p className="mr-auto text-[9.5px] text-[var(--primary-red)]">摘要或标识格式无效，决定入口已关闭。</p>}
                            {targetValid && !reviewable && <p className="mr-auto text-[9.5px] text-[var(--primary-red)]">请先补全每个节点的修改前后内容。</p>}
                            <button
                              type="button"
                              aria-label={`拒绝整组：${group.title || group.summary}`}
                              onClick={() => void decideGroup(selectedPlan, group, false)}
                              disabled={!canReject || Boolean(busyDecisionId)}
                              className="bauhaus-button bauhaus-button-outline !min-h-8 !justify-center !px-3 !py-1 !text-[10.5px] disabled:opacity-50"
                            >
                              {busy ? <Loader2 size={12} className="animate-spin" /> : null}拒绝整组
                            </button>
                            <button
                              type="button"
                              aria-label={`批准整组：${group.title || group.summary}`}
                              onClick={() => void decideGroup(selectedPlan, group, true)}
                              disabled={!canApprove || Boolean(busyDecisionId)}
                              className="bauhaus-button bauhaus-button-red !min-h-8 !justify-center !px-3 !py-1 !text-[10.5px] disabled:opacity-50"
                            >
                              {busy ? <Loader2 size={12} className="animate-spin" /> : null}批准这组改动
                            </button>
                          </div>
                        )}
                        </div>
                      </details>
                    );
                  })}
                </article>
              )}

              {compatibilityItems.length > 0 && (
                <details className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-3">
                  <summary className="cursor-pointer text-[11px] font-medium text-[var(--foreground-muted)]">
                    {compatibilityItems.length} 项兼容请求已由新计划接管，旧批准入口已关闭
                  </summary>
                  <p className="mt-2 text-[10px] leading-4 text-[var(--foreground-muted)]">这些 action_id 不会再提交决定，避免同一 Run 同时出现单动作和组级授权。</p>
                  {compatibilityItems.map((proposal) => <p key={proposal.runId} className="mt-1 break-all text-[9px] text-[var(--foreground-muted)]">{proposal.goal} · Run {proposal.runId}</p>)}
                </details>
              )}

              {(legacyItems.length > 0 || unavailable.length > 0) && (
                <details open={legacyOpen} onToggle={(event) => setLegacyOpen(event.currentTarget.open)} className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-3">
                  <summary className="cursor-pointer text-[11px] font-medium text-[var(--foreground-muted)]">
                    旧版兼容请求与历史记录（{pendingActionCount} 项待处理，{unavailable.length} 项历史）
                  </summary>
                  <p className="mt-2 text-[10px] leading-4 text-[var(--foreground-muted)]">只有计划接口确认该 Run 没有新 Plan 时，旧版单动作决定才可用。新计划一旦出现，旧 action_id 会被停用。</p>
                  {!planListReady && items.length > 0 && <p className="mt-2 text-[10px] text-[var(--primary-red)]">计划状态未同步；为防止重复批准，旧版决定暂不可用。</p>}
                  <div className="mt-2 space-y-2">
                    {legacyItems.map((proposal) => (
                      <article key={proposal.runId} className="space-y-2 border-t border-[var(--border)] pt-2">
                        <div>
                          <p className="text-[10.5px] font-semibold text-[var(--foreground)]">{proposal.goal || "旧版 Agent 请求"}</p>
                          <p className="break-all text-[9px] text-[var(--foreground-muted)]">Run {proposal.runId} · {proposal.createdAt}</p>
                        </div>
                        {proposal.steps.map((action) => {
                          const actionKey = `${proposal.runId}:${action.actionId}`;
                          const actionBusy = busyActionId === actionKey;
                          return (
                            <div key={action.actionId} className="rounded border border-[var(--border)] bg-[var(--background)] p-2.5">
                              <p className="text-[10.5px] font-semibold">{action.summary || action.operation}</p>
                              <OperationDetails renderDetails={() => (
                                <>
                                  <p className="mt-1 text-[9px]">Operation：<code>{action.operation}</code></p>
                                  <pre className="custom-scrollbar mt-1 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-[var(--surface-muted)] p-2 text-[9px]">{JSON.stringify(action.args || {}, null, 2)}</pre>
                                </>
                              )} />
                              <div className="mt-2 flex justify-end gap-1.5">
                                <button type="button" aria-label={`拒绝旧动作：${action.operation}`} onClick={() => void decideLegacyAction(proposal, action, false)} disabled={!planListReady || Boolean(busyActionId)} className="bauhaus-button bauhaus-button-outline !min-h-7 !px-2 !py-1 !text-[9.5px] disabled:opacity-50">{actionBusy ? <Loader2 size={11} className="animate-spin" /> : null}拒绝此旧动作</button>
                                <button type="button" aria-label={`执行旧动作：${action.operation}`} onClick={() => void decideLegacyAction(proposal, action, true)} disabled={!planListReady || Boolean(busyActionId)} className="bauhaus-button bauhaus-button-red !min-h-7 !px-2 !py-1 !text-[9.5px] disabled:opacity-50">{actionBusy ? <Loader2 size={11} className="animate-spin" /> : null}执行此旧动作</button>
                              </div>
                            </div>
                          );
                        })}
                      </article>
                    ))}
                  </div>
                  {unavailable.length > 0 && (
                    <div className="mt-2 border-t border-[var(--border)] pt-2">
                      <p className="text-[10px] font-semibold">已停止执行的历史请求</p>
                      {unavailable.map((proposal) => <article key={proposal.runId} className="mt-1 text-[9.5px]">
                        <p>{proposal.goal}</p><p className="break-all text-[9px] text-[var(--foreground-muted)]">{proposal.runId} · {proposal.createdAt}</p><p>{proposal.reason}</p>
                      </article>)}
                    </div>
                  )}
                </details>
              )}

              {!selectedPlan && plans.length === 0 && legacyItems.length === 0 && !planError && (
                <p className="rounded-lg border border-dashed border-[var(--border)] px-3 py-4 text-center text-[11px] text-[var(--foreground-muted)]">
                  {planLoading || legacyLoading ? "正在读取审核请求…" : "目前没有待审核计划。"}
                </p>
              )}
            </div>
          </section>
        )}
    </div>
  );
}
