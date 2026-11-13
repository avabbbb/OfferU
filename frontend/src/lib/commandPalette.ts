// =============================================
// 命令面板的纯数据模型（ADR 0031 + Cmd+K「不只会搜，还能直接办事」）
// 两种模式：
//   search — 跳页面 + 直接让 OfferU 办一件事（交给 Agent，立即开一个 Run）
//   ask    — 把输入当成问题交给 OfferU
// 保持纯函数，方便单测；组件只负责渲染和键盘。
// =============================================

export type PaletteMode = "search" | "ask";

export type PaletteGroup = "pages" | "actions" | "ask";

export interface PaletteItemBase {
  id: string;
  group: PaletteGroup;
  label: string;
  hint: string;
  keywords: string;
}

export interface PalettePageItem extends PaletteItemBase {
  group: "pages";
  href: string;
}

export interface PaletteAgentItem extends PaletteItemBase {
  group: "actions" | "ask";
  /** 交给 OfferU 的完整意图 */
  prompt: string;
}

export type PaletteItem = PalettePageItem | PaletteAgentItem;

export const GROUP_LABEL: Record<PaletteGroup, string> = {
  pages: "页面",
  actions: "让 OfferU 办",
  ask: "问 OfferU",
};

export const PAGE_ITEMS: PalettePageItem[] = [
  { id: "today", group: "pages", label: "今天", hint: "下一步和待办", keywords: "today 今天 首页 待办", href: "/" },
  { id: "jobs", group: "pages", label: "岗位", hint: "岗位和投递状态", keywords: "jobs 岗位 投递 job pipeline", href: "/jobs" },
  { id: "resume", group: "pages", label: "简历", hint: "主简历和定制版本", keywords: "resume 简历 pdf cv", href: "/resume" },
  { id: "profile", group: "pages", label: "档案", hint: "基本信息和经历", keywords: "profile 档案 经历 记忆", href: "/profile" },
  { id: "interview", group: "pages", label: "面试", hint: "准备和复盘", keywords: "interview 面试 复盘", href: "/interview" },
  { id: "settings", group: "pages", label: "设置", hint: "连接和模型", keywords: "settings 设置 配置 模型", href: "/settings" },
];

/** 一步就能交给 OfferU 的动作：选中即开跑，不需要再打字。 */
export const ACTION_ITEMS: PaletteAgentItem[] = [
  {
    id: "act-next",
    group: "actions",
    label: "排出今天的下一步",
    hint: "按截止时间排待办",
    keywords: "today todo 待办 下一步 截止 plan",
    prompt: "按截止时间帮我排出今天最该做的三件事，每件说明原因",
  },
  {
    id: "act-pick",
    group: "actions",
    label: "挑一个最值得投的岗位",
    hint: "结合档案和岗位库",
    keywords: "job 岗位 推荐 投递 recommend",
    prompt: "从我的岗位库里挑一个今天最值得投的岗位，并说明为什么",
  },
  {
    id: "act-check",
    group: "actions",
    label: "检查投递有没有异常",
    hint: "档案、岗位、日程",
    keywords: "check 异常 检查 体检 health",
    prompt: "检查我的档案、岗位库、投递进展和面试日程有没有异常",
  },
  {
    id: "act-review",
    group: "actions",
    label: "复盘最近一次面试",
    hint: "整理问题和改进点",
    keywords: "interview review 面试 复盘",
    prompt: "帮我复盘最近一次面试：列出被问到的问题、答得不好的地方和下次怎么改",
  },
];

/** Ask 模式下空输入时的示例问题。 */
export const ASK_SUGGESTIONS: PaletteAgentItem[] = [
  {
    id: "ask-gap",
    group: "ask",
    label: "我离目标岗位还差什么？",
    hint: "",
    keywords: "",
    prompt: "对照我收藏的目标岗位，我的档案和简历还差哪些可以证明的经历？",
  },
  {
    id: "ask-due",
    group: "ask",
    label: "这周有哪些截止和笔试？",
    hint: "",
    keywords: "",
    prompt: "列出这周所有的投递截止、笔试和面试，按时间排好",
  },
  {
    id: "ask-resume",
    group: "ask",
    label: "我的简历哪一段最弱？",
    hint: "",
    keywords: "",
    prompt: "看看我的主简历，哪一段最弱、应该怎么改？",
  },
];

function matches(item: PaletteItemBase, keyword: string) {
  return (
    item.label.toLowerCase().includes(keyword) ||
    item.hint.toLowerCase().includes(keyword) ||
    item.keywords.toLowerCase().includes(keyword)
  );
}

/** 输入原样变成一条「问 OfferU」，保证回车永远有事可做。 */
export function askItemFor(query: string): PaletteAgentItem {
  const text = query.trim();
  return { id: "ask-query", group: "ask", label: text, hint: "", keywords: "", prompt: text };
}

/**
 * 按模式和输入得到当前可选的条目，顺序即渲染顺序（同组相邻）。
 * search：页面 → 动作 → 输入非空时兜底一条「问 OfferU」。
 * ask：输入非空只有这一条提问；为空时给示例问题。
 */
export function paletteItems(mode: PaletteMode, query: string): PaletteItem[] {
  const keyword = query.trim().toLowerCase();
  if (mode === "ask") {
    return keyword ? [askItemFor(query)] : ASK_SUGGESTIONS;
  }
  if (!keyword) return [...PAGE_ITEMS, ...ACTION_ITEMS];
  const pages = PAGE_ITEMS.filter((item) => matches(item, keyword));
  const actions = ACTION_ITEMS.filter((item) => matches(item, keyword));
  return [...pages, ...actions, askItemFor(query)];
}

/** 上下键循环移动，空列表停在 0。 */
export function moveIndex(current: number, delta: number, length: number) {
  if (length <= 0) return 0;
  return (current + delta + length) % length;
}

/** macOS 显示 ⌘，其余显示 Ctrl（Apple HIG：快捷键用平台自己的修饰键符号）。 */
export function modifierLabel(platform: string | undefined | null) {
  return platform && /mac|iphone|ipad/i.test(platform) ? "⌘" : "Ctrl";
}
