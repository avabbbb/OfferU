import { RotateCw } from "lucide-react";

import { Button } from "@/components/ui";
import { safeClientErrorMessage } from "@/lib/safe-error";

/** Loading placeholder for a page whose data is not here yet: a few skeleton rows on a sheet, never blank. */
export function PageLoading({ label = "正在加载…", rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div className="ou-page-default py-8" role="status" aria-live="polite" data-testid="page-loading">
      <span className="sr-only">{label}</span>
      <div className="ou-skeleton h-7 w-40" aria-hidden="true" />
      <div className="ou-sheet mt-6 space-y-3 p-5" aria-hidden="true">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="ou-skeleton h-4" style={{ width: `${88 - index * 17}%` }} />
        ))}
      </div>
      <p className="ou-shimmer mt-4 text-[length:var(--ou-type-sm)] text-[var(--ou-text-tertiary)]">{label}</p>
    </div>
  );
}

/** Data failed to load: say so, keep the user's place, offer a retry. */
export function PageError({ title, error, onRetry }: { title: string; error: unknown; onRetry?: () => void }) {
  return (
    <div className="grid min-h-[50vh] place-items-center px-4 py-10">
      <section className="ou-glass-card w-full max-w-md p-6" role="alert" data-testid="page-error">
        <h1 className="text-[length:var(--ou-type-section)] font-semibold text-[var(--ou-text-primary)]">{title}</h1>
        <p className="mt-2 text-[length:var(--ou-type-body)] leading-relaxed text-[var(--ou-text-secondary)]">
          {safeClientErrorMessage(error, "读取失败，请稍后重试。")}
        </p>
        {onRetry && (
          <Button variant="primary" className="mt-4" onClick={onRetry}>
            <RotateCw size={14} aria-hidden="true" /> 重试
          </Button>
        )}
      </section>
    </div>
  );
}
