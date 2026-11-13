"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { mutate } from "swr";

import { BasicsMedia } from "@/components/resume/BasicsMedia";
import { DownloadButton } from "@/components/resume/DownloadButton";
import { BASICS, ModuleList } from "@/components/resume/ModuleList";
import { type FormFocus, ResumeForm } from "@/components/resume/ResumeForm";
import { type PreviewHandle, ResumePreview } from "@/components/resume/ResumePreview";
import { ResumeSwitcher } from "@/components/resume/ResumeSwitcher";
import { StylePanel } from "@/components/resume/StylePanel";
import { TailorBar } from "@/components/resume/TailorBar";
import { Button } from "@/components/ui";
import { type Doc, type Job, type Memory, type Profile, tool, useTool, write } from "@/lib/core";
import { resumeFromProfile } from "@/lib/resumeDraft";
import { emptyResume, locatePath, normalizeResume, type Resume } from "@/lib/resumeModel";
import { type FitOutcome, fitOnePage, resolveStyle, type ResumeStyle } from "@/lib/resumeStyle";
import "@/styles/resume-editor.css";

const FIT_NOTICE: Record<FitOutcome, string> = {
  fits: "已经刚好一页",
  shrunk: "已压到一页",
  grown: "已放大填满一页",
  overflow: "压到下限还是超过一页，建议删减内容",
};

// 三栏要正好占满视口剩下的高度（各栏自己滚，整页不滚，顶栏下面没有内容滚过去）。
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
  const [focus, setFocus] = useState<FormFocus | null>(null);
  // 左栏选中的模块（BASICS 或 section.id）：右栏跟着滚过去；预览里点到哪个块也切到它所在的模块。
  const [selected, setSelected] = useState<string>(BASICS);
  const select = (id: string) => {
    setSelected(id);
    setFocus(id === BASICS ? { basics: true, at: Date.now() } : { sectionId: id, at: Date.now() });
  };
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
  return (
    <div ref={shell} className="resume-shell re-shell">
      <header className="rs-head">
        <ResumeSwitcher docs={docs} current={doc} jobs={jobs} title={title} onRename={rename} onCreate={onCreate} onCopy={copy}
          onDelete={(d) => void remove(d)} />
        {job && <Link href={"/jobs/" + job.id} className="rs-joblink">{job.label}</Link>}
        <span className="rs-saved" data-pending={saved && styleSaved ? undefined : ""} aria-live="polite">{saved && styleSaved ? "已保存" : "保存中…"}</span>
        <StylePanel style={style} onChange={changeStyle} onFit={() => void fit()} fitting={fitting} notice={notice} />
        <DownloadButton docId={doc.id} />
      </header>
      <div className="re-grid">
        <aside className="re-rail">
          <ModuleList resume={resume} onChange={changeResume} selected={selected} onSelect={select} />
        </aside>
        <div className="re-preview">
          <ResumePreview ref={preview} resume={resume} style={style}
            toolbar={<TailorBar docId={doc.id} jobId={doc.job_id} jobs={jobs} disabled={!saved || !styleSaved} onRunning={setTailoring}
              onDone={async (id) => { await mutate((k) => Array.isArray(k) && k[0] === "tool"); if (id !== doc.id) router.push("/resume/" + id); }} />}
            onLocate={(path) => {
              const at = locatePath(resume, path);
              setSelected(at.sectionId ?? BASICS);
              setFocus({ ...at, at: Date.now() });
            }} />
        </div>
        <section className="re-editor" aria-label="编辑内容">
          <ResumeForm resume={resume} onChange={changeResume} focus={focus} readOnly={tailoring}
            basicsExtra={<BasicsMedia style={style} onStyle={changeStyle} photo={photo} school={school}
              onPhoto={() => void mutate((k) => Array.isArray(k) && k[0] === "tool")} />} />
        </section>
      </div>
    </div>
  );
}

/** 简历：一份主简历 + 按岗位改的版本。左边按块写，右边就是导出的样子；切换、新建、改名、复制、删除都在简历名的下拉里。 */
export default function ResumePage() {
  const params = useParams();
  const router = useRouter();
  const { data } = useTool<{ items: Doc[] }>("list", { type: "doc", kind: "resume", full: true, limit: 200 }, 5000);
  const { data: jobData } = useTool<{ items: Job[] }>("list", { type: "job", limit: 500 });
  const { data: profileData } = useTool<{ record: Profile | null }>("get", { type: "profile" });
  if (!data) return null;
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
    return (
      <div className="ou-page ou-page-default">
        <h1 className="rs-empty-title">简历</h1>
        <p className="rs-empty-lead">先有一份主简历，再按岗位复制一份改。左边按块写，右边就是导出的 PDF。</p>
        <div className="rs-empty-actions">
          <Button variant="primary" onClick={() => void create(true)}>从档案生成</Button>
          <Button variant="secondary" onClick={() => void create(false)}>空白开始</Button>
        </div>
        <p className="rs-empty-note">档案还空着？先去 <Link href="/profile" className="underline">档案</Link> 填经历，或者导入旧简历。</p>
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
