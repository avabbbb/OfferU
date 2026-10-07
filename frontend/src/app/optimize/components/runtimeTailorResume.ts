import type { AgentRunRecord } from "@/lib/api";

export const TAILOR_RESUME_SKILL_ID = "tailor_resume";

export function tailorResumeTaskId(jobId: number) {
  return `tailor_resume:job:${jobId}`;
}

export function tailorResumeGoal(jobId: number, referenceResumeId: number | null) {
  const reference = referenceResumeId ? `优先以简历 #${referenceResumeId} 作为源简历。` : "选择最合适的现有简历作为源简历。";
  return [
    `为 canonical Job #${jobId} 定制岗位简历。`,
    reference,
    "先读取 canonical Job、Profile evidence、源简历和当前 Job Workspace。",
    "只有存在会改变结果的定位、结构或经历取舍时才使用原生 Ask；每次只问一个真实取舍，并把推荐默认项放在选项里。不要为了凑数量提问。",
    "随后生成 section-level Before/After，并保留 target requirement、Career evidence 与 rationale。",
    "通过现有 Proposal v2 将待采用修改组织成少量语义决定组，等待用户独立审核；不要自行确认。",
    "审核回执后继续同一个 Run，读回岗位专用 Resume Workspace，并准确报告 adopted / blocked / failed。",
  ].join("\n");
}

export function runStatusLabel(status: string) {
  const labels: Record<string, string> = {
    queued: "排队中",
    running: "正在准备",
    waiting_input: "等待你的选择",
    waiting_decision: "等待审核改动组",
    waiting_confirmation: "等待审核",
    interrupted: "已中断，可恢复",
    completed: "已完成",
    failed: "失败",
    blocked: "受阻",
    cancelled: "已取消",
  };
  return labels[status] || status || "未开始";
}

export function isTailorResumeRunActive(run: AgentRunRecord | null | undefined) {
  return Boolean(run && ["queued", "running", "waiting_input", "waiting_decision", "waiting_confirmation"].includes(run.status));
}

export function activePlanId(run: AgentRunRecord | null | undefined) {
  const plans = run?.proposal_plans || [];
  const active = plans.find((plan) => !["completed", "rejected", "replaced"].includes(plan.status)) || plans[0];
  return active?.id || "";
}

export function resumeIdFromRun(run: AgentRunRecord | null | undefined): number | null {
  const result = run?.final_result;
  if (!result || typeof result !== "object") return null;
  const candidates = [
    result.resume_id,
    result.accepted_resume_id,
    result.tailored_resume_id,
    (result.workspace as Record<string, unknown> | undefined)?.resume_id,
  ];
  for (const value of candidates) {
    const numberValue = Number(value);
    if (Number.isFinite(numberValue) && numberValue > 0) return numberValue;
  }
  return null;
}
