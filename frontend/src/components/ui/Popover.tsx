import * as RadixPopover from "@radix-ui/react-popover";
import type { ReactNode } from "react";
import { cx } from "./cx";

// 浮层面板（筛选、排序、字段设置、上下文用量）：L3 = 1px 控件描边 + 8/24 阴影，圆角 --ou-radius-floating。
export function Popover({ trigger, children, align = "end", className }: { trigger: ReactNode; children: ReactNode; align?: "start" | "center" | "end"; className?: string }) {
  return (
    <RadixPopover.Root>
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content align={align} sideOffset={6} collisionPadding={12} className={cx("ou-floating ou-popover", className)}>
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
