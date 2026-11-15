// Agent 工作状态：Thinking Orbs 点阵球 + 静态中文标签的全圆角胶囊。
// 参考 Inspora 5-8 · Jakub Antalik「Thinking orbs」（npm thinking-orbs，MIT）：动效只在球里，
// 字是静的、无扫光 / 打字机；换阶段时旧胶囊模糊 + 右滑 + 淡出，新胶囊淡入。
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ThinkingOrb } from "thinking-orbs";
import { agentOrbLabel, agentOrbState, type AgentOrbContext, type AgentOrbState } from "@/lib/agentWorkingOrb";

/** 换阶段的离场时长，和 CSS 里 .ou-orb-swap 的 --ou-motion-slow 对齐。 */
const LEAVE_MS = 320;

// OfferU 只在根节点挂 .dark / data-theme="dark" 时才是暗色；不跟系统的 prefers-color-scheme，
// 所以不用 ThinkingOrb 的 theme="auto"（系统暗色 + 应用浅色时会画出浅色点），而是按根节点钉死。
function subscribeRootTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
  return () => observer.disconnect();
}
function rootIsDark() {
  const root = document.documentElement;
  return root.classList.contains("dark") || root.dataset.theme === "dark";
}
/** 点阵球的墨色：浅色界面用深色点（"light"），暗色界面用浅色点（"dark"）。inverse 用在墨黑底按钮上。 */
export function useOrbTheme(inverse = false): "dark" | "light" {
  const dark = useSyncExternalStore(subscribeRootTheme, rootIsDark, () => false);
  return dark !== inverse ? "dark" : "light";
}

/** 只要一颗球（任务条、工具行、输入框左侧）。 */
export function AgentOrbIcon({ state, size = 20, inverse, label }: { state: AgentOrbState; size?: 20 | 32 | 64; inverse?: boolean; label?: string }) {
  const theme = useOrbTheme(inverse);
  return <ThinkingOrb state={state} size={size} theme={theme} aria-label={label} className="ou-orb" />;
}

type Phase = { key: string; label: string; state: AgentOrbState };

/**
 * 运行中的胶囊。label 为空时显示「正在思考」；state 不给就按文案推（见 lib/agentWorkingOrb）。
 * meta 放在胶囊尾部（步数 / 用时），不参与换场动画。
 */
export function AgentWorkingOrb({
  label,
  state,
  context,
  meta,
  size = 20,
  testId,
}: {
  label?: string | null;
  state?: AgentOrbState;
  context?: AgentOrbContext;
  meta?: ReactNode;
  size?: 20 | 64;
  testId?: string;
}) {
  const text = agentOrbLabel(label);
  const orbState = state ?? agentOrbState(label, context);
  const current: Phase = { key: orbState + "|" + text, label: text, state: orbState };
  const [leaving, setLeaving] = useState<Phase | null>(null);
  const previous = useRef<Phase>(current);

  useEffect(() => {
    if (previous.current.key === current.key) return;
    setLeaving(previous.current);
    previous.current = current;
    const timer = window.setTimeout(() => setLeaving(null), LEAVE_MS);
    return () => window.clearTimeout(timer);
    // current 每次渲染都是新对象，只按 key 判断阶段是否变化。
  }, [current.key]);

  return (
    <div className="ou-orb-pill" data-size={size} data-state={orbState} data-testid={testId} role="status" aria-live="polite">
      <span className="ou-orb-stack">
        {leaving && <OrbPhase key={"out-" + leaving.key} phase={leaving} size={size} leaving />}
        <OrbPhase key={"in-" + current.key} phase={current} size={size} />
      </span>
      {meta != null && meta !== "" && <span className="ou-orb-meta">{meta}</span>}
    </div>
  );
}

function OrbPhase({ phase, size, leaving }: { phase: Phase; size: 20 | 64; leaving?: boolean }) {
  const theme = useOrbTheme();
  return (
    <span className="ou-orb-phase" data-leaving={leaving ? "" : undefined} aria-hidden={leaving || undefined}>
      <ThinkingOrb state={phase.state} size={size} theme={theme} aria-hidden className="ou-orb" />
      <span className="ou-orb-label">{phase.label}…</span>
    </span>
  );
}
