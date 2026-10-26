"use client";

// =============================================
// 右侧上下文栏 (ADR 0031)
// 默认只有 OfferU 助手；页面里选中了某个对象（岗位、投递…）时才出现「详情」标签，
// 没选中东西时不展示一个空的「详情」。
// =============================================

import { AnimatePresence, motion } from "framer-motion";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Bot, PanelRightClose } from "lucide-react";
import { useWorkbench } from "@/lib/workbench";
import { AGENT_COMPOSE_EVENT } from "@/lib/agentCompose";

const AgentPanel = lazy(() =>
  import("./AgentPanel").then((module) => ({ default: module.AgentPanel })),
);
const InspectorPanel = lazy(() =>
  import("./InspectorPanel").then((module) => ({ default: module.InspectorPanel })),
);

// 右栏宽度：可拖动左边缘调整，键盘 ←/→（Shift 加速）、Home/End，双击恢复默认；宽度存 localStorage。
const RAIL_MIN = 300;
const RAIL_MAX = 760;
const RAIL_DEFAULT = 380;
const RAIL_STEP = 16;
const RAIL_STEP_FAST = 64;
// 主内容区至少留这么宽，避免右栏把页面挤没。
const MAIN_MIN = 480;
const RAIL_WIDTH_KEY = "offeru.contextRail.width";

export function clampRailWidth(value: number, viewport?: number): number {
  const vw = viewport ?? (typeof window === "undefined" ? Infinity : window.innerWidth);
  const cap = Math.max(RAIL_MIN, Math.min(RAIL_MAX, vw - MAIN_MIN));
  return Math.round(Math.min(Math.max(value, RAIL_MIN), cap));
}

function readStoredRailWidth(): number {
  try {
    const stored = Number(window.localStorage.getItem(RAIL_WIDTH_KEY));
    return Number.isFinite(stored) && stored > 0 ? clampRailWidth(stored) : clampRailWidth(RAIL_DEFAULT);
  } catch {
    return clampRailWidth(RAIL_DEFAULT);
  }
}

function persistRailWidth(width: number) {
  try {
    window.localStorage.setItem(RAIL_WIDTH_KEY, String(width));
  } catch {
    // 隐私模式等写入失败时只影响下次默认宽度。
  }
}

export function ContextRail() {
  const { railMode: chosenMode, setRailMode, railOpen, setRailOpen, selection } = useWorkbench();
  const railMode = selection ? chosenMode : "agent";
  // SSR 先用默认值，挂载后再读存储，避免 hydration 不一致。
  const [railWidth, setRailWidth] = useState(RAIL_DEFAULT);
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    setRailWidth(readStoredRailWidth());
    const onViewportResize = () => setRailWidth((current) => clampRailWidth(current));
    window.addEventListener("resize", onViewportResize);
    return () => window.removeEventListener("resize", onViewportResize);
  }, []);

  const applyWidth = useCallback((next: number) => {
    const width = clampRailWidth(next);
    setRailWidth(width);
    persistRailWidth(width);
  }, []);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = railWidth;
    let latest = startWidth;
    const { cursor, userSelect } = document.body.style;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    handle.setPointerCapture(event.pointerId);
    setResizing(true);
    const onMove = (moveEvent: PointerEvent) => {
      // 把手在左边缘：往左拖 = 变宽。
      latest = clampRailWidth(startWidth + (startX - moveEvent.clientX));
      setRailWidth(latest);
    };
    const onEnd = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
      document.body.style.cursor = cursor;
      document.body.style.userSelect = userSelect;
      setResizing(false);
      persistRailWidth(latest);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
  };

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? RAIL_STEP_FAST : RAIL_STEP;
    const next =
      event.key === "ArrowLeft" ? railWidth + step
      : event.key === "ArrowRight" ? railWidth - step
      : event.key === "Home" ? RAIL_MIN
      : event.key === "End" ? RAIL_MAX
      : null;
    if (next === null) return;
    event.preventDefault();
    applyWidth(next);
  };

  useEffect(() => {
    const openAgent = () => { setRailMode("agent"); setRailOpen(true); };
    window.addEventListener(AGENT_COMPOSE_EVENT, openAgent);
    return () => window.removeEventListener(AGENT_COMPOSE_EVENT, openAgent);
  }, [setRailMode, setRailOpen]);

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
          aria-label="打开 OfferU 助手"
          title="OfferU 助手"
          onClick={() => setRailOpen(true)}
          className="fixed right-3 top-3 z-40 hidden h-8 w-8 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--surface)] text-[var(--foreground-muted)] transition-colors duration-[var(--dur-quick)] hover:border-[var(--border-strong)] hover:text-[var(--foreground)] md:flex"
        >
          <Bot size={15} strokeWidth={1.75} />
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
            animate={{ width: railWidth, opacity: 1 }}
            exit={{ width: 0, opacity: 0, pointerEvents: "none" }}
            // 拖动时宽度直接跟手，不走弹簧，否则会拖出延迟感。
            transition={resizing ? { duration: 0 } : { type: "spring", stiffness: 380, damping: 36 }}
            className="context-rail offeru-context-rail fixed inset-y-0 right-0 z-50 hidden min-h-0 shrink-0 overflow-hidden border-l border-[var(--border)] bg-[var(--background)] shadow-[-12px_0_32px_var(--shadow-medium)] md:block xl:relative xl:inset-auto xl:z-auto xl:shadow-none"
          >
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="调整 OfferU 助手面板宽度"
              aria-valuemin={RAIL_MIN}
              aria-valuemax={RAIL_MAX}
              aria-valuenow={railWidth}
              tabIndex={0}
              title="拖动调整宽度 · 双击恢复默认"
              data-resizing={resizing || undefined}
              onPointerDown={startResize}
              onKeyDown={resizeWithKeyboard}
              onDoubleClick={() => applyWidth(RAIL_DEFAULT)}
              className="context-rail-resizer absolute inset-y-0 left-0 z-20 w-2 -translate-x-px cursor-col-resize touch-none outline-none"
            />
            <div className="flex h-full flex-col" style={{ width: railWidth }}>
              {/* 模式切换头 */}
              <div className="context-rail-header flex items-center gap-1 border-b border-[var(--border)] px-3 py-2.5">
                {selection ? (
                <div className="offeru-rail-tabs relative flex flex-1 rounded-md bg-[var(--surface-muted)] p-0.5">
                  {(
                    [
                      { key: "inspector", label: "详情" },
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
                ) : (
                  <p className="flex flex-1 items-center gap-1.5 px-1 text-[13px] font-semibold text-[var(--foreground)]">
                    <Bot size={14} strokeWidth={1.75} /> OfferU
                  </p>
                )}
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
