"use client";

import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { motion } from "framer-motion";

// 设置目录的一行：图标方块 · 标题 · 状态值 · 箭头（iOS / macOS 系统设置式）。
// 目录模式（窄屏）状态值放右侧；侧栏模式（宽屏）状态值放标题下面，选中时由共享布局的白胶囊滑过来。
export function SettingsRow({
  rowKey,
  title,
  status,
  icon,
  variant = "list",
  selected = false,
  onOpen,
}: {
  rowKey: string;
  title: string;
  status?: string;
  icon: ReactNode;
  variant?: "list" | "nav";
  selected?: boolean;
  onOpen: () => void;
}) {
  const nav = variant === "nav";
  return (
    <button
      type="button"
      data-testid={"settings-row-" + rowKey}
      onClick={onOpen}
      aria-current={nav && selected ? "true" : undefined}
      className="ou-settings-row"
    >
      {nav && selected && (
        <motion.span
          layoutId="settings-nav-selection"
          className="ou-settings-row-pill"
          transition={{ type: "spring", stiffness: 520, damping: 42, mass: 0.9 }}
          aria-hidden
        />
      )}
      <span className="ou-tile" aria-hidden="true">{icon}</span>
      <span className="ou-settings-row-text">
        <span className="ou-settings-row-title">{title}</span>
        {nav && status && <span className="ou-settings-row-sub">{status}</span>}
      </span>
      {!nav && status && <span className="ou-settings-row-value">{status}</span>}
      {!nav && <ChevronRight size={16} aria-hidden="true" className="ou-settings-row-chevron" />}
    </button>
  );
}
