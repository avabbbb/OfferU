import type { ReactNode } from "react";

// 状态 / 标签胶囊：浅底 + 深字 + 同色描边 + 圆点，九个色相见 --ou-tone-*。颜色只是辅助，文字必须能单独说明含义。
export type Tone = "gray" | "brown" | "orange" | "yellow" | "green" | "blue" | "purple" | "pink" | "red";
export const TONES: Tone[] = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];

/** 同一个文字永远落到同一个色相。 */
export function toneOf(text: string): Tone {
  let hash = 0;
  for (const ch of text) hash = ((hash << 5) - hash + (ch.codePointAt(0) ?? 0)) >>> 0;
  return TONES[hash % TONES.length];
}

export function Pill({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return <span className={`ou-pill ou-tone-${tone}`} title={title}><span className="truncate">{children}</span></span>;
}
