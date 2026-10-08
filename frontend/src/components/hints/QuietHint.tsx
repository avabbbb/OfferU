// =============================================
// QuietHint — 安静的静态小标记
// 设计约束：
// - 默认只是一个灰色小圆点「?」，无动画、不自动弹出、不抢焦点；
// - 用户悬停 / 聚焦 / 点击才展开一句话说明，可带一个「怎么做」链接；
// - Esc、点外面、再点一次都能关；从不阻断下面的操作（不是模态）；
// - 设置里关闭「显示提示」后整体隐藏。
// =============================================

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useHintsEnabled } from "./hintPrefs";

interface QuietHintProps {
  /** 一句话说明，尽量 ≤ 40 字 */
  children: ReactNode;
  /** 屏幕阅读器标签，同时是标记的 title */
  label?: string;
  /** 可选：带用户去做这件事的入口 */
  action?: { href: string; label: string };
  align?: "start" | "end";
  className?: string;
}

export function QuietHint({ children, label = "这是什么？", action, align = "start", className = "" }: QuietHintProps) {
  const [enabled] = useHintsEnabled();
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        setPinned(false);
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
        setPinned(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  if (!enabled) return null;

  return (
    <span
      ref={rootRef}
      className={`quiet-hint relative inline-flex align-middle ${className}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        if (!pinned) setOpen(false);
      }}
      data-testid="quiet-hint"
    >
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-controls={panelId}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          if (!pinned) setOpen(false);
        }}
        onClick={() => {
          const next = !pinned;
          setPinned(next);
          setOpen(next);
        }}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-[var(--quiet-hint-border,#d8d5cb)] text-[10px] leading-none text-[var(--quiet-hint-ink,#87867f)] outline-none transition-colors hover:border-[var(--quiet-hint-accent,#1B365D)] hover:text-[var(--quiet-hint-accent,#1B365D)] focus-visible:border-[var(--quiet-hint-accent,#1B365D)] focus-visible:text-[var(--quiet-hint-accent,#1B365D)]"
      >
        ?
      </button>
      {open && (
        <span
          id={panelId}
          role="note"
          className={`absolute top-6 z-30 w-64 rounded-md border border-[#e8e6dc] bg-[#faf9f5] p-3 text-left text-[12px] font-normal leading-relaxed text-[#3d3d3a] shadow-[0_1px_2px_rgba(20,20,19,0.06)] ${
            align === "end" ? "right-0" : "left-0"
          }`}
        >
          <span className="block">{children}</span>
          {action && (
            <Link href={action.href} className="mt-2 inline-block font-medium text-[#1B365D] underline underline-offset-4">
              {action.label}
            </Link>
          )}
        </span>
      )}
    </span>
  );
}
