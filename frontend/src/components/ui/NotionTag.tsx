import type { ReactNode } from "react";

/** Notion 的标签色板：浅底深字，同一种东西永远同一种颜色。 */
export const TAG_COLORS = {
  gray: "bg-[#f1f1ef] text-[#787774]",
  default: "bg-[rgba(227,226,224,0.6)] text-[#32302c]",
  brown: "bg-[#f4eeee] text-[#64473a]",
  orange: "bg-[#fbecdd] text-[#9a5216]",
  yellow: "bg-[#fbf3db] text-[#7f5e10]",
  green: "bg-[#edf3ec] text-[#346538]",
  blue: "bg-[#e7f3f8] text-[#1f5a7a]",
  purple: "bg-[#f6f3f9] text-[#6940a5]",
  pink: "bg-[#faf1f5] text-[#ad1a72]",
  red: "bg-[#fdebec] text-[#9f2f2d]",
} as const;

export type TagColor = keyof typeof TAG_COLORS;

export function NotionTag({ color = "default", children }: { color?: TagColor; children: ReactNode }) {
  return (
    <span className={`inline-flex h-5 max-w-full items-center truncate rounded-[4px] px-1.5 text-[12px] leading-5 ${TAG_COLORS[color]}`}>
      {children}
    </span>
  );
}

const AVATAR_COLORS: TagColor[] = ["orange", "blue", "green", "purple", "pink", "brown", "yellow", "red"];

/** 按名字稳定取色的首字头像（公司没有 logo 时用）。 */
export function LetterAvatar({ name, size = 22 }: { name: string; size?: number }) {
  const text = (name || "?").trim() || "?";
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const color = AVATAR_COLORS[hash % AVATAR_COLORS.length];
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-[5px] font-semibold ${TAG_COLORS[color]}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.55) }}
      aria-hidden="true"
    >
      {text.slice(0, 1)}
    </span>
  );
}

/** Notion 画廊卡片的外框：白底、极细描边加一层很浅的阴影，悬停只轻微加深。 */
export const NOTION_CARD =
  "rounded-[10px] bg-white shadow-[0_0_0_1px_rgba(15,15,15,0.07),0_2px_4px_rgba(15,15,15,0.04)] transition-[background-color,box-shadow] duration-150 hover:bg-[#fcfcfb] hover:shadow-[0_0_0_1px_rgba(15,15,15,0.09),0_4px_12px_rgba(15,15,15,0.07)]";
