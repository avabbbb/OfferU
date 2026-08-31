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
import { resumeApi, type ResumeOptimizationProposalDetail, type ResumeWorkspace } from "@/lib/api";
import type { ResumeDetail, ResumeSectionBlock } from "@/lib/hooks";
import SectionEditor from "../components/SectionEditor";
import ResumePreview from "../components/ResumePreview";
import { TEMPLATE_OPTIONS } from "../components/templates/templateSettings";

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

function ProposalCard({
  proposal,
  onAction,
  pending,
}: {
  proposal: ResumeOptimizationProposalDetail;
  onAction: (changeId: string, action: "accept" | "reject", editedText?: string) => void;
  pending: string | null;
}) {
  const [edited, setEdited] = useState<Record<string, string>>({});
  const reviews = proposal.item_reviews || {};
  const changes = proposal.diff || [];
  const factGateBlocked = proposal.fact_gate_status === "blocked";
  return (
    <div className="space-y-3" data-testid="resume-proposal-queue">
      <div className="rounded-xl border border-violet-200 bg-violet-50 p-3">
        <div className="flex items-center justify-between gap-2">
          <div><p className="text-xs font-black text-violet-950">AI 建议 · {changes.length} 条</p><p className="mt-1 text-[11px] text-violet-800">保留原简历，逐条决定是否应用到当前岗位版本。</p></div>
          <Badge tone={proposal.fact_gate_status === "passed" ? "green" : "orange"}>事实门：{proposal.fact_gate_status === "passed" ? "通过" : proposal.fact_gate_status}</Badge>
        </div>
      </div>
      {changes.length === 0 && <div className="rounded-xl border border-dashed border-[var(--border-strong)]/20 p-4 text-xs text-[var(--foreground-muted)]">当前提案没有需要审核的变化。</div>}
      {changes.map((change) => {
        const id = String(change.change_id || "");
        const reviewed = reviews[id]?.action;
        const text = proposalChange(change);
        return (
          <div key={id} className={`rounded-xl border p-3 ${reviewed ? "border-emerald-200 bg-emerald-50/50" : "border-[var(--border-strong)]/15 bg-[var(--surface)]"}`} data-testid={`resume-proposal-${id}`}>
            <div className="flex items-center justify-between gap-2"><div className="flex min-w-0 items-center gap-2"><Sparkles size={13} className="shrink-0 text-violet-600" /><p className="truncate text-xs font-black">{change.title || change.section_key || "内容变化"}</p></div>{reviewed && <Badge tone="green">{reviewed === "accept" ? "已接受" : "已拒绝"}</Badge>}</div>
            <div className="mt-3 space-y-2 text-[11px] leading-relaxed">{text.before && <div className="rounded-lg bg-red-50 p-2 text-red-900"><span className="font-bold">Before · </span>{text.before}</div>}{text.after && <div className="rounded-lg bg-emerald-50 p-2 text-emerald-900"><span className="font-bold">After · </span>{text.after}</div>}</div>
            <p className="mt-2 text-[10px] text-[var(--foreground-muted)]">{change.change_type === "reordered" ? "根据岗位相关性调整顺序" : "岗位化建议，接受前仍可编辑"}</p>
            {!reviewed && <><textarea value={edited[id] || ""} onChange={(event) => setEdited((current) => ({ ...current, [id]: event.target.value }))} placeholder="可选：改写 After 后再接受" aria-label="编辑 AI 建议" className="mt-3 min-h-16 w-full resize-y rounded-lg border border-[var(--border-strong)]/15 bg-white p-2 text-[11px] outline-none focus:border-violet-400" /><div className="mt-3 flex gap-2"><button type="button" disabled={pending === id || factGateBlocked} title={factGateBlocked ? "事实门未通过，请先补充 Evidence" : undefined} onClick={() => onAction(id, "accept", edited[id])} className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg bg-black px-3 py-2 text-[11px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-50">{pending === id ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}{factGateBlocked ? "需补充证据" : "接受"}</button><button type="button" disabled={pending === id} onClick={() => onAction(id, "reject")} className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg border border-[var(--border-strong)]/20 px-3 py-2 text-[11px] font-bold disabled:opacity-50"><X size={12} />拒绝</button></div></>}
          </div>
        );
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
  const [exporting, setExporting] = useState(false);
  const [restoring, setRestoring] = useState<number | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const hydratedRef = useRef(false);
  const skipAutosaveRef = useRef(false);
  const lastSavedSignatureRef = useRef("");
  const draftRef = useRef<DraftResume | null>(null);
  const undoStackRef = useRef<DraftResume[]>([]);

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
      skipAutosaveRef.current = true; hydratedRef.current = true;
      setWorkspace(next); setDraft(next.resume as DraftResume); draftRef.current = next.resume as DraftResume;
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "简历工作区加载失败");
    } finally { setLoading(false); }
  }, [resumeId]);

  useEffect(() => { void loadWorkspace(); }, [loadWorkspace]);
  const draftSignature = useMemo(() => draft ? resumeSignature(draft) : "", [draft]);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    if (!draft || !hydratedRef.current) return;
    if (skipAutosaveRef.current) { skipAutosaveRef.current = false; lastSavedSignatureRef.current = draftSignature; return; }
    if (!draftSignature || draftSignature === lastSavedSignatureRef.current) return;
    const candidateSignature = draftSignature;
    setSaveState("saving");
    const timer = window.setTimeout(async () => {
      try {
        const saved = await resumeApi.update(draft.id, { user_name: draft.user_name, title: draft.title, summary: draft.summary, contact_json: draft.contact_json, template_id: draft.template_id, style_config: draft.style_config, language: draft.language, sections: draft.sections }) as DraftResume;
        if (draftRef.current && resumeSignature(draftRef.current) !== candidateSignature) return;
        lastSavedSignatureRef.current = resumeSignature(saved); skipAutosaveRef.current = true;
        draftRef.current = saved; setDraft(saved); setWorkspace((current) => current ? { ...current, resume: saved } : current); setSaveState("saved");
      } catch (error) {
        if (draftRef.current && resumeSignature(draftRef.current) !== candidateSignature) return;
        setSaveState("failed"); setWorkspaceError(error instanceof Error ? error.message : "无法保存简历修改");
      }
    }, 800);
    return () => window.clearTimeout(timer);
  }, [draft, draftSignature]);

  const setFromWorkspace = useCallback((next: ResumeWorkspace) => {
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
    const saved = await resumeApi.update(draft.id, { user_name: draft.user_name, title: draft.title, summary: draft.summary, contact_json: draft.contact_json, template_id: draft.template_id, style_config: draft.style_config, language: draft.language, sections: draft.sections }) as DraftResume;
    skipAutosaveRef.current = true; lastSavedSignatureRef.current = resumeSignature(saved); draftRef.current = saved; setDraft(saved); setWorkspace((current) => current ? { ...current, resume: saved } : current); setSaveState("saved"); return saved;
  }, [draft]);

  const retryAutosave = useCallback(async () => {
    if (!draft) return;
    const candidate = draft;
    const candidateSignature = resumeSignature(candidate);
    setSaveState("saving"); setWorkspaceError(null);
    try {
      const saved = await resumeApi.update(candidate.id, { user_name: candidate.user_name, title: candidate.title, summary: candidate.summary, contact_json: candidate.contact_json, template_id: candidate.template_id, style_config: candidate.style_config, language: candidate.language, sections: candidate.sections }) as DraftResume;
      if (draftRef.current && resumeSignature(draftRef.current) !== candidateSignature) return;
      skipAutosaveRef.current = true; lastSavedSignatureRef.current = resumeSignature(saved); draftRef.current = saved; setDraft(saved); setWorkspace((current) => current ? { ...current, resume: saved } : current); setSaveState("saved");
    } catch (error) {
      setSaveState("failed"); setWorkspaceError(error instanceof Error ? error.message : "无法保存简历修改");
    }
  }, [draft]);

  const handleSaveVersion = async () => {
    if (!draft) return; setPendingAction("version");
    try { const saved = await persistDraft(); await resumeApi.createVersion(saved?.id || draft.id, { change_summary: "Resume Workspace 编辑", created_by: "user" }); await loadWorkspace(); }
    catch (error) { setWorkspaceError(error instanceof Error ? error.message : "无法保存版本"); }
    finally { setPendingAction(null); }
  };

  const handleExport = async () => {
    if (!draft) return; setExporting(true); setWorkspaceError(null);
    try { await persistDraft(); const link = document.createElement("a"); link.href = resumeApi.exportPdfUrl(draft.id); link.download = `${draft.title || "resume"}.pdf`; link.style.display = "none"; document.body.appendChild(link); link.click(); window.setTimeout(() => link.remove(), 1000); }
    catch (error) { setWorkspaceError(error instanceof Error ? error.message : "PDF 导出失败"); }
    finally { setExporting(false); }
  };

  const handleProposalAction = async (changeId: string, action: "accept" | "reject", editedText = "") => {
    if (!workspace || !draft) return;
    const proposal = workspace.proposals.find((item) => ["ready", "in_review", "blocked"].includes(item.status)); if (!proposal) return;
    setPendingAction(changeId); setWorkspaceError(null);
    try { const next = await resumeApi.reviewProposalItem(proposal.proposal_id, { resume_id: draft.id, change_id: changeId, action, edited_text: editedText }); if (action === "accept") recordUndo(draft); setFromWorkspace(next); }
    catch (error) { setWorkspaceError(error instanceof Error ? error.message : "Proposal 审核失败"); await loadWorkspace(); }
    finally { setPendingAction(null); }
  };

  const handleAllProposalActions = async (action: "accept" | "reject") => {
    if (!workspace || !draft) return;
    let current = workspace; const proposal = current.proposals.find((item) => ["ready", "in_review", "blocked"].includes(item.status)); if (!proposal) return;
    const pending = proposal.diff.filter((item) => !proposal.item_reviews?.[String(item.change_id || "")]); setPendingAction(`all-${action}`);
    try { for (const item of pending) { const previous = current.resume as DraftResume; current = await resumeApi.reviewProposalItem(proposal.proposal_id, { resume_id: draft.id, change_id: String(item.change_id), action }); if (action === "accept") recordUndo(previous); setFromWorkspace(current); } }
    catch (error) { setWorkspaceError(error instanceof Error ? error.message : "批量审核失败"); await loadWorkspace(); }
    finally { setPendingAction(null); }
  };

  const handleRestore = async (versionId: number) => {
    if (!draft) return; setRestoring(versionId);
    try { recordUndo(draft); await resumeApi.restoreVersion(draft.id, versionId); await loadWorkspace(); }
    catch (error) { setWorkspaceError(error instanceof Error ? error.message : "无法恢复版本"); }
    finally { setRestoring(null); }
  };

  if (loading) return <div className="grid min-h-[70vh] place-items-center text-sm text-[var(--foreground-muted)]"><Loader2 className="animate-spin" size={20} /></div>;
  if (loadError || !workspace || !draft) return <div className="mx-auto max-w-xl p-8 text-sm text-red-700"><p>{loadError || "简历工作区不存在"}</p><button className="mt-4 underline" onClick={() => router.back()}>返回</button></div>;

  const style = draft.style_config || {};
  const setStyle = (key: string, value: string) => updateDraft({ style_config: { ...style, [key]: value } });
  const targetLabel = workspace.job ? `${workspace.job.company} · ${workspace.job.title}` : "未绑定目标岗位";
  const activeProposal = workspace.proposals.find((item) => ["ready", "in_review", "blocked"].includes(item.status));
  const staleProposal = workspace.proposals.find((item) => item.status === "stale");

  return (
    <div className="min-h-screen bg-[var(--background)] px-4 pb-8 pt-4 text-[var(--foreground)]" data-testid="resume-workspace">
      <header className="mx-auto flex max-w-[1800px] flex-wrap items-center justify-between gap-3 border-b border-[var(--border-strong)]/15 pb-4">
        <div className="flex min-w-0 items-center gap-3"><button type="button" onClick={() => router.back()} aria-label="返回" className="rounded-lg border border-[var(--border-strong)]/15 p-2 hover:bg-black/5"><ArrowLeft size={16} /></button><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h1 className="truncate text-lg font-black">Resume Workspace</h1><Badge tone="green">{workspace.application_packet.status === "ready" ? "已准备" : "草稿"}</Badge></div><p className="mt-1 truncate text-xs text-[var(--foreground-muted)]">{targetLabel}</p></div></div>
        <div className="flex flex-wrap items-center gap-2"><span className={`text-[11px] ${saveState === "failed" ? "text-red-600" : "text-[var(--foreground-muted)]"}`} data-testid="resume-save-status">{saveState === "saving" && "正在保存…"}{saveState === "saved" && "已保存"}{saveState === "failed" && "保存失败"}</span><button type="button" onClick={handleUndo} disabled={!canUndo} aria-label="撤销最近一次编辑" className="inline-flex items-center gap-1 rounded-lg border border-[var(--border-strong)]/20 px-3 py-2 text-xs font-bold hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40" data-testid="resume-undo"><Undo2 size={13} />撤销</button><button type="button" onClick={() => void handleSaveVersion()} disabled={pendingAction === "version"} className="inline-flex items-center gap-1 rounded-lg border border-[var(--border-strong)]/20 px-3 py-2 text-xs font-bold hover:bg-black/5 disabled:opacity-50" data-testid="resume-save-version">{pendingAction === "version" ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}保存版本</button><button type="button" onClick={() => void handleExport()} disabled={exporting} className="inline-flex items-center gap-1 rounded-lg bg-black px-3 py-2 text-xs font-bold text-white disabled:opacity-50" data-testid="resume-export-pdf">{exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}导出 PDF</button></div>
      </header>

      {(workspaceError || staleProposal) && <div className="mx-auto mt-3 flex max-w-[1800px] items-center justify-between rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="resume-workspace-error"><span>{workspaceError || "这条 AI Proposal 已过期，因为简历内容发生了变化。请重新生成建议或继续手动编辑。"}</span>{saveState === "failed" ? <button type="button" onClick={() => void retryAutosave()} className="font-bold underline" data-testid="resume-retry-save">重试保存</button> : <button type="button" onClick={() => void loadWorkspace()} className="font-bold underline">刷新</button>}</div>}

      <div className="mx-auto mt-4 grid max-w-[1800px] gap-4 xl:grid-cols-[minmax(300px,0.9fr)_minmax(480px,1.35fr)_minmax(300px,0.8fr)]">
        <section className="min-w-0 space-y-3" aria-label="简历内容编辑">
          <div className="rounded-xl border border-[var(--border-strong)]/15 bg-[var(--surface)] p-3"><div className="mb-3 flex items-center gap-2"><FileText size={15} /><h2 className="text-xs font-black uppercase tracking-[0.08em]">Content</h2></div><div className="space-y-2"><input value={draft.user_name || ""} onChange={(event) => updateDraft({ user_name: event.target.value })} aria-label="姓名" placeholder="姓名" className="w-full rounded-lg border border-[var(--border-strong)]/15 bg-white px-3 py-2 text-sm outline-none focus:border-black" data-testid="resume-name-input" /><input value={draft.title || ""} onChange={(event) => updateDraft({ title: event.target.value })} aria-label="简历标题" placeholder="简历标题" className="w-full rounded-lg border border-[var(--border-strong)]/15 bg-white px-3 py-2 text-sm outline-none focus:border-black" /><textarea value={draft.summary || ""} onChange={(event) => updateDraft({ summary: event.target.value })} aria-label="个人简介" placeholder="个人简介" className="min-h-20 w-full resize-y rounded-lg border border-[var(--border-strong)]/15 bg-white px-3 py-2 text-xs leading-relaxed outline-none focus:border-black" data-testid="resume-summary-input" /></div><div className="mt-3 border-t border-[var(--border-strong)]/10 pt-3"><p className="mb-2 text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--foreground-muted)]">联系方式</p><div className="grid grid-cols-2 gap-2">{["phone", "email", "linkedin", "github", "website", "wechat"].map((key) => <input key={key} value={String(draft.contact_json?.[key] || "")} onChange={(event) => updateDraft({ contact_json: { ...draft.contact_json, [key]: event.target.value } })} aria-label={key} placeholder={key} className="min-w-0 rounded-lg border border-[var(--border-strong)]/15 bg-white px-2 py-2 text-[11px] outline-none focus:border-black" />)}</div></div></div>
          <DndContext sensors={sectionSensors} collisionDetection={closestCenter} onDragEnd={handleSectionDragEnd}><SortableContext items={draft.sections.map((section) => `section-${section.id}`)} strategy={verticalListSortingStrategy}><div className="space-y-3">{draft.sections.map((section) => <SortableSectionCard key={section.id} section={section} onChange={updateSection} onToggle={() => updateSection({ ...section, visible: !section.visible })} onDelete={() => updateDraft({ sections: draft.sections.filter((item) => item.id !== section.id) })} />)}</div></SortableContext></DndContext>
          <div className="rounded-xl border border-dashed border-[var(--border-strong)]/25 bg-[var(--surface)] p-3"><div className="flex items-center gap-2 text-xs font-bold"><Plus size={14} />添加内容段落</div><div className="mt-2 grid grid-cols-2 gap-2">{EDITOR_SECTION_TYPES.map(([type, label]) => <button key={type} type="button" onClick={() => updateDraft({ sections: [...draft.sections, { id: -Date.now(), resume_id: draft.id, section_type: type, sort_order: draft.sections.length, title: label, visible: true, content_json: [], source_section_ids: [] }] })} className="rounded-lg border border-[var(--border-strong)]/15 px-2 py-2 text-left text-[11px] hover:bg-black/5">{label}</button>)}</div></div>
        </section>

        <section className="min-w-0 rounded-xl border border-[var(--border-strong)]/15 bg-[#e9e9e7] p-3" aria-label="简历实时预览"><div className="mb-3 flex items-center justify-between text-xs"><div className="flex items-center gap-2 font-black"><Eye size={14} />Live Preview <Badge>{style.pageSize === "LETTER" ? "Letter" : "A4"}</Badge></div><span className="text-[10px] text-[var(--foreground-muted)]">编辑即更新</span></div><div className="min-h-[900px] overflow-auto rounded-lg bg-[#d7d7d4] p-4"><div className="mx-auto w-fit origin-top scale-[0.78] pb-[-180px] shadow-2xl" data-testid="resume-live-preview"><ResumePreview userName={draft.user_name} title={draft.title} photoUrl={draft.photo_url} summary={draft.summary} contactJson={draft.contact_json || {}} sections={draft.sections} styleConfig={style} highlightKeywords={workspace.job?.keywords || []} /></div></div></section>

        <aside className="min-w-0 space-y-3" aria-label="简历工作区控制"><div className="flex rounded-xl border border-[var(--border-strong)]/15 bg-[var(--surface)] p-1" role="tablist">{([ ["ai", "AI Proposal", Wand2], ["design", "Design", Sparkles], ["versions", "Versions", History] ] as const).map(([key, label, Icon]) => <button key={key} type="button" role="tab" aria-selected={rightPanel === key} onClick={() => setRightPanel(key)} className={`flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-2 text-[10px] font-bold ${rightPanel === key ? "bg-black text-white" : "text-[var(--foreground-muted)] hover:bg-black/5"}`} data-testid={`resume-panel-${key}`}><Icon size={12} />{label}</button>)}</div>
          {rightPanel === "ai" && <div className="space-y-3"><div className="rounded-xl border border-[var(--border-strong)]/15 bg-[var(--surface)] p-3"><p className="text-xs font-black">目标岗位上下文</p><p className="mt-1 text-[11px] text-[var(--foreground-muted)]">{targetLabel}</p>{activeProposal?.strategy?.missing_capabilities?.length ? <p className="mt-2 text-[10px] text-amber-800">Evidence Gap：{activeProposal.strategy.missing_capabilities.join("、")}</p> : null}</div>{activeProposal ? <><div className="flex gap-2"><button type="button" onClick={() => void handleAllProposalActions("accept")} disabled={!!pendingAction || activeProposal.fact_gate_status === "blocked"} title={activeProposal.fact_gate_status === "blocked" ? "事实门未通过，请先补充 Evidence" : undefined} className="flex-1 rounded-lg bg-black px-2 py-2 text-[10px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-50">全部接受</button><button type="button" onClick={() => void handleAllProposalActions("reject")} disabled={!!pendingAction} className="flex-1 rounded-lg border border-[var(--border-strong)]/20 px-2 py-2 text-[10px] font-bold disabled:opacity-50">全部拒绝</button></div><ProposalCard proposal={activeProposal} onAction={(id, action, text) => void handleProposalAction(id, action, text)} pending={pendingAction} /></> : <div className="rounded-xl border border-dashed border-[var(--border-strong)]/20 bg-[var(--surface)] p-4 text-xs text-[var(--foreground-muted)]">当前没有待审核的 AI Proposal。你可以继续手动编辑这份岗位简历。</div>}</div>}
          {rightPanel === "design" && <div className="space-y-3 rounded-xl border border-[var(--border-strong)]/15 bg-[var(--surface)] p-3" data-testid="resume-design-panel"><div><p className="text-xs font-black">模板</p><div className="mt-2 grid gap-2">{TEMPLATE_OPTIONS.map((template) => <button key={template.id} type="button" onClick={() => setStyle("template", template.id)} className={`rounded-lg border px-3 py-2 text-left ${style.template === template.id ? "border-black bg-black text-white" : "border-[var(--border-strong)]/15 hover:bg-black/5"}`}><span className="block text-[11px] font-bold">{template.name}</span><span className={`mt-1 block text-[10px] ${style.template === template.id ? "text-white/70" : "text-[var(--foreground-muted)]"}`}>{template.description}</span></button>)}</div></div><label className="block text-[11px] font-bold">页面<select value={String(style.pageSize || "A4")} onChange={(event) => setStyle("pageSize", event.target.value)} className="mt-1 w-full rounded-lg border border-[var(--border-strong)]/15 bg-white px-2 py-2 text-xs"><option value="A4">A4</option><option value="LETTER">Letter</option></select></label><label className="block text-[11px] font-bold">强调色<input type="color" value={String(style.accentColorHex || "#1d4ed8")} onChange={(event) => setStyle("accentColorHex", event.target.value)} className="mt-1 h-9 w-full rounded-lg border border-[var(--border-strong)]/15 bg-white p-1" /></label><label className="block text-[11px] font-bold">正文大小 <span className="float-right font-normal text-[var(--foreground-muted)]">{style.bodySize || "12"}pt</span><input type="range" min="10" max="16" step="0.5" value={Number(style.bodySize || 12)} onChange={(event) => setStyle("bodySize", event.target.value)} className="mt-2 w-full" /></label><label className="block text-[11px] font-bold">行高 <span className="float-right font-normal text-[var(--foreground-muted)]">{style.lineHeight || "1.45"}</span><input type="range" min="1.15" max="1.8" step="0.05" value={Number(style.lineHeight || 1.45)} onChange={(event) => setStyle("lineHeight", event.target.value)} className="mt-2 w-full" /></label><label className="block text-[11px] font-bold">段落间距 <span className="float-right font-normal text-[var(--foreground-muted)]">{style.sectionGap || "14"}pt</span><input type="range" min="6" max="24" value={Number(style.sectionGap || 14)} onChange={(event) => setStyle("sectionGap", event.target.value)} className="mt-2 w-full" /></label></div>}
          {rightPanel === "versions" && <div className="space-y-2 rounded-xl border border-[var(--border-strong)]/15 bg-[var(--surface)] p-3" data-testid="resume-version-panel"><div className="mb-2 flex items-center justify-between"><p className="text-xs font-black">版本历史</p><span className="text-[10px] text-[var(--foreground-muted)]">当前 V{workspace.application_packet.current_version_number || 1}</span></div>{workspace.versions.length === 0 && <p className="text-xs text-[var(--foreground-muted)]">保存第一个版本后会显示在这里。</p>}{workspace.versions.map((version) => <div key={version.id} className={`rounded-lg border p-3 ${version.is_current ? "border-emerald-300 bg-emerald-50" : "border-[var(--border-strong)]/10"}`}><div className="flex items-center justify-between"><span className="text-xs font-black">V{version.version_number}</span>{version.is_current && <Badge tone="green">Current</Badge>}</div><p className="mt-1 text-[11px]">{version.change_summary}</p><p className="mt-1 text-[10px] text-[var(--foreground-muted)]">{version.created_by} · {new Date(version.created_at).toLocaleString()}</p>{!version.is_current && <button type="button" onClick={() => void handleRestore(version.id)} disabled={restoring === version.id} className="mt-2 inline-flex items-center gap-1 text-[10px] font-bold underline disabled:opacity-50">{restoring === version.id ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />}恢复此版本</button>}</div>)}</div>}
          <div className="rounded-xl border border-[var(--border-strong)]/15 bg-[var(--surface)] p-3 text-[11px]"><p className="font-black">Application Packet</p><div className="mt-2 space-y-1.5 text-[var(--foreground-muted)]"><p className="flex items-center justify-between"><span>Tailored Resume</span><Badge tone="green">V{workspace.application_packet.current_version_number || "Draft"}</Badge></p><p className="flex items-center justify-between"><span>Role Intelligence</span><span>{workspace.application_packet.artifacts.research ? "已关联" : "待准备"}</span></p><p className="flex items-center justify-between"><span>Interview Focus</span><span>{workspace.application_packet.artifacts.interview_focus ? "已关联" : "待准备"}</span></p></div></div>
        </aside>
      </div>
    </div>
  );
}
