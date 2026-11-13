import * as RadixSelect from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "./cx";

// 下拉选择：行为交给 Radix（键盘、屏幕阅读器、定位、碰撞翻转），外观只用 token。禁止裸 <select>。
export type SelectOption = { value: string; label: ReactNode; description?: ReactNode; icon?: ReactNode };

export function Select({ value, onValueChange, options, placeholder, id, "aria-label": ariaLabel, size, className }: {
  value?: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  id?: string;
  "aria-label"?: string;
  /** sm：工具栏 / 浮层里的紧凑版（28px 胶囊）。 */
  size?: "sm";
  className?: string;
}) {
  return (
    <span className={cx("ou-select-wrap", className)}>
    <RadixSelect.Root value={value} onValueChange={onValueChange}>
      <RadixSelect.Trigger id={id} aria-label={ariaLabel} className={cx("ou-input ou-select-trigger", size === "sm" && "ou-select-sm")}>
        <RadixSelect.Value placeholder={placeholder} />
        <RadixSelect.Icon><ChevronDown size={14} aria-hidden /></RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content position="popper" sideOffset={4} className="ou-floating ou-select-content">
          <RadixSelect.Viewport>
            {options.map((option) => (
              <RadixSelect.Item key={option.value} value={option.value} className="ou-menu-item">
                {option.icon ? <span className="ou-menu-icon" aria-hidden>{option.icon}</span> : null}
                <span className="ou-menu-text">
                  <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                  {option.description ? <span className="ou-menu-description">{option.description}</span> : null}
                </span>
                <RadixSelect.ItemIndicator className="ou-menu-check"><Check size={14} aria-hidden /></RadixSelect.ItemIndicator>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
    </span>
  );
}
