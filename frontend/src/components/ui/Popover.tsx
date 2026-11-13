import * as RadixPopover from "@radix-ui/react-popover";
import type { CSSProperties, ReactNode } from "react";
import { cx } from "./cx";

// 浮层面板（筛选、排序、字段设置、上下文用量）：和 Menu 同一块浅色玻璃（22px 圆角、半透明白 + 重模糊、柔和大阴影），
// 碰撞翻转、Esc / 点外面关闭、焦点归还交给 Radix。
export function Popover({ trigger, children, align = "end", side, className, style, label }: {
  trigger: ReactNode; children: ReactNode; align?: "start" | "center" | "end"; side?: "top" | "right" | "bottom" | "left";
  className?: string; style?: CSSProperties; label?: string;
}) {
  return (
    <RadixPopover.Root>
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content align={align} side={side} sideOffset={6} collisionPadding={12} aria-label={label} style={style}
          className={cx("ou-floating ou-popover", className)}>
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
