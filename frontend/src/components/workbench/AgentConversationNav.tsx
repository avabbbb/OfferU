"use client";

// 对话轮次刻度 + 「回到最新消息」。
// Ported from avabbbb/Flovart@28c79bf:components/agent/AgentConversationNav.tsx (MIT)：
// 消息区左缘每轮一道短刻度，当前可视轮高亮，悬停 / 聚焦弹出这一轮的预览，点击平滑滚回；指针靠近时刻度按距离放大（磁吸）。
// OfferU 改动：文案内置中文；刻度条是一个 toolbar，焦点在刻度上时 ↑/↓ 逐轮跳转、Home / End 到首轮 / 末轮；
// 面板里 Alt+PageUp / Alt+PageDown 也能逐轮跳（见 AgentPanel）。样式在 globals.css 的 .agent-turn-rail，只用 --ou-* Token。

import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef, type KeyboardEvent, type RefObject } from "react";
import { activeTurnIndex, type ConversationTurn } from "@/lib/agentConversationNav";

/** 吸附强度：距离指针 0px 为 1，约 25px 外衰减到 0（高斯）。 */
export function magnetStrength(distance: number, radius = 9) {
  if (!Number.isFinite(distance)) return 0;
  const value = Math.exp(-(distance * distance) / (2 * radius * radius));
  return value < 0.02 ? 0 : value;
}

function prefersReducedMotion() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** 平滑滚动（尊重减弱动效；环境不支持 scrollTo 时直接定位）。 */
export function smoothScrollTo(element: HTMLElement, top: number) {
  if (typeof element.scrollTo === "function") element.scrollTo({ top, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  else element.scrollTop = top;
}

function offsetWithin(scroller: HTMLElement, element: HTMLElement) {
  return element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
}

function turnElement(root: HTMLElement | null, index: number) {
  return root?.querySelector<HTMLElement>(`[data-turn-index="${index}"]`) ?? null;
}

export interface TurnTimelineHandle {
  /** 相对当前可视轮跳 delta 轮（-1 上一轮，1 下一轮）。 */
  step: (delta: number) => void;
}

export const AgentTurnTimeline = forwardRef<TurnTimelineHandle, {
  scrollerRef: RefObject<HTMLElement>;
  turns: readonly ConversationTurn[];
  /** 跳转前通知面板：停止跟随底部。 */
  onJump?: () => void;
}>(function AgentTurnTimeline({ scrollerRef, turns, onJump }, ref) {
  const [active, setActive] = useState(-1);
  const [preview, setPreview] = useState<number | null>(null);
  const railRef = useRef<HTMLElement | null>(null);
  const count = turns.length;

  const magnetize = useCallback((clientY: number | null) => {
    const rail = railRef.current;
    if (!rail) return;
    const ticks = Array.from(rail.querySelectorAll<HTMLElement>(".agent-turn-rail__tick"));
    let nearest = -1;
    let best = Number.POSITIVE_INFINITY;
    ticks.forEach((tick, index) => {
      if (clientY === null) { tick.style.removeProperty("--mag"); return; }
      const rect = tick.getBoundingClientRect();
      const distance = Math.abs(rect.top + rect.height / 2 - clientY);
      tick.style.setProperty("--mag", magnetStrength(distance).toFixed(3));
      if (distance < best) { best = distance; nearest = index; }
    });
    setPreview(clientY === null ? null : nearest);
  }, []);

  const measure = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !count) { setActive(-1); return; }
    const tops: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const element = turnElement(scroller, index);
      tops.push(element ? offsetWithin(scroller, element) : Number.POSITIVE_INFINITY);
    }
    setActive(activeTurnIndex(tops, scroller.scrollTop, scroller.clientHeight));
  }, [count, scrollerRef]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => { frame = 0; measure(); });
    };
    scroller?.addEventListener("scroll", onScroll, { passive: true });
    measure();
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      scroller?.removeEventListener("scroll", onScroll);
    };
  }, [measure, scrollerRef, turns]);

  const jump = useCallback((index: number) => {
    const scroller = scrollerRef.current;
    const element = turnElement(scroller, index);
    if (!scroller || !element) return;
    onJump?.();
    smoothScrollTo(scroller, Math.max(0, offsetWithin(scroller, element) - 8));
    setActive(index);
  }, [onJump, scrollerRef]);

  useImperativeHandle(ref, () => ({
    step: (delta: number) => {
      if (!count) return;
      const from = active < 0 ? count - 1 : active;
      jump(Math.max(0, Math.min(count - 1, from + delta)));
    },
  }), [active, count, jump]);

  if (count < 2) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const ticks = Array.from(railRef.current?.querySelectorAll<HTMLButtonElement>(".agent-turn-rail__tick") || []);
    const index = ticks.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    let next = -1;
    if (event.key === "ArrowDown") next = Math.min(count - 1, index + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, index - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = count - 1;
    if (next < 0) return;
    event.preventDefault();
    ticks[next]?.focus();
    jump(next);
  };

  return (
    <nav
      ref={railRef}
      className={`agent-turn-rail${preview !== null ? " is-magnet" : ""}`}
      aria-label="对话轮次（↑↓ 逐轮跳转）"
      data-testid="agent-turn-rail"
      onKeyDown={onKeyDown}
      onPointerMove={(event) => { if (event.pointerType !== "touch") magnetize(event.clientY); }}
      onPointerLeave={() => magnetize(null)}
    >
      {turns.map((turn) => (
        <div key={turn.userMessageId} className="agent-turn-rail__item">
          <button
            type="button"
            className={`agent-turn-rail__tick${turn.index === active ? " is-active" : ""}`}
            aria-label={`第 ${turn.index + 1} 轮${turn.question ? "：" + turn.question : ""}`}
            aria-current={turn.index === active ? "true" : undefined}
            tabIndex={turn.index === (active < 0 ? count - 1 : active) ? 0 : -1}
            onMouseEnter={() => setPreview(turn.index)}
            onFocus={() => setPreview(turn.index)}
            onBlur={() => setPreview((current) => (current === turn.index ? null : current))}
            onClick={() => jump(turn.index)}
          />
          {preview === turn.index && (
            <div className="agent-turn-rail__preview" role="tooltip">
              {turn.question && <strong>{turn.question}</strong>}
              {turn.answer && <p>{turn.answer}</p>}
              <small>点击或 Enter 跳到这一轮 · ↑↓ 切换</small>
            </div>
          )}
        </div>
      ))}
    </nav>
  );
});

/** 「回到最新消息」：离开底部时在输入框上方居中出现的圆形向下按钮。 */
export function AgentScrollToLatest({ visible, onClick }: { visible: boolean; onClick: () => void }) {
  if (!visible) return null;
  return (
    <div className="agent-scroll-latest">
      <button type="button" className="agent-scroll-latest__btn" aria-label="回到最新消息（Alt+End）" title="回到最新消息（Alt+End）" onClick={onClick} data-testid="agent-scroll-latest">
        <ChevronDown size={16} aria-hidden />
      </button>
    </div>
  );
}
