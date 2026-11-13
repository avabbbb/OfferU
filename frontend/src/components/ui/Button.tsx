import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cx } from "./cx";

// 全站只有三种按钮：primary（墨黑实心，一屏最多一个）、secondary（白底描边）、ghost（无底，图标/次要操作）。
// 颜色、圆角、高度都来自 --ou-* token；不要在页面里另写按钮样式。见 docs/design/components.md。
export type ButtonVariant = "primary" | "secondary" | "ghost";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", className, type = "button", ...props },
  ref,
) {
  return <button ref={ref} type={type} className={cx(`ou-button ou-button-${variant}`, size === "sm" && "ou-button-sm", className)} {...props} />;
});
