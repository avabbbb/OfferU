"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { mutate } from "swr";

import { ResumeEditor } from "@/components/core/ResumeEditor";
import { apiUrl, type Doc, type Job, type Memory, type Profile, TEMPLATES, type Template, tool, useTool, write } from "@/lib/core";
import { resumeFromProfile } from "@/lib/resumeDraft";

function Editor({ doc, jobs, photo }: { doc: Doc; jobs: Job[]; photo?: string }) {
  const router = useRouter();
  const [source, setSource] = useState(false);
  const [body, setBody] = useState(doc.body ?? "");
  const [title, setTitle] = useState(doc.title ?? "");
  const [saved, setSaved] = useState(true);
  useEffect(() => { setBody(doc.body ?? ""); setTitle(doc.title ?? ""); }, [doc.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Agent 或撤销改了内容、而你这边没有没存的修改时，跟上外面的版本。
  useEffect(() => { if (saved && (doc.body ?? "") !== body) setBody(doc.body ?? ""); }, [doc.body]); // eslint-disable-line react-hooks/exhaustive-deps
  // 边写边存：连续编辑在「最近改动」里只算一条，可以整段撤销。
  useEffect(() => {
    if (body === (doc.body ?? "")) return;
    setSaved(false);
    const t = setTimeout(async () => { await tool("save", { type: "doc", id: doc.id, data: { body } }); setSaved(true); void mutate((k) => Array.isArray(k) && k[1] === "overview"); }, 800);
    return () => clearTimeout(t);
  }, [body]); // eslint-disable-line react-hooks/exhaustive-deps
  const template = doc.template ?? "single";
  const job = jobs.find((j) => j.id === doc.job_id);
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-[var(--border)] px-6 py-3">
        <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="简历名称" style={{ fontSize: 15 }}
          onBlur={() => { if (title !== (doc.title ?? "")) void write("save", { type: "doc", id: doc.id, data: { title: title.trim() || null } }); }}
          className="min-w-[160px] flex-1 bg-transparent text-[15px] font-medium text-[var(--foreground)] outline-none" />
        {job && <Link href={`/jobs/${job.id}`} className="text-[12.5px] text-[var(--foreground-muted)] hover:text-[var(--foreground)]">{job.label}</Link>}
        <div role="radiogroup" aria-label="模板" className="flex gap-3 text-[13px]" style={{ fontSize: 13 }}>
          {(Object.keys(TEMPLATES) as Template[]).map((id) => (
            <button key={id} type="button" role="radio" aria-checked={template === id} style={{ fontSize: 13 }}
              onClick={() => void write("save", { type: "doc", id: doc.id, data: { template: id } })}
              className={template === id ? "font-medium text-[var(--foreground)]" : "text-[var(--foreground-muted)] hover:text-[var(--foreground)]"}>{TEMPLATES[id]}</button>
          ))}
        </div>
        <button type="button" onClick={() => setSource(!source)} style={{ fontSize: 13 }} aria-pressed={source}
          className={source ? "text-[13px] font-medium text-[var(--foreground)]" : "text-[13px] text-[var(--foreground-muted)] hover:text-[var(--foreground)]"}>源码</button>
        <span className="w-12 text-[12px] text-[var(--foreground-muted)]">{saved ? "已保存" : "保存中"}</span>
        <a href={apiUrl(`/api/resume/${doc.id}/pdf`)} download style={{ fontSize: 13 }}
          className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[13px] text-[var(--foreground)] hover:bg-[var(--surface)]">导出 PDF</a>
        <button type="button" aria-label="删除这份简历" style={{ fontSize: 12.5 }} className="text-[12.5px] text-[var(--foreground-muted)] hover:text-[var(--foreground)]"
          onClick={async () => { await write("delete", { type: "doc", id: doc.id }); router.push("/resume"); }}>删除</button>
      </div>
      <p className="px-6 pt-3 text-[12px] text-[var(--foreground-muted)]">
        直接在纸上改，和 Typora 一样用 Markdown 的写法：{["# 名字", "## 分节", "### 公司 | 职位 | 时间", "- 要点", "**加粗**"].map((t) => <span key={t} className="ml-3 text-[var(--foreground)]">{t}</span>)}
      </p>
      <ResumeEditor body={body} template={template} photo={photo} source={source} onChange={setBody} />
    </div>
  );
}

/** 简历：一份主简历 + 按岗位改的版本。左边写 Markdown，右边就是导出的样子。 */
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

  const create = async (fromProfile: boolean) => {
    let body = "# 你的名字\n电话 · 邮箱 · 城市\n\n## 教育经历\n### 学校 | 专业 学历 | 2022.09 – 2026.06\n";
    if (fromProfile) {
      const [profile, memories] = await Promise.all([
        tool<{ record: Profile | null }>("get", { type: "profile" }),
        tool<{ items: Memory[] }>("list", { type: "memory", full: true, limit: 500 }),
      ]);
      body = resumeFromProfile(profile.record ?? {}, [...memories.items].sort((a, b) => a.id - b.id));
    }
    const { record } = await write<{ record: Doc }>("save", { type: "doc", data: { kind: "resume", title: docs.length ? "新简历" : "主简历", body, template: "single" } });
    router.push(`/resume/${record.id}`);
  };

  if (!current) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="text-[24px] font-semibold tracking-tight text-[var(--foreground)]">简历</h1>
        <p className="mt-1 text-[13.5px] text-[var(--foreground-muted)]">先有一份主简历，再按岗位复制一份改。直接在纸上写，导出的 PDF 就是你看到的样子。</p>
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
          <Link key={d.id} href={`/resume/${d.id}`}
            className={`block truncate rounded-md px-2 py-1.5 text-[13px] ${d.id === current.id ? "bg-[var(--surface)] font-medium text-[var(--foreground)]" : "text-[var(--foreground-muted)] hover:text-[var(--foreground)]"}`}>
            {d.title || "简历"}
            {d.job_id && <span className="block truncate text-[11.5px] font-normal text-[var(--foreground-muted)]">{jobs.find((j) => j.id === d.job_id)?.label}</span>}
          </Link>
        ))}
        <button type="button" onClick={() => void create(true)} style={{ fontSize: 12.5 }} className="mt-2 px-2 text-[12.5px] text-[var(--foreground-muted)] hover:text-[var(--foreground)]">从档案新建</button>
      </nav>
      <Editor key={current.id} doc={current} jobs={jobs} photo={profileData?.record?.photo} />
    </div>
  );
}
