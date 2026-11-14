import type { ButtonHTMLAttributes } from "react";
import { cx } from "./cx";

// 开关：一颗胶囊轨道 + 白色圆钮。开 = 墨黑轨道（和主按钮同一支墨，不用彩色），关 = 半透明墨轨道。
// 语义是 role="switch" + aria-checked，空格 / 回车切换（原生 button 自带）；必须给 aria-label 或可见文字。
export function Switch({ checked, onCheckedChange, disabled, className, ...props }: {
  checked: boolean; onCheckedChange?: (checked: boolean) => void;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "role">) {
  return (
    <button type="button" role="switch" aria-checked={checked} disabled={disabled} className={cx("ou-switch", className)}
      onClick={(e) => { e.stopPropagation(); onCheckedChange?.(!checked); }} {...props}>
      <span className="ou-switch-thumb" aria-hidden />
    </button>
  );
}
