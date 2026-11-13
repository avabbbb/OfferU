"use client";

// =============================================
// 一级导航：今天 / 岗位 / 投递 / 简历 / 面试 / 设置（定义见 navModel.ts）。
// 子页面以二级标签出现在页面顶部。
// =============================================

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { Search } from "lucide-react";
import { useWorkbenchOptional } from "@/lib/workbench";
import { modifierLabel } from "@/lib/commandPalette";
import { AgentConnectionStatus } from "@/components/workbench/AgentConnectionPanel";
import { PRIMARY_NAV, activePrimary, type PrimaryNavItem } from "./navModel";

type NavItem = PrimaryNavItem;

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
      className={`offeru-nav-link group relative flex items-center gap-2.5 rounded-md px-2.5 py-2 transition-colors duration-[var(--dur-quick)] ${
        active
          ? "text-[var(--foreground)]"
          : "text-[var(--foreground-muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]"
      }`}
    >
      <Icon size={17} strokeWidth={1.75} />
      <span className={`truncate text-[length:var(--ou-type-body)] ${active ? "font-semibold" : "font-medium"}`}>{item.label}</span>
    </Link>
  );
}

export function Sidebar() {
  const pathname = usePathname() || "/";
  const current = activePrimary(pathname);
  const workbench = useWorkbenchOptional();

  return (
    <>
      <aside className="offeru-sidebar relative hidden h-full w-[var(--ou-sidebar-width)] shrink-0 overflow-hidden border-r border-[var(--border)] bg-[var(--sidebar-bg,var(--background))] md:flex md:flex-col">
        <div className="offeru-sidebar-brand relative z-10 px-4 pb-2 pt-5">
          <Link href="/" className="flex items-center gap-2.5 rounded-md px-1.5 py-1">
            <div className="offeru-sidebar-mark flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] bg-[var(--foreground)] text-[var(--surface)]">
              <span className="text-[length:var(--ou-type-sm)] font-bold tracking-tight">O</span>
            </div>
            <p className="text-[length:var(--ou-type-section)] font-semibold tracking-tight text-[var(--foreground)]">OfferU</p>
          </Link>
        </div>

        {/* ⌘K / Ctrl+K 入口 — 与命令面板联动：搜索 + 让 OfferU 办事 */}
        <div className="offeru-sidebar-search px-3 pt-1">
          <button
            type="button"
            onClick={() => workbench?.setPaletteOpen(true)}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[length:var(--ou-type-sm)] text-[var(--foreground-muted)] transition-colors duration-[var(--dur-quick)] hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]"
          >
            <Search size={14} strokeWidth={1.75} />
            <span className="min-w-0 flex-1 truncate whitespace-nowrap text-left">搜索或问 OfferU</span>
            <kbd className="shrink-0 font-sans text-[length:var(--ou-type-xs)] text-[var(--foreground-faint)]">
              {modifierLabel(typeof navigator === "undefined" ? "" : navigator.platform || navigator.userAgent)} K
            </kbd>
          </button>
        </div>

        <motion.nav
          variants={navContainer}
          initial="hidden"
          animate="show"
          className="offeru-sidebar-nav relative z-10 flex-1 space-y-0.5 overflow-y-auto px-3 py-3"
        >
          {PRIMARY_NAV.map((item) => (
            <motion.div key={item.href} variants={navItemVariant}>
              <NavLink item={item} active={current?.href === item.href} />
            </motion.div>
          ))}
        </motion.nav>
        <div className="flex items-center gap-2 p-3">
          <div className="min-w-0 flex-1">
            <AgentConnectionStatus />
          </div>
        </div>
      </aside>

      <nav className="offeru-mobile-nav fixed inset-x-0 bottom-0 z-50 border-t border-[var(--border)] bg-[var(--surface)] md:hidden">
        <div className="grid grid-cols-6 gap-0">
          {PRIMARY_NAV.map((item) => {
            const Icon = item.icon;
            const active = current?.href === item.href;

            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`relative flex min-h-[3.75rem] flex-col items-center justify-center gap-1 border-r border-[var(--border)] px-1 py-2 text-[length:var(--ou-type-xs)] font-medium last:border-r-0 ${
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
