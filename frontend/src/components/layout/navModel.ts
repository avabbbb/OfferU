// =============================================
// 一级导航 6 个：今天 / 岗位 / 投递 / 简历 / 面试 / 设置。
// 其余页面按「属于谁」归入某个一级入口，在页面顶部以二级标签出现：
//   投递 ← 看板、邮件、日历（进展事件的来源）
//   简历 ← 我的简历、岗位定制、档案（页内切换；档案是写简历的事实来源）
//   面试 ← 准备（题库、面经、模拟面试）、复盘（真实面试逐题记录）
// =============================================

import { Briefcase, FileText, MessagesSquare, Send, Settings, Sun } from "lucide-react";

export interface SectionTab {
  href: string;
  label: string;
  /** 命中这些路径前缀时该标签为当前页 */
  match: string[];
}

export interface PrimaryNavItem {
  href: string;
  label: string;
  icon: typeof Sun;
  tabs: SectionTab[];
}

export const PRIMARY_NAV: PrimaryNavItem[] = [
  { href: "/", label: "今天", icon: Sun, tabs: [{ href: "/", label: "今天", match: ["/"] }] },
  { href: "/jobs", label: "岗位", icon: Briefcase, tabs: [{ href: "/jobs", label: "岗位", match: ["/jobs"] }] },
  {
    href: "/applications?view=board",
    label: "投递",
    icon: Send,
    tabs: [
      { href: "/applications?view=board", label: "看板", match: ["/applications"] },
      { href: "/email", label: "邮件", match: ["/email"] },
      { href: "/calendar", label: "日历", match: ["/calendar"] },
    ],
  },
  // 简历自己的「我的简历 / 岗位定制 / 档案」切换在页内（ResumeHub），这里只占一个入口，避免两排标签。
  { href: "/resume", label: "简历", icon: FileText, tabs: [{ href: "/resume", label: "简历", match: ["/resume", "/optimize", "/profile"] }] },
  {
    href: "/interview",
    label: "面试",
    icon: MessagesSquare,
    tabs: [
      { href: "/interview", label: "准备", match: ["/interview"] },
      { href: "/interview/review", label: "复盘", match: ["/interview/review"] },
    ],
  },
  { href: "/settings", label: "设置", icon: Settings, tabs: [{ href: "/settings", label: "设置", match: ["/settings"] }] },
];

function matchesPrefix(prefix: string, pathname: string): boolean {
  return prefix === "/" ? pathname === "/" : pathname === prefix || pathname.startsWith(prefix + "/");
}

export function isTabActive(tab: SectionTab, pathname: string): boolean {
  return tab.match.some((prefix) => matchesPrefix(prefix, pathname));
}

/** 同一入口下多个标签都命中时（/interview 与 /interview/review），取前缀最长的那个。 */
export function activeTab(primary: PrimaryNavItem, pathname: string): SectionTab | null {
  let best: SectionTab | null = null;
  let bestLength = -1;
  for (const tab of primary.tabs) {
    for (const prefix of tab.match) {
      if (matchesPrefix(prefix, pathname) && prefix.length > bestLength) {
        best = tab;
        bestLength = prefix.length;
      }
    }
  }
  return best;
}

/** 当前路径属于哪个一级入口。 */
export function activePrimary(pathname: string): PrimaryNavItem | null {
  return PRIMARY_NAV.find((item) => item.tabs.some((tab) => isTabActive(tab, pathname))) ?? null;
}
