"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  Check,
  Download,
  Eye,
  EyeOff,
  FileText,
  GripVertical,
  History,
  Loader2,
  Plus,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
  Undo2,
  Wand2,
  X,
} from "lucide-react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { resumeApi, type ResumeOptimizationProposalDetail, type ResumePacketArtifactState, type ResumeWorkspace } from "@/lib/api";
import {
  projectRoleBenchmarkArtifact,
  roleBenchmarkArtifactVerificationLabel,
} from "@/lib/jobPreparationProgress";
import type { ResumeDetail, ResumeSectionBlock } from "@/lib/hooks";
import SectionEditor from "../components/SectionEditor";
import ResumePreview from "../components/ResumePreview";
import ResumeDesignPanel from "../components/ResumeDesignPanel";
import { normalizeTemplateSettings } from "../components/templates/templateSettings";
import { buildCommentPrompt, CanvasSelectionBar, CommentTray, InlineProposal, type CanvasComment, type InlineChange } from "../components/canvas/CanvasAssist";
import { conflictsWithManualEdit, findTargetSection } from "../components/canvas/proposalDiff";
import { composeToAgent } from "@/lib/agentCompose";
import { safeClientErrorMessage } from "@/lib/safe-error";

type DraftResume = ResumeDetail & { sections: ResumeSectionBlock[] };
type SaveState = "idle" | "saving" | "saved" | "failed";

const EDITOR_SECTION_TYPES = [
  ["education", "教育经历"],
  ["workExperiences", "工作经历"],
  ["projects", "项目经历"],
  ["skills", "技能"],
  ["certificates", "证书"],
  ["awards", "获奖经历"],
  ["personalExperiences", "个人经历"],
] as const;

function editorSectionType(type: string) {
  return ({
    experience: "workExperiences",
    project: "projects",
    skill: "skills",
    custom: "personalExperiences",
  } as Record<string, string>)[type] || type;
}

function displayText(value: unknown): string {
  if (typeof value === "string") {
    return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  if (Array.isArray(value)) return value.map(displayText).filter(Boolean).join("；");
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).map(displayText).filter(Boolean).join("；");
  }
  return value == null ? "" : String(value);
}

function proposalChange(change: Record<string, any>) {
  return {
    before: displayText(change.before?.content_json || change.before?.title || ""),
    after: displayText(change.after?.content_json || change.after?.title || ""),
  };
}

function resumeSignature(resume: DraftResume) {
  return JSON.stringify({
    user_name: resume.user_name,
    title: resume.title,
    photo_url: resume.photo_url,
    summary: resume.summary,
    contact_json: resume.contact_json,
    style_config: resume.style_config,
    sections: resume.sections,
  });
}

function SortableSectionCard({
  section,
  onChange,
  onToggle,
  onDelete,
}: {
  section: ResumeSectionBlock;
  onChange: (section: ResumeSectionBlock) => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `section-${section.id}`,
  });
  const type = editorSectionType(section.section_type);
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1 }}
      className="rounded-xl border border-[var(--border-strong)]/15 bg-[var(--surface)] p-3 shadow-[1px_2px_0_rgba(18,18,18,0.08)]"
      data-testid={`resume-section-${section.id}`}
    >
      <div className="mb-3 flex items-center gap-2">
        <button type="button" {...attributes} {...listeners} aria-label="拖拽段落排序" className="cursor-grab text-[var(--foreground-muted)] active:cursor-grabbing"><GripVertical size={15} /></button>
        <input value={section.title || ""} onChange={(event) => onChange({ ...section, title: event.target.value })} aria-label="段落标题" className="min-w-0 flex-1 border-b border-transparent bg-transparent px-1 py-1 text-sm font-black outline-none focus:border-[var(--foreground)]" />
        <button type="button" onClick={onToggle} aria-label={section.visible ? "隐藏段落" : "显示段落"} className="rounded-md p-1.5 text-[var(--foreground-muted)] hover:bg-black/5">{section.visible ? <Eye size={14} /> : <EyeOff size={14} />}</button>
        <button type="button" onClick={onDelete} aria-label="删除段落" className="rounded-md p-1.5 text-red-600 hover:bg-red-50"><Trash2 size={14} /></button>
      </div>
      <SectionEditor sectionType={type} contentJson={section.content_json || []} onChange={(contentJson) => onChange({ ...section, content_json: contentJson })} />
    </div>
  );
}

function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "green" | "orange" | "red" }) {
  const tones = { neutral: "bg-black/5 text-[var(--foreground-muted)]", green: "bg-emerald-100 text-emerald-800", orange: "bg-amber-100 text-amber-800", red: "bg-red-100 text-red-800" };
  return <span className={`rounded-full px-2 py-1 text-[10px] font-bold ${tones[tone]}`}>{children}</span>;
}

type PacketStatus = { label: string; tone: "neutral" | "green" | "orange" | "red" };

function resumePacketStatus(state?: ResumePacketArtifactState["resume"]): PacketStatus {
  if (!state) return { label: "简历状态无法验证", tone: "neutral" };
  if (!state.exists) return { label: "简历尚未关联", tone: "neutral" };
  if (state.ready && state.adopted && state.adoption_status === "adopted") return { label: "简历版本已采纳", tone: "green" };
  if (state.ready && !state.adopted && state.adoption_status === "user_saved") return { label: "简历版本已保存", tone: "green" };
  if (state.ready) return { label: "简历状态无法验证", tone: "neutral" };
  if (state.current_version_matches_resume === false) return { label: "简历版本与当前内容不一致", tone: "orange" };
  if (state.adoption_status === "not_adopted") return { label: "简历提案尚未采纳", tone: "orange" };
  return { label: "简历版本尚未准备", tone: "neutral" };
}

function researchPacketStatus(state: ResumePacketArtifactState["research"] | undefined, jobId: number | null): PacketStatus {
  if (!state) return { label: "岗位研究状态无法验证", tone: "neutral" };
  if (!state.exists && state.proposal_run_id) return { label: "简历提案关联的岗位研究不可用", tone: "orange" };
  if (!state.exists || state.status === "unavailable") return { label: "岗位研究不可用", tone: "neutral" };
  if (state.status === "failed") return { label: "岗位研究失败", tone: "red" };
  if (state.status === "blocked") return { label: "岗位研究受阻", tone: "red" };
  if (state.status === "running") return { label: "岗位研究进行中", tone: "orange" };
  if (state.status === "pending") return { label: "岗位研究等待执行", tone: "orange" };
  if (state.status === "completed" && state.linked_to_resume !== true) return { label: "岗位研究未关联此简历", tone: "orange" };
  if (state.status === "completed" && (!state.run_id || !state.proposal_run_id)) return { label: "岗位研究引用无法验证", tone: "orange" };
  if (state.status === "completed" && state.run_id !== state.proposal_run_id) return { label: "岗位研究与简历提案引用不匹配", tone: "orange" };
  if (state.status === "completed" && state.target_job_matches === false) return { label: "岗位研究关联了其他岗位", tone: "orange" };
  if (state.status === "completed" && (jobId == null || state.target_job_id !== jobId || state.target_job_matches !== true)) {
    return { label: "岗位研究与当前岗位关联无法验证", tone: "orange" };
  }
  if (state.status === "completed" && !state.data_mode) return { label: "岗位研究来源无法验证", tone: "orange" };
  if (state.status === "completed" && state.data_mode === "replay") return { label: "岗位研究回放结果（仅供验收）", tone: "orange" };
  if (state.status === "completed" && state.data_mode && !["live", "fixture", "fixture_plugin"].includes(state.data_mode)) {
    return { label: "岗位研究来源无法验证", tone: "orange" };
  }
  if (state.status === "completed" && (state.data_mode === "fixture" || state.data_mode === "fixture_plugin")) {
    if (state.review_status === "rejected") return { label: "样本岗位研究已拒绝", tone: "neutral" };
    if (state.review_status === "accepted" && state.adopted) {
      return { label: "样本岗位研究已审核", tone: "orange" };
    }
    return { label: "样本岗位研究待审核", tone: "orange" };
  }
  if (state.status === "completed" && state.ready && state.verification_status === "verified" && state.adopted && state.linked_to_resume && state.run_id && state.run_id === state.proposal_run_id) {
    return { label: "岗位研究已审核", tone: "green" };
  }
  if (state.status === "completed" && ["pending", "candidate"].includes(String(state.review_status || ""))) {
    return { label: "岗位研究待审核", tone: "orange" };
  }
  if (state.status === "completed" && state.review_status === "rejected") return { label: "岗位研究已拒绝", tone: "neutral" };
  if (state.status === "completed") return { label: "岗位研究尚未就绪", tone: "orange" };
  return { label: "岗位研究状态无法验证", tone: "neutral" };
}

function benchmarkPacketStatus(state: ResumePacketArtifactState["benchmark"] | undefined): PacketStatus {
  if (!state) return { label: "岗位基准状态无法验证", tone: "neutral" };
  if (!state.exists || state.status === "not_built") return { label: "岗位基准尚未构建", tone: "neutral" };
  if (state.status === "failed") return { label: "岗位基准失败", tone: "red" };
  if (state.status === "blocked") return { label: "岗位基准受阻", tone: "red" };
  if (state.status === "running") return { label: "岗位基准分析中", tone: "orange" };
  if (state.status === "pending") return { label: "岗位基准等待执行", tone: "orange" };
  if (state.status === "completed") {
    const artifact = projectRoleBenchmarkArtifact(state);
    if (artifact === "verified") return { label: "岗位基准已就绪", tone: "green" };
    if (artifact === "fixture") return { label: "样本岗位基准已生成（仅供本地验收）", tone: "orange" };
    if (artifact === "replay") return { label: "岗位基准回放结果（仅供验收）", tone: "orange" };
    if (artifact === "insufficient_sample") return { label: "岗位基准样本不足", tone: "orange" };
    if (artifact === "fixture_insufficient_sample") return { label: "样本岗位基准样本不足（仅供本地验收）", tone: "orange" };
    return { label: roleBenchmarkArtifactVerificationLabel(state), tone: "orange" };
  }
  return { label: "岗位基准状态无法验证", tone: "neutral" };
}

function interviewPacketStatus(state: ResumePacketArtifactState["interview_focus"] | undefined, resumeId: number): PacketStatus {
  if (!state) return { label: "面试准备状态无法验证", tone: "neutral" };
  if (!state.exists || state.status === "not_built") return { label: "面试准备尚未构建", tone: "neutral" };
  if (state.status === "failed") return { label: "面试准备失败", tone: "red" };
  if (state.status === "blocked") return { label: "面试准备受阻", tone: "red" };
  if (state.status === "running" || state.status === "active") return { label: "面试准备进行中", tone: "orange" };
  if (state.status === "completed") {
    if (!state.interview_id || state.resume_id !== resumeId || !state.focus_schema || !state.benchmark_run_id) {
      return { label: "面试准备引用无法验证", tone: "orange" };
    }
    if (state.ready) return { label: "面试准备已就绪", tone: "green" };
    return { label: "面试准备尚未就绪", tone: "orange" };
  }
  return { label: "面试准备状态无法验证", tone: "neutral" };
}

function packetDocumentsStatus(state?: ResumePacketArtifactState["documents"]): PacketStatus {
  if (!state) return { label: "关联材料状态无法验证", tone: "neutral" };
  if (!state.exists || state.count < 1) return { label: "暂无关联材料", tone: "neutral" };
  if (!state.items.length || state.items.length !== state.count) {
    return { label: `${state.count} 份材料的版本无法完整核验`, tone: "orange" };
  }
  const matched = state.items.filter((item) => item.version_matches_resume === true && item.matches_current_version === true).length;
  return {
    label: `${matched} / ${state.count} 当前版本匹配`,
    tone: matched === state.count ? "green" : "orange",
  };
}

function externalSubmissionStatus(state?: ResumeWorkspace["application_packet"]["external_submission"]): PacketStatus {
  if (!state) return { label: "投递状态无法验证", tone: "neutral" };
  if (state.scope !== "recorded_only" || state.receipt_verified !== false) {
    return { label: "投递记录无法验证", tone: "orange" };
  }
  const successfulStatuses = ["submitted", "applied"];
  const historyIsValid = Boolean(
    state.completed
      && state.recorded
      && state.attempt_id != null
      && successfulStatuses.includes(state.status || "")
      && state.resume_version_id != null
      && typeof state.matches_current_version === "boolean",
  );
  if (state.completed && !historyIsValid) return { label: "投递记录无法验证", tone: "orange" };

  const historyLabel = historyIsValid
    ? `记录为已投递，使用${state.matches_current_version ? "当前版本" : "旧版本"}`
    : null;
  const latestStatus = state.latest_attempt?.status ?? state.status;
  const latestLabels: Record<string, PacketStatus> = {
    queued: { label: "最近一次投递尝试等待执行", tone: "orange" },
    pending: { label: "最近一次投递尝试等待执行", tone: "orange" },
    running: { label: "最近一次投递尝试进行中", tone: "orange" },
    waiting_for_approval: { label: "最近一次投递尝试待审核", tone: "orange" },
    failed: { label: "最近一次投递尝试失败", tone: "red" },
    blocked: { label: "最近一次投递尝试受阻", tone: "red" },
    cancelled: { label: "最近一次投递尝试已取消", tone: "neutral" },
  };
  const latestLabel = latestStatus ? latestLabels[latestStatus] : undefined;
  if (latestLabel) {
    return {
      label: historyLabel ? `${latestLabel.label}；${historyLabel}` : latestLabel.label,
      tone: latestLabel.tone,
    };
  }
  if (historyLabel) return { label: historyLabel, tone: state.matches_current_version ? "green" : "orange" };
  if (!state.recorded && !state.latest_attempt) return { label: "尚无投递记录", tone: "neutral" };
  if (successfulStatuses.includes(latestStatus || "")) return { label: "投递记录缺少简历版本信息", tone: "orange" };
  return { label: "投递记录状态无法验证", tone: "orange" };
}

function PacketRow({ label, status }: { label: string; status: PacketStatus }) {
  return (
    <p className="flex items-center justify-between gap-2">
      <span>{label}</span>
      <Badge tone={status.tone}>{status.label}</Badge>
    </p>
  );
}

function ProposalCard({
  proposal,
  onAction,
  onGroupAction,
  onHasEdits,
  pending,
}: {
  proposal: ResumeOptimizationProposalDetail;
  onAction: (changeId: string, action: "accept" | "reject", editedText?: string) => void;
  onGroupAction: (changeIds: string[], action: "accept" | "reject") => void;
  onHasEdits: (hasEdits: boolean) => void;
  pending: string | null;
}) {
  const [edited, setEdited] = useState<Record<string, string>>({});
  const reviews = proposal.item_reviews || {};
  const changes = proposal.diff || [];
  useEffect(() => {
    onHasEdits(changes.some((change) => !reviews[String(change.change_id)] && !!edited[String(change.change_id)]));
  }, [changes, reviews, edited, onHasEdits]);
  const factGateBlocked = proposal.fact_gate_status === "blocked";
  const groups = Object.entries(changes.reduce<Record<string, typeof changes>>((result, change) => {
    const key = String(change.section_type || change.before?.section_type || change.after?.section_type || change.section_key || change.title || "内容变化");
    (result[key] ||= []).push(change);
    return result;
  }, {}));
  return (
    <div className="space-y-3" data-testid="resume-proposal-queue">
      <div className="rounded-xl border border-violet-200 bg-violet-50 p-3">
        <div className="flex items-center justify-between gap-2">
          <div><p className="text-xs font-black text-violet-950">AI 建议 · {groups.length} 组</p><p className="mt-1 text-[11px] text-violet-800">按结构与段落比较岗位版本；每组一次采用，仍可单独修改。</p></div>
          <Badge tone={proposal.fact_gate_status === "passed" ? "green" : "orange"}>事实门：{proposal.fact_gate_status === "passed" ? "通过" : proposal.fact_gate_status}</Badge>
        </div>
      </div>
      {changes.length === 0 && <div className="rounded-xl border border-dashed border-[var(--border-strong)]/20 p-4 text-xs text-[var(--foreground-muted)]">当前提案没有需要审核的变化。</div>}
      {groups.map(([key, group]) => {
        const ids = group.filter((change) => !reviews[String(change.change_id)]).map((change) => String(change.change_id));
        return <section key={key} className="space-y-2" data-testid="resume-proposal-group">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-violet-50 p-2">
            <p className="text-xs font-black">段落 · {EDITOR_SECTION_TYPES.find(([type]) => type === key)?.[1] || group[0].before?.title || group[0].after?.title || group[0].title || key}</p>
            {ids.length > 0 && <div className="flex gap-2"><button type="button" disabled={!!pending || factGateBlocked || ids.some((id) => !!edited[id])} onClick={() => onGroupAction(ids, "accept")} className="rounded bg-black px-2 py-1 text-[11px] text-white disabled:opacity-50">采用本段</button><button type="button" disabled={!!pending} onClick={() => onGroupAction(ids, "reject")} className="rounded border px-2 py-1 text-[11px] disabled:opacity-50">保留本段原文</button></div>}
          </div>
          {group.map((change) => {
        const id = String(change.change_id || "");
        const reviewed = reviews[id]?.action;
        const text = proposalChange(change);
        const structureChanged = Boolean(change.before || change.after) && (!change.before || !change.after ||
          ["title", "sort_order", "visible"].some((field) => change.before?.[field] !== change.after?.[field]));
        const structure = (row: Record<string, any> | undefined) => row
          ? `${row.title || "本段"} · ${typeof row.sort_order === "number" ? `第 ${row.sort_order + 1} 段 · ` : ""}${row.visible === false ? "隐藏" : "显示"}`
          : "不包含本段";
        const sourceIds = change.source_section_ids || change.after?.source_section_ids || change.before?.source_section_ids || [];
        const rationale = (proposal.strategy?.rationale || []).filter((item: Record<string, any>) => (item.source_section_ids || []).some((id: number) => sourceIds.includes(id)));
        return (
          <div key={id} className={`rounded-xl border p-3 ${reviewed ? "border-emerald-200 bg-emerald-50/50" : "border-[var(--border-strong)]/15 bg-[var(--surface)]"}`} data-testid={`resume-proposal-${id}`}>
            <div className="flex items-center justify-between gap-2"><div className="flex min-w-0 items-center gap-2"><Sparkles size={13} className="shrink-0 text-violet-600" /><p className="truncate text-xs font-black">{change.title || change.section_key || "内容变化"}</p></div>{reviewed && <Badge tone="green">{reviewed === "accept" ? "已接受" : "已拒绝"}</Badge>}</div>
            <div className="mt-3 space-y-2 text-[11px] leading-relaxed">{text.before && <div className="rounded-lg bg-red-50 p-2 text-red-900"><span className="font-bold">Before · </span>{text.before}</div>}{text.after && <div className="rounded-lg bg-emerald-50 p-2 text-emerald-900"><span className="font-bold">After · </span>{text.after}</div>}</div>
            {structureChanged && <div aria-label="结构调整对比" className="mt-2 rounded-lg bg-violet-50 p-2 text-[11px] text-violet-950"><p>调整前：{structure(change.before)}</p><p>调整后：{structure(change.after)}</p></div>}
            <div className="mt-2 space-y-1 text-[10px] text-[var(--foreground-muted)]">
              <p>原始证据：{sourceIds.length ? sourceIds.map((id: number) => `Profile #${id}`).join("、") : "未提供引用"}</p>
              {rationale.map((item: Record<string, any>, index: number) => <p key={index}>岗位要求：{item.requirement} · 改写理由：{item.why || item.reason || item.rationale || item.emphasis || "见岗位策略"}</p>)}
              {!rationale.length && <p>岗位要求与改写理由：{change.rationale || change.reason || "未提供，请先向 Agent 核对"}</p>}
            </div>
            <p className="mt-2 text-[10px] text-[var(--foreground-muted)]">{change.change_type === "reordered" ? "根据岗位相关性调整顺序" : "岗位化建议，接受前仍可编辑"}</p>
            {!reviewed && <><textarea value={edited[id] || ""} onChange={(event) => setEdited((current) => ({ ...current, [id]: event.target.value }))} placeholder="可选：改写 After 后再接受" aria-label="编辑 AI 建议" className="mt-3 min-h-16 w-full resize-y rounded-lg border border-[var(--border-strong)]/15 bg-white p-2 text-[11px] outline-none focus:border-violet-400" /><div className="mt-3 flex gap-2"><button type="button" disabled={!!pending || factGateBlocked} title={factGateBlocked ? "事实门未通过，请先补充 Evidence" : undefined} onClick={() => onAction(id, "accept", edited[id])} className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg bg-black px-3 py-2 text-[11px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-50">{pending === id ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}{factGateBlocked ? "需补充证据" : "接受"}</button><button type="button" disabled={!!pending} onClick={() => onAction(id, "reject")} className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg border border-[var(--border-strong)]/20 px-3 py-2 text-[11px] font-bold disabled:opacity-50"><X size={12} />拒绝</button></div></>}
          </div>
        );
          })}
        </section>;
      })}
    </div>
  );
}

export default function ResumeEditorPage() {
  const params = useParams();
  const router = useRouter();
  const resumeId = Number(params?.id);
  const [workspace, setWorkspace] = useState<ResumeWorkspace | null>(null);
  const [draft, setDraft] = useState<DraftResume | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [rightPanel, setRightPanel] = useState<"ai" | "design" | "versions">("ai");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [hasEditedProposal, setHasEditedProposal] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [restoring, setRestoring] = useState<number | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  // 「纸」画布：量出成品高度，超过一页时在第一页底部画出分页线，让用户自己决定删哪条。
  const [canvasEl, setCanvasEl] = useState<HTMLDivElement | null>(null);
  const [pageOverflowMm, setPageOverflowMm] = useState(0);
  const canvasNodeRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useCallback((node: HTMLDivElement | null) => { canvasNodeRef.current = node; setCanvasEl(node); }, []);
  // 切片 ②：画布上堆积的修改意见，以及「对比 / 当前」视图。
  const [comments, setComments] = useState<CanvasComment[]>([]);
  const [showProposals, setShowProposals] = useState(true);
  const pageSizeKey = draft?.style_config?.pageSize === "LETTER" ? "LETTER" : "A4";
  const pageHeightPx = ((pageSizeKey === "LETTER" ? 279.4 : 297) * 96) / 25.4;
  useEffect(() => {
    if (!canvasEl || typeof ResizeObserver === "undefined") { setPageOverflowMm(0); return; }
    const measure = () => {
      const height = canvasEl.getBoundingClientRect().height;
      setPageOverflowMm(Math.max(0, ((height - pageHeightPx) * 25.4) / 96));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(canvasEl);
    measure();
    return () => observer.disconnect();
  }, [canvasEl, pageHeightPx]);
  const hydratedRef = useRef(false);
  const skipAutosaveRef = useRef(false);
  const lastSavedSignatureRef = useRef("");
  const draftRef = useRef<DraftResume | null>(null);
  const revisionRef = useRef<number | undefined>(undefined);
  const saveQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const undoStackRef = useRef<DraftResume[]>([]);

  const saveDraftRecord = useCallback((candidate: DraftResume) => {
    const pending = saveQueueRef.current.catch(() => undefined).then(async () => {
      const saved = await resumeApi.update(candidate.id, { user_name: candidate.user_name, title: candidate.title, summary: candidate.summary, contact_json: candidate.contact_json, template_id: candidate.template_id, style_config: candidate.style_config, language: candidate.language, sections: candidate.sections, expected_revision: revisionRef.current }) as DraftResume;
      revisionRef.current = saved.workspace_revision;
      return saved;
    });
    saveQueueRef.current = pending;
    return pending;
  }, []);

  const recordUndo = useCallback((resume: DraftResume) => {
    undoStackRef.current = [...undoStackRef.current, JSON.parse(JSON.stringify(resume))].slice(-40);
    setCanUndo(true);
  }, []);

  const handleUndo = useCallback(() => {
    const previous = undoStackRef.current.pop();
    setCanUndo(undoStackRef.current.length > 0);
    if (!previous) return;
    skipAutosaveRef.current = false;
    setDraft(previous);
    setSaveState("idle");
  }, []);

  const loadWorkspace = useCallback(async () => {
    if (!Number.isFinite(resumeId)) return;
    setLoading(true); setLoadError(null);
    try {
      const next = await resumeApi.workspace(resumeId);
      revisionRef.current = next.resume.workspace_revision;
      skipAutosaveRef.current = true; hydratedRef.current = true;
      setWorkspace(next); setDraft(next.resume as DraftResume); draftRef.current = next.resume as DraftResume;
    } catch (error) {
      setLoadError(safeClientErrorMessage(error, "简历工作区加载失败"));
    } finally { setLoading(false); }
  }, [resumeId]);

  useEffect(() => { void loadWorkspace(); }, [loadWorkspace]);
  const draftSignature = useMemo(() => draft ? resumeSignature(draft) : "", [draft]);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    if (!draft || !hydratedRef.current || pendingAction === "upload") return;
    if (skipAutosaveRef.current) { skipAutosaveRef.current = false; lastSavedSignatureRef.current = draftSignature; return; }
    if (!draftSignature || draftSignature === lastSavedSignatureRef.current) return;
    const candidateSignature = draftSignature;
    setSaveState("saving");
    const timer = window.setTimeout(async () => {
      try {
        const saved = await saveDraftRecord(draft);
        if (draftRef.current && resumeSignature(draftRef.current) !== candidateSignature) return;
        lastSavedSignatureRef.current = resumeSignature(saved); skipAutosaveRef.current = true;
        draftRef.current = saved; setDraft(saved); setWorkspace((current) => current ? { ...current, resume: saved } : current); setSaveState("saved");
      } catch (error) {
        if (draftRef.current && resumeSignature(draftRef.current) !== candidateSignature) return;
        setSaveState("failed"); setWorkspaceError(safeClientErrorMessage(error, "无法保存简历修改"));
      }
    }, 800);
    return () => window.clearTimeout(timer);
  }, [draft, draftSignature, pendingAction, saveDraftRecord]);

  const setFromWorkspace = useCallback((next: ResumeWorkspace) => {
    revisionRef.current = next.resume.workspace_revision;
    skipAutosaveRef.current = true; draftRef.current = next.resume as DraftResume; setWorkspace(next); setDraft(next.resume as DraftResume); setSaveState("saved"); setWorkspaceError(null);
  }, []);
  const updateDraft = useCallback((patch: Partial<DraftResume>) => { setDraft((current) => { if (!current) return current; recordUndo(current); return { ...current, ...patch }; }); setSaveState("idle"); }, [recordUndo]);
  const updateSection = useCallback((section: ResumeSectionBlock) => { setDraft((current) => { if (!current) return current; recordUndo(current); return { ...current, sections: current.sections.map((item) => item.id === section.id ? section : item) }; }); setSaveState("idle"); }, [recordUndo]);

  const sectionSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const handleSectionDragEnd = (event: DragEndEvent) => {
    if (!draft || !event.over || event.active.id === event.over.id) return;
    const ids = draft.sections.map((section) => `section-${section.id}`); const from = ids.indexOf(String(event.active.id)); const to = ids.indexOf(String(event.over.id));
    if (from < 0 || to < 0) return;
    updateDraft({ sections: arrayMove(draft.sections, from, to).map((section, index) => ({ ...section, sort_order: index })) });
  };

  const persistDraft = useCallback(async () => {
    if (!draft) return null;
    const candidateSignature = resumeSignature(draft);
    const saved = await saveDraftRecord(draft);
    if (draftRef.current && resumeSignature(draftRef.current) !== candidateSignature) return saved;
    skipAutosaveRef.current = true; lastSavedSignatureRef.current = resumeSignature(saved); draftRef.current = saved; setDraft(saved); setWorkspace((current) => current ? { ...current, resume: saved } : current); setSaveState("saved"); return saved;
  }, [draft, saveDraftRecord]);

  const retryAutosave = useCallback(async () => {
    if (!draft) return;
    const candidate = draft;
    const candidateSignature = resumeSignature(candidate);
    setSaveState("saving"); setWorkspaceError(null);
    try {
      const saved = await saveDraftRecord(candidate);
      if (draftRef.current && resumeSignature(draftRef.current) !== candidateSignature) return;
      skipAutosaveRef.current = true; lastSavedSignatureRef.current = resumeSignature(saved); draftRef.current = saved; setDraft(saved); setWorkspace((current) => current ? { ...current, resume: saved } : current); setSaveState("saved");
    } catch (error) {
      setSaveState("failed"); setWorkspaceError(safeClientErrorMessage(error, "无法保存简历修改"));
    }
  }, [draft, saveDraftRecord]);

  const handleSaveVersion = async () => {
    if (!draft) return; setPendingAction("version");
    try { const saved = await persistDraft(); await resumeApi.createVersion(saved?.id || draft.id, { change_summary: "Resume Workspace 编辑", created_by: "user" }); await loadWorkspace(); }
    catch (error) { setWorkspaceError(safeClientErrorMessage(error, "无法保存版本")); }
    finally { setPendingAction(null); }
  };

  const handleExport = async () => {
    if (!draft) return; setExporting(true); setWorkspaceError(null);
    try {
      await persistDraft();
      const response = await resumeApi.exportPdf(draft.id);
      if (!response.ok) throw new Error(`PDF 导出失败（HTTP ${response.status}）`);
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `${draft.title || "resume"}.pdf`;
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
      window.setTimeout(() => { link.remove(); URL.revokeObjectURL(objectUrl); }, 1000);
    }
    catch (error) { setWorkspaceError(safeClientErrorMessage(error, "PDF 导出失败")); }
    finally { setExporting(false); }
  };

  const handleAssetUpload = async (kind: "photo" | "logo", file: File | null) => {
    if (!draft) return;
    if (file && (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024)) {
      setWorkspaceError("请选择不超过 5 MB 的 JPG、PNG 或 WebP 图片"); return;
    }
    setPendingAction("upload"); setWorkspaceError(null);
    try {
      const saved = await persistDraft();
      if (!saved || saved.workspace_revision == null) throw new Error("缺少简历版本，请刷新后重试");
      const content = file ? await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () => reject(new Error("图片读取失败"));
        reader.readAsDataURL(file);
      }) : null;
      const result = await resumeApi.updateDesign(draft.id, { expected_revision: saved.workspace_revision,
        ...(file ? { [kind]: { content_b64: content, content_type: file.type } } : { [`remove_${kind}`]: true }) }) as DraftResume;
      revisionRef.current = result.workspace_revision;
      lastSavedSignatureRef.current = resumeSignature(result);
      skipAutosaveRef.current = false;
      setSaveState("saved");
      setDraft((current) => {
        if (!current) return current;
        const contact = { ...current.contact_json };
        if (kind === "logo") for (const key of ["schoolLogoUrl", "universityLogoUrl", "logoUrl", "school_logo_url"]) {
          if (result.contact_json[key]) contact[key] = result.contact_json[key]; else delete contact[key];
        }
        return { ...current, photo_url: result.photo_url, contact_json: contact, workspace_revision: result.workspace_revision };
      });
      const next = await resumeApi.workspace(draft.id);
      setWorkspace(next);
    } catch (error) { setWorkspaceError(safeClientErrorMessage(error, "图片上传失败")); skipAutosaveRef.current = false; }
    finally { setPendingAction(null); }
  };

  const handleProposalAction = async (changeId: string, action: "accept" | "reject", editedText = "") => {
    if (!workspace || !draft) return;
    const proposal = workspace.proposals.find((item) => ["ready", "in_review", "blocked"].includes(item.status)); if (!proposal) return;
    setPendingAction(changeId); setWorkspaceError(null);
    try { const next = await resumeApi.reviewProposalItem(proposal.proposal_id, { resume_id: draft.id, change_id: changeId, action, edited_text: editedText }); if (action === "accept") recordUndo(draft); setFromWorkspace(next); }
    catch (error) { setWorkspaceError(safeClientErrorMessage(error, "Proposal 审核失败")); await loadWorkspace(); }
    finally { setPendingAction(null); }
  };

  const handleProposalGroupAction = async (changeIds: string[], action: "accept" | "reject") => {
    if (!workspace || !draft || !changeIds.length) return;
    const proposal = workspace.proposals.find((item) => ["ready", "in_review", "blocked"].includes(item.status)); if (!proposal) return;
    setPendingAction(`group-${action}`); setWorkspaceError(null);
    try {
      const next = await resumeApi.reviewProposalItems(proposal.proposal_id, { resume_id: draft.id, change_ids: changeIds, action });
      if (action === "accept") recordUndo(draft);
      setFromWorkspace(next);
    } catch (error) { setWorkspaceError(safeClientErrorMessage(error, "段落审核失败")); await loadWorkspace(); }
    finally { setPendingAction(null); }
  };

  const handleAllProposalActions = async (action: "accept" | "reject") => {
    const proposal = workspace?.proposals.find((item) => ["ready", "in_review", "blocked"].includes(item.status)); if (!proposal) return;
    await handleProposalGroupAction(proposal.diff.filter((item) => !proposal.item_reviews?.[String(item.change_id || "")]).map((item) => String(item.change_id)), action);
  };

  const handleRestore = async (versionId: number) => {
    if (!draft) return; setRestoring(versionId);
    try { recordUndo(draft); await resumeApi.restoreVersion(draft.id, versionId); await loadWorkspace(); }
    catch (error) { setWorkspaceError(safeClientErrorMessage(error, "无法恢复版本")); }
    finally { setRestoring(null); }
  };

  if (loading) return <div className="grid min-h-[70vh] place-items-center text-sm text-[var(--foreground-muted)]"><Loader2 className="animate-spin" size={20} /></div>;
  if (loadError || !workspace || !draft) return <div className="mx-auto max-w-xl p-8 text-sm text-red-700"><p>{loadError || "简历工作区不存在"}</p><button className="mt-4 underline" onClick={() => router.back()}>返回</button></div>;

  const style = draft.style_config || {};
  const paperMode = normalizeTemplateSettings(style).template === "paper";
  const setStyle = (key: string, value: string) => updateDraft({ style_config: { ...style, [key]: value } });
  const targetLabel = workspace.job ? `${workspace.job.company} · ${workspace.job.title}` : "未绑定目标岗位";
  const packetArtifactState = workspace.application_packet.artifact_state;
  const packetResumeStatus = resumePacketStatus(packetArtifactState?.resume);
  const packetJobId = workspace.job?.id ?? workspace.application_packet.job_id;
  const packetResearchStatus = researchPacketStatus(packetArtifactState?.research, packetJobId);
  const packetBenchmarkStatus = benchmarkPacketStatus(packetArtifactState?.benchmark);
  const packetInterviewStatus = interviewPacketStatus(packetArtifactState?.interview_focus, draft.id);
  const packetDocumentStatus = packetDocumentsStatus(packetArtifactState?.documents);
  const packetSubmissionStatus = externalSubmissionStatus(workspace.application_packet.external_submission);
  const activeProposal = workspace.proposals.find((item) => ["ready", "in_review", "blocked"].includes(item.status));
  const staleProposal = workspace.proposals.find((item) => item.status === "stale");
  // AI 建议落到它要改的那一段里。冲突（建议生成后用户改过这段）以用户版本为准，不能直接采用。
  const pendingChanges: InlineChange[] = activeProposal
    ? (activeProposal.diff || []).filter((change) => !activeProposal.item_reviews?.[String(change.change_id || "")]) as InlineChange[]
    : [];
  const changeTargets = pendingChanges.map((change) => ({
    change,
    target: change.change_type === "added" ? undefined : findTargetSection(draft.sections, change),
  }));
  const isConflicted = (change: InlineChange, target?: ResumeSectionBlock) => conflictsWithManualEdit(target, change);
  const safeChangeIds = changeTargets.filter(({ change, target }) => !isConflicted(change, target)).map(({ change }) => String(change.change_id));
  const factGateBlocked = activeProposal?.fact_gate_status === "blocked";
  const askRewrite = (target: ResumeSectionBlock | undefined) => composeToAgent({
    skillId: "tailor_resume",
    message: buildCommentPrompt(draft.id, targetLabel, [{
      id: "rewrite", quote: target?.title || "这一段", section: target?.title || "这一段",
      instruction: "我在你的建议生成后手动改过这一段。请基于我现在的版本重新给出建议，保留我改过的措辞。",
    }]),
  });
  const renderInline = (change: InlineChange, target?: ResumeSectionBlock) => (
    <InlineProposal key={change.change_id} change={change} conflict={isConflicted(change, target)} factGateBlocked={factGateBlocked}
      busy={!!pendingAction} onAccept={(edited) => void handleProposalAction(String(change.change_id), "accept", edited || "")}
      onSkip={() => void handleProposalAction(String(change.change_id), "reject")} onAskRewrite={() => askRewrite(target)} />
  );
  const renderSectionAside = showProposals && paperMode
    ? (section: { id: number }) => {
      const items = changeTargets.filter(({ target }) => target?.id === section.id);
      return items.length ? <>{items.map(({ change, target }) => renderInline(change, target))}</> : null;
    }
    : undefined;
  const orphanChanges = changeTargets.filter(({ target }) => !target);
  const canvasFooter = showProposals && paperMode && orphanChanges.length
    ? <div className="paper-section">{orphanChanges.map(({ change }) => renderInline(change))}</div>
    : undefined;
  const submitComments = () => {
    if (!comments.length) return;
    composeToAgent({ skillId: "tailor_resume", message: buildCommentPrompt(draft.id, targetLabel, comments) });
    setComments([]);
  };

  return (
    <div className="offeru-viewport-min-height bg-[var(--background)] px-4 pb-8 pt-4 text-[var(--foreground)]" data-testid="resume-workspace">
      <header className="mx-auto flex max-w-[1800px] flex-wrap items-center justify-between gap-3 border-b border-[var(--border-strong)]/15 pb-4">
        <div className="flex min-w-0 items-center gap-3"><button type="button" onClick={() => router.back()} aria-label="返回" className="rounded-lg border border-[var(--border-strong)]/15 p-2 hover:bg-black/5"><ArrowLeft size={16} /></button><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h1 className="truncate text-lg font-black">岗位简历</h1><Badge tone={packetResumeStatus.tone}>{packetResumeStatus.label}</Badge></div><p className="mt-1 truncate text-xs text-[var(--foreground-muted)]">{targetLabel}</p></div></div>
        <div className="flex flex-wrap items-center gap-2"><span className={`text-[11px] ${saveState === "failed" ? "text-red-600" : "text-[var(--foreground-muted)]"}`} data-testid="resume-save-status">{saveState === "saving" && "正在保存…"}{saveState === "saved" && "已保存"}{saveState === "failed" && "保存失败"}</span><button type="button" onClick={handleUndo} disabled={!canUndo} aria-label="撤销最近一次编辑" className="inline-flex items-center gap-1 rounded-lg border border-[var(--border-strong)]/20 px-3 py-2 text-xs font-bold hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40" data-testid="resume-undo"><Undo2 size={13} />撤销</button><button type="button" onClick={() => void handleSaveVersion()} disabled={pendingAction === "version"} className="inline-flex items-center gap-1 rounded-lg border border-[var(--border-strong)]/20 px-3 py-2 text-xs font-bold hover:bg-black/5 disabled:opacity-50" data-testid="resume-save-version">{pendingAction === "version" ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}保存版本</button><button type="button" onClick={() => void handleExport()} disabled={exporting} className="inline-flex items-center gap-1 rounded-lg bg-black px-3 py-2 text-xs font-bold text-white disabled:opacity-50" data-testid="resume-export-pdf">{exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}导出 PDF</button></div>
      </header>

      {(workspaceError || staleProposal) && <div className="mx-auto mt-3 flex max-w-[1800px] items-center justify-between rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="resume-workspace-error"><span>{workspaceError || "这条 AI Proposal 已过期，因为简历内容发生了变化。请重新生成建议或继续手动编辑。"}</span>{saveState === "failed" ? <button type="button" onClick={() => void retryAutosave()} className="font-bold underline" data-testid="resume-retry-save">重试保存</button> : <button type="button" onClick={() => void loadWorkspace()} className="font-bold underline">刷新</button>}</div>}

      <div className="mx-auto mt-4 grid max-w-[1800px] gap-4 xl:grid-cols-[minmax(300px,0.9fr)_minmax(480px,1.35fr)_minmax(300px,0.8fr)]">
        <section className="min-w-0 space-y-3" aria-label="简历内容编辑">
          <div className="rounded-xl border border-[var(--border-strong)]/15 bg-[var(--surface)] p-3"><div className="mb-3 flex items-center gap-2"><FileText size={15} /><h2 className="text-xs font-black uppercase tracking-[0.08em]">Content</h2></div><div className="space-y-2"><input value={draft.user_name || ""} onChange={(event) => updateDraft({ user_name: event.target.value })} aria-label="姓名" placeholder="姓名" className="w-full rounded-lg border border-[var(--border-strong)]/15 bg-white px-3 py-2 text-sm outline-none focus:border-black" data-testid="resume-name-input" /><input value={draft.title || ""} onChange={(event) => updateDraft({ title: event.target.value })} aria-label="简历标题" placeholder="简历标题" className="w-full rounded-lg border border-[var(--border-strong)]/15 bg-white px-3 py-2 text-sm outline-none focus:border-black" /><textarea value={draft.summary || ""} onChange={(event) => updateDraft({ summary: event.target.value })} aria-label="个人简介" placeholder="个人简介" className="min-h-20 w-full resize-y rounded-lg border border-[var(--border-strong)]/15 bg-white px-3 py-2 text-xs leading-relaxed outline-none focus:border-black" data-testid="resume-summary-input" /></div><div className="mt-3 border-t border-[var(--border-strong)]/10 pt-3"><p className="mb-2 text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--foreground-muted)]">联系方式</p><div className="grid grid-cols-2 gap-2">{["phone", "email", "linkedin", "github", "website", "wechat"].map((key) => <input key={key} value={String(draft.contact_json?.[key] || "")} onChange={(event) => updateDraft({ contact_json: { ...draft.contact_json, [key]: event.target.value } })} aria-label={key} placeholder={key} className="min-w-0 rounded-lg border border-[var(--border-strong)]/15 bg-white px-2 py-2 text-[11px] outline-none focus:border-black" />)}</div></div></div>
          <DndContext sensors={sectionSensors} collisionDetection={closestCenter} onDragEnd={handleSectionDragEnd}><SortableContext items={draft.sections.map((section) => `section-${section.id}`)} strategy={verticalListSortingStrategy}><div className="space-y-3">{draft.sections.map((section) => <SortableSectionCard key={section.id} section={section} onChange={updateSection} onToggle={() => updateSection({ ...section, visible: !section.visible })} onDelete={() => updateDraft({ sections: draft.sections.filter((item) => item.id !== section.id) })} />)}</div></SortableContext></DndContext>
          <div className="rounded-xl border border-dashed border-[var(--border-strong)]/25 bg-[var(--surface)] p-3"><div className="flex items-center gap-2 text-xs font-bold"><Plus size={14} />添加内容段落</div><div className="mt-2 grid grid-cols-2 gap-2">{EDITOR_SECTION_TYPES.map(([type, label]) => <button key={type} type="button" onClick={() => updateDraft({ sections: [...draft.sections, { id: -(Date.now() * 1000 + Math.floor(Math.random() * 1000)), resume_id: draft.id, section_type: type, sort_order: draft.sections.length, title: label, visible: true, content_json: [], source_section_ids: [] }] })} className="rounded-lg border border-[var(--border-strong)]/15 px-2 py-2 text-left text-[11px] hover:bg-black/5">{label}</button>)}</div></div>
        </section>

        <section className={`min-w-0 rounded-xl border border-[var(--border-strong)]/15 p-3 ${paperMode ? "bg-[#ebe9e1]" : "bg-[#e9e9e7]"}`} aria-label={paperMode ? "简历成品（可直接编辑）" : "简历实时预览"}><div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs"><div className="flex items-center gap-2 font-black"><Eye size={14} />{paperMode ? "成品" : "预览"} <Badge>{style.pageSize === "LETTER" ? "Letter" : "A4"}</Badge></div>{paperMode ? <div className="flex flex-wrap items-center gap-2 text-[10px] text-[var(--foreground-muted)]">{pendingChanges.length > 0 && <span className="flex items-center gap-1.5 rounded border border-[#1b365d]/25 px-2 py-0.5 text-[#1b365d]" data-testid="resume-canvas-proposals"><Wand2 size={11} />AI 建议 {pendingChanges.length} 条<button type="button" onClick={() => void handleProposalGroupAction(safeChangeIds, "accept")} disabled={!!pendingAction || !safeChangeIds.length || factGateBlocked} className="font-bold underline disabled:opacity-40">全部采用{safeChangeIds.length < pendingChanges.length ? `（${safeChangeIds.length} 条无冲突）` : ""}</button><button type="button" onClick={() => setShowProposals((value) => !value)} className="font-bold underline" aria-pressed={showProposals}>{showProposals ? "只看当前" : "显示对比"}</button></span>}<span>选中文字可留言给 AI · 点任意文字直接修改 · 回车新增要点 · Esc 撤回</span><button type="button" onClick={() => updateDraft({ style_config: { ...style, paperTone: style.paperTone === "white" ? "parchment" : "white" } })} className="rounded border border-[var(--border-strong)]/20 px-2 py-0.5 font-bold" data-testid="resume-paper-tone">{style.paperTone === "white" ? "白纸" : "暖纸"}</button></div> : <button type="button" onClick={() => updateDraft({ style_config: { ...style, template: "paper" } })} className="text-[10px] font-bold underline" data-testid="resume-switch-paper">换成「纸」模板，直接在页面上改</button>}</div><div className={`min-h-[900px] overflow-auto rounded-lg p-4 ${paperMode ? "bg-[#e3e0d6]" : "bg-[#d7d7d4]"}`}><div className={paperMode ? "relative mx-auto w-fit" : "mx-auto w-fit origin-top scale-[0.78] pb-[-180px] shadow-2xl"} data-testid="resume-live-preview" ref={paperMode ? canvasRef : undefined}><ResumePreview userName={draft.user_name} title={draft.title} photoUrl={draft.photo_url} summary={draft.summary} contactJson={draft.contact_json || {}} sections={draft.sections} styleConfig={style} highlightKeywords={paperMode ? [] : workspace.job?.keywords || []} editable={paperMode} onProfileChange={(patch) => updateDraft(patch)} onSectionChange={(section) => updateSection(section as ResumeSectionBlock)} renderSectionAside={renderSectionAside} canvasFooter={canvasFooter} />{paperMode && <CanvasSelectionBar containerRef={canvasNodeRef} onAddComment={(comment) => setComments((current) => [...current, { ...comment, id: `comment-${Date.now()}-${current.length}` }])} />}{paperMode && pageOverflowMm > 0 && <div className="pointer-events-none absolute left-0 right-0 border-t border-dashed border-[#9a5b4a]" style={{ top: `${pageHeightPx}px` }} data-testid="resume-page-break"><span className="absolute right-0 -translate-y-full rounded-t bg-[#9a5b4a] px-2 py-0.5 text-[10px] text-white">第一页到此 · 超出约 {Math.round(pageOverflowMm)} mm</span></div>}</div>{paperMode && <CommentTray comments={comments} onRemove={(id) => setComments((current) => current.filter((item) => item.id !== id))} onSubmit={submitComments} />}</div></section>

        <aside className="min-w-0 space-y-3" aria-label="简历工作区控制"><div className="flex rounded-xl border border-[var(--border-strong)]/15 bg-[var(--surface)] p-1" role="tablist">{([ ["ai", "AI 建议", Wand2], ["design", "排版", Sparkles], ["versions", "历史", History] ] as const).map(([key, label, Icon]) => <button key={key} type="button" role="tab" aria-selected={rightPanel === key} onClick={() => setRightPanel(key)} className={`flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-2 text-[10px] font-bold ${rightPanel === key ? "bg-black text-white" : "text-[var(--foreground-muted)] hover:bg-black/5"}`} data-testid={`resume-panel-${key}`}><Icon size={12} />{label}</button>)}</div>
          {rightPanel === "ai" && <div className="space-y-3"><div className="rounded-xl border border-[var(--border-strong)]/15 bg-[var(--surface)] p-3"><p className="text-xs font-black">目标岗位上下文</p><p className="mt-1 text-[11px] text-[var(--foreground-muted)]">{targetLabel}</p>{activeProposal?.strategy?.missing_capabilities?.length ? <p className="mt-2 text-[10px] text-amber-800">Evidence Gap：{activeProposal.strategy.missing_capabilities.join("、")}</p> : null}</div>{activeProposal ? <><div className="flex gap-2"><button type="button" onClick={() => void handleAllProposalActions("accept")} disabled={!!pendingAction || hasEditedProposal || activeProposal.fact_gate_status === "blocked"} title={activeProposal.fact_gate_status === "blocked" ? "事实门未通过，请先补充 Evidence" : undefined} className="flex-1 rounded-lg bg-black px-2 py-2 text-[10px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-50">全部接受</button><button type="button" onClick={() => void handleAllProposalActions("reject")} disabled={!!pendingAction} className="flex-1 rounded-lg border border-[var(--border-strong)]/20 px-2 py-2 text-[10px] font-bold disabled:opacity-50">全部拒绝</button></div><ProposalCard proposal={activeProposal} onAction={(id, action, text) => void handleProposalAction(id, action, text)} onHasEdits={setHasEditedProposal} onGroupAction={(ids, action) => void handleProposalGroupAction(ids, action)} pending={pendingAction} /></> : <div className="rounded-xl border border-dashed border-[var(--border-strong)]/20 bg-[var(--surface)] p-4 text-xs text-[var(--foreground-muted)]">当前没有待审核的 AI Proposal。你可以继续手动编辑这份岗位简历。</div>}</div>}
          {rightPanel === "design" && <ResumeDesignPanel config={style} onChange={setStyle} onUpload={handleAssetUpload} uploading={pendingAction === "upload"} />}
          {rightPanel === "versions" && <div className="space-y-2 rounded-xl border border-[var(--border-strong)]/15 bg-[var(--surface)] p-3" data-testid="resume-version-panel"><div className="mb-2 flex items-center justify-between"><p className="text-xs font-black">版本历史</p><span className="text-[10px] text-[var(--foreground-muted)]">当前 V{workspace.application_packet.current_version_number || 1}</span></div>{workspace.versions.length === 0 && <p className="text-xs text-[var(--foreground-muted)]">保存第一个版本后会显示在这里。</p>}{workspace.versions.map((version) => <div key={version.id} className={`rounded-lg border p-3 ${version.is_current ? "border-emerald-300 bg-emerald-50" : "border-[var(--border-strong)]/10"}`}><div className="flex items-center justify-between"><span className="text-xs font-black">V{version.version_number}</span>{version.is_current && <Badge tone="green">Current</Badge>}</div><p className="mt-1 text-[11px]">{version.change_summary}</p><p className="mt-1 text-[10px] text-[var(--foreground-muted)]">{version.created_by} · {new Date(version.created_at).toLocaleString()}</p>{!version.is_current && <button type="button" onClick={() => void handleRestore(version.id)} disabled={restoring === version.id} className="mt-2 inline-flex items-center gap-1 text-[10px] font-bold underline disabled:opacity-50">{restoring === version.id ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />}恢复此版本</button>}</div>)}</div>}
          <div className="rounded-xl border border-[var(--border-strong)]/15 bg-[var(--surface)] p-3 text-[11px]" data-testid="application-packet-summary">
            <p className="font-black">Application Packet</p>
            <div className="mt-2 space-y-1.5 text-[var(--foreground-muted)]">
              <PacketRow label="Tailored Resume" status={{
                ...packetResumeStatus,
                label: `${packetResumeStatus.label}${workspace.application_packet.current_version_number ? ` · V${workspace.application_packet.current_version_number}` : ""}`,
              }} />
              <PacketRow label="岗位研究" status={packetResearchStatus} />
              <PacketRow label="岗位基准" status={packetBenchmarkStatus} />
              <PacketRow label="面试准备" status={packetInterviewStatus} />
              <PacketRow label="关联材料" status={packetDocumentStatus} />
              <PacketRow label="外部投递" status={packetSubmissionStatus} />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
