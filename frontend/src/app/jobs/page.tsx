"use client";

import Link from "next/link";
import { useState } from "react";

import { JOB_STATUS, type Job, type JobStatus, useTool, write } from "@/lib/core";

const FILTERS: Array<[string, string, JobStatus[]]> = [
  ["all", "全部", []], ["saved", "想投", ["saved"]], ["going", "进行中", ["applied", "test", "interview"]],
  ["offer", "offer", ["offer"]], ["ended", "已结束", ["rejected", "closed"]],
];
const field = "rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-[13px] text-[var(--foreground)] outline-none focus:border-[var(--foreground-muted)]";

export function StatusSelect({ job }: { job: Job }) {
  return (
    <select value={job.status} aria-label="投递状态" style={{ fontSize: 13 }} className={`${field} py-1`}
      onChange={(e) => void write("save", { type: "job", id: job.id, data: { status: e.target.value } })}>
      {Object.entries(JOB_STATUS).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
    </select>
  );
}

/** 岗位和投递是一回事：一个岗位一行，状态就在行里改。 */
export default function JobsPage() {
  const { data } = useTool<{ items: Job[] }>("list", { type: "job", limit: 500 }, 5000);
  const [filter, setFilter] = useState("all");
  const [company, setCompany] = useState("");
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const jobs = data?.items ?? [];
  const statuses = FILTERS.find(([id]) => id === filter)![2];
  const shown = statuses.length ? jobs.filter((job) => statuses.includes(job.status)) : jobs;

  const add = async () => {
    await write("save", { type: "job", data: { company: company.trim() || null, title: title.trim() || null, url: url.trim() || null } });
    setCompany(""); setTitle(""); setUrl("");
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-6 py-10">
      <h1 className="text-[24px] font-semibold tracking-tight text-[var(--foreground)]">岗位</h1>
      <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="公司" aria-label="公司" style={{ fontSize: 13 }} className={`${field} w-36`} />
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="岗位" aria-label="岗位" style={{ fontSize: 13 }} className={`${field} w-48`} />
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="链接（可选）" aria-label="链接" style={{ fontSize: 13 }} className={`${field} min-w-[180px] flex-1`} />
        <button type="submit" style={{ fontSize: 13 }} disabled={!company.trim() && !title.trim()} className="rounded-md bg-[var(--foreground)] px-3 py-1.5 text-[13px] font-medium text-[var(--background)] disabled:opacity-40">添加</button>
      </form>

      <div className="flex gap-4 border-b border-[var(--border)] text-[13px]">
        {FILTERS.map(([id, name, match]) => {
          const count = match.length ? jobs.filter((job) => match.includes(job.status)).length : jobs.length;
          return (
            <button key={id} type="button" onClick={() => setFilter(id)}
              className={`-mb-px border-b-2 pb-2 ${filter === id ? "border-[var(--foreground)] text-[var(--foreground)]" : "border-transparent text-[var(--foreground-muted)] hover:text-[var(--foreground)]"}`}>
              {name} <span className="text-[12px] text-[var(--foreground-muted)]">{count}</span>
            </button>
          );
        })}
      </div>

      {data && !shown.length && <p className="text-[13.5px] text-[var(--foreground-muted)]">{jobs.length ? "这一栏没有岗位。" : "还没有岗位。上面填公司和岗位，或者让 Agent 把链接存进来。"}</p>}
      <ul className="divide-y divide-[var(--border)]">
        {shown.map((job) => (
          <li key={job.id} className="flex items-center gap-4 py-3">
            <Link href={`/jobs/${job.id}`} className="min-w-0 flex-1 hover:underline">
              <span className="text-[14px] font-medium text-[var(--foreground)]">{job.company || "未填公司"}</span>
              <span className="ml-2 text-[13.5px] text-[var(--foreground-muted)]">{job.title}</span>
            </Link>
            {job.applied_at && <span className="text-[12px] text-[var(--foreground-muted)]">{job.applied_at.slice(5)} 投递</span>}
            <StatusSelect job={job} />
          </li>
        ))}
      </ul>
    </div>
  );
}
