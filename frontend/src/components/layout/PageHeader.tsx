import type { ReactNode } from "react";

/**
 * 一级页面的页头：标题 + 一句话 + 右侧最多一个主操作。
 * 不放统计卡——数字放在它所描述的列表旁边，而不是页面顶上。
 */
export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="offeru-page-header flex flex-wrap items-end justify-between gap-4 pb-1 pt-2">
      <div className="min-w-0">
        <h1 className="text-[28px] font-semibold leading-tight tracking-tight text-[var(--foreground)]">{title}</h1>
        {description && <p className="mt-3 max-w-2xl text-[13.5px] leading-relaxed text-[var(--foreground-muted)]">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** 页头右侧的视图切换（看板 / 表格 之类），比两个按钮更安静。 */
export function ViewSwitch<T extends string>({ value, options, onChange }: { value: T; options: Array<{ id: T; label: string; icon?: ReactNode }>; onChange: (id: T) => void }) {
  return (
    <div role="radiogroup" className="inline-flex rounded-lg bg-[var(--surface-muted)] p-0.5">
      {options.map((option) => {
        const active = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.id)}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors ${
              active ? "bg-[var(--surface)] text-[var(--foreground)] shadow-[0_1px_2px_rgba(31,31,29,0.08)]" : "text-[var(--foreground-muted)] hover:text-[var(--foreground)]"
            }`}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
