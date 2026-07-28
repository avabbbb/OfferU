import { AlertTriangle, CheckCircle2, Target } from "lucide-react";

export default function MatchScorePanel({
  score,
  matched,
  missing,
}: {
  score?: number;
  matched?: string[];
  missing?: string[];
}) {
  const safeScore = Math.max(0, Math.min(100, Math.round(score ?? 0)));
  const hasResult = score !== undefined || (matched?.length || 0) > 0 || (missing?.length || 0) > 0;

  if (!hasResult) {
    return (
      <div className="border border-[var(--border)] bg-white p-3 text-[var(--foreground)] ">
        <div className="flex items-center gap-2 font-mono text-xs font-bold uppercase">
          <Target size={14} />
          JD Match
        </div>
        <p className="mt-2 text-xs text-[var(--foreground-muted)]">运行 AI 优化后，这里会显示匹配度和关键词命中。</p>
      </div>
    );
  }

  return (
    <div className="border border-[var(--border)] bg-white p-3 text-[var(--foreground)] ">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 font-mono text-xs font-bold uppercase">
          <Target size={14} />
          JD Match
        </div>
        <span className="font-mono text-lg font-black">{safeScore}%</span>
      </div>
      <div className="mt-2 h-2 border border-[var(--border)] bg-[var(--surface-muted)]">
        <div className="h-full bg-[var(--primary-blue)]" style={{ width: `${safeScore}%` }} />
      </div>
      <div className="mt-3 grid gap-2 text-xs md:grid-cols-2">
        <div>
          <div className="mb-1 flex items-center gap-1 font-mono font-bold uppercase text-[var(--primary-green)]">
            <CheckCircle2 size={12} />
            命中
          </div>
          <div className="flex flex-wrap gap-1">
            {(matched || []).slice(0, 12).map((item) => (
              <span key={item} className="border border-[var(--border)] bg-[var(--status-sage)] px-1.5 py-0.5 font-mono">
                {item}
              </span>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-1 flex items-center gap-1 font-mono font-bold uppercase text-[var(--primary-red)]">
            <AlertTriangle size={12} />
            缺失
          </div>
          <div className="flex flex-wrap gap-1">
            {(missing || []).slice(0, 12).map((item) => (
              <span key={item} className="border border-[var(--border)] bg-[var(--status-blush)] px-1.5 py-0.5 font-mono">
                {item}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
