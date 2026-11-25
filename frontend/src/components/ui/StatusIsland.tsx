import type { ReactNode } from "react";
import { cx } from "./cx";

// 状态岛：一颗墨色小胶囊，说明「正在做 / 做完了 / 出错了」。见 components.css 的 .ou-island。
export type IslandState = "busy" | "done" | "error";

export function StatusIsland({ state, children, className }: { state: IslandState; children: ReactNode; className?: string }) {
  return (
    <span className={cx("ou-island", className)} data-state={state} role={state === "error" ? "alert" : "status"} aria-live="polite">
      {state === "done" ? (
        <svg className="ou-check-draw" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path pathLength={1} d="M3.5 8.5l3 3 6-7" />
        </svg>
      ) : (
        <span className="ou-island-dot" aria-hidden="true" />
      )}
      <span className="truncate">{children}</span>
    </span>
  );
}

/** 分段进度：total 段，前 done 段完成，第 done 段是当前。 */
export function SegmentedProgress({ total, done, label }: { total: number; done: number; label: string }) {
  return (
    <div className="ou-steps" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
      {Array.from({ length: total }, (_, index) => (
        <i key={index} data-state={index < done ? "done" : index === done ? "current" : "todo"} />
      ))}
    </div>
  );
}
