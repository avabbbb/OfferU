import type { JobPreparationProgressStage } from "@/lib/jobPreparationProgress";

const STATE_STYLES: Record<JobPreparationProgressStage["state"], { text: string; dot: string }> = {
  done: { text: "text-[var(--foreground-muted)]", dot: "bg-[var(--primary-blue)]" },
  active: { text: "text-[var(--foreground)]", dot: "bg-[var(--primary-yellow)]" },
  pending: { text: "text-[var(--foreground-soft)]", dot: "bg-[var(--border)]" },
  needs_review: { text: "text-amber-800", dot: "bg-amber-500" },
  prepared: { text: "text-blue-800", dot: "bg-blue-600" },
  adopted: { text: "text-emerald-800", dot: "bg-emerald-600" },
  rejected: { text: "text-[var(--foreground-muted)]", dot: "bg-[var(--border-strong)]" },
  failed: { text: "text-[var(--primary-red)]", dot: "bg-[var(--primary-red)]" },
  blocked: { text: "text-[var(--primary-red)]", dot: "bg-[var(--primary-red)]" },
  unavailable: { text: "text-[var(--foreground-soft)]", dot: "bg-[var(--border)]" },
  mismatch: { text: "text-orange-800", dot: "bg-orange-500" },
};

export function JobPreparationProgress({ stages }: { stages: JobPreparationProgressStage[] }) {
  return (
    <ul
      aria-label="岗位准备进度"
      data-testid="job-preparation-progress"
      className="mt-3 space-y-1.5"
    >
      {stages.map((stage) => {
        const style = STATE_STYLES[stage.state];
        return (
          <li
            key={stage.key}
            data-state={stage.state}
            className={`flex items-center gap-2 text-xs font-semibold ${style.text}`}
          >
            <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 rounded-full ${style.dot}`} />
            {stage.label}
          </li>
        );
      })}
    </ul>
  );
}
