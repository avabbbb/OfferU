"use client";

import { useLayoutEffect, useState, type ReactNode, type RefObject } from "react";
import { AnimatePresence, motion } from "framer-motion";

// 设置的布局积木：分组插页卡片、左文右控件的设置项、高度动画的披露区，以及「容器够宽就双栏」的判断。

/** 容器（不是视口）宽于 minWidth 时返回 true：开着 Agent 栏、侧栏变宽时也按实际可用宽度切换双栏 / 推入。 */
export function useContainerWide(ref: RefObject<HTMLElement | null>, minWidth: number) {
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.innerWidth >= 1024);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWide(el.getBoundingClientRect().width >= minWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, minWidth]);
  return wide;
}

export function SettingsGroup({ label, action, note, children, testId }: { label?: ReactNode; action?: ReactNode; note?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section className="ou-settings-group" data-testid={testId}>
      {(label || action) && (
        <div className="ou-settings-group-head">
          {label && <h3 className="ou-settings-group-label">{label}</h3>}
          {action}
        </div>
      )}
      <div className="ou-settings-card">{children}</div>
      {note && <p className="ou-settings-group-note">{note}</p>}
    </section>
  );
}

export function SettingsItem({
  icon,
  label,
  description,
  children,
  htmlFor,
  testId,
}: {
  icon?: ReactNode;
  label: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  htmlFor?: string;
  testId?: string;
}) {
  return (
    <div className="ou-settings-item" data-testid={testId}>
      {icon && <span className="ou-tile" aria-hidden="true">{icon}</span>}
      <div className="ou-settings-item-text">
        {htmlFor ? <label htmlFor={htmlFor} className="ou-settings-item-label">{label}</label> : <span className="ou-settings-item-label">{label}</span>}
        {description && <span className="ou-settings-item-desc">{description}</span>}
      </div>
      {children && <div className="ou-settings-item-control">{children}</div>}
    </div>
  );
}

/** 展开 / 收起：高度和透明度一起动；减少动态效果时由外层 MotionConfig 变成瞬时。 */
export function DisclosurePanel({ open, id, children }: { open: boolean; id?: string; children: ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          id={id}
          key="panel"
          className="ou-disclosure-panel"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ height: { type: "spring", stiffness: 420, damping: 40 }, opacity: { duration: 0.18 } }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
