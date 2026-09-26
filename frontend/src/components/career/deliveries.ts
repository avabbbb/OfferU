// =============================================
// 交付物状态模型 —— 只渲染后端 resolve_deliveries 解析出的真实持久化结果。
// state=ready 唯一意味着交付物已落库且可打开；suggested/preparing 永远不会
// 伪装成 ready；blocked/failed/stale 必须携带真实原因。
// =============================================

import type { CareerDelivery } from "@/lib/api";

export const DELIVERY_STATE_LABELS: Record<string, string> = {
  suggested: "建议（未生成）",
  preparing: "准备中",
  ready: "已就绪",
  blocked: "受阻",
  failed: "已失败",
  stale: "已过期",
};

export const DELIVERY_TYPE_LABELS: Record<string, string> = {
  tailored_resume_proposal: "简历提案",
  interview_prep: "面试备料",
  follow_up_draft: "跟进草稿",
  reengagement_candidate: "重新评估候选",
};

export function deliveryStateLabel(state: string | undefined): string {
  return DELIVERY_STATE_LABELS[state || "suggested"] ?? state ?? "建议（未生成）";
}

export function deliveryTypeLabel(artifactType: string | undefined): string {
  return DELIVERY_TYPE_LABELS[artifactType || ""] ?? "交付物";
}

function isDelivery(value: unknown): value is CareerDelivery {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** 从 task.result / inbox payload 里安全读取 deliveries（字段可能尚未刷新）。 */
export function readDeliveries(source: unknown): CareerDelivery[] {
  if (!source || typeof source !== "object" || Array.isArray(source)) return [];
  const list = (source as Record<string, unknown>).deliveries;
  return Array.isArray(list) ? list.filter(isDelivery) : [];
}

/**
 * 把简报 action 与真实交付物对应起来。
 * 匹配依据：action_key === dedupe_key；其次 target_ref.kind/id 与
 * job_id/application_id 一致且唯一匹配。找不到时返回 undefined ——
 * 绝不把 expected_outcome 当成已交付。
 */
export function matchDeliveryForAction(
  action: Record<string, any>,
  deliveries: CareerDelivery[],
): CareerDelivery | undefined {
  const dedupeKey = String(action?.dedupe_key || "").trim();
  if (dedupeKey) {
    const direct = deliveries.find((delivery) => String(delivery.action_key || "") === dedupeKey);
    if (direct) return direct;
  }
  const target = action?.target_ref as Record<string, any> | undefined;
  const targetKind = String(target?.kind || "");
  const targetId = String(target?.id || "");
  if (!targetKind || !targetId) return undefined;

  const matches = targetKind === "job"
    ? deliveries.filter((delivery) => String(delivery.job_id ?? "") === targetId)
    : targetKind === "application"
      ? deliveries.filter((delivery) => String(delivery.application_id ?? "") === targetId)
      : targetKind === "interview"
        ? deliveries.filter(
            (delivery) =>
              String(delivery.calendar_event_id ?? "") === targetId
              || String(delivery.application_id ?? "") === targetId,
          )
        : targetKind === "follow_up"
          ? deliveries.filter((delivery) => delivery.artifact_type === "follow_up_draft")
          : [];
  return matches.length === 1 ? matches[0] : undefined;
}

/** blocked/failed/stale 都要露出真实原因，提示用户介入。 */
export function deliveryNeedsAttention(delivery: CareerDelivery): boolean {
  return delivery.state === "blocked" || delivery.state === "failed" || delivery.state === "stale";
}
