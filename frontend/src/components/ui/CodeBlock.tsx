import { Check, Copy } from "lucide-react";
import { useState } from "react";

// 只读代码块 + 右上角复制按钮：给用户粘到别处的配置（CORS 规则、连接码、命令）。
export function CodeBlock({ code, label, wrap }: { code: string; label: string; wrap?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="ou-code-block" data-wrap={wrap ? "" : undefined}>
      <pre aria-label={label} tabIndex={0}>{code}</pre>
      <button type="button" className="ou-icon-button ou-code-copy" onClick={() => void copy()} aria-label={copied ? "已复制" : `复制${label}`} title={copied ? "已复制" : "复制"}>
        {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
      </button>
    </div>
  );
}
