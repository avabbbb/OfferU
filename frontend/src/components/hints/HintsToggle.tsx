// 设置页的「显示提示」开关：熟手可以一键隐藏所有安静提示。
import { useHintsEnabled } from "./hintPrefs";

export function HintsToggle() {
  const [enabled, setEnabled] = useHintsEnabled();
  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5" data-testid="hints-toggle">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">界面提示</h2>
          <p className="mt-1 text-sm text-[var(--foreground-muted)]">
            标题旁的小「?」只在你需要时展开，不会自己弹出。熟悉之后可以全部隐藏。
          </p>
        </div>
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            role="switch"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            className="h-4 w-4 accent-[#1B365D]"
          />
          显示提示
        </label>
      </div>
    </section>
  );
}
