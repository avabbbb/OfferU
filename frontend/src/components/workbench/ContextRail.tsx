"use client";

// =============================================
// 右侧上下文栏 (ADR 0031)
// 对象详情与主 Agent 共用一栏,"详情 / OfferU" 两种模式切换,
// 共享当前选中对象;同一时间只显示一种模式。
// =============================================

import { AnimatePresence, motion } from "framer-motion";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { useWorkbench } from "@/lib/workbench";
import { AgentPanel } from "./AgentPanel";
import { InspectorPanel } from "./InspectorPanel";

const RAIL_WIDTH = 340;

export function ContextRail() {
  const { railMode, setRailMode, railOpen, setRailOpen, selection } = useWorkbench();

  return (
    <>
      {/* 收起状态:仅保留一个贴边的展开按钮 */}
      {!railOpen && (
        <button
          type="button"
          aria-label="打开上下文栏"
          onClick={() => setRailOpen(true)}
          className="fixed right-3 top-3 z-40 hidden h-8 w-8 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--surface)] text-[var(--foreground-muted)] transition-colors duration-[var(--dur-quick)] hover:border-[var(--border-strong)] hover:text-[var(--foreground)] md:flex"
        >
          <PanelRightOpen size={15} strokeWidth={1.75} />
        </button>
      )}

      <AnimatePresence initial={false}>
        {railOpen && (
          <motion.aside
            key="context-rail"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: RAIL_WIDTH, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ type: "spring", stiffness: 380, damping: 36 }}
            className="relative hidden h-screen shrink-0 overflow-hidden border-l border-[var(--border)] bg-[var(--background)] md:block"
          >
            <div className="flex h-full flex-col" style={{ width: RAIL_WIDTH }}>
              {/* 模式切换头 */}
              <div className="flex items-center gap-1 border-b border-[var(--border)] px-3 py-2.5">
                <div className="relative flex flex-1 rounded-md bg-[var(--surface-muted)] p-0.5">
                  {(
                    [
                      { key: "inspector", label: selection ? "详情" : "详情 · 空" },
                      { key: "agent", label: "OfferU" },
                    ] as const
                  ).map((mode) => {
                    const active = railMode === mode.key;
                    return (
                      <button
                        key={mode.key}
                        type="button"
                        onClick={() => setRailMode(mode.key)}
                        aria-pressed={active}
                        className={`relative flex-1 rounded px-2 py-1 text-[12px] font-medium transition-colors duration-[var(--dur-quick)] ${
                          active
                            ? "text-[var(--foreground)]"
                            : "text-[var(--foreground-muted)] hover:text-[var(--foreground)]"
                        }`}
                      >
                        {active && (
                          <motion.span
                            layoutId="rail-mode-indicator"
                            className="absolute inset-0 rounded bg-[var(--surface)] shadow-[0_1px_2px_var(--shadow-soft)]"
                            transition={{ type: "spring", stiffness: 480, damping: 38 }}
                          />
                        )}
                        <span className="relative z-10">{mode.label}</span>
                      </button>
                    );
                  })}
                </div>
                <button
                  type="button"
                  aria-label="收起上下文栏"
                  onClick={() => setRailOpen(false)}
                  className="rounded-md p-1.5 text-[var(--foreground-muted)] transition-colors duration-[var(--dur-quick)] hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]"
                >
                  <PanelRightClose size={15} strokeWidth={1.75} />
                </button>
              </div>

              {/* 面板体:同一时间只显示一种模式 */}
              <div className="relative min-h-0 flex-1">
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={railMode}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    transition={{ duration: 0.16, ease: "easeOut" }}
                    className="absolute inset-0"
                  >
                    {railMode === "inspector" ? <InspectorPanel /> : <AgentPanel />}
                  </motion.div>
                </AnimatePresence>
              </div>
            </div>
          </motion.aside>
        )}
      </AnimatePresence>
    </>
  );
}
