// Adapted from Motif's context-usage (https://motif.sweetretry.com, MIT, © SweetRetry), remapped to OfferU --ou-* tokens.
// 上下文用量环：放在 Agent 输入框角落，一眼看出窗口用了多少；点开看「已用 / 上限 / 剩余」。
// 80% 起转琥珀、满了转红；颜色之外始终有百分比文字（不只靠颜色表达状态）。
import * as RadixPopover from "@radix-ui/react-popover";

const SIZE = 20;
const STROKE = 2.5;
const RADIUS = (SIZE - STROKE) / 2;
const LENGTH = 2 * Math.PI * RADIUS;
const COMPACT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, notation: "compact" });

export type ContextUsageTone = "ok" | "near" | "full";

export function contextUsage(used: number, limit: number, nearAt = 80) {
  const percent = limit > 0 ? (Math.max(used, 0) / limit) * 100 : 0;
  const tone: ContextUsageTone = percent >= 100 ? "full" : percent >= nearAt ? "near" : "ok";
  const label = percent > 0 && percent < 1 ? "<1%" : `${Math.round(percent)}%`;
  return { percent, tone, label, remaining: Math.max(limit - used, 0) };
}

export function ContextUsageRing({ used, limit, nearAt }: { used: number; limit: number; nearAt?: number }) {
  const { percent, tone, label, remaining } = contextUsage(used, limit, nearAt);
  const arc = Math.min(Math.max(percent, 0), 100) / 100;
  return (
    <RadixPopover.Root>
      <RadixPopover.Trigger className="ou-context-ring" data-tone={tone} aria-label={`上下文已用 ${label}`}>
        <svg aria-hidden width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="ou-context-ring-svg">
          <circle className="ou-context-ring-track" cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" strokeWidth={STROKE} />
          <circle className="ou-context-ring-arc" cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" strokeWidth={STROKE}
            strokeDasharray={LENGTH} strokeDashoffset={LENGTH * (1 - arc)} strokeLinecap="round" />
        </svg>
        <span className="ou-context-ring-label">{label}</span>
      </RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content side="top" align="end" sideOffset={6} className="ou-floating ou-popover ou-context-popover">
          <div className="ou-context-row"><strong>{COMPACT.format(used)} / {COMPACT.format(limit)}</strong><span>{label}</span></div>
          <div className="ou-context-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} aria-label="上下文窗口">
            <span style={{ width: `${arc * 100}%` }} data-tone={tone} />
          </div>
          <p className="ou-context-hint">还剩 {COMPACT.format(remaining)} tokens</p>
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
