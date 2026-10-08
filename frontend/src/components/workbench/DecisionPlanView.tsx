"use client";

// =============================================
// Plan Review（Proposal v2）
// 以语义化 DecisionGroup 为审批单位：标题/目的/风险/状态/
// display_json 的 Before/After/Why/依据；技术执行细节默认折叠，
// 不在默认视图暴露原始 Operation 名。批准/拒绝经由父级回调。
// =============================================

import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  Clock3,
  Loader2,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import {
  DISPLAY_SECTIONS,
  EFFECT_STATE_LABELS,
  GROUP_STATUS_LABELS,
  NODE_STATUS_LABELS,
  PLAN_STATUS_LABELS,
  RISK_LABELS,
  groupStatusTone,
  isGroupActionable,
  nodeStatusTone,
  type DecisionGroupView,
  type DecisionNodeView,
  type DecisionPlanView,
  type ExecutionReceiptView,
  type StatusTone,
} from "@/lib/decisionPlans";

const TONE_TEXT: Record<StatusTone, string> = {
  ok: "text-[var(--primary-green)]",
  active: "text-[var(--foreground)]",
  warn: "text-[var(--primary-amber,#B26A00)]",
  error: "text-[var(--primary-red)]",
  muted: "text-[var(--foreground-muted)]",
};

const TONE_CHIP: Record<StatusTone, string> = {
  ok: "border-[var(--primary-green)]/40 text-[var(--primary-green)]",
  active: "border-[var(--border-strong)] text-[var(--foreground)]",
  warn: "border-[var(--primary-amber,#B26A00)]/50 text-[var(--primary-amber,#B26A00)]",
  error: "border-[var(--status-blush)] text-[var(--primary-red)]",
  muted: "border-[var(--border)] text-[var(--foreground-muted)]",
};

const REVIEW_WARNING_LABELS: Record<string, string> = {
  missing_before: "缺少 Before",
  missing_after: "缺少 After",
  missing_why: "缺少修改理由",
  missing_evidence: "缺少证据说明",
  missing_current_source: "未绑定来源版本",
  missing_scope: "未标注作用范围",
  input_request_not_bound_to_group: "Ask 未绑定独立问题卡",
  auto_fallback_requires_confirmation: "自动执行无人接管，已降级为手动确认",
};

function StatusChip({ status, labels }: { status: string; labels: Record<string, string> }) {
  const label = labels[status] ?? status;
  return (
    <span
      data-status={status}
      className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${TONE_CHIP[groupStatusTone(status)]}`}
    >
      {label}
    </span>
  );
}

function StatusIcon({ status }: { status: string }) {
  const tone = nodeStatusTone(status);
  const cls = TONE_TEXT[tone];
  if (tone === "ok") return <CheckCircle2 size={12} className={cls} />;
  if (tone === "active") return <Loader2 size={12} className={`${cls} animate-spin`} />;
  if (tone === "warn") return <Clock3 size={12} className={cls} />;
  if (tone === "error") return <XCircle size={12} className={cls} />;
  return <CircleDashed size={12} className={cls} />;
}

/** display_json 值渲染：字符串→段落、数组→列表、对象→键值对。 */
function DisplayValue({ value }: { value: unknown }) {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return <p className="whitespace-pre-wrap">{String(value)}</p>;
  }
  if (Array.isArray(value)) {
    return (
      <ul className="list-disc space-y-0.5 pl-4">
        {value.map((item, index) => (
          <li key={index}>
            {item && typeof item === "object"
              ? Object.entries(item as Record<string, unknown>)
                  .map(([key, entry]) => `${key}：${String(entry)}`)
                  .join("；")
              : String(item)}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <dl className="space-y-0.5">
      {Object.entries(value as Record<string, unknown>).map(([key, entry]) => (
        <div key={key} className="flex gap-1.5">
          <dt className="shrink-0 text-[var(--foreground-muted)]">{key}：</dt>
          <dd className="min-w-0 whitespace-pre-wrap break-words">
            {typeof entry === "object" && entry !== null ? JSON.stringify(entry) : String(entry)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function shortDigest(digest?: string) {
  return digest ? `${digest.slice(0, 12)}…` : "缺失";
}

function receiptSummary(receipts?: ExecutionReceiptView[]): string {
  if (!receipts?.length) return "";
  const counts = new Map<string, number>();
  for (const receipt of receipts) {
    const state = receipt.effect_state || "unknown";
    counts.set(state, (counts.get(state) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([state, count]) => `${EFFECT_STATE_LABELS[state] ?? state} ${count} 项`)
    .join("，");
}

export function describeDecisionOutcome(
  groupTitle: string,
  decision: "approve" | "reject",
  receipts?: ExecutionReceiptView[],
): string {
  if (decision === "reject") {
    return `已拒绝“${groupTitle}”；该分组及其依赖后续分组不会执行。`;
  }
  const effects = receiptSummary(receipts);
  return effects
    ? `已批准“${groupTitle}”：${effects}。`
    : `已批准“${groupTitle}”；OfferU 正在通过 Operation Registry 执行。`;
}

function NodeStrip({ nodes }: { nodes: DecisionNodeView[] }) {
  if (nodes.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-[10px] text-[var(--foreground-muted)]">执行步骤</span>
      {nodes.map((node, index) => (
        <span
          key={node.node_id || index}
          title={NODE_STATUS_LABELS[node.status] ?? node.status}
          className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--background)] px-1.5 py-0.5 text-[10px] text-[var(--foreground-soft)]"
        >
          <StatusIcon status={node.status} />
          步骤 {node.sequence || index + 1}
        </span>
      ))}
    </div>
  );
}

function NodeTechnicalDetails({ nodes }: { nodes: DecisionNodeView[] }) {
  // 原始 Operation 名只在用户展开后进入 DOM：默认视图不出现技术名。
  const [open, setOpen] = useState(false);
  if (nodes.length === 0) return null;
  return (
    <details
      className="rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1.5"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-[10.5px] font-medium text-[var(--foreground-soft)]">
        技术细节（{nodes.length} 个 Registry 操作）
      </summary>
      {open && (
        <div className="mt-1.5 space-y-2">
          {nodes.map((node, index) => (
            <div
              key={node.node_id || index}
              className="border-t border-[var(--border)] pt-1.5 first:border-t-0 first:pt-0"
            >
              <p className="font-mono text-[9.5px] text-[var(--foreground-muted)]">
                <code>{node.operation}</code>
                {node.operation_version ? `@${node.operation_version}` : ""}
                {" · "}
                {NODE_STATUS_LABELS[node.status] ?? node.status}
              </p>
              <pre className="custom-scrollbar mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--surface-muted)] p-1.5 text-[9.5px] leading-4 text-[var(--foreground-soft)]">
                {JSON.stringify(node.args || {}, null, 2)}
              </pre>
              {node.idempotency_key && (
                <p className="mt-0.5 break-all font-mono text-[9px] text-[var(--foreground-muted)]">
                  幂等键 {node.idempotency_key}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </details>
  );
}

interface DecisionGroupCardProps {
  plan: DecisionPlanView;
  group: DecisionGroupView;
  deciding: boolean;
  dependencyTitles: string[];
  onDecide?: (group: DecisionGroupView, decision: "approve" | "reject") => void;
  onAdjust?: (group: DecisionGroupView, feedback: string) => void;
}

function DecisionGroupCard({
  plan,
  group,
  deciding,
  dependencyTitles,
  onDecide,
  onAdjust,
}: DecisionGroupCardProps) {
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const actionable = isGroupActionable(group);
  const digestsReady = Boolean(plan.plan_digest && group.group_digest);
  const display = group.display || {};
  const knownKeys: Record<string, true> = { before: true, after: true, why: true, evidence: true };
  const extraKeys = Object.keys(display).filter((key) => !knownKeys[key]);

  const submitAdjust = () => {
    const text = feedback.trim();
    setAdjustOpen(false);
    setFeedback("");
    if (onAdjust) {
      onAdjust(group, text);
    } else {
      onDecide?.(group, "reject");
    }
  };

  return (
    <section
      aria-label={`决策分组：${group.title}`}
      className="space-y-2 rounded-md border border-[var(--border)] bg-[var(--background)] p-2.5"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[12px] font-semibold leading-5 text-[var(--foreground)]">
            {group.sequence}. {group.title}
          </p>
          {group.summary && (
            <p className="mt-0.5 text-[11px] leading-4 text-[var(--foreground-soft)]">
              {group.summary}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <span
            className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${
              group.risk_level === "L3"
                ? TONE_CHIP.error
                : group.risk_level === "L2"
                  ? TONE_CHIP.warn
                  : TONE_CHIP.muted
            }`}
          >
            {RISK_LABELS[group.risk_level] ?? `风险 ${group.risk_level}`}
          </span>
          <StatusChip status={group.status} labels={GROUP_STATUS_LABELS} />
        </div>
      </div>

      {dependencyTitles.length > 0 && (
        <p className="text-[10px] text-[var(--foreground-muted)]">
          依赖前置分组：{dependencyTitles.join("、")}
        </p>
      )}

      {DISPLAY_SECTIONS.map(({ key, label }) =>
        display[key] === undefined ? null : (
          <div
            key={key}
            className="rounded-md bg-[var(--surface)] px-2 py-1.5 text-[11px] leading-5 text-[var(--foreground-soft)]"
          >
            <p className="mb-0.5 text-[10px] font-semibold text-[var(--foreground-muted)]">
              {label}
            </p>
            <DisplayValue value={display[key]} />
          </div>
        ),
      )}
      {extraKeys.length > 0 && (
        <details className="rounded-md border border-[var(--border)] px-2 py-1.5">
          <summary className="cursor-pointer text-[10.5px] font-medium text-[var(--foreground-soft)]">
            更多说明
          </summary>
          <div className="mt-1 space-y-1 text-[11px] leading-5 text-[var(--foreground-soft)]">
            {extraKeys.map((key) => (
              <div key={key}>
                <p className="text-[10px] font-semibold text-[var(--foreground-muted)]">{key}</p>
                <DisplayValue value={display[key]} />
              </div>
            ))}
          </div>
        </details>
      )}

      <NodeStrip nodes={group.nodes} />
      <NodeTechnicalDetails nodes={group.nodes} />

      {group.reviewability?.status === "ready" && group.reviewability.reason_codes?.length > 0 && (
        <div
          role="note"
          className="rounded-md border border-[var(--primary-amber,#B26A00)]/35 bg-[var(--primary-amber,#B26A00)]/5 px-2 py-1.5 text-[10.5px] leading-4 text-[var(--primary-amber,#B26A00)]"
        >
          <p className="font-semibold">信息提示，不影响确认</p>
          <p className="mt-0.5">
            {group.reviewability.reason_codes
              .map((code) => REVIEW_WARNING_LABELS[code] ?? code)
              .join(" · ")}
          </p>
        </div>
      )}

      {!digestsReady && actionable && (
        <p role="alert" className="flex items-center gap-1 text-[10.5px] text-[var(--primary-red)]">
          <ShieldAlert size={12} /> 摘要缺失，无法安全批准此分组。
        </p>
      )}
      {group.status === "stale" && (
        <p className="flex items-center gap-1 text-[10.5px] text-[var(--primary-amber,#B26A00)]">
          <AlertTriangle size={12} /> 该分组对应的内容已变化，需重新生成提案后再决定。
        </p>
      )}
      {group.status === "blocked" && (
        <p className="flex items-center gap-1 text-[10.5px] text-[var(--primary-amber,#B26A00)]">
          <AlertTriangle size={12} /> 因前置分组被拒绝或未完成而阻塞，不会执行。
        </p>
      )}
      {group.status === "needs_reconciliation" && (
        <p role="alert" className="flex items-center gap-1 text-[10.5px] text-[var(--primary-red)]">
          <AlertTriangle size={12} /> 执行结果不确定，需要对账确认后才能继续。
        </p>
      )}

      {actionable && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              aria-label={`拒绝：${group.title}`}
              disabled={deciding}
              onClick={() => onDecide?.(group, "reject")}
              className="bauhaus-button bauhaus-button-outline !min-h-8 !justify-center !px-3 !py-1 !text-[11px] disabled:opacity-50"
            >
              {deciding ? <Loader2 size={12} className="animate-spin" /> : null}
              拒绝
            </button>
            <button
              type="button"
              aria-label={`调整建议：${group.title}`}
              disabled={deciding}
              onClick={() => setAdjustOpen((value) => !value)}
              className="bauhaus-button bauhaus-button-outline !min-h-8 !justify-center !px-3 !py-1 !text-[11px] disabled:opacity-50"
            >
              调整建议
            </button>
            <button
              type="button"
              aria-label={`批准：${group.title}`}
              disabled={deciding || !digestsReady}
              onClick={() => onDecide?.(group, "approve")}
              className="bauhaus-button bauhaus-button-red !min-h-8 !justify-center !px-3 !py-1 !text-[11px] disabled:opacity-50"
            >
              {deciding ? <Loader2 size={12} className="animate-spin" /> : null}
              批准并执行
            </button>
          </div>
          {adjustOpen && (
            <div className="space-y-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] p-2">
              <label
                htmlFor={`adjust-${group.group_id}`}
                className="text-[10.5px] font-medium text-[var(--foreground-soft)]"
              >
                说明需要的调整；提交后此分组按拒绝处理。
              </label>
              <textarea
                id={`adjust-${group.group_id}`}
                aria-label={`调整意见：${group.title}`}
                value={feedback}
                onChange={(event) => setFeedback(event.target.value)}
                rows={2}
                placeholder="例如：保留第一段经历，其余按原始措辞……"
                className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1 text-[11.5px] leading-5 text-[var(--foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--foreground)]"
              />
              <div className="flex justify-end">
                <button
                  type="button"
                  aria-label={`提交调整：${group.title}`}
                  disabled={deciding}
                  onClick={submitAdjust}
                  className="bauhaus-button bauhaus-button-outline !min-h-7 !justify-center !px-3 !py-1 !text-[11px] disabled:opacity-50"
                >
                  拒绝并提交调整意见
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export interface DecisionPlanViewProps {
  plan: DecisionPlanView;
  /** group_id 正在提交决定时禁用其按钮并显示加载。 */
  decidingGroupId?: string | null;
  onDecide?: (group: DecisionGroupView, decision: "approve" | "reject") => void;
  /** 附调整意见的拒绝；未提供时“调整建议”按普通拒绝提交。 */
  onAdjust?: (group: DecisionGroupView, feedback: string) => void;
  /** 展示 Run / 修订号等元信息（全局收件箱开启，会话内联时关闭）。 */
  showRunMeta?: boolean;
}

export function DecisionPlanView({
  plan,
  decidingGroupId = null,
  onDecide,
  onAdjust,
  showRunMeta = false,
}: DecisionPlanViewProps) {
  const groupTitles: Record<string, string> = {};
  for (const group of plan.groups) groupTitles[group.group_id] = group.title;
  return (
    <article className="space-y-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold leading-5 text-[var(--foreground)]">
            {plan.title || "待审阅的变更计划"}
          </h3>
          {plan.purpose && (
            <p className="mt-0.5 text-[11px] leading-4 text-[var(--foreground-soft)]">
              {plan.purpose}
            </p>
          )}
        </div>
        <StatusChip status={plan.status} labels={PLAN_STATUS_LABELS} />
      </header>
      {showRunMeta && (
        <p className="break-all font-mono text-[9.5px] text-[var(--foreground-muted)]">
          Run {plan.run_id} · 修订 v{plan.revision}
        </p>
      )}
      {plan.status === "needs_reconciliation" && (
        <p
          role="alert"
          className="flex items-center gap-1 rounded-md border border-[var(--status-blush)] bg-[var(--status-blush)]/40 px-2 py-1 text-[10.5px] text-[var(--primary-red)]"
        >
          <AlertTriangle size={12} /> 计划执行结果不确定，需要人工对账；不会自动重放。
        </p>
      )}
      {plan.status === "superseded" && (
        <p className="text-[10.5px] text-[var(--foreground-muted)]">
          已有更新的修订版本，本计划仅供参考。
        </p>
      )}

      <div className="space-y-2">
        {plan.groups.map((group) => (
          <DecisionGroupCard
            key={group.group_id}
            plan={plan}
            group={group}
            deciding={decidingGroupId === group.group_id}
            dependencyTitles={(group.dependency_group_ids || [])
              .map((id) => groupTitles[id])
              .filter((title): title is string => Boolean(title))}
            onDecide={onDecide}
            onAdjust={onAdjust}
          />
        ))}
        {plan.groups.length === 0 && (
          <p className="rounded-md border border-dashed border-[var(--border)] px-2 py-3 text-center text-[11px] text-[var(--foreground-muted)]">
            此计划没有可展示的分组。
          </p>
        )}
      </div>

      <details className="text-[10px] text-[var(--foreground-muted)]">
        <summary className="cursor-pointer">
          计划校验信息 <ChevronDown size={10} className="inline" />
        </summary>
        <p className="mt-1 break-all font-mono">
          plan_digest {shortDigest(plan.plan_digest)}
          {plan.supersedes_plan_id ? ` · 取代 ${plan.supersedes_plan_id}` : ""}
          {plan.sealed_at ? ` · 封存于 ${plan.sealed_at}` : ""}
        </p>
      </details>
    </article>
  );
}
