import * as RadixPopover from "@radix-ui/react-popover";
import { type ReactNode, useMemo } from "react";
import { cx } from "./cx";

// 跟着选区 / 光标走的浮层（编辑器的格式条、/ 菜单）：受控打开，锚点是一块矩形，不抢编辑框的焦点和选区。
// 和 Popover 同一个 L3 外观；层级比弹窗高一层，放大编辑弹窗里也能用。
export function Floating({ open, rect, onClose, side = "top", align = "center", className, label, children }: {
  open: boolean;
  rect: DOMRect | null;
  onClose: () => void;
  side?: "top" | "bottom";
  align?: "start" | "center" | "end";
  className?: string;
  label: string;
  children: ReactNode;
}) {
  const anchor = useMemo(() => ({ current: { getBoundingClientRect: () => rect ?? new DOMRect() } }), [rect]);
  return (
    <RadixPopover.Root open={open && !!rect} onOpenChange={(next) => { if (!next) onClose(); }}>
      <RadixPopover.Anchor virtualRef={anchor} />
      <RadixPopover.Portal>
        <RadixPopover.Content side={side} align={align} sideOffset={6} collisionPadding={12} aria-label={label}
          className={cx("ou-floating ou-caret-floating", className)}
          onOpenAutoFocus={(e) => e.preventDefault()} onCloseAutoFocus={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}>
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
