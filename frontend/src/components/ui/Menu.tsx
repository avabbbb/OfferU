import * as Dropdown from "@radix-ui/react-dropdown-menu";
import type { ReactNode } from "react";

// 操作菜单（更多、行操作、状态切换）：Radix DropdownMenu + L3 浮层。每项 = 图标 + 文字 + 可选快捷键，危险项放最后并用红字。
export type MenuItem = { label: ReactNode; icon?: ReactNode; shortcut?: string; danger?: boolean; disabled?: boolean; onSelect: () => void } | "separator";

export function Menu({ trigger, items, align = "end" }: { trigger: ReactNode; items: MenuItem[]; align?: "start" | "center" | "end" }) {
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>{trigger}</Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content align={align} sideOffset={4} className="ou-floating ou-menu">
          {items.map((item, index) =>
            item === "separator" ? (
              <Dropdown.Separator key={`sep-${index}`} className="ou-menu-separator" />
            ) : (
              <Dropdown.Item key={index} disabled={item.disabled} onSelect={item.onSelect} className="ou-menu-item" data-danger={item.danger ? "" : undefined}>
                {item.icon ? <span className="ou-menu-icon" aria-hidden>{item.icon}</span> : null}
                <span className="ou-menu-text">{item.label}</span>
                {item.shortcut ? <kbd className="ou-menu-shortcut">{item.shortcut}</kbd> : null}
              </Dropdown.Item>
            ),
          )}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
