import type { KeyboardEvent, ReactNode } from "react";

// 单选卡片组：每项一个标题 + 一行说明，选中是白胶囊浮起。方向键在项之间移动并选中（radiogroup 语义）。
export type Choice<T extends string> = { value: T; label: ReactNode; description?: ReactNode };

export function ChoiceGroup<T extends string>({ value, onChange, options, label }: {
  value: T;
  onChange: (value: T) => void;
  options: Choice<T>[];
  label: string;
}) {
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = options[(index + step + options.length) % options.length];
    onChange(next.value);
    const group = event.currentTarget.parentElement;
    (group?.querySelector<HTMLButtonElement>(`[data-value="${next.value}"]`))?.focus();
  };
  return (
    <div className="ou-choice-group" role="radiogroup" aria-label={label}>
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            data-value={option.value}
            className="ou-choice"
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => move(event, index)}
          >
            <span className="ou-choice-label">{option.label}</span>
            {option.description ? <span className="ou-choice-description">{option.description}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
