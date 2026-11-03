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
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [company, setCompany] = useState("");
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const jobs = data?.items ?? [];
  const statuses = FILTERS.find(([id]) => id === filter)![2];
  const filtered = statuses.length ? jobs.filter((job) => statuses.includes(job.status)) : jobs;
  const shown = [...filtered].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const unscored = jobs.filter((job) => job.score == null && job.status !== "rejected" && job.status !== "closed").length;
  const [ranking, setRanking] = useState(false);
  const [view, setView] = useState<"list" | "board">("list");
  const [over, setOver] = useState<JobStatus | null>(null);
  /** 看板：把卡片拖到另一列就改状态（一条改动，可撤销）。 */
  const drop = (status: JobStatus, raw: string) => {
    setOver(null);
    const job = jobs.find((j) => String(j.id) === raw);
    if (job && job.status !== status) void write("save", { type: "job", id: job.id, data: { status } });
  };

  /** 贴链接或 JD：后端抓正文、拆字段；抓不到就报错，不存空壳。 */
  const paste = async () => {
    setBusy(true); setError("");
    try {
      await write("add_job", { text: text.trim() });
      setText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    await write("save", { type: "job", data: { company: company.trim() || null, title: title.trim() || null, url: url.trim() || null } });
    setCompany(""); setTitle(""); setUrl("");
  };

  /** 读档案和偏好给没打分的岗位打分，结果存在岗位上，列表按分排。 */
  const rank = async () => {
    setRanking(true); setError("");
    try {
      await write("rank_jobs", {});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRanking(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-6 py-10">
      <h1 className="text-[24px] font-semibold tracking-tight text-[var(--foreground)]">岗位</h1>
      <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void paste(); }}>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} aria-label="岗位链接或 JD"
          placeholder="贴岗位链接，或者整段 JD" style={{ fontSize: 13 }} className={`${field} block w-full resize-y`}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && text.trim() && !busy) { e.preventDefault(); void paste(); } }} />
        <div className="flex items-center gap-3">
          <button type="submit" style={{ fontSize: 13 }} disabled={!text.trim() || busy} className="rounded-md bg-[var(--foreground)] px-3 py-1.5 text-[13px] font-medium text-[var(--background)] disabled:opacity-40">{busy ? "正在读…" : "添加"}</button>
          {error && <span role="alert" className="text-[12.5px] text-red-600">{error}</span>}
        </div>
      </form>
      <details className="text-[13px] text-[var(--foreground-muted)]">
        <summary className="cursor-pointer select-none">手动填</summary>
        <form className="mt-2 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="公司" aria-label="公司" style={{ fontSize: 13 }} className={`${field} w-36`} />
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="岗位" aria-label="岗位" style={{ fontSize: 13 }} className={`${field} w-48`} />
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="链接（可选）" aria-label="链接" style={{ fontSize: 13 }} className={`${field} min-w-[180px] flex-1`} />
          <button type="submit" style={{ fontSize: 13 }} disabled={!company.trim() || !title.trim()} className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[13px] text-[var(--foreground)] disabled:opacity-40">添加</button>
        </form>
      </details>
      {unscored > 0 && (
        <div className="flex items-center gap-3 text-[13px] text-[var(--foreground-muted)]">
          <span>{unscored} 个岗位还没评估</span>
          <button type="button" onClick={() => void rank()} disabled={ranking} style={{ fontSize: 13 }} className="rounded-md border border-[var(--border)] px-3 py-1 text-[13px] text-[var(--foreground)] disabled:opacity-40">{ranking ? "正在评估…" : "评估未评估的"}</button>
        </div>
      )}

      <div className="flex gap-3 text-[13px]">
        {([["list", "列表"], ["board", "看板"]] as const).map(([id, name]) => (
          <button key={id} type="button" onClick={() => setView(id)} aria-pressed={view === id}
            className={view === id ? "font-medium text-[var(--foreground)]" : "text-[var(--foreground-muted)] hover:text-[var(--foreground)]"}>{name}</button>
        ))}
      </div>

      {view === "board" ? (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {(Object.entries(JOB_STATUS) as Array<[JobStatus, string]>).map(([status, name]) => {
            const column = jobs.filter((job) => job.status === status).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
            return (
              <section key={status} aria-label={name}
                onDragOver={(e) => { e.preventDefault(); setOver(status); }}
                onDragLeave={() => setOver((cur) => (cur === status ? null : cur))}
                onDrop={(e) => { e.preventDefault(); drop(status, e.dataTransfer.getData("text/plain")); }}
                className={"w-48 shrink-0 rounded-lg border p-2 " + (over === status ? "border-[var(--foreground-muted)] bg-[var(--surface)]" : "border-[var(--border)]")}>
                <h2 className="px-1 pb-2 text-[12.5px] font-medium text-[var(--foreground-muted)]">{name} <span className="tabular-nums">{column.length}</span></h2>
                <ul className="min-h-[48px] space-y-2">
                  {column.map((job) => (
                    <li key={job.id} draggable onDragStart={(e) => { e.dataTransfer.setData("text/plain", String(job.id)); e.dataTransfer.effectAllowed = "move"; }}
                      className="cursor-grab rounded-md border border-[var(--border)] bg-[var(--background)] p-2 text-[13px] active:cursor-grabbing">
                      <Link href={"/jobs/" + job.id} className="block hover:underline">
                        <span className="font-medium text-[var(--foreground)]">{job.company || "未填公司"}</span>
                        <span className="block truncate text-[12.5px] text-[var(--foreground-muted)]">{job.title}</span>
                      </Link>
                      {job.score != null && <span className="text-[12px] tabular-nums text-[var(--foreground-muted)]">{job.score} 分</span>}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      ) : (<>
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

      {data && !shown.length && <p className="text-[13.5px] text-[var(--foreground-muted)]">{jobs.length ? "这一栏没有岗位。" : "还没有岗位。上面贴一个岗位链接或 JD。"}</p>}
      <ul className="divide-y divide-[var(--border)]">
        {shown.map((job) => (
          <li key={job.id} className="flex items-center gap-4 py-3">
            <Link href={`/jobs/${job.id}`} className="min-w-0 flex-1 hover:underline">
              <span className="text-[14px] font-medium text-[var(--foreground)]">{job.company || "未填公司"}</span>
              <span className="ml-2 text-[13.5px] text-[var(--foreground-muted)]">{job.title}</span>
            </Link>
            {job.score != null && <span title={(job.reasons ?? []).join("\n")} aria-label={"评分 " + job.score}
              className={"rounded px-1.5 py-0.5 text-[12px] font-medium tabular-nums " + (job.score >= 80 ? "bg-green-100 text-green-800" : job.score >= 60 ? "bg-amber-100 text-amber-800" : "bg-[var(--surface)] text-[var(--foreground-muted)]")}>{job.score}</span>}
            {job.applied_at && <span className="text-[12px] text-[var(--foreground-muted)]">{job.applied_at.slice(5)} 投递</span>}
            <StatusSelect job={job} />
          </li>
        ))}
      </ul>
      </>)}
    </div>
  );
}
