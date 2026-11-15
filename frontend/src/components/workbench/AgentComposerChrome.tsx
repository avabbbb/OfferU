"use client";

// 输入栏的外观部件：左上角的流光小球（处理中变成转圈的四个点），以及左右两侧的拖动把手。
// 宽度变窄时胶囊变成只剩图标，是 globals.css 里的容器查询做的，这里不管。
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

const STORAGE_KEY = "offeru.agent.composerWidth";
export const COMPOSER_MIN_WIDTH = 280;
const KEY_STEP = 24;

function readStored(): number | null {
  if (typeof window === "undefined") return null;
  const raw = Number(window.localStorage.getItem(STORAGE_KEY));
  return Number.isFinite(raw) && raw >= COMPOSER_MIN_WIDTH ? raw : null;
}

/** 输入栏宽度：null 表示铺满；拖动时两侧对称伸缩（输入栏居中）。 */
export function useComposerWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);

  useEffect(() => setWidth(readStored()), []);

  const maxWidth = useCallback(() => {
    const parent = ref.current?.parentElement;
    if (!parent) return Infinity;
    const style = window.getComputedStyle(parent);
    return parent.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  }, []);

  const commit = useCallback((next: number | null) => {
    const max = maxWidth();
    const value = next === null || next >= max - 2 ? null : Math.max(COMPOSER_MIN_WIDTH, Math.min(next, max));
    setWidth(value);
    try {
      if (value === null) window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, String(Math.round(value)));
    } catch {
      /* 隐私模式下存不了就算了 */
    }
    return value;
  }, [maxWidth]);

  const startDrag = useCallback((side: "left" | "right", event: PointerEvent<HTMLElement>) => {
    const el = ref.current;
    if (!el || event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startW = el.getBoundingClientRect().width;
    const max = maxWidth();
    const sign = side === "right" ? 1 : -1;
    let latest = startW;
    el.dataset.resizing = "";
    const move = (ev: globalThis.PointerEvent) => {
      latest = Math.max(COMPOSER_MIN_WIDTH, Math.min(startW + (ev.clientX - startX) * sign * 2, max));
      setWidth(latest);
    };
    const up = () => {
      delete el.dataset.resizing;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      commit(latest);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }, [commit, maxWidth]);

  const onGripKey = useCallback((side: "left" | "right", event: KeyboardEvent<HTMLElement>) => {
    const current = ref.current?.getBoundingClientRect().width ?? 0;
    const grow = side === "right" ? "ArrowRight" : "ArrowLeft";
    const shrink = side === "right" ? "ArrowLeft" : "ArrowRight";
    if (event.key === grow) commit(current + KEY_STEP);
    else if (event.key === shrink) commit(current - KEY_STEP);
    else if (event.key === "Home") commit(COMPOSER_MIN_WIDTH);
    else if (event.key === "End") commit(null);
    else return;
    event.preventDefault();
  }, [commit]);

  return { ref, width, startDrag, onGripKey, reset: () => commit(null) };
}

export function ComposerGrip({ side, width, onPointerDown, onKeyDown, onReset }: {
  side: "left" | "right";
  width: number | null;
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onReset: () => void;
}) {
  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label="拖动调整输入栏宽度，双击恢复铺满"
      aria-valuemin={COMPOSER_MIN_WIDTH}
      aria-valuenow={width === null ? undefined : Math.round(width)}
      tabIndex={0}
      title="拖动调整宽度，双击恢复"
      className="agent-composer-grip"
      data-side={side}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
    />
  );
}

/** 流光小球：空闲时慢慢转、轻轻呼吸；处理中缩成一点，再散成 2×2 的四个点转圈。 */
export function AgentOrb({ working }: { working: boolean }) {
  return (
    <span className="agent-orb" data-working={working ? "" : undefined} aria-hidden>
      <span className="agent-orb-ball" />
      <span className="agent-orb-dots">
        <i /><i /><i /><i />
      </span>
    </span>
  );
}

export const COMPOSER_SUGGESTIONS = [
  "问 OfferU 任何事…",
  "把我的简历改成适合这个岗位",
  "今天该投哪几个岗位？",
  "陪我模拟一轮产品经理面试",
  "给 HR 写一封跟进邮件",
  "帮我对比这两个 offer",
];

/**
 * 会「呼吸」的占位文字：输入框空着时，一句句轮换示例问题，
 * 每个字依次从模糊浮现，换句前整句模糊淡出（学 inspora AI prompt bar 的打字节奏）。
 */
export function AnimatedPlaceholder({ items = COMPOSER_SUGGESTIONS, interval = 3600 }: { items?: string[]; interval?: number }) {
  const [index, setIndex] = useState(0);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (items.length < 2) return;
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    let swap: ReturnType<typeof setTimeout> | undefined;
    const tick = setInterval(() => {
      setLeaving(true);
      swap = setTimeout(() => {
        setIndex((value) => (value + 1) % items.length);
        setLeaving(false);
      }, 360);
    }, interval);
    return () => {
      clearInterval(tick);
      if (swap) clearTimeout(swap);
    };
  }, [items.length, interval]);

  const text = items[index] ?? "";
  return (
    <span className="agent-placeholder" data-leaving={leaving ? "" : undefined} aria-hidden>
      {Array.from(text).map((char, i) => (
        <span key={`${index}-${i}`} style={{ animationDelay: `${i * 28}ms` }}>{char}</span>
      ))}
    </span>
  );
}
