"use client";

// =============================================
// 五阶段求职流程导航 (ADR 0030 / 0033)
// 一级入口:今日 / 机会 / 材料 / 进展 / 面试
// 支持入口:档案 / 设置;主 Agent 由右侧上下文栏承接,不在此并列。
// =============================================

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import {
  Briefcase,
  Calendar,
  FileText,
  GraduationCap,
  Search,
  Settings,
  Send,
  Sun,
  UserRound,
} from "lucide-react";
import { useWorkbenchOptional } from "@/lib/workbench";

interface NavItem {
  href: string;
  label: string;
  hint: string;
  icon: typeof Sun;
  /** 命中这些前缀时视为处于该阶段 */
  match: string[];
}

// 五个求职阶段 + 支持入口。旧路由通过 next.config redirects 收敛。
const stageItems: NavItem[] = [
  { href: "/", label: "今日", hint: "行动队列", icon: Sun, match: ["/"] },
  { href: "/jobs", label: "机会", hint: "岗位与调研", icon: Briefcase, match: ["/jobs"] },
  { href: "/resume", label: "材料", hint: "简历与定制", icon: FileText, match: ["/resume", "/optimize", "/studio"] },
  { href: "/applications", label: "进展", hint: "投递与信号", icon: Send, match: ["/applications", "/email", "/calendar"] },
  { href: "/interview", label: "面试", hint: "训练与日程", icon: GraduationCap, match: ["/interview"] },
];

const supportItems: NavItem[] = [
  { href: "/profile", label: "档案", hint: "职业模型", icon: UserRound, match: ["/profile"] },
  { href: "/settings", label: "设置", hint: "来源与授权", icon: Settings, match: ["/settings"] },
];

const mobileItems = [...stageItems, supportItems[0]];

function isStageActive(item: NavItem, pathname: string): boolean {
  return item.match.some((prefix) =>
    prefix === "/" ? pathname === "/" : pathname === prefix || pathname.startsWith(prefix + "/")
  );
}

const navContainer = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.04, delayChildren: 0.05 },
  },
};

const navItemVariant = {
  hidden: { opacity: 0, x: -14 },
  show: {
    opacity: 1,
    x: 0,
    transition: { type: "spring", stiffness: 420, damping: 32 },
  },
};

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={`group relative flex items-center gap-2.5 rounded-md px-2.5 py-2 transition-colors duration-[var(--dur-quick)] ${
        active
          ? "bg-[var(--surface-muted)] text-[var(--foreground)]"
          : "text-[var(--foreground-muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]"
      }`}
    >
      {active && (
        <motion.span
          layoutId="sidebar-active-indicator"
          className="absolute inset-y-1.5 left-0 w-[2.5px] rounded-full bg-[var(--foreground)]"
          transition={{ type: "spring", stiffness: 480, damping: 38 }}
        />
      )}
      <Icon size={17} strokeWidth={1.75} />
      <div className="min-w-0 flex-1">
        <p
          className={`truncate text-[13.5px] font-medium leading-none ${
            active
              ? "text-[var(--foreground)]"
              : "text-[var(--foreground-muted)] group-hover:text-[var(--foreground)]"
          }`}
        >
          {item.label}
        </p>
      </div>
      <span
        className={`truncate text-[11px] font-medium ${
          active
            ? "text-[var(--foreground-soft)]"
            : "text-[var(--foreground-faint)] group-hover:text-[var(--foreground-muted)]"
        }`}
      >
        {item.hint}
      </span>
    </Link>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const workbench = useWorkbenchOptional();

  return (
    <>
      <aside className="relative hidden h-screen w-[15rem] shrink-0 overflow-hidden border-r border-[var(--border)] bg-[var(--background)] md:flex md:flex-col">
        <div className="relative z-10 border-b border-[var(--border)] px-5 py-5">
          <Link href="/" className="flex items-center gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--foreground)] text-[var(--surface)]">
              <span className="text-[13px] font-bold tracking-tight">O</span>
            </div>
            <div className="space-y-0.5">
              <p className="text-[11px] font-medium text-[var(--foreground-muted)]">求职工作台</p>
              <p className="text-[15px] font-semibold tracking-tight text-[var(--foreground)]">OfferU</p>
            </div>
          </Link>
        </div>

        {/* Ctrl+K 搜索入口 — 与命令面板联动 */}
        <div className="px-3 pt-3">
          <button
            type="button"
            onClick={() => workbench?.setPaletteOpen(true)}
            className="flex w-full items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-[12.5px] text-[var(--foreground-muted)] transition-colors duration-[var(--dur-quick)] hover:border-[var(--border-strong)] hover:text-[var(--foreground)]"
          >
            <Search size={14} strokeWidth={1.75} />
            <span className="flex-1 text-left">搜索与跳转</span>
            <kbd className="rounded border border-[var(--border)] bg-[var(--surface-muted)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--foreground-muted)]">
              Ctrl K
            </kbd>
          </button>
        </div>

        <motion.nav
          variants={navContainer}
          initial="hidden"
          animate="show"
          className="relative z-10 flex-1 space-y-0.5 overflow-y-auto px-3 py-3"
        >
          {stageItems.map((item) => (
            <motion.div key={item.href} variants={navItemVariant}>
              <NavLink item={item} active={isStageActive(item, pathname)} />
            </motion.div>
          ))}

          <motion.div variants={navItemVariant} className="!mt-4 border-t border-[var(--border)] pt-3">
            {supportItems.map((item) => (
              <NavLink key={item.href} item={item} active={isStageActive(item, pathname)} />
            ))}
          </motion.div>
        </motion.nav>
      </aside>

      <nav className="fixed inset-x-0 bottom-0 z-50 border-t border-[var(--border)] bg-[var(--surface)] md:hidden">
        <div className="grid grid-cols-6 gap-0">
          {mobileItems.map((item) => {
            const Icon = item.icon;
            const active = isStageActive(item, pathname);

            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`relative flex min-h-[60px] flex-col items-center justify-center gap-1 border-r border-[var(--border)] px-1 py-2 text-[11px] font-medium last:border-r-0 ${
                  active ? "text-[var(--foreground)]" : "text-[var(--foreground-muted)]"
                }`}
              >
                {active && (
                  <motion.span
                    layoutId="mobile-active-indicator"
                    className="absolute top-0 h-[2px] w-8 rounded-full bg-[var(--foreground)]"
                    transition={{ type: "spring", stiffness: 480, damping: 38 }}
                  />
                )}
                <Icon size={18} strokeWidth={1.75} />
                <span className="truncate">{item.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}
