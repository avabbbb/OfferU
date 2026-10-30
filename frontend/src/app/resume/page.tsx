"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { mutate } from "swr";

import { ResumeEditor } from "@/components/core/ResumeEditor";
import { type PreviewHandle, ResumePreview } from "@/components/resume/ResumePreview";
import { StylePanel } from "@/components/resume/StylePanel";
import { apiUrl, type Doc, type Job, type Memory, type Profile, tool, useTool, write } from "@/lib/core";
import { resumeFromProfile } from "@/lib/resumeDraft";
import { type FitOutcome, fitOnePage, resolveStyle, type ResumeStyle } from "@/lib/resumeStyle";

const FIT_NOTICE: Record<FitOutcome, string> = {
  fits: "已经刚好一页",
  shrunk: "已压到一页",
  grown: "已放大填满一页",
  overflow: "压到下限还是超过一页，建议删减内容",
};

const refreshOverview = () => void mutate((k) => Array.isArray(k) && k[1] === "overview");

function Editor({ doc, jobs, photo, onCopy }: { doc: Doc; jobs: Job[]; photo?: string; onCopy: (doc: Doc) => void }) {
  const router = useRouter();
  const preview = useRef<PreviewHandle>(null);
  const [source, setSource] = useState(false);
  const [body, setBody] = useState(doc.body ?? "");
  const [title, setTitle] = useState(doc.title ?? "");
  const [saved, setSaved] = useState(true);
  const [style, setStyle] = useState<ResumeStyle>(() => resolveStyle(doc.style, doc.template));
  const [styleSaved, setStyleSaved] = useState(true);
  const [fitting, setFitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const outerStyle = JSON.stringify([doc.style ?? null, doc.template ?? null]);

  useEffect(() => { setBody(doc.body ?? ""); setTitle(doc.title ?? ""); }, [doc.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Agent 或撤销改了内容、而你这边没有没存的修改时，跟上外面的版本。
  useEffect(() => { if (saved && (doc.body ?? "") !== body) setBody(doc.body ?? ""); }, [doc.body]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (styleSaved) setStyle(resolveStyle(doc.style, doc.template)); }, [outerStyle]); // eslint-disable-line react-hooks/exhaustive-deps
  // 边写边存：连续编辑在「最近改动」里只算一条，可以整段撤销。
  useEffect(() => {
    if (body === (doc.body ?? "")) return;
    setSaved(false);
    const t = setTimeout(async () => { await tool("save", { type: "doc", id: doc.id, data: { body } }); setSaved(true); refreshOverview(); }, 800);
    return () => clearTimeout(t);
  }, [body]); // eslint-disable-line react-hooks/exhaustive-deps
  // 排版停顿 500ms 后整份 style 存一次（更新要传完整对象）。
  useEffect(() => {
    if (styleSaved) return;
    const t = setTimeout(async () => { await tool("save", { type: "doc", id: doc.id, data: { style } }); setStyleSaved(true); refreshOverview(); }, 500);
    return () => clearTimeout(t);
  }, [style, styleSaved]); // eslint-disable-line react-hooks/exhaustive-deps

  const changeStyle = (next: ResumeStyle) => { setStyle(next); setStyleSaved(false); setNotice(null); };

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

  const job = jobs.find((j) => j.id === doc.job_id);
  const link = "text-[12.5px] text-[var(--foreground-muted)] hover:text-[var(--foreground)]";
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-[var(--border)] px-6 py-3">
        <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="简历名称" style={{ fontSize: 15 }}
          onBlur={() => { if (title !== (doc.title ?? "")) void write("save", { type: "doc", id: doc.id, data: { title: title.trim() || null } }); }}
          className="min-w-[160px] flex-1 bg-transparent text-[15px] font-medium text-[var(--foreground)] outline-none" />
        {job && <Link href={"/jobs/" + job.id} className={link}>{job.label}</Link>}
        <button type="button" onClick={() => setSource(!source)} style={{ fontSize: 13 }} aria-pressed={source}
          className={source ? "text-[13px] font-medium text-[var(--foreground)]" : "text-[13px] text-[var(--foreground-muted)] hover:text-[var(--foreground)]"}>源码</button>
        <span className="w-12 text-[12px] text-[var(--foreground-muted)]">{saved && styleSaved ? "已保存" : "保存中"}</span>
        <button type="button" style={{ fontSize: 12.5 }} className={link}
          onClick={() => onCopy({ ...doc, title, body, style })}>复制</button>
        <button type="button" aria-label="删除这份简历" style={{ fontSize: 12.5 }} className={link}
          onClick={async () => { await write("delete", { type: "doc", id: doc.id }); router.push("/resume"); }}>删除</button>
      </div>
      <div className="flex min-h-0 flex-1">
        <ResumeEditor body={body} template={style.template} photo={style.photo ? photo : undefined} source={source} onChange={setBody} />
        <div className="flex w-[46%] min-w-[360px] shrink-0 flex-col border-l border-[var(--border)]">
          <StylePanel style={style} onChange={changeStyle} onFit={() => void fit()} fitting={fitting} notice={notice}
            hasPhoto={Boolean(photo)} pdfHref={apiUrl("/api/resume/" + doc.id + "/pdf")} />
          <ResumePreview ref={preview} body={body} style={style} />
        </div>
      </div>
    </div>
  );
}

/** 简历：一份主简历 + 按岗位改的版本。左边按块写，右边就是导出的样子。 */
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
    let body = "# 你的名字\n电话 · 邮箱 · 城市\n\n## 教育经历\n### 学校 | 专业 学历 | 2022.09 – 2026.06\n";
    if (fromProfile) {
      const [profile, memories] = await Promise.all([
        tool<{ record: Profile | null }>("get", { type: "profile" }),
        tool<{ items: Memory[] }>("list", { type: "memory", full: true, limit: 500 }),
      ]);
      body = resumeFromProfile(profile.record ?? {}, [...memories.items].sort((a, b) => a.id - b.id));
    }
    await open({ title: docs.length ? "新简历" : "主简历", body });
  };

  const copy = (doc: Doc) => void open({ title: (doc.title || "简历") + " 副本", body: doc.body ?? "", style: doc.style, job_id: doc.job_id ?? null });

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
    <div className="flex h-full min-h-0">
      <nav aria-label="简历列表" className="w-52 shrink-0 space-y-0.5 border-r border-[var(--border)] px-3 py-4">
        {docs.map((d) => (
          <Link key={d.id} href={"/resume/" + d.id}
            className={"block truncate rounded-md px-2 py-1.5 text-[13px] " + (d.id === current.id ? "bg-[var(--surface)] font-medium text-[var(--foreground)]" : "text-[var(--foreground-muted)] hover:text-[var(--foreground)]")}>
            {d.title || "简历"}
            {d.job_id && <span className="block truncate text-[11.5px] font-normal text-[var(--foreground-muted)]">{jobs.find((j) => j.id === d.job_id)?.label}</span>}
          </Link>
        ))}
        <button type="button" onClick={() => void create(true)} style={{ fontSize: 12.5 }} className="mt-2 block px-2 text-[12.5px] text-[var(--foreground-muted)] hover:text-[var(--foreground)]">从档案新建</button>
        <button type="button" onClick={() => void create(false)} style={{ fontSize: 12.5 }} className="mt-1 block px-2 text-[12.5px] text-[var(--foreground-muted)] hover:text-[var(--foreground)]">空白新建</button>
      </nav>
      <Editor key={current.id} doc={current} jobs={jobs} photo={profileData?.record?.photo} onCopy={copy} />
    </div>
  );
}
