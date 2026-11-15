"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ActivePill } from "@/components/ui";
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
    // 按一级入口换 key：换入口时标签整排重建、胶囊直接落位，只在同一排里滑动。
    <nav key={primary.href} aria-label={`${primary.label}分区`} className="ou-segment ou-pill-host mb-5">
      <ActivePill />
      {primary.tabs.map((tab) => {
        const active = tab === current;
        return (
          <Link key={tab.href} href={tab.href} aria-current={active ? "page" : undefined} className="ou-segment-item">
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
