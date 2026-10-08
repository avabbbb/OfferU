"use client";

/**
 * 简历画布上的 AI 协作层（切片 ②）：
 * - InlineProposal：AI 建议落在它要改的那一段里，按块「采用 / 修改 / 跳过」；
 * - CanvasSelectionBar：选中文字后的浮条，「更精炼 / 对齐岗位 / 换个说法 / 留言」；
 * - CommentTray：修改意见先堆着，攒够了一次交给 Agent。
 *
 * 这些控件全部带 data-paper-chrome，打印 / 导出时不存在。
 */

import { useEffect, useRef, useState, type RefObject } from "react";
import { Check, MessageSquarePlus, PenLine, Sparkles, X } from "lucide-react";
import { diffText, proposalTextChanges, type ProposalTextChange } from "./proposalDiff";

export interface InlineChange {
  change_id: string;
  change_type?: string;
  title?: string;
  before?: any;
  after?: any;
  rationale?: string;
  reason?: string;
}

export function DiffLine({ change }: { change: ProposalTextChange }) {
  const segments = diffText(change.before, change.after);
  return (
    <p className="paper-diff-line">
      {segments.map((segment, index) => (
        <span key={index} className={`paper-diff-${segment.kind}`}>{segment.text}</span>
      ))}
    </p>
  );
}

export function InlineProposal({
  change,
  conflict,
  factGateBlocked,
  busy,
  onAccept,
  onSkip,
  onAskRewrite,
}: {
  change: InlineChange;
  conflict: boolean;
  factGateBlocked: boolean;
  busy: boolean;
  onAccept: (editedText?: string) => void;
  onSkip: () => void;
  onAskRewrite: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const editRef = useRef<HTMLSpanElement | null>(null);
  const lines = proposalTextChanges(change);
  const editableLine = lines.length === 1 ? lines[0] : null;
  const reason = change.rationale || change.reason || "";
  const structural = change.change_type === "removed"
    ? "建议隐藏这一段"
    : change.change_type === "reordered"
      ? "建议调整这一段的位置"
      : change.change_type === "added"
        ? `建议新增段落「${change.after?.title || change.title || ""}」`
        : "";
  const acceptBlocked = conflict || factGateBlocked;

  useEffect(() => {
    if (editing && editRef.current) {
      editRef.current.textContent = editableLine?.after || "";
      editRef.current.focus();
    }
  }, [editing, editableLine?.after]);

  return (
    <div className="paper-proposal" data-paper-chrome="" data-testid={`inline-proposal-${change.change_id}`}>
      <div className="paper-proposal-head">
        <span className="paper-proposal-tag"><Sparkles size={11} aria-hidden /> AI 建议</span>
        {reason && <span className="paper-proposal-reason">{reason}</span>}
      </div>
      {conflict && (
        <p className="paper-proposal-conflict" role="note">
          你在建议生成后改过这段，以你的版本为准。这条建议基于旧内容，不能直接采用。
        </p>
      )}
      {structural && <p className="paper-proposal-structural">{structural}</p>}
      {!editing && lines.map((line, index) => (
        <div key={index} className="paper-proposal-change">
          <span className="paper-proposal-label">{line.label}</span>
          <DiffLine change={line} />
        </div>
      ))}
      {editing && editableLine && (
        <div className="paper-proposal-change">
          <span className="paper-proposal-label">{editableLine.label} · 改成你想要的样子</span>
          <span
            ref={editRef}
            role="textbox"
            aria-label="修改 AI 建议"
            contentEditable="plaintext-only"
            suppressContentEditableWarning
            className="paper-proposal-edit"
          />
        </div>
      )}
      <div className="paper-proposal-actions">
        {editing ? (
          <>
            <button type="button" disabled={busy || acceptBlocked} className="is-primary"
              onClick={() => { onAccept((editRef.current?.textContent || "").trim()); setEditing(false); }}>
              <Check size={11} aria-hidden /> 按我的改法采用
            </button>
            <button type="button" onClick={() => setEditing(false)}>取消</button>
          </>
        ) : (
          <>
            <button type="button" disabled={busy || acceptBlocked} className="is-primary" onClick={() => onAccept()}
              title={factGateBlocked ? "事实门未通过，请先补充证据" : conflict ? "这段你改过，先跳过或让 AI 重写" : undefined}>
              <Check size={11} aria-hidden /> 采用
            </button>
            <button type="button" disabled={busy || acceptBlocked || !editableLine} onClick={() => setEditing(true)}
              title={!editableLine ? "这条建议改了多处：先采用，再直接在页面上改" : undefined}>
              <PenLine size={11} aria-hidden /> 修改
            </button>
            <button type="button" disabled={busy} onClick={onSkip}><X size={11} aria-hidden /> 跳过</button>
            {conflict && <button type="button" disabled={busy} onClick={onAskRewrite}>让 AI 按我的版本重写</button>}
          </>
        )}
      </div>
    </div>
  );
}

export interface CanvasComment {
  id: string;
  quote: string;
  section: string;
  instruction: string;
}

const QUICK_INSTRUCTIONS: Array<[string, string]> = [
  ["更精炼", "更精炼：保留事实和数字，删掉空话，控制在一行内"],
  ["对齐岗位", "对齐目标岗位：用 JD 里的关键词重写，但只能使用已有事实"],
  ["换个说法", "换个说法：意思不变，用更有力的动词开头"],
];

export function CanvasSelectionBar({
  containerRef,
  onAddComment,
}: {
  containerRef: RefObject<HTMLElement | null>;
  onAddComment: (comment: Omit<CanvasComment, "id">) => void;
}) {
  const [anchor, setAnchor] = useState<{ top: number; left: number; quote: string; section: string } | null>(null);
  const [writing, setWriting] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const update = () => {
      const selection = window.getSelection();
      const quote = selection?.toString().trim() || "";
      if (!selection || selection.isCollapsed || quote.length < 2 || !selection.rangeCount) {
        if (!writing) setAnchor(null);
        return;
      }
      const range = selection.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) return;
      const rect = range.getBoundingClientRect();
      const host = container.getBoundingClientRect();
      const sectionNode = (range.startContainer.parentElement || null)?.closest("[data-section-type]");
      const section = sectionNode?.querySelector(".paper-section-title")?.textContent?.trim()
        || ((range.startContainer.parentElement || null)?.closest(".paper-header") ? "抬头" : "简介");
      setAnchor({
        top: rect.top - host.top - 34,
        left: Math.max(0, rect.left - host.left),
        quote: quote.slice(0, 400),
        section,
      });
    };
    container.addEventListener("mouseup", update);
    container.addEventListener("keyup", update);
    return () => {
      container.removeEventListener("mouseup", update);
      container.removeEventListener("keyup", update);
    };
  }, [containerRef, writing]);

  if (!anchor) return null;
  const add = (instruction: string) => {
    onAddComment({ quote: anchor.quote, section: anchor.section, instruction });
    setAnchor(null); setWriting(false); setNote("");
    window.getSelection()?.removeAllRanges();
  };

  return (
    <div className="paper-selection-bar" data-paper-chrome="" role="toolbar" aria-label="选中文字的修改意见"
      style={{ top: anchor.top, left: anchor.left }} onMouseDown={(event) => { if (!writing) event.preventDefault(); }}>
      {writing ? (
        <form onSubmit={(event) => { event.preventDefault(); if (note.trim()) add(note.trim()); }} className="flex items-center gap-1">
          <input autoFocus value={note} onChange={(event) => setNote(event.target.value)} aria-label="给 AI 的留言"
            placeholder="想怎么改？例如：突出我带的 3 人小组" className="paper-selection-input" />
          <button type="submit" disabled={!note.trim()}>加入</button>
          <button type="button" onClick={() => { setWriting(false); setAnchor(null); }}>取消</button>
        </form>
      ) : (
        <>
          {QUICK_INSTRUCTIONS.map(([label, instruction]) => (
            <button key={label} type="button" onClick={() => add(instruction)}>{label}</button>
          ))}
          <button type="button" onClick={() => setWriting(true)}><MessageSquarePlus size={11} aria-hidden /> 留言给 AI</button>
        </>
      )}
    </div>
  );
}

export function buildCommentPrompt(resumeId: number, targetLabel: string, comments: CanvasComment[]) {
  const lines = comments.map((comment, index) =>
    `${index + 1}. 【${comment.section}】「${comment.quote}」→ ${comment.instruction}`,
  );
  return [
    `请修改岗位简历 #${resumeId}（目标：${targetLabel}）中我圈出的内容：`,
    ...lines,
    "",
    "要求：",
    "- 先用 get_resume_workspace 读取当前版本：我刚在页面上手动改过，它是最新的，不要基于旧内容改写；",
    "- 只改我圈出的文字，其他内容保持原样；",
    "- 新增的数字、公司、成果必须来自已验证档案（Evidence）；没有证据就先问我，不要编造；",
    "- 以可审核的修改建议提交，让我在页面上逐条采用、修改或跳过，不要直接覆盖。",
  ].join("\n");
}

export function CommentTray({
  comments,
  onRemove,
  onSubmit,
}: {
  comments: CanvasComment[];
  onRemove: (id: string) => void;
  onSubmit: () => void;
}) {
  if (!comments.length) return null;
  return (
    <div className="paper-comment-tray" data-paper-chrome="" data-testid="resume-comment-tray">
      <div className="paper-comment-tray-head">
        <span>{comments.length} 条修改意见</span>
        <button type="button" className="is-primary" onClick={onSubmit}>一次交给 AI</button>
      </div>
      <ol>
        {comments.map((comment) => (
          <li key={comment.id}>
            <span className="paper-comment-quote">「{comment.quote}」</span>
            <span className="paper-comment-instruction">{comment.instruction}</span>
            <button type="button" aria-label="删除这条意见" onClick={() => onRemove(comment.id)}><X size={11} aria-hidden /></button>
          </li>
        ))}
      </ol>
    </div>
  );
}
