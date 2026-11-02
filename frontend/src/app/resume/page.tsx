"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { mutate } from "swr";

import { BasicsMedia } from "@/components/resume/BasicsMedia";
import { DownloadButton } from "@/components/resume/DownloadButton";
import { type FormFocus, ResumeForm } from "@/components/resume/ResumeForm";
import { type PreviewHandle, ResumePreview } from "@/components/resume/ResumePreview";
import { ResumeSwitcher } from "@/components/resume/ResumeSwitcher";
import { StylePanel } from "@/components/resume/StylePanel";
import { TailorBar } from "@/components/resume/TailorBar";
import { type Doc, type Job, type Memory, type Profile, tool, useTool, write } from "@/lib/core";
import { resumeFromProfile } from "@/lib/resumeDraft";
import { emptyResume, locatePath, normalizeResume, type Resume } from "@/lib/resumeModel";
import { type FitOutcome, fitOnePage, resolveStyle, type ResumeStyle } from "@/lib/resumeStyle";

const FIT_NOTICE: Record<FitOutcome, string> = {
  fits: "已经刚好一页",
  shrunk: "已压到一页",
  grown: "已放大填满一页",
  overflow: "压到下限还是超过一页，建议删减内容",
};

const refreshOverview = () => void mutate((k) => Array.isArray(k) && k[1] === "overview");

function Editor({ doc, docs, jobs, photo, onCopy, onCreate }: {
  doc: Doc; docs: Doc[]; jobs: Job[]; photo?: string; onCopy: (doc: Doc) => void; onCreate: (fromProfile: boolean) => void;
}) {
  const router = useRouter();
  const preview = useRef<PreviewHandle>(null);
  const [resume, setResume] = useState<Resume>(() => normalizeResume(doc.resume));
  const latest = useRef(resume);
  latest.current = resume;
  const [focus, setFocus] = useState<FormFocus | null>(null);
  const [title, setTitle] = useState(doc.title ?? "");
  const [saved, setSaved] = useState(true);
  const [style, setStyle] = useState<ResumeStyle>(() => resolveStyle(doc.style, doc.template));
  const [styleSaved, setStyleSaved] = useState(true);
  const [fitting, setFitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
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
  const changeResume = (next: Resume) => { setResume(next); setSaved(false); setNotice(null); };

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
  const link = "text-[12.5px] text-[var(--foreground-muted)] hover:text-[var(--foreground)]";
  return (
    <div className="resume-shell flex min-w-0 flex-1 flex-col bg-[var(--background)]">
      <header className="rs-head">
        <ResumeSwitcher docs={docs} current={doc} jobs={jobs} title={title} onRename={rename} onCreate={onCreate} onCopy={copy}
          onDelete={(d) => void remove(d)} />
        {job && <Link href={"/jobs/" + job.id} className={link + " shrink-0"}>{job.label}</Link>}
        <span className="rs-saved">{saved && styleSaved ? "已保存" : "保存中…"}</span>
        <StylePanel style={style} onChange={changeStyle} onFit={() => void fit()} fitting={fitting} notice={notice} />
        <DownloadButton docId={doc.id} />
      </header>
      <div className="flex min-h-0 flex-1">
        <ResumeForm resume={resume} onChange={changeResume} focus={focus}
          basicsExtra={<BasicsMedia style={style} onStyle={changeStyle} photo={photo} school={school}
            onPhoto={() => void mutate((k) => Array.isArray(k) && k[0] === "tool")} />} />
        <div className="flex w-[56%] min-w-[420px] shrink-0 flex-col bg-[var(--background)]">
          <ResumePreview ref={preview} resume={resume} style={style}
            toolbar={<TailorBar docId={doc.id} jobId={doc.job_id} jobs={jobs} disabled={!saved || !styleSaved}
              onDone={() => mutate((k) => Array.isArray(k) && k[0] === "tool")} />}
            onLocate={(path) => setFocus({ ...locatePath(resume, path), at: Date.now() })} />
        </div>
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
    await open({ title: docs.length ? "新简历" : "主简历", resume });
  };

  const copy = (doc: Doc) => void open({ title: (doc.title || "简历") + " 副本", resume: doc.resume, style: doc.style, job_id: doc.job_id ?? null });

  if (!current) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="text-[24px] font-semibold tracking-tight text-[var(--foreground)]">简历</h1>
        <p className="mt-1 text-[13.5px] text-[var(--foreground-muted)]">先有一份主简历，再按岗位复制一份改。左边按块写，右边就是导出的 PDF。</p>
        <div className="mt-6 flex gap-3">
          <button type="button" onClick={() => void create(true)} style={{ fontSize: 13 }} className="rounded-md bg-[var(--foreground)] px-3 py-1.5 text-[13px] font-medium text-[var(--background)]">从档案生成</button>
          <button type="button" onClick={() => void create(false)} style={{ fontSize: 13 }} className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[13px] text-[var(--foreground)] hover:bg-[var(--surface)]">空白开始</button>
        </div>
        <p className="mt-4 text-[13px] text-[var(--foreground-muted)]">档案还空着？先去 <Link href="/profile" className="underline">档案</Link> 填经历，或者导入旧简历。</p>
      </div>
    );
  }

  return (
    <div className="resume-shell flex h-full min-h-0 bg-[var(--background)]">
      <Editor key={current.id} doc={current} docs={docs} jobs={jobs} photo={profileData?.record?.photo} onCopy={copy}
        onCreate={(fromProfile) => void create(fromProfile)} />
    </div>
  );
}
