"use client";

// =============================================
// Ctrl+K 命令面板 (ADR 0031)
// 统一搜索、五阶段跳转与注册操作。轻量自实现,无额外依赖。
// =============================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import {
  Briefcase,
  Bot,
  Calendar,
  CornerDownLeft,
  FileText,
  GraduationCap,
  Mail,
  Search,
  Send,
  Settings,
  Sparkles,
  Sun,
  UserRound,
} from "lucide-react";
import { useWorkbench } from "@/lib/workbench";

interface Command {
  id: string;
  label: string;
  hint: string;
  keywords: string;
  icon: typeof Sun;
  run: () => void;
}

export function CommandPalette() {
  const router = useRouter();
  const { paletteOpen, setPaletteOpen, setRailMode, setRailOpen } = useWorkbench();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const close = useCallback(() => {
    setPaletteOpen(false);
    setQuery("");
    setActiveIndex(0);
  }, [setPaletteOpen]);

  const commands = useMemo<Command[]>(() => {
    const go = (href: string) => () => {
      router.push(href);
      close();
    };
    return [
      { id: "today", label: "今日", hint: "行动队列", keywords: "today dashboard 首页 仪表盘", icon: Sun, run: go("/") },
      { id: "jobs", label: "机会", hint: "岗位与调研", keywords: "jobs 岗位 机会 job", icon: Briefcase, run: go("/jobs") },
      { id: "resume", label: "材料", hint: "简历与定制", keywords: "resume 简历 材料 优化 optimize", icon: FileText, run: go("/resume") },
      { id: "applications", label: "进展", hint: "投递与信号", keywords: "applications 投递 进展 跟进", icon: Send, run: go("/applications") },
      { id: "interview", label: "面试", hint: "训练与日程", keywords: "interview 面试 训练", icon: GraduationCap, run: go("/interview") },
      { id: "calendar", label: "日程", hint: "进展 · 日历", keywords: "calendar 日程 日历", icon: Calendar, run: go("/calendar") },
      { id: "email", label: "信号收件箱", hint: "进展 · 邮箱信号", keywords: "email 邮箱 邮件 信号", icon: Mail, run: go("/email") },
      { id: "profile", label: "档案", hint: "职业模型", keywords: "profile 档案 个人", icon: UserRound, run: go("/profile") },
      { id: "settings", label: "设置", hint: "来源与授权", keywords: "settings 设置 配置", icon: Settings, run: go("/settings") },
      {
        id: "ask-offeru",
        label: "问 OfferU",
        hint: "打开右侧 OfferU 面板",
        keywords: "agent ai 助手 offeru 对话 chat",
        icon: Bot,
        run: () => {
          setRailMode("agent");
          setRailOpen(true);
          close();
        },
      },
      {
        id: "tailor-resume",
        label: "定制简历",
        hint: "材料 · 从岗位生成",
        keywords: "optimize 优化 定制 简历 tailor",
        icon: Sparkles,
        run: go("/optimize"),
      },
    ];
  }, [router, close, setRailMode, setRailOpen]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return commands;
    return commands.filter(
      (command) =>
        command.label.toLowerCase().includes(keyword) ||
        command.hint.toLowerCase().includes(keyword) ||
        command.keywords.toLowerCase().includes(keyword)
    );
  }, [commands, query]);

  // 全局快捷键:Ctrl+K 开关面板
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(!paletteOpen);
      }
      if (event.key === "Escape" && paletteOpen) close();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [paletteOpen, setPaletteOpen, close]);

  useEffect(() => {
    if (paletteOpen) {
      // 等弹层挂载后聚焦
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [paletteOpen]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  return (
    <AnimatePresence>
      {paletteOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          className="offeru-command-backdrop fixed inset-0 z-[90] bg-[rgba(55,53,47,0.24)] backdrop-blur-[1px]"
          onClick={close}
        >
          <motion.div
            initial={{ opacity: 0, y: -14, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 460, damping: 34 }}
            className="offeru-command-surface mx-auto mt-[16vh] w-[min(92vw,560px)] overflow-hidden rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] shadow-[0_12px_36px_var(--shadow-medium)]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center gap-2.5 border-b border-[var(--border)] px-3.5 py-3">
              <Search size={16} className="shrink-0 text-[var(--foreground-muted)]" />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setActiveIndex((prev) => Math.min(prev + 1, filtered.length - 1));
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setActiveIndex((prev) => Math.max(prev - 1, 0));
                  }
                  if (event.key === "Enter") {
                    event.preventDefault();
                    filtered[activeIndex]?.run();
                  }
                }}
                placeholder="搜索页面或操作..."
                className="flex-1 bg-transparent text-[14px] text-[var(--foreground)] outline-none placeholder:text-[var(--foreground-faint)]"
              />
              <kbd className="rounded border border-[var(--border)] bg-[var(--surface-muted)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--foreground-muted)]">
                Esc
              </kbd>
            </div>

            <ul className="custom-scrollbar max-h-[46vh] overflow-y-auto p-1.5">
              {filtered.length === 0 && (
                <li className="px-3 py-6 text-center text-[13px] text-[var(--foreground-muted)]">
                  没有匹配的页面或操作
                </li>
              )}
              {filtered.map((command, index) => {
                const Icon = command.icon;
                const active = index === activeIndex;
                return (
                  <li key={command.id}>
                    <button
                      type="button"
                      onClick={command.run}
                      onMouseEnter={() => setActiveIndex(index)}
                      className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors duration-[var(--dur-instant)] ${
                        active ? "bg-[var(--surface-muted)]" : ""
                      }`}
                    >
                      <Icon
                        size={15}
                        strokeWidth={1.75}
                        className={active ? "text-[var(--foreground)]" : "text-[var(--foreground-muted)]"}
                      />
                      <span className="flex-1 text-[13.5px] font-medium text-[var(--foreground)]">
                        {command.label}
                      </span>
                      <span className="text-[11.5px] text-[var(--foreground-muted)]">{command.hint}</span>
                      {active && <CornerDownLeft size={12} className="text-[var(--foreground-faint)]" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
