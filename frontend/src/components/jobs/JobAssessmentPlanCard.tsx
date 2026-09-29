import { useState } from "react";
import type { CareerTask } from "@/lib/hooks";

type CapabilityNeed = {
  relevance?: "needed" | "useful" | "not_now";
  rationale?: string;
};

type JobAssessment = {
  fit?: "strong_match" | "plausible_match" | "stretch" | "weak_match" | "insufficient_evidence";
  fit_rationale?: string;
  application_priority?: "high" | "normal" | "low" | "hold";
  evidence_alignment?: Array<{
    requirement?: string;
    evidence_ref?: string;
    match?: "strong" | "partial" | "missing";
    rationale?: string;
  }>;
  evidence_gaps?: Array<{
    requirement?: string;
    why_missing?: string;
    evidence_to_seek?: string;
  }>;
  role_intelligence?: CapabilityNeed;
  resume_prep?: CapabilityNeed;
  interview_prep?: CapabilityNeed;
  recommended_operations?: string[];
};

type AssessmentTask = CareerTask & {
  result?: {
    briefing?: {
      situation_summary?: string;
      job_assessment?: JobAssessment;
    };
  };
};

const FIT_LABELS: Record<NonNullable<JobAssessment["fit"]>, string> = {
  strong_match: "匹配较强",
  plausible_match: "值得继续评估",
  stretch: "有挑战，可验证",
  weak_match: "当前匹配较弱",
  insufficient_evidence: "证据还不足",
};

const PRIORITY_LABELS: Record<NonNullable<JobAssessment["application_priority"]>, string> = {
  high: "优先",
  normal: "正常",
  low: "较低",
  hold: "暂缓",
};

const RELEVANCE_LABELS: Record<NonNullable<CapabilityNeed["relevance"]>, string> = {
  needed: "建议准备",
  useful: "可考虑",
  not_now: "暂时不需要",
};

const OPERATION_LABELS: Record<string, string> = {
  build_role_benchmark: "岗位情报",
  prepare_resume_optimization: "简历准备",
  prepare_role_interview_focus: "面试准备",
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readAssessment(task: CareerTask): { summary: string; assessment: JobAssessment | null } {
  const result = isPlainObject(task.result) ? task.result : {};
  const briefing = isPlainObject(result.briefing) ? result.briefing : {};
  const rawAssessment = isPlainObject(briefing.job_assessment) ? briefing.job_assessment : null;
  return {
    summary: typeof briefing.situation_summary === "string" ? briefing.situation_summary : "",
    assessment: rawAssessment as JobAssessment | null,
  };
}

export function JobAssessmentPlanCard({
  task,
  onRetry,
  onStartRoleIntelligence,
  startingRoleIntelligence = false,
  roleIntelligenceError = "",
}: {
  task: CareerTask | null;
  onRetry?: () => void;
  onStartRoleIntelligence?: () => void | Promise<void>;
  startingRoleIntelligence?: boolean;
  roleIntelligenceError?: string;
}) {
  const [operationStarting, setOperationStarting] = useState(false);
  if (!task) return null;

  const { summary, assessment } = readAssessment(task as AssessmentTask);
  const completed = task.status === "completed" && Boolean(assessment);
  const active = task.status === "queued" || task.status === "running";
  const roleIntelligenceRecommended = Boolean(
    completed
    && ["needed", "useful"].includes(String(assessment?.role_intelligence?.relevance || ""))
    && assessment?.recommended_operations?.includes("build_role_benchmark")
    && onStartRoleIntelligence,
  );

  const startRoleIntelligence = async () => {
    if (!onStartRoleIntelligence || operationStarting || startingRoleIntelligence) return;
    setOperationStarting(true);
    try {
      await onStartRoleIntelligence();
    } finally {
      setOperationStarting(false);
    }
  };

  return (
    <section
      className="bauhaus-panel space-y-4 bg-white p-5"
      data-testid="job-assessment-plan"
      aria-labelledby="job-assessment-plan-title"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="bauhaus-label text-[var(--foreground-muted)]">OfferU 注意到这个岗位</p>
          <h2 id="job-assessment-plan-title" className="mt-2 text-2xl font-black tracking-[-0.05em] text-[var(--foreground)]">
            岗位匹配与准备计划
          </h2>
        </div>
        <span className="bauhaus-chip bg-[var(--surface-muted)] text-[var(--foreground)]">
          {completed ? "评估已完成" : active ? "正在分析" : task.status === "failed" || task.status === "blocked" ? "需要处理" : task.status === "completed" ? "评估结果不可用" : "等待开始"}
        </span>
      </div>

      {active ? (
        <p className="text-sm font-medium leading-relaxed text-[var(--foreground-soft)]">
          正在对照当前职业证据、岗位要求和已有准备状态。分析只会生成建议，不会自动修改个人资料或投递状态。
        </p>
      ) : task.status === "failed" || task.status === "blocked" ? (
        <div role="alert" className="space-y-3 text-sm font-semibold leading-relaxed text-[var(--primary-red)]">
          <p>{task.error || "这次岗位评估没有完成。"}</p>
          {task.retryable && onRetry && (
            <button type="button" onClick={onRetry} className="bauhaus-button bauhaus-button-outline !px-3 !py-2 !text-[11px]">
              重试评估
            </button>
          )}
        </div>
      ) : completed && assessment ? (
        <>
          <div className="bauhaus-panel-sm grid gap-3 bg-[var(--surface-muted)] p-4 sm:grid-cols-[auto_1fr] sm:items-center">
            <div className="flex flex-wrap gap-2">
              <span className="bauhaus-chip bg-white text-[var(--foreground)]">
                {assessment.fit ? FIT_LABELS[assessment.fit] : "待确认"}
              </span>
              <span className="bauhaus-chip bg-white text-[var(--foreground)]">
                投递优先级：{assessment.application_priority ? PRIORITY_LABELS[assessment.application_priority] : "待确认"}
              </span>
            </div>
            <p className="text-sm font-semibold leading-relaxed text-[var(--foreground-soft)]">
              {assessment.fit_rationale || summary}
            </p>
          </div>

          {summary && <p className="text-sm font-medium leading-relaxed text-[var(--foreground-muted)]">{summary}</p>}

          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <p className="bauhaus-label text-[var(--foreground-muted)]">已对照的证据</p>
              {assessment.evidence_alignment?.length ? (
                <ul className="mt-2 space-y-2">
                  {assessment.evidence_alignment.map((item, index) => (
                    <li key={`${item.requirement || "alignment"}-${index}`} className="bauhaus-panel-sm bg-[var(--surface-muted)] p-3 text-sm">
                      <p className="font-black text-[var(--foreground)]">{item.requirement || "岗位要求"}</p>
                      <p className="mt-1 font-medium leading-relaxed text-[var(--foreground-muted)]">
                        {item.evidence_ref ? `${item.evidence_ref} · ` : ""}{item.rationale || "需要进一步核对"}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-sm font-medium leading-relaxed text-[var(--foreground-muted)]">这次评估没有列出直接对应的证据条目。</p>
              )}
            </div>

            <div>
              <p className="bauhaus-label text-[var(--foreground-muted)]">需要你补充或核对</p>
              {assessment.evidence_gaps?.length ? (
                <ul className="mt-2 space-y-2">
                  {assessment.evidence_gaps.map((gap, index) => (
                    <li key={`${gap.requirement || "gap"}-${index}`} className="bauhaus-panel-sm border-amber-500 bg-amber-50 p-3 text-sm">
                      <p className="font-black text-amber-950">{gap.requirement || "待核对的岗位要求"}</p>
                      <p className="mt-1 font-medium leading-relaxed text-amber-900">{gap.why_missing || "目前资料里还没有足够证据。"}</p>
                      {gap.evidence_to_seek && <p className="mt-1 font-semibold leading-relaxed text-amber-950">下一步：{gap.evidence_to_seek}</p>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-sm font-medium leading-relaxed text-[var(--foreground-muted)]">这次评估没有发现需要立即补充的具体证据项。</p>
              )}
            </div>
          </div>

          <div className="border-t border-[var(--border)] pt-4">
            <p className="bauhaus-label text-[var(--foreground-muted)]">OfferU 已整理的准备方向</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              {([
                ["岗位情报", assessment.role_intelligence],
                ["简历准备", assessment.resume_prep],
                ["面试准备", assessment.interview_prep],
              ] as Array<[string, CapabilityNeed | undefined]>).map(([label, need]) => (
                <div key={label} className="bauhaus-panel-sm bg-[var(--surface-muted)] p-3">
                  <p className="text-xs font-black text-[var(--foreground)]">{label} · {need?.relevance ? RELEVANCE_LABELS[need.relevance] : "待评估"}</p>
                  <p className="mt-1 text-xs font-medium leading-relaxed text-[var(--foreground-muted)]">{need?.rationale || "尚无准备说明。"}</p>
                </div>
              ))}
            </div>
            {assessment.recommended_operations?.length ? (
              <p className="mt-3 text-xs font-semibold leading-relaxed text-[var(--foreground-muted)]">
                建议继续：{assessment.recommended_operations.map((name) => OPERATION_LABELS[name] || name).join("、")}。需要修改职业事实或对外提交时，仍由你审核确认。
              </p>
            ) : null}
            {roleIntelligenceRecommended ? (
              <div className="mt-3 space-y-2">
                <p className="text-xs font-medium leading-relaxed text-[var(--foreground-muted)]">
                  这会按你当前的岗位情报配置收集同类岗位并保存基准；只有你点击后才会开始。
                </p>
                <button
                  type="button"
                  onClick={() => void startRoleIntelligence()}
                  disabled={operationStarting || startingRoleIntelligence}
                  className="bauhaus-button bauhaus-button-blue !px-4 !py-3 !text-[11px] disabled:cursor-wait disabled:opacity-60"
                >
                  {operationStarting || startingRoleIntelligence ? "正在启动岗位情报…" : "开始岗位情报"}
                </button>
                {roleIntelligenceError ? <p role="alert" className="text-xs font-semibold text-[var(--primary-red)]">{roleIntelligenceError}</p> : null}
              </div>
            ) : null}
          </div>
        </>
      ) : (
        <p className="text-sm font-medium leading-relaxed text-[var(--foreground-muted)]">岗位评估任务尚未返回可展示的计划。</p>
      )}
    </section>
  );
}
