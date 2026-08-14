// =============================================
// Showcase 业务规则 — 从 Python 后端移植的规则子集
// =============================================
// 对齐 backend/app/ops.py（update_job_operation / batch_update_jobs_operation）
// 与 backend/app/services/application_progress.py 的状态机语义。
// 注意：Python 为唯一事实源；此处规则变更必须同步回 Python 侧，
// 避免两版行为漂移（由契约测试锁定）。

export const TRIAGE_STATUSES = ["inbox", "picked", "ignored"] as const;
export type TriageStatus = (typeof TRIAGE_STATUSES)[number];

export const APPLICATION_STAGES = [
  "prepared",
  "applied",
  "written_test",
  "assessment",
  "interview_1",
  "interview_2",
  "interview_hr",
  "offer",
  "rejected",
] as const;
export type ApplicationStage = (typeof APPLICATION_STAGES)[number];

export interface TriageValidationError {
  error: string;
}

/**
 * 批量分拣校验（对齐 Python batch_update_jobs_operation）：
 * - job_ids 必填且 ≤500
 * - triage_status 必须合法；pool 只允许配 picked
 * - pool_id 与 clear_pool 互斥
 * - 离开 picked 时清池（调用方执行）；picked 且未指定池时保留原池
 */
export function validateTriageUpdate(input: {
  job_ids?: unknown;
  triage_status?: unknown;
  pool_id?: unknown;
  clear_pool?: unknown;
}): TriageValidationError | null {
  const jobIds = input.job_ids;
  if (!Array.isArray(jobIds) || jobIds.length === 0) {
    return { error: "job_ids is required" };
  }
  if (jobIds.length > 500) {
    return { error: "job_ids exceeds 500" };
  }
  if (
    input.triage_status === undefined &&
    input.pool_id === undefined &&
    !input.clear_pool
  ) {
    return { error: "no update fields provided" };
  }
  const status = input.triage_status;
  if (status !== undefined && !TRIAGE_STATUSES.includes(status as TriageStatus)) {
    return { error: "invalid triage_status" };
  }
  const poolId = input.pool_id;
  const clearPool = Boolean(input.clear_pool);
  if (poolId !== undefined && poolId !== null && clearPool) {
    return { error: "pool_id and clear_pool are mutually exclusive" };
  }
  if (
    poolId !== undefined &&
    poolId !== null &&
    status !== undefined &&
    status !== "picked"
  ) {
    return { error: "pool_id can only be used with triage_status=picked" };
  }
  return null;
}

/** 单条岗位更新校验（对齐 update_job_operation）。 */
export function validateJobUpdate(input: {
  triage_status?: unknown;
  pool_id?: unknown;
  clear_pool?: unknown;
}): TriageValidationError | null {
  if (input.triage_status === undefined && input.pool_id === undefined && !input.clear_pool) {
    return { error: "no update fields provided" };
  }
  const status = input.triage_status;
  if (status !== undefined && !TRIAGE_STATUSES.includes(status as TriageStatus)) {
    return { error: "invalid triage_status" };
  }
  if (input.pool_id !== undefined && input.pool_id !== null && status !== undefined && status !== "picked") {
    return { error: "pool_id can only be used with triage_status=picked" };
  }
  return null;
}

/**
 * 候选进展确认的阶段校验（对齐 Python review_application_progress）：
 * accept 时必须选择合法枚举阶段；prepared/unknown 是内部态，不可作为新阶段。
 */
export function validateReviewStage(stage: string): TriageValidationError | null {
  if (stage === "prepared" || stage === "unknown") {
    return { error: `内部阶段不可作为确认目标: ${stage}` };
  }
  if (!APPLICATION_STAGES.includes(stage as ApplicationStage)) {
    return { error: `接受候选进展前必须选择有效的新阶段: ${stage}` };
  }
  return null;
}
