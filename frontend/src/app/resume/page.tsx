"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { ArrowLeft, FileText, Pencil, Sparkles } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { mutate } from "swr";

import { BasicsMedia } from "@/components/resume/BasicsMedia";
import { BASICS, ModuleList } from "@/components/resume/ModuleList";
import { type EditorFocus, ModuleEditor } from "@/components/resume/ModuleEditor";
import { type PreviewHandle, ResumePreview } from "@/components/resume/ResumePreview";
import { ResumeActions } from "@/components/resume/ResumeActions";
import { StyleTab } from "@/components/resume/StyleTab";
import { hasTailorResult, TailorBar } from "@/components/resume/TailorBar";
import { TemplateTab } from "@/components/resume/TemplateTab";
import { VersionList } from "@/components/resume/VersionList";
import { Disclosure, Reveal, SPRING } from "@/app/interview/kit";
import { ActivePill, Button } from "@/components/ui";
import { type Doc, type Job, type Memory, type Profile, tool, useTool, write } from "@/lib/core";
import { resumeFromProfile } from "@/lib/resumeDraft";
import { emptyResume, locatePath, normalizeResume, type Resume } from "@/lib/resumeModel";
import { resumeToText } from "@/lib/resumeText";
import { PageError, PageLoading } from "@/components/layout/PageState";
import { type FitOutcome, fitOnePage, resolveStyle, type ResumeStyle } from "@/lib/resumeStyle";
import "@/styles/resume-editor.css";
import "@/styles/resume.css";

const FIT_NOTICE: Record<FitOutcome, string> = {
  fits: "已经刚好一页",
  shrunk: "已压到一页",
  grown: "已放大填满一页",
  overflow: "压到下限还是超过一页，建议删减内容",
};

// 宽窗口里各栏要正好占满视口剩下的高度（各栏自己滚，整页不滚，顶栏下面没有内容滚过去）；窄窗口整页滚（见 resume.css）。
// 上面有没有「简历 / 档案」分段、外层留白多少都不固定，所以按自己离视口顶的距离量。
function useFillViewport() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => el.style.setProperty("--re-fill", Math.max(0, window.innerHeight - el.getBoundingClientRect().top) + "px");
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  return ref;
}

// 编辑栏三个标签：编辑内容 / 排版美化 / 更换模版。
const TABS = [["content", "编辑内容"], ["style", "排版美化"], ["template", "更换模版"]] as const;
type Tab = (typeof TABS)[number][0];

const refreshOverview = () => void mutate((k) => Array.isArray(k) && k[1] === "overview");

function Editor({ doc, docs, jobs, photo, onCopy, onCreate }: {
  doc: Doc; docs: Doc[]; jobs: Job[]; photo?: string; onCopy: (doc: Doc) => void; onCreate: (fromProfile: boolean) => void;
}) {
  const router = useRouter();
  const preview = useRef<PreviewHandle>(null);
  const shell = useFillViewport();
  const [resume, setResume] = useState<Resume>(() => normalizeResume(doc.resume));
  const latest = useRef(resume);
  latest.current = resume;
  const [focus, setFocus] = useState<EditorFocus | null>(null);
  // 展开的模块（BASICS 或 section.id）：一次只展开一块；预览里点到哪一条就展开它所在的模块并滚过去。
  // 默认全部收起（渐进式披露：先看文档，再展开要改的那一块）；空字符串 = 没有展开的模块。
  const [selected, setSelected] = useState<string>("");
  const [tab, setTab] = useState<Tab>("content");
  const pick = (id: string) => { setSelected(id); setTab("content"); };
  const toggle = (id: string) => setSelected((now) => (now === id ? "" : id));
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(doc.title ?? "");
  const [saved, setSaved] = useState(true);
  const [style, setStyle] = useState<ResumeStyle>(() => resolveStyle(doc.style, doc.template));
  const [styleSaved, setStyleSaved] = useState(true);
  const [fitting, setFitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [tailoring, setTailoring] = useState(false);
  const outerResume = JSON.stringify(doc.resume ?? null);
  const outerStyle = JSON.stringify([doc.style ?? null, doc.template ?? null]);

  // Agent、按岗位改写或撤销改了内容、而你这边没有没存的修改时，跟上外面的版本。
  useEffect(() => { if (saved) setResume(normalizeResume(doc.resume)); }, [outerResume]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (styleSaved) setStyle(resolveStyle(doc.style, doc.template)); }, [outerStyle]); // eslint-disable-line react-hooks/exhaustive-deps
  // 边写边存：停顿 800ms 整份 resume 存一次，连续编辑在「最近改动」里只算一条。存的时候又改了，就等下一轮。
  useEffect(() => {
    if (saved) return;
    const t = setTimeout(async () => {
      await tool("save", { type: "doc", id: doc.id, data: { resume } });
      if (latest.current === resume) setSaved(true);
      refreshOverview();
    }, 800);
    return () => clearTimeout(t);
  }, [resume, saved]); // eslint-disable-line react-hooks/exhaustive-deps
  // 排版停顿 500ms 后整份 style 存一次（更新要传完整对象）。
  useEffect(() => {
    if (styleSaved) return;
    const t = setTimeout(async () => { await tool("save", { type: "doc", id: doc.id, data: { style } }); setStyleSaved(true); refreshOverview(); }, 500);
    return () => clearTimeout(t);
  }, [style, styleSaved]); // eslint-disable-line react-hooks/exhaustive-deps

  // 顶栏「保存」、导出、分享之前：把还在等停顿的改动立刻存下（存完对应的定时器在 effect 清理里取消）。
  const latestStyle = useRef(style);
  latestStyle.current = style;
  const saveNow = async () => {
    const pending: Promise<unknown>[] = [];
    if (!saved) {
      const snap = latest.current;
      pending.push(tool("save", { type: "doc", id: doc.id, data: { resume: snap } }).then(() => { if (latest.current === snap) setSaved(true); }));
    }
    if (!styleSaved) {
      const snap = latestStyle.current;
      pending.push(tool("save", { type: "doc", id: doc.id, data: { style: snap } }).then(() => { if (latestStyle.current === snap) setStyleSaved(true); }));
    }
    if (!pending.length) return;
    await Promise.all(pending);
    refreshOverview();
  };

  const changeStyle = (next: ResumeStyle) => { setStyle(next); setStyleSaved(false); setNotice(null); };
  const changeResume = (next: Resume) => { if (tailoring) return; setResume(next); setSaved(false); setNotice(null); };

  const fit = async () => {
    const measure = (s: ResumeStyle) => preview.current?.measure(s) ?? 0;
    if (!measure(style)) { setNotice("预览还没加载好，稍等再试"); return; }
    setFitting(true);
    try {
      const result = await fitOnePage(style, measure);
      if (result.style !== style) changeStyle(result.style);
      setNotice(FIT_NOTICE[result.outcome]);
    } finally {
      setFitting(false);
    }
  };

  // 名字下拉里的增删改：改当前这份时同步编辑器里的名字；复制当前这份带上还没存的内容。
  const rename = (target: Doc, next: string) => {
    if (target.id === doc.id) setTitle(next);
    void write("save", { type: "doc", id: target.id, data: { title: next } });
  };
  const remove = async (target: Doc) => {
    await write("delete", { type: "doc", id: target.id });
    if (target.id === doc.id) router.push("/resume");
  };
  const copy = (target: Doc) => onCopy(target.id === doc.id ? { ...doc, title, resume, style } : target);

  const job = jobs.find((j) => j.id === doc.job_id);
  const school = resume.sections.find((s) => s.type === "education")?.items[0]?.title.trim() ?? "";
  const allSaved = saved && styleSaved;
  const finishRename = (value: string) => {
    setRenaming(false);
    const next = value.trim();
    if (next && next !== title) rename(doc, next);
  };
  return (
    <div ref={shell} className="resume-shell re-shell rz">
      {/* 页头：返回 · 大标题（当前这份简历）+ 一行状态 ……… 安静的「分享」· 墨黑的「导出」 */}
      <header className="rz-head">
        <button type="button" className="ou-icon-button rz-back" aria-label="返回" title="返回"
          onClick={() => ((window.history.state as { idx?: number } | null)?.idx ? router.back() : router.push("/"))}>
          <ArrowLeft size={18} aria-hidden />
        </button>
        <div className="rz-heading">
          <div className="rz-title-row">
            {renaming ? (
              <input autoFocus defaultValue={title} aria-label="简历名称" className="rz-title-input"
                onFocus={(e) => e.currentTarget.select()} onBlur={(e) => finishRename(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") { e.currentTarget.value = title; e.currentTarget.blur(); }
                }} />
            ) : (
              <>
                <h1 className="rz-title" title={title.trim() || "未命名简历"}>{title.trim() || "未命名简历"}</h1>
                <button type="button" className="ou-icon-button rz-rename" aria-label="改简历名" title="改简历名" onClick={() => setRenaming(true)}>
                  <Pencil size={15} aria-hidden />
                </button>
              </>
            )}
          </div>
          <p className="rz-meta">
            <span className="rs-saved" data-pending={allSaved ? undefined : ""} aria-live="polite">{allSaved ? "已保存" : "保存中…"}</span>
            {job ? <Link href={"/jobs/" + job.id} className="rz-joblink">为「{job.label}」定制</Link> : <span>通用版，按岗位复制一份再改</span>}
          </p>
        </div>
        <ResumeActions docId={doc.id} dirty={!allSaved} saveNow={saveNow} plainText={() => resumeToText(latest.current)} />
      </header>

      <div className="rz-body">
        <aside className="rz-versions">
          <VersionList docs={docs} current={doc} jobs={jobs} title={title} onRename={rename} onCreate={onCreate} onCopy={copy}
            onDelete={(d) => void remove(d)} />
        </aside>

        {/* 焦点：文档本身。上面一条安静的「按岗位定制」，点开才露出岗位选择和 AI 结果。 */}
        <motion.section className="rz-doc" aria-label="简历预览" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={SPRING}>
          <div className="rz-tailor">
            <Disclosure testId="resume-tailor" defaultOpen={hasTailorResult(doc.id)}
              icon={<Sparkles size={15} className="rz-agent-icon" aria-hidden />}
              title={job ? "按「" + job.label + "」再改一版" : "按岗位定制"}
              summary={tailoring ? "Agent 在改写…" : "Agent 起草 · 审稿 · 可撤销"}>
              <TailorBar docId={doc.id} jobId={doc.job_id} jobs={jobs} disabled={!allSaved} onRunning={setTailoring}
                onDone={async (id) => { await mutate((k) => Array.isArray(k) && k[0] === "tool"); if (id !== doc.id) router.push("/resume/" + id); }} />
            </Disclosure>
          </div>
          <ResumePreview ref={preview} resume={resume} style={style}
            onLocate={(path) => {
              const at = locatePath(resume, path);
              pick(at.sectionId ?? BASICS);
              setFocus({ itemId: at.itemId ?? (at.basics ? BASICS : undefined), at: Date.now() });
            }} />
        </motion.section>

        <section className="rz-inspector re-editor" aria-label="编辑与排版">
          <div className="re-tabs ou-segment ou-pill-host" role="tablist" aria-label="编辑栏">
            <ActivePill />
            {TABS.map(([id, label]) => (
              <button key={id} type="button" role="tab" id={"re-tab-" + id} aria-selected={tab === id} aria-controls="re-tabpanel"
                className="ou-segment-item" onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </div>
          <div id="re-tabpanel" role="tabpanel" className="re-tabpanel" aria-labelledby={"re-tab-" + tab}>
            {tab === "content" && (
              <div className="rz-modules">
                <ModuleList resume={resume} onChange={changeResume} selected={selected} onSelect={toggle}
                  renderBody={(id) => (
                    <ModuleEditor bare resume={resume} onChange={changeResume} selected={id} focus={focus} readOnly={tailoring}
                      doc={{ id: doc.id, title }} canPolish={allSaved && !tailoring}
                      basicsExtra={<BasicsMedia style={style} onStyle={changeStyle} photo={photo} school={school}
                        onPhoto={() => void mutate((k) => Array.isArray(k) && k[0] === "tool")} />} />
                  )} />
              </div>
            )}
            {tab === "style" && <StyleTab style={style} onChange={changeStyle} onFit={() => void fit()} fitting={fitting} notice={notice} />}
            {tab === "template" && <TemplateTab resume={resume} style={style} onChange={changeStyle} />}
          </div>
        </section>
      </div>
    </div>
  );
}

/** 简历：一份主简历 + 按岗位改的版本。左边按块写，右边就是导出的样子；切换、新建、改名、复制、删除都在简历名的下拉里。 */
export default function ResumePage() {
  const params = useParams();
  const router = useRouter();
  const { data, error, mutate } = useTool<{ items: Doc[] }>("list", { type: "doc", kind: "resume", full: true, limit: 200 }, 5000);
  const { data: jobData } = useTool<{ items: Job[] }>("list", { type: "job", limit: 500 });
  const { data: profileData } = useTool<{ record: Profile | null }>("get", { type: "profile" });
  if (error && !data) return <PageError title="简历没能读出来" error={error} onRetry={() => void mutate()} />;
  if (!data) return <PageLoading label="正在打开简历…" rows={6} />;
  const docs = [...data.items].sort((a, b) => Number(Boolean(a.job_id)) - Number(Boolean(b.job_id)) || a.id - b.id);
  const jobs = jobData?.items ?? [];
  const current = docs.find((d) => d.id === Number(params.id)) ?? docs[0];

  const open = async (data: Record<string, unknown>) => {
    const { record } = await write<{ record: Doc }>("save", { type: "doc", data: { kind: "resume", ...data } });
    router.push("/resume/" + record.id);
  };

  const create = async (fromProfile: boolean) => {
    let resume = emptyResume();
    if (fromProfile) {
      const [profile, memories] = await Promise.all([
        tool<{ record: Profile | null }>("get", { type: "profile" }),
        tool<{ items: Memory[] }>("list", { type: "memory", full: true, limit: 500 }),
      ]);
      resume = resumeFromProfile(profile.record ?? {}, [...memories.items].sort((a, b) => a.id - b.id));
    }
    // 新建的简历默认用 kami；没存 style 的旧简历仍按 classic 显示，不变样。
    await open({ title: docs.length ? "新简历" : "主简历", resume, style: { template: "kami" } });
  };

  const copy = (doc: Doc) => void open({ title: (doc.title || "简历") + " 副本", resume: doc.resume, style: doc.style, job_id: doc.job_id ?? null });

  if (!current) {
    // 空状态：一张卡、一个墨黑主操作；「空白开始」是安静的文字钮。
    return (
      <div className="ou-page ou-page-reading rz-empty-page">
        <Reveal className="rz-empty">
          <span className="ou-tile rz-empty-tile" aria-hidden><FileText size={22} /></span>
          <h1 className="rz-empty-title">先做一份主简历</h1>
          <p className="rz-empty-lead">从档案里的经历起草，右边就是导出的 PDF。之后按岗位复制一份改。</p>
          <Button variant="primary" className="rz-empty-primary" onClick={() => void create(true)}>从档案生成</Button>
          <Button variant="ghost" className="rz-empty-quiet" onClick={() => void create(false)}>或者空白开始</Button>
          <p className="rz-empty-note">档案还空着？先去 <Link href="/profile" className="rz-inline-link">档案</Link> 填经历，或者导入旧简历。</p>
        </Reveal>
      </div>
    );
  }

  return (
    <div className="resume-shell flex min-h-0">
      <Editor key={current.id} doc={current} docs={docs} jobs={jobs} photo={profileData?.record?.photo} onCopy={copy}
        onCreate={(fromProfile) => void create(fromProfile)} />
    </div>
  );
}
