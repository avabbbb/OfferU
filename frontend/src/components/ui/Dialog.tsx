import * as RadixDialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";

// 弹窗：L4 + 遮罩。标题一行、正文、底部右对齐操作（主按钮在最右）。Esc 与点遮罩关闭，焦点锁定由 Radix 负责。
export function Dialog({ open, onOpenChange, title, description, children, footer }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="ou-scrim" />
        <RadixDialog.Content className="ou-dialog">
          <div className="ou-dialog-head">
            <RadixDialog.Title className="ou-dialog-title">{title}</RadixDialog.Title>
            <RadixDialog.Close className="ou-icon-button" aria-label="关闭"><X size={16} aria-hidden /></RadixDialog.Close>
          </div>
          {description ? <RadixDialog.Description className="ou-dialog-description">{description}</RadixDialog.Description> : null}
          {children}
          {footer ? <div className="ou-dialog-footer">{footer}</div> : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
