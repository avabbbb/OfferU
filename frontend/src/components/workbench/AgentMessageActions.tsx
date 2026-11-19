"use client";

// 消息下方的小操作（复制、引用、从这里分叉）与看大图。
// 复制按钮移植自 avabbbb/Flovart@28c79bf:components/agent/AgentCopyButton.tsx 与 agentTranscript.ts 的
// copyToClipboard（MIT）；看大图对应 Flovart 的 AgentMediaTiles 预览，OfferU 用 components/ui 的 Dialog。

import { Check, ChevronLeft, ChevronRight, Copy, GitBranch, Quote, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Dialog } from "@/components/ui";
import { ApiImg } from "@/lib/apiAsset";
import { quotePreview } from "@/lib/agentQuote";
import { selectionWithin } from "@/lib/agentMessageBranch";

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 权限被拒时走回退路径。
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/** 图标按钮 + 一瞬间的「已复制」确认；文案放在 title / aria-label 上。 */
export function AgentCopyButton({ text, label = "复制", copiedLabel = "已复制" }: { text: string; label?: string; copiedLabel?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const current = copied ? copiedLabel : label;
  return (
    <button
      type="button"
      className={copied ? "agent-msg-action is-done" : "agent-msg-action"}
      title={current}
      aria-label={current}
      data-testid="agent-copy"
      onClick={async () => {
        if (!await copyToClipboard(text)) return;
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1600);
      }}
    >
      {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
    </button>
  );
}

export function AgentMessageAction({ label, icon, onClick, disabled, testId }: { label: string; icon: ReactNode; onClick: () => void; disabled?: boolean; testId?: string }) {
  return (
    <button type="button" className="agent-msg-action" title={label} aria-label={label} onClick={onClick} disabled={disabled} data-testid={testId}>
      {icon}
    </button>
  );
}

// ---- 引用 / 分叉 ----

/** 输入框上方的引用条：一行预览 + 取消（×）。Esc 取消由输入框处理。 */
export function AgentQuoteChip({ quote, onClear }: { quote: string; onClear: () => void }) {
  return (
    <div className="agent-quote-chip" data-testid="agent-quote-chip">
      <Quote size={12} aria-hidden />
      <span className="agent-quote-chip__text" title={quote}>{quotePreview(quote)}</span>
      <button type="button" className="agent-quote-chip__close" aria-label="取消引用（Esc）" onClick={onClear}>
        <X size={12} aria-hidden />
      </button>
    </div>
  );
}

/**
 * 消息工具条上的「引用」「分叉」两个按钮。引用：选区落在这条消息里就只引用选中的部分，否则引用整条（fallbackText）。
 * 按下时先记住选区——有的浏览器点按钮会把选区清掉。
 */
export function AgentQuoteBranchActions({ rowRef, fallbackText, onQuote, onBranch, branchDisabled }: {
  rowRef: RefObject<HTMLElement | null>;
  fallbackText: string;
  onQuote?: (text: string) => void;
  onBranch?: () => void;
  branchDisabled?: boolean;
}) {
  const pendingSelection = useRef("");
  return (
    <>
      {onQuote && (
        <span className="contents" onPointerDownCapture={() => { pendingSelection.current = selectionWithin(rowRef.current); }}>
          <AgentMessageAction label="引用到输入框（有选中文字时只引用选中部分）" icon={<Quote size={13} aria-hidden />} testId="agent-quote"
            onClick={() => {
              const picked = pendingSelection.current || selectionWithin(rowRef.current);
              pendingSelection.current = "";
              onQuote(picked || fallbackText);
            }} />
        </span>
      )}
      {onBranch && (
        <AgentMessageAction label="从这里分叉成新对话" icon={<GitBranch size={13} aria-hidden />} testId="agent-branch"
          onClick={onBranch} disabled={branchDisabled} />
      )}
    </>
  );
}

// ---- 看大图 ----

export const AGENT_IMAGE_VIEW_EVENT = "offeru-agent-image-view";

export interface ImageViewRequest {
  images: Array<{ src: string; name: string }>;
  index: number;
}

/** 消息里的任意图片（附件、Markdown 图）都发这个事件，面板里的 AgentImageViewer 接住。 */
export function openAgentImage(request: ImageViewRequest) {
  window.dispatchEvent(new CustomEvent<ImageViewRequest>(AGENT_IMAGE_VIEW_EVENT, { detail: request }));
}

/** 大图浮层：←/→ 切换同一条消息里的图，Esc 关闭（Radix Dialog 负责焦点锁定与归还）。 */
export function AgentImageViewer() {
  const [request, setRequest] = useState<ImageViewRequest | null>(null);
  useEffect(() => {
    const open = (event: Event) => setRequest((event as CustomEvent<ImageViewRequest>).detail);
    window.addEventListener(AGENT_IMAGE_VIEW_EVENT, open);
    return () => window.removeEventListener(AGENT_IMAGE_VIEW_EVENT, open);
  }, []);
  if (!request || !request.images.length) return null;
  const count = request.images.length;
  const index = ((request.index % count) + count) % count;
  const image = request.images[index];
  const go = (delta: number) => setRequest({ ...request, index: index + delta });
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (count < 2) return;
    if (event.key === "ArrowRight") { event.preventDefault(); go(1); }
    if (event.key === "ArrowLeft") { event.preventDefault(); go(-1); }
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) setRequest(null); }} title={image.name || "图片"} className="ou-dialog-media">
      <div className="ou-image-viewer" data-testid="agent-image-viewer" onKeyDown={onKeyDown}>
        <ApiImg src={image.src} alt={image.name} />
        {count > 1 && (
          <div className="ou-image-viewer-bar">
            <button type="button" className="ou-icon-button" aria-label="上一张（←）" onClick={() => go(-1)}><ChevronLeft size={16} aria-hidden /></button>
            <span>{index + 1} / {count} · ←→ 切换</span>
            <button type="button" className="ou-icon-button" aria-label="下一张（→）" onClick={() => go(1)}><ChevronRight size={16} aria-hidden /></button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
