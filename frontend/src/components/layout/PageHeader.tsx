import type { ReactNode } from "react";

/**
 * 一级页面的页头：标题 + 一句话 + 右侧最多一个主操作。
 * 不放统计卡——数字放在它所描述的列表旁边，而不是页面顶上。
 */
export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="offeru-page-header flex flex-wrap items-end justify-between gap-4 pb-1 pt-2">
      <div className="min-w-0">
        <h1 className="text-[length:var(--ou-type-page)] font-semibold leading-tight tracking-tight text-[var(--foreground)]">{title}</h1>
        {description && <p className="mt-3 max-w-2xl text-[length:var(--ou-type-body)] leading-relaxed text-[var(--foreground-muted)]">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** 页头右侧的视图切换（看板 / 表格 之类），比两个按钮更安静。 */
export function ViewSwitch<T extends string>({ value, options, onChange }: { value: T; options: Array<{ id: T; label: string; icon?: ReactNode }>; onChange: (id: T) => void }) {
  return (
    <div role="radiogroup" className="ou-segment">
      {options.map((option) => {
        return (
          <button key={option.id} type="button" role="radio" aria-checked={option.id === value} onClick={() => onChange(option.id)} className="ou-segment-item">
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
