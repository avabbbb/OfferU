import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { ArrowRight, Check, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

// 操作菜单（更多、行操作、状态切换）：Radix DropdownMenu + 浅色玻璃面板（参考 Inspora · Mona「feature menu」改成浅色）：
// 22px 圆角、半透明白 + 重模糊；一行 40px 胶囊；层级只靠同一支墨色的透明度（不靠字重）；
// 悬停 = 白胶囊浮起 + 文字往右挪一点 + 右侧小箭头淡入（弹簧曲线）。危险项放最后并用红字。
// 级联子菜单（{ items }）：同一块玻璃面板，→ / Enter 展开、← / Esc 收回，键盘与焦点交给 Radix Sub。
export type MenuAction = { label: ReactNode; icon?: ReactNode; shortcut?: string; description?: ReactNode; danger?: boolean; disabled?: boolean; checked?: boolean; onSelect: () => void };
export type MenuSubmenu = { label: ReactNode; icon?: ReactNode; description?: ReactNode; disabled?: boolean; checked?: boolean; items: MenuItem[]; testId?: string };
export type MenuItem =
  | MenuAction
  | MenuSubmenu
  | { heading: ReactNode }
  | "separator";

function ItemBody({ item, trailing }: { item: MenuAction | MenuSubmenu; trailing: ReactNode }) {
  return (
    <>
      {item.icon ? <span className="ou-menu-icon" aria-hidden>{item.icon}</span> : null}
      <span className="ou-menu-text">
        <span className="truncate">{item.label}</span>
        {item.description ? <span className="ou-menu-description">{item.description}</span> : null}
      </span>
      {"shortcut" in item && item.shortcut ? <kbd className="ou-menu-shortcut">{item.shortcut}</kbd> : null}
      {item.checked ? <Check size={14} strokeWidth={2.2} className="ou-menu-check" aria-hidden /> : null}
      {trailing}
    </>
  );
}

function MenuItems({ items }: { items: MenuItem[] }) {
  return (
    <>
      {items.map((item, index) => {
        if (item === "separator") return <Dropdown.Separator key={`sep-${index}`} className="ou-menu-separator" />;
        if ("heading" in item) return <Dropdown.Label key={`h-${index}`} className="ou-menu-heading">{item.heading}</Dropdown.Label>;
        if ("items" in item) {
          return (
            <Dropdown.Sub key={index}>
              <Dropdown.SubTrigger disabled={item.disabled} className="ou-menu-item ou-menu-subtrigger" data-testid={item.testId}
                data-checked={item.checked ? "" : undefined}>
                <ItemBody item={item} trailing={<ChevronRight size={14} strokeWidth={1.9} className="ou-menu-caret" aria-hidden />} />
              </Dropdown.SubTrigger>
              <Dropdown.Portal>
                <Dropdown.SubContent sideOffset={6} alignOffset={-6} collisionPadding={12} className="ou-floating ou-menu">
                  <MenuItems items={item.items} />
                </Dropdown.SubContent>
              </Dropdown.Portal>
            </Dropdown.Sub>
          );
        }
        return (
          <Dropdown.Item key={index} disabled={item.disabled} onSelect={item.onSelect} className="ou-menu-item" data-danger={item.danger ? "" : undefined}
            role={item.checked === undefined ? undefined : "menuitemradio"} aria-checked={item.checked}>
            <ItemBody item={item} trailing={<ArrowRight size={14} strokeWidth={1.9} className="ou-menu-arrow" aria-hidden />} />
          </Dropdown.Item>
        );
      })}
    </>
  );
}

// open / onOpenChange 可选：受控时由调用方决定什么时候打开（例如拖拽把手：拖动是排序，单击才开菜单）。
// checked：单选组（模型、模式）里当前那一项，行尾一个对勾，读屏读作 menuitemradio。
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
          <MenuItems items={items} />
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
