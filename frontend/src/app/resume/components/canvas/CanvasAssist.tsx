"use client";

/**
 * 简历编辑器的 AI 协作层：
 * - SuggestionCard：右侧「建议」里的一条 AI 改动，「采用 / 不用 / 修改」；
 * - CanvasSelectionBar：选中文字后的浮条，「更精炼 / 对齐岗位 / 换个说法 / 留言」；
 * - CommentTray：修改意见先堆着，攒够了一次交给 Agent。
 *
 * 纸上的控件带 data-paper-chrome，打印 / 导出时不存在。
 */

import { useEffect, useRef, useState, type RefObject } from "react";
import { MessageSquarePlus, X } from "lucide-react";
import { diffText, proposalTextChanges, type ProposalTextChange } from "./proposalDiff";

export interface InlineChange {
  change_id: string;
  change_type?: string;
  title?: string;
  before?: any;
  after?: any;
  rationale?: string;
  reason?: string;
  /** 模型根据档案推断出的技能：可以采用，但必须逐条确认属实。 */
  inferred_skills?: Array<{ skill: string; basis?: string }>;
  /** 逐条事实检查：只拦这一条，不影响其他建议。 */
  fact_gate?: { status: "passed" | "blocked"; warnings?: string[] };
}

/** 建议卡上的一句话：原句删除线，新句里新增的字加粗。 */
function ChangedLine({ change }: { change: ProposalTextChange }) {
  const segments = diffText(change.before, change.after);
  return (
    <div className="space-y-1">
      {change.before && <p className="text-[13px] leading-5 text-[#9b9a97] line-through decoration-[#c9c7c1]">{change.before}</p>}
      <p className="text-[14px] leading-6 text-[#191919]">
        {segments.filter((segment) => segment.kind !== "removed").map((segment, index) => (
          segment.kind === "added" ? <strong key={index} className="font-semibold" data-diff="added">{segment.text}</strong> : <span key={index}>{segment.text}</span>
        ))}
      </p>
    </div>
  );
}

/**
 * 右侧「建议」里的一张卡：哪一段 · 原句 → 新句 · 为什么改 · 采用 / 不用。
 * 点卡片会在左边的纸上定位到这一段。
 */
export function SuggestionCard({
  change,
  sectionLabel,
  conflict,
  factGateBlocked,
  busy,
  onAccept,
  onSkip,
  onAskRewrite,
  onLocate,
}: {
  change: InlineChange;
  sectionLabel: string;
  conflict: boolean;
  factGateBlocked: boolean;
  busy: boolean;
  onAccept: (editedText?: string) => void;
  onSkip: () => void;
  onAskRewrite: () => void;
  onLocate?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const editRef = useRef<HTMLDivElement | null>(null);
  const lines = proposalTextChanges(change);
  const editableLine = lines.length === 1 ? lines[0] : null;
  const reason = change.rationale || change.reason || "";
  const structural = change.change_type === "removed"
    ? "建议隐藏这一段"
    : change.change_type === "reordered"
      ? "建议调整这一段的位置"
      : change.change_type === "added"
        ? `建议新增「${change.after?.title || change.title || ""}」`
        : "";
  const gateBlocked = change.fact_gate ? change.fact_gate.status === "blocked" : factGateBlocked;
  const acceptBlocked = conflict || gateBlocked;
  const inferred = (change.inferred_skills || []).filter((item) => item && item.skill);
  const location = [sectionLabel, editableLine?.label.split(" · ")[0]].filter(Boolean).join(" · ");

  useEffect(() => {
    if (editing && editRef.current) {
      editRef.current.textContent = editableLine?.after || "";
      editRef.current.focus();
    }
  }, [editing, editableLine?.after]);

  return (
    <article
      className="rounded-xl border border-black/[0.07] bg-white p-4 transition-shadow hover:shadow-[0_2px_10px_rgba(15,15,15,0.06)]"
      data-testid={`suggestion-${change.change_id}`}
      onClick={(event) => { if (!(event.target as HTMLElement).closest("button,[contenteditable]")) onLocate?.(); }}
    >
      <p className="text-[12px] text-[#9b9a97]">{location || "简历"}</p>
      {structural && <p className="mt-2 text-[14px] text-[#191919]">{structural}</p>}
      {!editing && <div className="mt-2 space-y-3">{lines.map((line, index) => <ChangedLine key={index} change={line} />)}</div>}
      {editing && editableLine && (
        <div ref={editRef} role="textbox" aria-label="修改 AI 建议" contentEditable="plaintext-only" suppressContentEditableWarning
          className="mt-2 rounded-lg border border-black/15 px-3 py-2 text-[14px] leading-6 outline-none focus:border-black/40" />
      )}
      {reason && <p className="mt-3 rounded-lg bg-[#f7f7f5] px-3 py-2 text-[12px] leading-5 text-[#787774]">{reason}</p>}
      {inferred.length > 0 && (
        <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-[12px] leading-5 text-amber-900" role="note" aria-label="模型推断的技能">
          <p>这些说法档案里没有直接写，是模型推断的，面试会被追问：</p>
          <ul className="mt-1 space-y-0.5">
            {inferred.map((item) => <li key={item.skill}><span className="font-medium">{item.skill}</span>{item.basis ? `　依据：「${item.basis}」` : "　依据缺失"}</li>)}
          </ul>
        </div>
      )}
      {conflict && <p className="mt-3 text-[12px] leading-5 text-amber-800" role="note">你在建议生成后改过这段，以你的版本为准，这条不能直接采用。</p>}
      {change.fact_gate?.status === "blocked" && (
        <p className="mt-3 text-[12px] leading-5 text-amber-800" role="note">没通过事实检查：{(change.fact_gate.warnings || []).join("；") || "含档案里没有的数字或名称"}。</p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {editing ? (
          <>
            <button type="button" disabled={busy || acceptBlocked} className="h-8 rounded-lg bg-[#191919] px-3 text-[13px] font-medium text-white disabled:opacity-40"
              onClick={() => { onAccept((editRef.current?.textContent || "").trim()); setEditing(false); }}>按我的改法采用</button>
            <button type="button" className="h-8 rounded-lg border border-black/10 px-3 text-[13px] text-[#37352f] hover:bg-black/[0.03]" onClick={() => setEditing(false)}>取消</button>
          </>
        ) : (
          <>
            <button type="button" disabled={busy || acceptBlocked} onClick={() => onAccept()}
              title={gateBlocked ? "这一条没有通过事实检查" : conflict ? "这段你改过，先跳过或让 AI 重写" : undefined}
              className="h-8 rounded-lg bg-[#191919] px-3 text-[13px] font-medium text-white disabled:opacity-40">{inferred.length ? "属实，采用" : "采用"}</button>
            <button type="button" disabled={busy} onClick={onSkip} className="h-8 rounded-lg border border-black/10 px-3 text-[13px] text-[#37352f] hover:bg-black/[0.03] disabled:opacity-40">不用</button>
            {editableLine && !acceptBlocked && (
              <button type="button" disabled={busy} onClick={() => setEditing(true)} className="h-8 rounded-lg px-2 text-[13px] text-[#787774] hover:bg-black/[0.03] disabled:opacity-40">修改</button>
            )}
            {conflict && <button type="button" disabled={busy} onClick={onAskRewrite} className="h-8 rounded-lg px-2 text-[13px] text-[#787774] hover:bg-black/[0.03]">让 AI 按我的版本重写</button>}
          </>
        )}
      </div>
    </article>
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
