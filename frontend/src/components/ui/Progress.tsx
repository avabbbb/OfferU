// 进度条：细轨道 + 墨色填充。value 为 null 表示不确定（来回流动），读屏读作 progressbar。
export function Progress({ value, label }: { value: number | null; label: string }) {
  const percent = value === null ? undefined : Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div
      className="ou-progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      data-indeterminate={percent === undefined ? "" : undefined}
    >
      <span className="ou-progress-bar" style={percent === undefined ? undefined : { width: `${percent}%` }} />
    </div>
  );
}
