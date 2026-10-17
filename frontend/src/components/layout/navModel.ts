// =============================================
// 一级导航 5 个：今天 / 投递 / 岗位 / 简历 / 档案。
// 简历是用户最常打开的东西，单独成为一级入口；岗位定制产出的也是简历，归在简历下。
// 其余页面按「属于谁」归入某个一级入口，在页面顶部以二级标签出现：
//   投递 ← 看板、邮件、日历（进展事件的来源）
//   岗位 ← 机会、面试训练（都围绕某个岗位）
//   简历 ← 我的简历、岗位定制（页内切换）
// 设置不是导航入口，放在侧栏底部。
// =============================================

import { Briefcase, FileText, Send, Sun, UserRound } from "lucide-react";

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
  {
    href: "/jobs",
    label: "岗位",
    icon: Briefcase,
    tabs: [
      { href: "/jobs", label: "机会", match: ["/jobs"] },
      { href: "/interview", label: "面试", match: ["/interview"] },
    ],
  },
  // 简历自己的「我的简历 / 岗位定制」切换在页内（ResumeHub），这里只占一个入口，避免两排标签。
  { href: "/resume", label: "简历", icon: FileText, tabs: [{ href: "/resume", label: "简历", match: ["/resume", "/optimize"] }] },
  { href: "/profile", label: "档案", icon: UserRound, tabs: [{ href: "/profile", label: "档案", match: ["/profile"] }] },
];

export const SETTINGS_HREF = "/settings";

function matchesPrefix(prefix: string, pathname: string): boolean {
  return prefix === "/" ? pathname === "/" : pathname === prefix || pathname.startsWith(prefix + "/");
}

export function isTabActive(tab: SectionTab, pathname: string): boolean {
  return tab.match.some((prefix) => matchesPrefix(prefix, pathname));
}

/** 当前路径属于哪个一级入口；设置等支持页返回 null。 */
export function activePrimary(pathname: string): PrimaryNavItem | null {
  return PRIMARY_NAV.find((item) => item.tabs.some((tab) => isTabActive(tab, pathname))) ?? null;
}
