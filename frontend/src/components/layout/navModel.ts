// =============================================
// 一级导航只有 4 个：今天 / 投递 / 岗位 / 档案（对齐产品走查视频）。
// 其余页面按「属于谁」归入某个一级入口，在页面顶部以二级标签出现：
//   投递 ← 看板、邮件、日历（进展事件的来源）
//   岗位 ← 机会列表、岗位定制、面试训练（都围绕某个岗位）
//   档案 ← 职业档案、简历（简历是档案的投影）
// 设置不是导航入口，放在侧栏底部。
// =============================================

import { Briefcase, Send, Sun, UserRound } from "lucide-react";

export interface SectionTab {
  href: string;
  label: string;
  /** 命中这些路径前缀时该标签为当前页 */
  match: string[];
}

export interface PrimaryNavItem {
  href: string;
  label: string;
  hint: string;
  icon: typeof Sun;
  tabs: SectionTab[];
}

export const PRIMARY_NAV: PrimaryNavItem[] = [
  {
    href: "/",
    label: "今天",
    hint: "下一步",
    icon: Sun,
    tabs: [{ href: "/", label: "今天", match: ["/"] }],
  },
  {
    href: "/applications?view=board",
    label: "投递",
    hint: "进展",
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
    hint: "目标岗位",
    icon: Briefcase,
    tabs: [
      { href: "/jobs", label: "机会", match: ["/jobs"] },
      { href: "/optimize", label: "定制", match: ["/optimize"] },
      { href: "/interview", label: "面试", match: ["/interview"] },
    ],
  },
  {
    href: "/profile",
    label: "档案",
    hint: "职业档案",
    icon: UserRound,
    tabs: [
      { href: "/profile", label: "档案", match: ["/profile"] },
      { href: "/resume", label: "简历", match: ["/resume", "/studio"] },
    ],
  },
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
