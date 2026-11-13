import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";

// 操作菜单（更多、行操作、状态切换）：Radix DropdownMenu + 浅色玻璃面板（参考 Inspora · Mona「feature menu」改成浅色）：
// 22px 圆角、半透明白 + 重模糊；一行 40px 胶囊；层级只靠同一支墨色的透明度（不靠字重）；
// 悬停 = 白胶囊浮起 + 文字往右挪一点 + 右侧小箭头淡入（弹簧曲线）。危险项放最后并用红字。
export type MenuItem =
  | { label: ReactNode; icon?: ReactNode; shortcut?: string; description?: ReactNode; danger?: boolean; disabled?: boolean; onSelect: () => void }
  | { heading: ReactNode }
  | "separator";

// open / onOpenChange 可选：受控时由调用方决定什么时候打开（例如拖拽把手：拖动是排序，单击才开菜单）。
// onCloseAutoFocus：菜单关掉时默认把焦点还给触发器；某一项要把焦点放到别处（如新建的块）时在这里 preventDefault。
export function Menu({ trigger, items, align = "end", side, open, onOpenChange, onCloseAutoFocus, label }: {
  trigger: ReactNode; items: MenuItem[]; align?: "start" | "center" | "end"; side?: "top" | "right" | "bottom" | "left";
  open?: boolean; onOpenChange?: (open: boolean) => void; onCloseAutoFocus?: (event: Event) => void; label?: string;
}) {
  return (
    <Dropdown.Root open={open} onOpenChange={onOpenChange}>
      <Dropdown.Trigger asChild>{trigger}</Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content align={align} side={side} sideOffset={6} collisionPadding={12} aria-label={label}
          className="ou-floating ou-menu" onCloseAutoFocus={onCloseAutoFocus}>
          {items.map((item, index) => {
            if (item === "separator") return <Dropdown.Separator key={`sep-${index}`} className="ou-menu-separator" />;
            if ("heading" in item) return <Dropdown.Label key={`h-${index}`} className="ou-menu-heading">{item.heading}</Dropdown.Label>;
            return (
              <Dropdown.Item key={index} disabled={item.disabled} onSelect={item.onSelect} className="ou-menu-item" data-danger={item.danger ? "" : undefined}>
                {item.icon ? <span className="ou-menu-icon" aria-hidden>{item.icon}</span> : null}
                <span className="ou-menu-text">
                  <span className="truncate">{item.label}</span>
                  {item.description ? <span className="ou-menu-description">{item.description}</span> : null}
                </span>
                {item.shortcut ? <kbd className="ou-menu-shortcut">{item.shortcut}</kbd> : null}
                <ArrowRight size={14} strokeWidth={1.9} className="ou-menu-arrow" aria-hidden />
              </Dropdown.Item>
            );
          })}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
