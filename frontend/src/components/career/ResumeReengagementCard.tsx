import Link from "next/link";
import { Sparkles } from "lucide-react";
import type { CareerTask } from "@/lib/hooks";

type ReengagementCandidate = {
  job_id?: number;
  company?: string;
  role?: string;
  worth_reengaging?: boolean;
  why?: string;
  suggested_angle?: string;
  urgency?: "now" | "soon" | "monitor" | "skip" | string;
};

type ResumeUpdatePlan = {
  summary?: string;
  added_evidence_summary?: string;
  candidates?: ReengagementCandidate[];
};

const urgencyLabels: Record<string, string> = {
  now: "现在值得跟进",
  soon: "近期可考虑",
  monitor: "继续观察",
};

function readPlan(task: CareerTask): ResumeUpdatePlan | null {
  const briefing = task.result?.briefing;
  if (!briefing || typeof briefing !== "object" || Array.isArray(briefing)) return null;
  const plan = (briefing as Record<string, unknown>).resume_update;
  return plan && typeof plan === "object" && !Array.isArray(plan)
    ? plan as ResumeUpdatePlan
    : null;
}

function positiveCandidates(plan: ResumeUpdatePlan, jobId?: number | string) {
  const filterJobId = jobId == null ? null : Number(jobId);
  const seenJobIds = new Set<number>();
  return (Array.isArray(plan.candidates) ? plan.candidates : []).filter((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    const candidateJobId = Number(candidate?.job_id);
    const isPositiveCandidate = Number.isInteger(candidateJobId)
      && candidateJobId > 0
      && candidate.worth_reengaging === true
      && candidate.urgency !== "skip"
      && (filterJobId == null || candidateJobId === filterJobId);
    if (!isPositiveCandidate || seenJobIds.has(candidateJobId)) return false;
    seenJobIds.add(candidateJobId);
    return true;
  });
}

export function ResumeReengagementCard({
  task,
  jobId,
}: {
  task: CareerTask | null;
  jobId?: number | string;
}) {
  if (!task
    || task.task_type !== "career_director"
    || task.status !== "completed"
    || task.input?.event_type !== "RESUME_UPDATED") return null;
  const plan = readPlan(task);
  if (!plan) return null;
  const candidates = positiveCandidates(plan, jobId);
  if (candidates.length === 0) return null;

  return (
    <section
      className="rounded-xl border border-[var(--primary-yellow)]/40 bg-[var(--surface)] p-4"
      data-testid="resume-reengagement-card"
      aria-labelledby={`resume-reengagement-${task.task_id}`}
    >
      <div className="flex items-start gap-2">
        <Sparkles size={15} className="mt-0.5 shrink-0 text-[var(--primary-yellow)]" />
        <div className="min-w-0 flex-1">
          <h3 id={`resume-reengagement-${task.task_id}`} className="text-[13px] font-semibold text-[var(--foreground)]">
            简历更新后，值得重新考虑的岗位
          </h3>
          {plan.summary ? (
            <p className="mt-1 text-[12px] leading-5 text-[var(--foreground-muted)]">{plan.summary}</p>
          ) : null}
        </div>
      </div>

      {plan.added_evidence_summary ? (
        <p className="mt-3 rounded-lg bg-[var(--surface-muted)] px-3 py-2 text-[12px] leading-5 text-[var(--foreground-muted)]">
          简历新增证据：{plan.added_evidence_summary}
        </p>
      ) : null}

      <div className="mt-3 space-y-2">
        {candidates.map((candidate) => {
          const id = Number(candidate.job_id);
          const title = [candidate.company, candidate.role].filter(Boolean).join(" · ") || `岗位 #${id}`;
          return (
            <article key={id} className="rounded-lg border border-[var(--border)] p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h4 className="text-[12px] font-semibold text-[var(--foreground)]">{title}</h4>
                {candidate.urgency && urgencyLabels[candidate.urgency] ? (
                  <span className="rounded-full bg-[var(--surface-muted)] px-2 py-0.5 text-[10px] text-[var(--foreground-muted)]">
                    {urgencyLabels[candidate.urgency]}
                  </span>
                ) : null}
              </div>
              {candidate.why ? (
                <p className="mt-2 text-[12px] leading-5 text-[var(--foreground-muted)]">为什么值得考虑：{candidate.why}</p>
              ) : null}
              {candidate.suggested_angle ? (
                <p className="mt-1 text-[12px] leading-5 text-[var(--foreground-muted)]">可以突出：{candidate.suggested_angle}</p>
              ) : null}
              <Link
                href={`/jobs/${encodeURIComponent(String(id))}`}
                className="mt-2 inline-flex text-[11px] font-semibold text-[var(--foreground)] underline underline-offset-2"
              >
                查看岗位与申请进展
              </Link>
            </article>
          );
        })}
      </div>

      <p className="mt-3 text-[11px] leading-5 text-[var(--foreground-muted)]">
        这些只是供你查看的候选；OfferU 不会发送消息或联系招聘方。
      </p>
    </section>
  );
}
