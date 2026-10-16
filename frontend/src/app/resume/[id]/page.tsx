"use client";

/**
 * 简历编辑器：左边是纸（直接在上面改，所见即导出），右边是 AI 建议和版本历史。
 * 没有表单——表单和纸两份内容是旧编辑器 bug 的来源。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { resumeApi, type ResumeWorkspace } from "@/lib/api";
import type { ResumeDetail, ResumeSectionBlock } from "@/lib/hooks";
import ResumeSheet from "../components/ResumeSheet";
import { normalizeTemplateSettings } from "../components/templates/templateSettings";
import type { AskAgentRequest } from "../components/templates/FormatBar";
import PaperToolbar, { type ToolbarSection } from "../components/canvas/PaperToolbar";
import { buildCommentPrompt, CanvasAgentMenu, CommentTray, SuggestionCard, type CanvasComment, type InlineChange } from "../components/canvas/CanvasAssist";
import { conflictsWithManualEdit, findTargetSection } from "../components/canvas/proposalDiff";
import { composeToAgent, toggleAgentDrawer } from "@/lib/agentCompose";
import { safeClientErrorMessage } from "@/lib/safe-error";

type DraftResume = ResumeDetail & { sections: ResumeSectionBlock[] };
type SaveState = "idle" | "saving" | "saved" | "failed";

function resumeSignature(resume: DraftResume) {
  return JSON.stringify({
    user_name: resume.user_name, title: resume.title, photo_url: resume.photo_url, summary: resume.summary,
    contact_json: resume.contact_json, style_config: resume.style_config, sections: resume.sections,
  });
}

const LOGO_KEYS = ["schoolLogoUrl", "universityLogoUrl", "logoUrl", "school_logo_url"];
const ACTIVE_PROPOSAL = ["ready", "in_review", "blocked"];

export default function ResumeEditorPage() {
  const params = useParams();
  const router = useRouter();
  const resumeId = Number(params?.id);
  const [workspace, setWorkspace] = useState<ResumeWorkspace | null>(null);
  const [agentRequest, setAgentRequest] = useState<AskAgentRequest | null>(null);
  const [draft, setDraft] = useState<DraftResume | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [panel, setPanel] = useState<"suggestions" | "history">("suggestions");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [restoring, setRestoring] = useState<number | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [comments, setComments] = useState<CanvasComment[]>([]);
  const [fitting, setFitting] = useState(false);
  const [fitNotice, setFitNotice] = useState<string | null>(null);

  // 量出成品高度：超过一页时画分页线并显示页数。
  const [canvasEl, setCanvasEl] = useState<HTMLDivElement | null>(null);
  const [pageOverflowMm, setPageOverflowMm] = useState(0);
  const canvasNodeRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useCallback((node: HTMLDivElement | null) => { canvasNodeRef.current = node; setCanvasEl(node); }, []);
  const letter = draft?.style_config?.pageSize === "LETTER";
  const pageMm = letter ? 279.4 : 297;
  const pageHeightPx = (pageMm * 96) / 25.4;
  useEffect(() => {
    if (!canvasEl || typeof ResizeObserver === "undefined") { setPageOverflowMm(0); return; }
    // 只量成品：同步地临时藏起编辑控件、去掉最小高度，读完立刻还原（不会闪）。
    const measure = () => {
      const body = canvasEl.querySelector<HTMLElement>(".resume-body");
      if (!body) { setPageOverflowMm(0); return; }
      const minHeight = body.style.minHeight;
      body.classList.add("paper-measuring");
      body.style.minHeight = "0px";
      const height = body.getBoundingClientRect().height;
      body.style.minHeight = minHeight;
      body.classList.remove("paper-measuring");
      setPageOverflowMm(Math.max(0, ((height - pageHeightPx) * 25.4) / 96));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(canvasEl);
    measure();
    return () => observer.disconnect();
  }, [canvasEl, pageHeightPx]);
  const pageCount = pageOverflowMm > 0.5 ? 1 + Math.ceil((pageOverflowMm - 0.5) / pageMm) : 1;

  useEffect(() => {
    if (!fitNotice) return;
    const timer = window.setTimeout(() => setFitNotice(null), 6000);
    return () => window.clearTimeout(timer);
  }, [fitNotice]);

  const hydratedRef = useRef(false);
  const skipAutosaveRef = useRef(false);
  const lastSavedSignatureRef = useRef("");
  const draftRef = useRef<DraftResume | null>(null);
  const revisionRef = useRef<number | undefined>(undefined);
  const saveQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const undoStackRef = useRef<DraftResume[]>([]);

  const saveDraftRecord = useCallback((candidate: DraftResume) => {
    const pending = saveQueueRef.current.catch(() => undefined).then(async () => {
      const saved = await resumeApi.update(candidate.id, {
        user_name: candidate.user_name, title: candidate.title, summary: candidate.summary, contact_json: candidate.contact_json,
        template_id: candidate.template_id, style_config: candidate.style_config, language: candidate.language,
        sections: candidate.sections, expected_revision: revisionRef.current,
      }) as DraftResume;
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
      setLoadError(safeClientErrorMessage(error, "简历加载失败"));
    } finally { setLoading(false); }
  }, [resumeId]);

  useEffect(() => { void loadWorkspace(); }, [loadWorkspace]);
  const draftSignature = useMemo(() => draft ? resumeSignature(draft) : "", [draft]);
  useEffect(() => { draftRef.current = draft; }, [draft]);

  const acceptSaved = useCallback((saved: DraftResume) => {
    skipAutosaveRef.current = true; lastSavedSignatureRef.current = resumeSignature(saved); draftRef.current = saved;
    setDraft(saved); setWorkspace((current) => current ? { ...current, resume: saved } : current); setSaveState("saved");
  }, []);

  // 填好学校后自动配校徽：只在还没有校徽时、对每个校名试一次；配不上就留给纸上的「上传」。
  const logoAttemptsRef = useRef(new Set<string>());
  const firstSchool = (() => {
    for (const section of draft?.sections || []) {
      if (section.visible === false || section.section_type !== "education" || !Array.isArray(section.content_json)) continue;
      for (const item of section.content_json as Array<Record<string, unknown>>) if (typeof item?.school === "string" && item.school.trim()) return item.school.trim();
    }
    return "";
  })();
  const hasLogo = LOGO_KEYS.some((key) => draft?.contact_json?.[key]);
  useEffect(() => {
    if (!draft || hasLogo || firstSchool.length < 2 || logoAttemptsRef.current.has(firstSchool)) return;
    const timer = window.setTimeout(async () => {
      logoAttemptsRef.current.add(firstSchool);
      try {
        const found = await resumeApi.resolveLogo(draft.id, firstSchool);
        setDraft((current) => current && { ...current, contact_json: { ...current.contact_json, schoolName: found.school_name, schoolLogoUrl: found.schoolLogoUrl, schoolLogoSource: found.source } });
      } catch { /* 没配上：纸上的校徽位保持「上传」入口 */ }
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [draft?.id, firstSchool, hasLogo]);

  // 自动保存：停手 0.8 秒后存；存的过程中又改了就以最新的为准。
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
        acceptSaved(saved);
      } catch (error) {
        if (draftRef.current && resumeSignature(draftRef.current) !== candidateSignature) return;
        setSaveState("failed"); setWorkspaceError(safeClientErrorMessage(error, "无法保存简历修改"));
      }
    }, 800);
    return () => window.clearTimeout(timer);
  }, [draft, draftSignature, pendingAction, saveDraftRecord, acceptSaved]);

  const persistDraft = useCallback(async () => {
    if (!draft) return null;
    const candidateSignature = resumeSignature(draft);
    const saved = await saveDraftRecord(draft);
    if (draftRef.current && resumeSignature(draftRef.current) !== candidateSignature) return saved;
    acceptSaved(saved);
    return saved;
  }, [draft, saveDraftRecord, acceptSaved]);

  const retrySave = async () => {
    setSaveState("saving"); setWorkspaceError(null);
    try { await persistDraft(); } catch (error) { setSaveState("failed"); setWorkspaceError(safeClientErrorMessage(error, "无法保存简历修改")); }
  };

  const setFromWorkspace = useCallback((next: ResumeWorkspace) => {
    revisionRef.current = next.resume.workspace_revision;
    skipAutosaveRef.current = true; draftRef.current = next.resume as DraftResume;
    setWorkspace(next); setDraft(next.resume as DraftResume); setSaveState("saved"); setWorkspaceError(null);
  }, []);
  const updateDraft = useCallback((patch: Partial<DraftResume>) => {
    setDraft((current) => { if (!current) return current; recordUndo(current); return { ...current, ...patch }; });
    setSaveState("idle");
  }, [recordUndo]);
  const updateSection = useCallback((section: ResumeSectionBlock) => {
    setDraft((current) => { if (!current) return current; recordUndo(current); return { ...current, sections: current.sections.map((item) => item.id === section.id ? section : item) }; });
    setSaveState("idle");
  }, [recordUndo]);

  const handleExport = async () => {
    if (!draft) return; setExporting(true); setWorkspaceError(null);
    try {
      await persistDraft();
      const response = await resumeApi.exportPdf(draft.id);
      if (!response.ok) throw new Error(`PDF 导出失败（HTTP ${response.status}）`);
      const objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = objectUrl; link.download = `${draft.title || "resume"}.pdf`; link.style.display = "none";
      document.body.appendChild(link); link.click();
      window.setTimeout(() => { link.remove(); URL.revokeObjectURL(objectUrl); }, 1000);
    } catch (error) { setWorkspaceError(safeClientErrorMessage(error, "PDF 导出失败")); }
    finally { setExporting(false); }
  };

  const handleAssetUpload = async (kind: "photo" | "logo", file: File | null) => {
    if (!draft) return;
    if (file && (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024)) {
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
      const result = await resumeApi.updateDesign(draft.id, {
        expected_revision: saved.workspace_revision,
        ...(file ? { [kind]: { content_b64: content, content_type: file.type } } : { [`remove_${kind}`]: true }),
      }) as DraftResume;
      revisionRef.current = result.workspace_revision;
      lastSavedSignatureRef.current = resumeSignature(result);
      skipAutosaveRef.current = false;
      setSaveState("saved");
      setDraft((current) => {
        if (!current) return current;
        const contact = { ...current.contact_json };
        if (kind === "logo") for (const key of LOGO_KEYS) { if (result.contact_json[key]) contact[key] = result.contact_json[key]; else delete contact[key]; }
        return { ...current, photo_url: result.photo_url, contact_json: contact, workspace_revision: result.workspace_revision };
      });
      setWorkspace(await resumeApi.workspace(draft.id));
    } catch (error) { setWorkspaceError(safeClientErrorMessage(error, "图片上传失败")); skipAutosaveRef.current = false; }
    finally { setPendingAction(null); }
  };

  const activeProposal = workspace?.proposals.find((item) => ACTIVE_PROPOSAL.includes(item.status));
  const reviewChanges = async (changeIds: string[], action: "accept" | "reject", editedText = "") => {
    if (!activeProposal || !draft || !changeIds.length) return;
    setPendingAction(changeIds.length === 1 ? changeIds[0] : `group-${action}`); setWorkspaceError(null);
    try {
      const next = changeIds.length === 1
        ? await resumeApi.reviewProposalItem(activeProposal.proposal_id, { resume_id: draft.id, change_id: changeIds[0], action, edited_text: editedText })
        : await resumeApi.reviewProposalItems(activeProposal.proposal_id, { resume_id: draft.id, change_ids: changeIds, action });
      if (action === "accept") recordUndo(draft);
      setFromWorkspace(next);
    } catch (error) { setWorkspaceError(safeClientErrorMessage(error, "处理 AI 建议失败")); await loadWorkspace(); }
    finally { setPendingAction(null); }
  };

  const handleSaveVersion = async () => {
    if (!draft) return; setPendingAction("version");
    try { const saved = await persistDraft(); await resumeApi.createVersion(saved?.id || draft.id, { change_summary: "手动保存", created_by: "user" }); await loadWorkspace(); }
    catch (error) { setWorkspaceError(safeClientErrorMessage(error, "无法保存版本")); }
    finally { setPendingAction(null); }
  };

  const handleRestore = async (versionId: number) => {
    if (!draft) return; setRestoring(versionId);
    try { recordUndo(draft); await resumeApi.restoreVersion(draft.id, versionId); await loadWorkspace(); }
    catch (error) { setWorkspaceError(safeClientErrorMessage(error, "无法恢复版本")); }
    finally { setRestoring(null); }
  };

  if (loading) return <div className="grid min-h-[70vh] place-items-center text-sm text-[var(--foreground-muted)]"><Loader2 className="animate-spin" size={20} /></div>;
  if (loadError || !workspace || !draft) return <div className="mx-auto max-w-xl p-8 text-sm text-red-700"><p>{loadError || "简历不存在"}</p><button className="mt-4 underline" onClick={() => router.back()}>返回</button></div>;

  const style = draft.style_config || {};
  const settings = normalizeTemplateSettings(style);
  const setStyle = (patch: Record<string, string>) => updateDraft({ style_config: { ...style, ...patch } });
  const LAYOUT_KEYS = ["font", "bodySize", "lineHeight", "sectionGap", "itemGap", "marginTop", "marginBottom", "marginLeft", "marginRight", "accentColorHex"];
  const resetLayout = () => updateDraft({ style_config: Object.fromEntries(Object.entries(style).filter(([key]) => !LAYOUT_KEYS.includes(key))) });

  // 智能一页：只动字号、行距、间距和页边距，直接量真实排版。
  // 超出一页：从当前值一步步压向下限，第一个放得进一页的就用它；压到下限还放不下就按多页排。
  // 不到一页且下方空得多：字号、行距、间距一步步放大（页边距不动），取最后一个还放得下的。
  const fitOnePage = () => {
    const body = canvasNodeRef.current?.querySelector<HTMLElement>(".resume-body");
    if (!body) return;
    setFitting(true);
    const current: Record<string, number> = {
      bodySize: settings.exact.bodySize, lineHeight: settings.exact.lineHeight,
      sectionGap: settings.exact.sectionGap, itemGap: settings.exact.itemGap,
      marginTop: settings.margins.top, marginBottom: settings.margins.bottom,
      marginLeft: settings.margins.left, marginRight: settings.margins.right,
    };
    const floor: Record<string, number> = { bodySize: 8.5, lineHeight: 1.25, sectionGap: 5, itemGap: 2, marginTop: 7, marginBottom: 7, marginLeft: 9, marginRight: 9 };
    // 放大有上限：内容少就留白，不靠拉大段距凑满一页。
    const ceiling: Record<string, number> = { bodySize: 10.5, lineHeight: 1.55, sectionGap: 10, itemGap: 5 };
    const at = (t: number, grow = false) => Object.fromEntries(Object.entries(current).map(([key, value]) => {
      const target = grow ? Math.max(value, ceiling[key] ?? value) : Math.min(value, floor[key]);
      const digits = key === "lineHeight" ? 100 : 10;
      return [key, Math.round((value + (target - value) * t) * digits) / digits];
    })) as Record<string, number>;
    const vars = (v: Record<string, number>) => ({
      "--font-size-base": `${v.bodySize}pt`, "--line-height": String(v.lineHeight),
      "--section-gap": `${v.sectionGap}pt`, "--item-gap": `${v.itemGap}pt`,
      "--margin-top": `${v.marginTop}mm`, "--margin-bottom": `${v.marginBottom}mm`,
      "--margin-left": `${v.marginLeft}mm`, "--margin-right": `${v.marginRight}mm`,
    });
    const saved = Object.keys(vars(current)).map((key) => [key, body.style.getPropertyValue(key)] as const);
    const savedMinHeight = body.style.minHeight;
    body.classList.add("paper-measuring");
    body.style.minHeight = "0px";
    const heightAt = (v: Record<string, number>) => {
      Object.entries(vars(v)).forEach(([key, value]) => body.style.setProperty(key, value));
      return body.getBoundingClientRect().height;
    };
    const fits = (v: Record<string, number>, room = 1) => heightAt(v) <= pageHeightPx * room + 0.5;
    let chosen: Record<string, number> | null = null;
    let grown = false;
    const currentHeight = heightAt(current);
    const already = currentHeight <= pageHeightPx + 0.5;
    if (!already) {
      for (let step = 1; step <= 12; step += 1) {
        const candidate = at(step / 12);
        if (fits(candidate)) { chosen = candidate; break; }
      }
    } else if (currentHeight < pageHeightPx * 0.9) {
      // 放大时给打印留 3% 余量，免得屏幕上刚好一页、导出变两页。
      for (let step = 1; step <= 12; step += 1) {
        const candidate = at(step / 12, true);
        if (!fits(candidate, 0.94)) break;
        chosen = candidate; grown = true;
      }
      if (chosen && Object.keys(chosen).every((key) => chosen?.[key] === current[key])) chosen = null;
    }
    saved.forEach(([key, value]) => body.style.setProperty(key, value));
    body.style.minHeight = savedMinHeight;
    body.classList.remove("paper-measuring");
    setFitting(false);
    if (!chosen) { setFitNotice(already ? "已经占满一页" : `内容超过一页，已按 ${pageCount} 页排版`); return; }
    const picked = chosen;
    setStyle(Object.fromEntries(Object.entries(picked).map(([key, value]) => [key, String(value)])));
    setFitNotice(`${grown ? "已放大到合适大小" : "已放进一页"}：字号 ${picked.bodySize} pt · 行距 ${picked.lineHeight}`);
  };

  const targetLabel = workspace.job ? `${workspace.job.company} · ${workspace.job.title}` : "";
  const staleProposal = workspace.proposals.find((item) => item.status === "stale");
  const pendingChanges: InlineChange[] = activeProposal
    ? (activeProposal.diff || []).filter((change) => !activeProposal.item_reviews?.[String(change.change_id || "")]) as InlineChange[]
    : [];
  const factGateBlocked = activeProposal?.fact_gate_status === "blocked";
  const suggestions = pendingChanges.map((change) => {
    const target = change.change_type === "added" ? undefined : findTargetSection(draft.sections, change);
    const conflict = conflictsWithManualEdit(target, change);
    const inferred = Array.isArray(change.inferred_skills) && change.inferred_skills.length > 0;
    return { change, target, conflict, safe: !conflict && !inferred && change.fact_gate?.status !== "blocked" };
  });
  const safeIds = suggestions.filter((item) => item.safe).map((item) => String(item.change.change_id));

  const askRewrite = (target?: ResumeSectionBlock) => composeToAgent({
    skillId: "tailor_resume",
    message: buildCommentPrompt(draft.id, targetLabel || "通用校招", [{
      id: "rewrite", quote: target?.title || "这一段", section: target?.title || "这一段",
      instruction: "我在你的建议生成后手动改过这一段。请基于我现在的版本重新给出建议，保留我改过的措辞。",
    }]),
  });
  const locate = (target?: ResumeSectionBlock) => {
    if (!target) return;
    const node = canvasNodeRef.current?.querySelector<HTMLElement>(`[data-section-id="${target.id}"]`);
    if (!node) return;
    node.scrollIntoView({ behavior: "smooth", block: "center" });
    node.classList.add("is-located");
    window.setTimeout(() => node.classList.remove("is-located"), 1400);
  };
  const addSection = (type: string, label: string) => updateDraft({ sections: [...draft.sections, {
    id: -(Date.now() * 1000 + Math.floor(Math.random() * 1000)), resume_id: draft.id, section_type: type,
    sort_order: Math.max(-1, ...draft.sections.map((section) => section.sort_order || 0)) + 1,
    title: label, visible: true, content_json: [], source_section_ids: [],
  }] });
  const submitComments = () => {
    if (!comments.length) return;
    composeToAgent({ skillId: "tailor_resume", message: buildCommentPrompt(draft.id, targetLabel || "通用校招", comments) });
    setComments([]);
  };
  const saveLabel = { idle: "", saving: "正在保存…", saved: "已保存", failed: "保存失败" }[saveState];
  const tab = (key: typeof panel, label: string) => (
    <button type="button" role="tab" aria-selected={panel === key} onClick={() => setPanel(key)} data-testid={`resume-panel-${key}`}
      className={`h-8 flex-1 rounded-md text-[13px] ${panel === key ? "bg-white font-medium text-[#191919] shadow-[0_1px_2px_rgba(15,15,15,0.08)]" : "text-[#787774] hover:text-[#37352f]"}`}>{label}</button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-white text-[var(--foreground)]" data-testid="resume-workspace">
      <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-black/[0.06] px-5">
        <div className="flex min-w-0 items-center gap-4 text-[14px]">
          <p className="min-w-0 truncate"><button type="button" onClick={() => router.push("/resume")} className="text-[#9b9a97] hover:text-[#37352f]">简历</button><span className="mx-1.5 text-[#c9c7c1]">/</span><span className="text-[#191919]">{draft.title || "未命名简历"}</span></p>
          <span className={`shrink-0 text-[13px] ${saveState === "failed" ? "text-red-600" : "text-[#9b9a97]"}`} data-testid="resume-save-status">{saveLabel}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {targetLabel && <span className="hidden max-w-[320px] items-center gap-2 truncate rounded-lg bg-[#f7f7f5] px-3 py-1.5 text-[13px] text-[#37352f] md:inline-flex" title={targetLabel}><span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#d9730d]" />目标：{targetLabel}</span>}
          <button type="button" onClick={toggleAgentDrawer} className="h-9 rounded-lg px-3 text-[14px] text-[#37352f] hover:bg-black/[0.04]" data-testid="resume-open-agent">Agent</button>
          <button type="button" onClick={handleUndo} disabled={!canUndo} aria-label="撤销最近一次编辑" className="h-9 rounded-lg px-3 text-[14px] text-[#37352f] hover:bg-black/[0.04] disabled:opacity-35" data-testid="resume-undo">撤销</button>
          <button type="button" onClick={() => void handleExport()} disabled={exporting} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[#191919] px-4 text-[14px] font-medium text-white hover:bg-black disabled:opacity-50" data-testid="resume-export-pdf">{exporting && <Loader2 size={14} className="animate-spin" />}导出 PDF</button>
        </div>
      </header>

      {(workspaceError || staleProposal) && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-5 py-2 text-[13px] text-amber-900" data-testid="resume-workspace-error">
          <span>{workspaceError || "简历内容已经变了，这批 AI 建议作废了。可以让 AI 重新提，或继续手动改。"}</span>
          {saveState === "failed"
            ? <button type="button" onClick={() => void retrySave()} className="font-medium underline" data-testid="resume-retry-save">重试保存</button>
            : <button type="button" onClick={() => void loadWorkspace()} className="font-medium underline">刷新</button>}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 overflow-auto bg-[#f1f1ef] px-6 pb-16" aria-label="简历（可直接编辑）">
          <PaperToolbar
            bodySize={settings.exact.bodySize}
            lineHeight={settings.exact.lineHeight}
            paperStyle={style.paperStyle === "kami" ? "kami" : "cv"}
            pages={pageCount}
            pageSize={letter ? "LETTER" : "A4"}
            fitting={fitting}
            sections={draft.sections as ToolbarSection[]}
            layout={{
              font: settings.font, sectionGap: settings.exact.sectionGap, itemGap: settings.exact.itemGap,
              marginVertical: settings.margins.top, marginHorizontal: settings.margins.left, themeColor: settings.themeColor,
            }}
            onBodySize={(value) => setStyle({ bodySize: String(value) })}
            onLineHeight={(value) => setStyle({ lineHeight: String(value) })}
            onPaperStyle={(value) => setStyle({ paperStyle: value })}
            onStyle={setStyle}
            onReset={resetLayout}
            onFit={fitOnePage}
            onSections={(next) => {
              const byId = new Map(next.map((section) => [section.id, section]));
              updateDraft({ sections: draft.sections.map((section) => {
                const moved = byId.get(section.id);
                return moved ? { ...section, sort_order: moved.sort_order, visible: moved.visible } : section;
              }) });
            }}
            onAddModule={addSection}
            trailing={fitNotice && <span className="rounded-md bg-[#191919] px-2.5 py-1 text-[12px] text-white" role="status" data-testid="paper-fit-notice">{fitNotice}</span>}
          />
          <div className="relative mx-auto mt-6 w-fit" data-testid="resume-live-preview" ref={canvasRef}>
            <ResumeSheet
              userName={draft.user_name} title={draft.title} photoUrl={draft.photo_url} summary={draft.summary}
              contactJson={draft.contact_json || {}} sections={draft.sections} styleConfig={style} editable
              onProfileChange={(patch) => updateDraft(patch)}
              onSectionChange={(section) => updateSection(section as unknown as ResumeSectionBlock)}
              onUploadAsset={handleAssetUpload}
              onStyleChange={setStyle}
              onAskAgent={setAgentRequest}
            />
            {agentRequest && (
              <CanvasAgentMenu request={agentRequest} onClose={() => setAgentRequest(null)}
                onAddComment={(comment) => setComments((current) => [...current, { ...comment, id: `comment-${Date.now()}-${current.length}` }])} />
            )}
            {Array.from({ length: pageCount - 1 }, (_, index) => (
              <div key={index} className="pointer-events-none absolute left-0 right-0 border-t border-dashed border-[#c9c7c1]" style={{ top: `${pageHeightPx * (index + 1)}px` }} data-testid="resume-page-break">
                <span className="absolute -right-2 -translate-y-1/2 translate-x-full text-[11px] text-[#9b9a97]">第 {index + 2} 页</span>
              </div>
            ))}
          </div>
          <CommentTray comments={comments} onRemove={(id) => setComments((current) => current.filter((item) => item.id !== id))} onSubmit={submitComments} />
        </main>

        <aside className="hidden w-[360px] shrink-0 flex-col border-l border-black/[0.06] bg-white lg:flex" aria-label="建议与历史">
          <div className="p-4 pb-3">
            <div className="flex rounded-lg bg-[#f1f1ef] p-0.5" role="tablist">
              {tab("suggestions", pendingChanges.length ? `建议 ${pendingChanges.length}` : "建议")}
              {tab("history", "历史")}
            </div>
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-auto px-4 pb-4">
            {panel === "suggestions" && <>
              {suggestions.length > 1 && safeIds.length > 0 && (
                <div className="flex items-center justify-between text-[12px] text-[#9b9a97]" data-testid="resume-ai-summary">
                  <span>{factGateBlocked ? "有建议缺少经历依据，需逐条处理" : "点卡片可在简历上定位"}</span>
                  <button type="button" disabled={!!pendingAction} onClick={() => void reviewChanges(safeIds, "accept")} className="rounded-md px-2 py-1 text-[#37352f] hover:bg-black/[0.04] disabled:opacity-40">全部采用（{safeIds.length}）</button>
                </div>
              )}
              {suggestions.map(({ change, target, conflict }) => (
                <SuggestionCard key={change.change_id} change={change} sectionLabel={target?.title || change.after?.title || change.title || ""}
                  conflict={conflict} factGateBlocked={factGateBlocked} busy={!!pendingAction}
                  onAccept={(edited) => void reviewChanges([String(change.change_id)], "accept", edited || "")}
                  onSkip={() => void reviewChanges([String(change.change_id)], "reject")}
                  onAskRewrite={() => askRewrite(target)} onLocate={() => locate(target)} />
              ))}
              {!suggestions.length && (
                <div className="rounded-xl border border-dashed border-black/10 p-5 text-[13px] leading-6 text-[#787774]">
                  <p>现在没有待确认的建议。</p>
                  <button type="button" className="mt-3 h-8 rounded-lg border border-black/10 px-3 text-[13px] text-[#37352f] hover:bg-black/[0.03]"
                    onClick={() => composeToAgent({ skillId: "tailor_resume", message: `请按${targetLabel ? `「${targetLabel}」` : "通用校招标准"}帮我改岗位简历 #${draft.id}，以可审核的修改建议提交。` })}>
                    让 Agent 提建议
                  </button>
                </div>
              )}
            </>}
            {panel === "history" && <div data-testid="resume-version-panel">
              <button type="button" onClick={() => void handleSaveVersion()} disabled={pendingAction === "version"} className="mb-3 inline-flex h-8 items-center gap-1.5 rounded-lg border border-black/10 px-3 text-[13px] text-[#37352f] hover:bg-black/[0.03] disabled:opacity-50" data-testid="resume-save-version">
                {pendingAction === "version" && <Loader2 size={13} className="animate-spin" />}存为新版本
              </button>
              {workspace.versions.length === 0 && <p className="text-[13px] text-[#9b9a97]">还没有保存过版本。</p>}
              <ol className="space-y-1">
                {workspace.versions.map((version) => (
                  <li key={version.id} className="rounded-lg px-3 py-2.5 hover:bg-black/[0.03]">
                    <div className="flex items-center justify-between gap-2 text-[13px]">
                      <span className="font-medium text-[#191919]">V{version.version_number}{version.is_current && <span className="ml-2 font-normal text-[#9b9a97]">当前</span>}</span>
                      {!version.is_current && <button type="button" onClick={() => void handleRestore(version.id)} disabled={restoring === version.id} className="text-[12px] text-[#787774] hover:text-[#191919] disabled:opacity-50">{restoring === version.id ? "恢复中…" : "恢复"}</button>}
                    </div>
                    <p className="mt-0.5 text-[12px] text-[#787774]">{version.change_summary}</p>
                    <p className="mt-0.5 text-[11px] text-[#9b9a97]">{new Date(version.created_at).toLocaleString()}</p>
                  </li>
                ))}
              </ol>
            </div>}
          </div>
          <p className="border-t border-black/[0.06] px-4 py-3 text-[12px] text-[#9b9a97]">在简历上选中文字可以直接改，或让 Agent 帮你改。</p>
        </aside>
      </div>
    </div>
  );
}