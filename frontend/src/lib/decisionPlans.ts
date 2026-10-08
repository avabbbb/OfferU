// =============================================
// Proposal v2 — DecisionPlan / AgentAsk DTO types
// Shapes mirror the frozen contract's snake_case public view:
// GET  /api/agent/runtime/decision-plans/pending        -> { plans: DecisionPlanView[] }
// GET  /api/agent/runtime/runs/{run_id}/decision-plan   -> { run_id, plan }
// POST /api/agent/runtime/runs/{run_id}/decision-groups/{group_id}/decision
// GET  /api/agent/runtime/runs/{run_id}/input-requests/pending -> { requests: AgentInputRequestView[] }
// POST /api/agent/runtime/runs/{run_id}/input-requests/{request_id}/answer
// =============================================

export type DecisionPlanStatus =
  | "draft"
  | "pending"
  | "executing"
  | "completed"
  | "partially_completed"
  | "failed"
  | "needs_reconciliation"
  | "rejected"
  | "superseded"
  | string;

export type DecisionGroupStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "blocked"
  | "executing"
  | "completed"
  | "failed"
  | "needs_reconciliation"
  | "stale"
  | string;

export type DecisionNodeStatus =
  | "pending"
  | "authorized"
  | "blocked"
  | "executing"
  | "completed"
  | "failed"
  | "uncertain"
  | "rejected"
  | "stale"
  | string;

export type InteractionState =
  | "none"
  | "needs_user_input"
  | "needs_user_review"
  | "needs_user_authorization"
  | "system_recovering"
  | "system_blocked";

export type ReviewabilityStatus =
  | "ready"
  | "needs_preparation"
  | "needs_reconciliation"
  | "archived";

export interface Reviewability {
  status: ReviewabilityStatus;
  /** Blocking reasons (only when status is not "ready"). */
  reason_codes: string[];
  /** Non-blocking hints on a ready group (e.g. missing_evidence, outside_skill_scope). */
  advisory_codes?: string[];
  counts_as_user_decision: boolean;
}

export interface DecisionNodeView {
  node_id: string;
  sequence: number;
  operation: string;
  operation_version?: string;
  args: Record<string, unknown>;
  args_digest?: string;
  target?: unknown;
  target_digest?: string;
  idempotency_key?: string;
  status: DecisionNodeStatus;
  summary?: string;
}

export interface DecisionGroupView {
  group_id: string;
  plan_id: string;
  sequence: number;
  title: string;
  summary: string;
  risk_level: "L1" | "L2" | "L3" | string;
  status: DecisionGroupStatus;
  interaction_state: InteractionState;
  reviewability: Reviewability;
  group_digest: string;
  dependency_group_ids: string[];
  /** display_json: display-safe Before/After/Why/evidence material. */
  display: Record<string, unknown>;
  nodes: DecisionNodeView[];
}

export interface ExecutionReceiptView {
  receipt_id?: string;
  node_id?: string;
  plan_id?: string;
  group_id?: string;
  operation?: string;
  idempotency_key?: string;
  audit_id?: string | null;
  status?: string;
  effect_state?: "committed" | "no_effect" | "unknown" | string;
  errors?: unknown;
  warnings?: unknown;
  created_at?: string;
  completed_at?: string;
}

export interface DecisionPlanView {
  plan_id: string;
  run_id: string;
  revision: number;
  title: string;
  purpose: string;
  status: DecisionPlanStatus;
  interaction_state: InteractionState;
  plan_digest: string;
  supersedes_plan_id?: string | null;
  created_at?: string;
  sealed_at?: string;
  groups: DecisionGroupView[];
}

export interface AgentInputOption {
  option_id: string;
  label: string;
  description?: string;
}

export interface AgentInputRequestView {
  request_id: string;
  run_id: string;
  status: "pending" | "answered" | "cancelled" | "expired" | string;
  question: string;
  reason?: string;
  options: AgentInputOption[];
  allow_free_text: boolean;
  created_at?: string;
}

export interface DecisionGroupDecisionBody {
  plan_id: string;
  plan_digest: string;
  group_digest: string;
  decision_id: string;
  decision: "approve" | "reject";
}

export interface DecisionGroupRevisionBody {
  feedback: string;
  plan_digest: string;
  group_digest: string;
  request_id: string;
}

export interface DecisionGroupRevisionResult {
  ok: boolean;
  status: "queued" | "needs_preparation" | "revised" | string;
  run_id: string;
  plan_id: string;
  group_id: string;
  duplicate: boolean;
  plan?: DecisionPlanView;
  errors?: string[];
}

export interface DecisionPlanReviewReconcileResult {
  original_pending: number;
  repaired: number;
  archived: number;
  needs_preparation: number;
  needs_reconciliation: number;
  needs_user_decision: number;
}

export interface AgentInputAnswerBody {
  answer_id: string;
  selected_option_ids: string[];
  free_text: string;
}

export interface DecisionGroupDecisionResult {
  ok: boolean;
  plan?: DecisionPlanView;
  group?: DecisionGroupView;
  receipts?: ExecutionReceiptView[];
  decision_id?: string;
  run?: { id?: string; status?: string } & Record<string, unknown>;
  continuation?: { ok?: boolean; assistant_message?: string; errors?: string[] };
  errors?: string[];
  warnings?: string[];
}

export interface AgentInputAnswerResult {
  ok: boolean;
  duplicate?: boolean;
  request?: {
    request_id?: string;
    status?: string;
    answer?: { selected_option_ids?: string[]; free_text?: string };
    answered_at?: string;
  };
  run?: { id?: string; status?: string } & Record<string, unknown>;
  continuation?: { ok?: boolean; assistant_message?: string; errors?: string[] };
  errors?: string[];
}

// ---------- normalization (route layer already emits snake_case; keep tolerant) ----------

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : value == null ? fallback : String(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function normalizeDecisionNode(raw: unknown, index: number): DecisionNodeView {
  const record = asRecord(raw);
  return {
    node_id: asString(record.node_id ?? record.id),
    sequence: typeof record.sequence === "number" ? record.sequence : index + 1,
    operation: asString(record.operation),
    operation_version: asString(record.operation_version) || undefined,
    args: asRecord(record.args ?? record.args_json),
    args_digest: asString(record.args_digest) || undefined,
    target: record.target ?? record.target_json,
    target_digest: asString(record.target_digest) || undefined,
    idempotency_key: asString(record.idempotency_key) || undefined,
    status: asString(record.status, "pending"),
    summary: asString(record.summary) || undefined,
  };
}

export function normalizeDecisionGroup(raw: unknown, index: number): DecisionGroupView {
  const record = asRecord(raw);
  return {
    group_id: asString(record.group_id ?? record.id),
    plan_id: asString(record.plan_id),
    sequence: typeof record.sequence === "number" ? record.sequence : index + 1,
    title: asString(record.title),
    summary: asString(record.summary),
    risk_level: asString(record.risk_level ?? record.risk, "L1"),
    status: asString(record.status, "pending"),
    interaction_state: asString(record.interaction_state, "none") as InteractionState,
    reviewability: (() => {
      const value = asRecord(record.reviewability);
      return {
        status: asString(value.status, "needs_preparation") as ReviewabilityStatus,
        reason_codes: asArray(value.reason_codes).map((item) => asString(item)),
        advisory_codes: asArray(value.advisory_codes).map((item) => asString(item)).filter(Boolean),
        counts_as_user_decision: Boolean(value.counts_as_user_decision),
      };
    })(),
    group_digest: asString(record.group_digest),
    dependency_group_ids: asArray(record.dependency_group_ids ?? record.dependency_group_ids_json).map(
      (value) => asString(value),
    ),
    display: asRecord(record.display ?? record.display_json),
    nodes: asArray(record.nodes ?? record.operation_nodes).map(normalizeDecisionNode),
  };
}

export function normalizeDecisionPlan(raw: unknown): DecisionPlanView {
  const record = asRecord(raw);
  const groups = asArray(record.groups ?? record.decision_groups).map(normalizeDecisionGroup);
  groups.sort((a, b) => a.sequence - b.sequence);
  return {
    plan_id: asString(record.plan_id ?? record.id),
    run_id: asString(record.run_id),
    revision: typeof record.revision === "number" ? record.revision : 1,
    title: asString(record.title),
    purpose: asString(record.purpose),
    status: asString(record.status, "pending"),
    interaction_state: asString(record.interaction_state, "none") as InteractionState,
    plan_digest: asString(record.plan_digest ?? record.digest),
    supersedes_plan_id: (record.supersedes_plan_id as string | null | undefined) ?? null,
    created_at: asString(record.created_at) || undefined,
    sealed_at: asString(record.sealed_at) || undefined,
    groups,
  };
}

export function normalizeInputRequest(raw: unknown): AgentInputRequestView {
  const record = asRecord(raw);
  return {
    request_id: asString(record.request_id ?? record.id),
    run_id: asString(record.run_id),
    status: asString(record.status, "pending"),
    question: asString(record.question),
    reason: asString(record.reason) || undefined,
    options: asArray(record.options ?? record.options_json).map((option, index) => {
      const item = asRecord(option);
      return {
        option_id: asString(item.option_id ?? item.id, `option_${index + 1}`),
        label: asString(item.label ?? item.title ?? item.option_id ?? item.id, `选项 ${index + 1}`),
        description: asString(item.description) || undefined,
      };
    }),
    allow_free_text: Boolean(record.allow_free_text),
    created_at: asString(record.created_at) || undefined,
  };
}

// ---------- status / digest helpers ----------

/** A group is actionable only while it awaits a fresh human decision. */
/**
 * A pending group the backend marked ready can be approved. Advisory codes
 * never block; interaction_state and counts_as_user_decision are projections
 * of the same readiness and are not re-checked here (a ready group with an
 * odd projection used to vanish with no way to decide it).
 */
export function isGroupActionable(group: DecisionGroupView): boolean {
  return group.status === "pending" && group.reviewability?.status === "ready";
}

/** Any pending group can be rejected: rejecting runs nothing. */
export function isGroupRejectable(group: DecisionGroupView): boolean {
  return group.status === "pending";
}

const ADVISORY_LABELS: Record<string, string> = {
  missing_before: "未提供修改前内容",
  missing_after: "未提供修改后内容",
  missing_why: "未说明原因",
  missing_evidence: "未附来源证据",
  missing_current_source: "未固定当前来源版本",
  missing_scope: "未列出影响范围",
  outside_skill_scope: "超出当前技能的常规范围",
};

/** Human-readable advisory hints for a group; empty when there are none. */
export function groupAdvisoryHints(group: DecisionGroupView): string[] {
  return (group.reviewability?.advisory_codes ?? []).map((code) => ADVISORY_LABELS[code] ?? code);
}

export function hasPendingGroups(plan: DecisionPlanView): boolean {
  return plan.groups.some(isGroupActionable);
}

export function groupDecisionBody(
  plan: DecisionPlanView,
  group: DecisionGroupView,
  decision: "approve" | "reject",
): DecisionGroupDecisionBody {
  return {
    plan_id: plan.plan_id,
    plan_digest: plan.plan_digest,
    group_digest: group.group_digest,
    decision_id: crypto.randomUUID(),
    decision,
  };
}


export type StatusTone = "ok" | "active" | "warn" | "error" | "muted";

export function planStatusTone(status: string): StatusTone {
  switch (status) {
    case "completed":
      return "ok";
    case "executing":
      return "active";
    case "failed":
    case "needs_reconciliation":
      return "error";
    case "partially_completed":
    case "rejected":
    case "superseded":
      return "warn";
    default:
      return "muted";
  }
}

export function groupStatusTone(status: string): StatusTone {
  switch (status) {
    case "completed":
      return "ok";
    case "approved":
    case "executing":
      return "active";
    case "failed":
    case "needs_reconciliation":
      return "error";
    case "rejected":
    case "blocked":
    case "stale":
      return "warn";
    default:
      return "muted";
  }
}

export function nodeStatusTone(status: string): StatusTone {
  switch (status) {
    case "completed":
      return "ok";
    case "executing":
    case "authorized":
      return "active";
    case "failed":
    case "uncertain":
      return "error";
    case "rejected":
    case "blocked":
    case "stale":
      return "warn";
    default:
      return "muted";
  }
}

export const PLAN_STATUS_LABELS: Record<string, string> = {
  draft: "草稿",
  pending: "待审阅",
  executing: "执行中",
  completed: "已完成",
  partially_completed: "部分完成",
  failed: "执行失败",
  needs_reconciliation: "需要对账",
  rejected: "已拒绝",
  superseded: "已被新版本取代",
};

export const GROUP_STATUS_LABELS: Record<string, string> = {
  pending: "待决定",
  approved: "已批准",
  rejected: "已拒绝",
  blocked: "已阻塞",
  executing: "执行中",
  completed: "已完成",
  failed: "执行失败",
  needs_reconciliation: "需要对账",
  stale: "已过期",
};

export const NODE_STATUS_LABELS: Record<string, string> = {
  pending: "等待",
  authorized: "已授权",
  blocked: "已阻塞",
  executing: "执行中",
  completed: "完成",
  failed: "失败",
  uncertain: "结果未知",
  rejected: "已拒绝",
  stale: "已过期",
};

export const RISK_LABELS: Record<string, string> = {
  L1: "低风险",
  L2: "中等风险",
  L3: "高风险",
};

export const EFFECT_STATE_LABELS: Record<string, string> = {
  committed: "已生效",
  no_effect: "未产生变更",
  unknown: "效果未知",
};

/** display_json keys rendered as named sections before/after/why/evidence. */
export const DISPLAY_SECTIONS: Array<{ key: string; label: string }> = [
  { key: "before", label: "Before" },
  { key: "after", label: "After" },
  { key: "why", label: "为什么" },
  { key: "evidence", label: "依据" },
];
