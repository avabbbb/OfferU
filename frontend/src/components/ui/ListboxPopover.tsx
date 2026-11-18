import * as RadixPopover from "@radix-ui/react-popover";
import { ArrowRight } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { cx } from "./cx";
import type { ListboxKeyboard } from "@/lib/useListboxKeyboard";

// 跟着输入框走的候选列表（「/」命令、@ 引用这类「边打字边选」的浮层）：和 Menu 同一块浅色玻璃、同一种 40px 胶囊行，
// 但焦点始终留在输入框里——高亮项靠 aria-activedescendant 表示，↑/↓ 移动、Enter 选择、Esc 关闭都由调用方的
// useListboxKeyboard 处理（lib/useListboxKeyboard.ts）。打开 / 关闭不抢焦点；点输入框本身不算「点外面」。
export interface ListboxOption {
  id: string;
  label: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  /** 分组名：相邻同组只出一次小标题。 */
  group?: string;
  /** 行尾的小字（如「/new」）。 */
  hint?: string;
}

export function ListboxPopover({ open, onOpenChange, anchorRef, options, listbox, onPick, label, empty, side = "top", align = "start", className, testId }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 浮层贴着的元素（一般是输入框外层卡片），不用改动它的 DOM。 */
  anchorRef: RefObject<HTMLElement | null>;
  options: ListboxOption[];
  listbox: ListboxKeyboard;
  onPick: (option: ListboxOption, index: number) => void;
  label: string;
  empty?: ReactNode;
  side?: "top" | "bottom";
  align?: "start" | "center" | "end";
  className?: string;
  testId?: string;
}) {
  let lastGroup: string | undefined;
  return (
    <RadixPopover.Root open={open} onOpenChange={onOpenChange}>
      <RadixPopover.Anchor virtualRef={anchorRef as RefObject<HTMLElement>} />
      <RadixPopover.Portal>
        <RadixPopover.Content side={side} align={align} sideOffset={8} collisionPadding={12} aria-label={label}
          className={cx("ou-floating ou-menu ou-listbox", className)} data-testid={testId}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onInteractOutside={(event) => {
            // 点回输入框（调用方给它标 data-ou-listbox-anchor）不关浮层。
            const target = event.target as HTMLElement | null;
            if (target?.closest?.("[data-ou-listbox-anchor]")) event.preventDefault();
          }}>
          <div {...listbox.getListboxProps({ className: "ou-listbox-list", "aria-label": label })}>
            {options.length === 0 && <p className="ou-listbox-empty">{empty ?? "没有匹配项"}</p>}
            {options.map((option, index) => {
              const heading = option.group && option.group !== lastGroup ? option.group : null;
              lastGroup = option.group;
              return (
                <div key={option.id} role="presentation">
                  {heading && <p className="ou-menu-heading" role="presentation">{heading}</p>}
                  <div {...listbox.getOptionProps(index, {
                    className: "ou-menu-item",
                    onMouseDown: (event) => event.preventDefault(),
                    onClick: () => onPick(option, index),
                  })} aria-selected={index === listbox.activeIndex}
                    data-highlighted={index === listbox.activeIndex ? "" : undefined}>
                    {option.icon ? <span className="ou-menu-icon" aria-hidden>{option.icon}</span> : null}
                    <span className="ou-menu-text">
                      <span className="truncate">{option.label}</span>
                      {option.description ? <span className="ou-menu-description truncate">{option.description}</span> : null}
                    </span>
                    {option.hint ? <kbd className="ou-menu-shortcut">{option.hint}</kbd> : null}
                    <ArrowRight size={14} strokeWidth={1.9} className="ou-menu-arrow" aria-hidden />
                  </div>
                </div>
              );
            })}
          </div>
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
