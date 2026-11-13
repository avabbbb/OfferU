import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from "react";
import { cx } from "./cx";

// 表单字段 = 标签 + 控件 + 一行提示。输入框一律正文字体（等宽只给代码）；说明文字不超过一行，长说明放「了解更多」。
export function Field({ label, hint, error, children, id }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; children: (id: string) => ReactNode; id?: string }) {
  const auto = useId();
  const fieldId = id ?? auto;
  return (
    <div className="ou-field">
      <label className="ou-field-label" htmlFor={fieldId}>{label}</label>
      {children(fieldId)}
      {error ? <p className="ou-field-error" role="alert">{error}</p> : hint ? <p className="ou-field-hint">{hint}</p> : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cx("ou-input", className)} {...props} />;
});
