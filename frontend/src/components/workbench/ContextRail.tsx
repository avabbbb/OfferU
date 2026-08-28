"use client";

// =============================================
// 右侧上下文栏 (ADR 0031)
// 对象详情与主 Agent 共用一栏,"详情 / OfferU" 两种模式切换,
// 共享当前选中对象;同一时间只显示一种模式。
// =============================================

import { AnimatePresence, motion } from "framer-motion";
import { lazy, Suspense, useEffect } from "react";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { useWorkbench } from "@/lib/workbench";

const AgentPanel = lazy(() =>
  import("./AgentPanel").then((module) => ({ default: module.AgentPanel })),
);
const InspectorPanel = lazy(() =>
  import("./InspectorPanel").then((module) => ({ default: module.InspectorPanel })),
);

const RAIL_WIDTH = 340;

export function ContextRail() {
  const { railMode, setRailMode, railOpen, setRailOpen, selection } = useWorkbench();

  useEffect(() => {
    if (!railOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setRailOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [railOpen, setRailOpen]);

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
          <motion.button
            key="context-rail-backdrop"
            type="button"
            tabIndex={-1}
            aria-label="关闭上下文栏遮罩"
            onClick={() => setRailOpen(false)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, pointerEvents: "none" }}
            transition={{ duration: 0.16, ease: [0.2, 0.85, 0.25, 1] }}
            className="fixed inset-y-0 left-60 right-0 z-40 hidden cursor-default border-0 bg-[var(--shadow-medium)] p-0 md:block xl:hidden"
          />
        )}
        {railOpen && (
          <motion.aside
            key="context-rail"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: RAIL_WIDTH, opacity: 1 }}
            exit={{ width: 0, opacity: 0, pointerEvents: "none" }}
            transition={{ type: "spring", stiffness: 380, damping: 36 }}
            className="context-rail offeru-context-rail fixed inset-y-0 right-0 z-50 hidden h-screen shrink-0 overflow-hidden border-l border-[var(--border)] bg-[var(--background)] shadow-[-12px_0_32px_var(--shadow-medium)] md:block xl:relative xl:inset-auto xl:z-auto xl:shadow-none"
          >
            <div className="flex h-full flex-col" style={{ width: RAIL_WIDTH }}>
              {/* 模式切换头 */}
              <div className="context-rail-header flex items-center gap-1 border-b border-[var(--border)] px-3 py-2.5">
                <div className="offeru-rail-tabs relative flex flex-1 rounded-md bg-[var(--surface-muted)] p-0.5">
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
                        className={`offeru-rail-tab relative flex-1 rounded px-2 py-1 text-[12px] font-medium transition-colors duration-[var(--dur-quick)] ${
                          active
                            ? "text-[var(--foreground)]"
                            : "text-[var(--foreground-muted)] hover:text-[var(--foreground)]"
                        }`}
                      >
                        {active && (
                          <motion.span
                            layoutId="rail-mode-indicator"
                            className="offeru-rail-indicator absolute inset-0 rounded bg-[var(--surface)] shadow-[0_1px_2px_var(--shadow-soft)]"
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
                    transition={{ type: "spring", stiffness: 420, damping: 38, mass: 0.72 }}
                    className="absolute inset-0"
                  >
                    <Suspense fallback={null}>
                      {railMode === "inspector" ? <InspectorPanel /> : <AgentPanel />}
                    </Suspense>
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
