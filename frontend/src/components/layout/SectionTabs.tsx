"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { activePrimary, activeTab } from "./navModel";

/** 一级入口下的二级标签；只有一个标签的入口（今天）不显示。 */
export function SectionTabs() {
  const pathname = usePathname() || "/";
  const primary = activePrimary(pathname);
  if (!primary || primary.tabs.length < 2) return null;
  // 打印页、简历编辑器等深层页面保持全屏专注，不插标签。
  if (pathname.startsWith("/jobs/") || pathname.startsWith("/interview/ai") || pathname.startsWith("/interview/pose")) return null;
  const current = activeTab(primary, pathname);
  return (
    <nav aria-label={`${primary.label}分区`} className="mb-4 flex gap-1 border-b border-[var(--border)]">
      {primary.tabs.map((tab) => {
        const active = tab === current;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-[13px] font-medium transition-colors ${
              active
                ? "border-[var(--foreground)] text-[var(--foreground)]"
                : "border-transparent text-[var(--foreground-muted)] hover:text-[var(--foreground)]"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
