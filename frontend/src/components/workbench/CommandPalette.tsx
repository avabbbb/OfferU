"use client";

// =============================================
// ⌘K / Ctrl+K 命令面板 (ADR 0031)
// 不只会搜，还能直接办事：
//   - 搜索：跳页面，或选一个动作直接交给 OfferU 开跑
//   - 问 OfferU：输入就是问题，回车交给右侧 Agent
// 交互参照 Apple HIG：平台修饰键符号、键盘全程可达、即时反馈、尊重「减少动态效果」。
// 视觉守 docs/DESIGN.md §10/§11：黑白灰、层级靠字号字重颜色、一个浮起容器。
// =============================================

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  ArrowRight,
  Briefcase,
  Check,
  FileText,
  GraduationCap,
  MessageSquare,
  Search,
  Settings,
  Sparkles,
  Sun,
  UserRound,
} from "lucide-react";
import { useWorkbench } from "@/lib/workbench";
import { composeToAgent } from "@/lib/agentCompose";
import {
  GROUP_LABEL,
  type PaletteItem,
  type PaletteMode,
  modifierLabel,
  moveIndex,
  paletteItems,
} from "@/lib/commandPalette";

const PAGE_ICONS: Record<string, typeof Sun> = {
  today: Sun,
  jobs: Briefcase,
  resume: FileText,
  profile: UserRound,
  interview: GraduationCap,
  settings: Settings,
};

function iconFor(item: PaletteItem) {
  if (item.group === "pages") return PAGE_ICONS[item.id] ?? ArrowRight;
  if (item.group === "actions") return Sparkles;
  return MessageSquare;
}

/** 交给 Agent 后保留一下「已交给 OfferU」的反馈再关，让用户看见这一步发生了。 */
const HANDOFF_FEEDBACK_MS = 420;

export function CommandPalette() {
  const router = useRouter();
  const reduceMotion = useReducedMotion();
  const { paletteOpen, setPaletteOpen, setRailMode, setRailOpen } = useWorkbench();
  const [mode, setMode] = useState<PaletteMode>("search");
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [handedOff, setHandedOff] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const closeTimer = useRef<number | null>(null);
  const baseId = useId();
  const mod = useMemo(
    () => modifierLabel(typeof navigator === "undefined" ? "" : navigator.platform || navigator.userAgent),
    [],
  );

  const items = useMemo(() => paletteItems(mode, query), [mode, query]);

  const close = useCallback(() => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
    setPaletteOpen(false);
    setQuery("");
    setMode("search");
    setActiveIndex(0);
    setHandedOff(null);
  }, [setPaletteOpen]);

  const run = useCallback(
    (item: PaletteItem | undefined) => {
      if (!item || handedOff) return;
      if (item.group === "pages") {
        router.push(item.href);
        close();
        return;
      }
      if (!item.prompt.trim()) return;
      composeToAgent({ message: item.prompt });
      setRailMode("agent");
      setRailOpen(true);
      setHandedOff(item.id);
      closeTimer.current = window.setTimeout(close, reduceMotion ? 0 : HANDOFF_FEEDBACK_MS);
    },
    [handedOff, router, close, setRailMode, setRailOpen, reduceMotion],
  );

  // 全局快捷键：⌘K / Ctrl+K 开关面板
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (paletteOpen) close();
        else setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [paletteOpen, setPaletteOpen, close]);

  useEffect(() => () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
  }, []);

  useEffect(() => {
    if (paletteOpen) requestAnimationFrame(() => inputRef.current?.focus());
  }, [paletteOpen]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, mode]);

  // 键盘移动时让当前项留在可视区
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    node?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  const switchMode = (next: PaletteMode) => {
    setMode(next);
    inputRef.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return; // 中文输入法选词时不抢回车
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((prev) => moveIndex(prev, 1, items.length));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((prev) => moveIndex(prev, -1, items.length));
        break;
      case "Enter":
        event.preventDefault();
        run(items[activeIndex]);
        break;
      case "Tab":
        event.preventDefault();
        switchMode(mode === "search" ? "ask" : "search");
        break;
      case "Escape":
        event.preventDefault();
        // 先清输入 / 回到搜索，再关闭：Esc 是「返回」而不是一下全没
        if (query) setQuery("");
        else if (mode === "ask") setMode("search");
        else close();
        break;
    }
  };

  const listboxId = `${baseId}-list`;
  const optionId = (index: number) => `${baseId}-opt-${index}`;
  const enterLabel = items[activeIndex]?.group === "pages" ? "打开" : mode === "ask" ? "提问" : "执行";

  return (
    <AnimatePresence>
      {paletteOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.14 }}
          className="offeru-command-backdrop fixed inset-0"
          onClick={close}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="命令面板"
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.985 }}
            animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.985 }}
            transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 520, damping: 38 }}
            className="offeru-command-surface mx-auto mt-[12vh] w-[min(92vw,780px)] overflow-hidden"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="offeru-command-head">
              {mode === "search" ? (
                <Search size={16} strokeWidth={1.75} className="shrink-0 text-[var(--foreground-muted)]" aria-hidden />
              ) : (
                <Sparkles size={16} strokeWidth={1.75} className="shrink-0 text-[var(--foreground)]" aria-hidden />
              )}
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onKeyDown}
                placeholder={mode === "search" ? "搜索页面，或让 OfferU 办一件事…" : "问 OfferU 任何关于你求职的问题…"}
                className="offeru-command-input"
                role="combobox"
                aria-expanded="true"
                aria-controls={listboxId}
                aria-activedescendant={items.length ? optionId(activeIndex) : undefined}
                aria-autocomplete="list"
                spellCheck={false}
              />
              <div className="offeru-command-segment" role="tablist" aria-label="模式">
                {(["search", "ask"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="tab"
                    aria-selected={mode === value}
                    tabIndex={-1}
                    onClick={() => switchMode(value)}
                    className="offeru-command-segment-item"
                  >
                    {value === "search" ? "搜索" : "问 OfferU"}
                  </button>
                ))}
              </div>
            </div>

            <div className="offeru-command-body">
              <ul ref={listRef} id={listboxId} role="listbox" aria-label={mode === "search" ? "结果" : "提问"} className="offeru-command-list custom-scrollbar">
                {items.map((item, index) => {
                  const Icon = iconFor(item);
                  const active = index === activeIndex;
                  const done = handedOff === item.id;
                  const showHeader = index === 0 || items[index - 1].group !== item.group;
                  const headerLabel = mode === "ask" && !query.trim() ? "试着问" : GROUP_LABEL[item.group];
                  return (
                    <li key={item.id} role="presentation">
                      {showHeader && (
                        <p className="offeru-command-group" role="presentation">
                          {headerLabel}
                        </p>
                      )}
                      <div
                        id={optionId(index)}
                        role="option"
                        aria-selected={active}
                        data-index={index}
                        data-active={active || undefined}
                        onClick={() => run(item)}
                        onMouseMove={() => !active && setActiveIndex(index)}
                        className="offeru-command-item"
                      >
                        <span className="offeru-command-icon" aria-hidden>
                          {done ? <Check size={14} strokeWidth={2} /> : <Icon size={14} strokeWidth={1.75} />}
                        </span>
                        <span className="offeru-command-label">
                          {item.id === "ask-query" && mode === "search" ? (
                            <>
                              问 OfferU：<span className="text-[var(--foreground)]">{item.label}</span>
                            </>
                          ) : (
                            item.label
                          )}
                        </span>
                        <span className="offeru-command-hint">
                          {done ? "已交给 OfferU" : item.hint}
                        </span>
                        <ArrowRight size={14} strokeWidth={1.9} className="offeru-command-arrow" aria-hidden />
                      </div>
                    </li>
                  );
                })}
              </ul>
              <CommandPreview item={items[activeIndex]} done={handedOff === items[activeIndex]?.id} mode={mode} />
            </div>

            <div className="offeru-command-foot" aria-hidden>
              <span className="truncate">
                {mode === "search" ? "选中动作会直接在右侧开一个 OfferU 任务" : "回答会出现在右侧 OfferU 面板"}
              </span>
              <span className="flex shrink-0 items-center gap-3">
                <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
                <span><kbd>↵</kbd> {enterLabel}</span>
                <span><kbd>Tab</kbd> 切换</span>
                <span><kbd>Esc</kbd> 返回</span>
                <span className="hidden sm:inline"><kbd>{mod}</kbd><kbd>K</kbd></span>
              </span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** 右侧预览（参考 Inspora · Mona「feature menu」的「左索引 + 右预览」）：高亮哪一项，就提前说清楚选它会发生什么。 */
function CommandPreview({ item, done, mode }: { item: PaletteItem | undefined; done: boolean; mode: PaletteMode }) {
  if (!item) return <aside className="offeru-command-preview" aria-hidden />;
  const Icon = iconFor(item);
  const isPage = item.group === "pages";
  return (
    <aside className="offeru-command-preview" aria-hidden>
      <div key={item.id} className="offeru-command-preview-inner">
        <span className="offeru-command-preview-tile" data-agent={!isPage || undefined}>
          {done ? <Check size={18} strokeWidth={2} /> : <Icon size={18} strokeWidth={1.75} />}
        </span>
        <p className="offeru-command-preview-title">{item.group === "ask" && mode === "search" ? "问 OfferU" : item.label}</p>
        <p className="offeru-command-preview-desc">{isPage ? item.hint : GROUP_LABEL[item.group] + " · " + item.hint}</p>
        <div className="offeru-command-preview-card">
          {isPage ? (
            <>
              <span className="offeru-command-preview-eyebrow">打开页面</span>
              <span>{item.label}<span className="offeru-command-preview-path">{item.href}</span></span>
            </>
          ) : (
            <>
              <span className="offeru-command-preview-eyebrow">{done ? "已交给 OfferU" : "会交给右侧 OfferU"}</span>
              <span className="offeru-command-preview-prompt">{item.prompt || "输入问题后回车"}</span>
            </>
          )}
        </div>
        <span className="offeru-command-preview-enter"><kbd>↵</kbd> {isPage ? "打开" : mode === "ask" ? "提问" : "执行"}</span>
      </div>
    </aside>
  );
}
