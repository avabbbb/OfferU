"use client";

import Link from "next/link";
import { type DragEvent, useState } from "react";

import { TagInput } from "@/components/core/TagInput";
import { type Event, JOB_STATUS, type Job, type JobStatus, useTool, when, write } from "@/lib/core";
import { tagPatch } from "@/lib/jobView";

const OPEN: JobStatus[] = ["saved", "applied", "test", "interview", "offer"];
const ENDED: JobStatus[] = ["rejected", "closed"];
const byScore = (a: Job, b: Job) => (b.score ?? -1) - (a.score ?? -1);

// 今天页的投递看板：一列一个阶段，卡片拖到另一列就改状态（一条改动，可撤销）。
// 未通过和不投了合成「已结束」，默认收起；顶上按标签筛，卡片上点 #标签 也是筛。
export function JobBoard({ embedded = false }: { embedded?: boolean } = {}) {
  const { data: jobs } = useTool<{ items: Job[] }>("list", { type: "job", limit: 500 }, 5000);
  const { data: events } = useTool<{ items: Event[] }>("list", { type: "event", done: false, limit: 500 }, 5000);
  const [tag, setTag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [showEnded, setShowEnded] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  if (!jobs) return null;
  const all = jobs.items;

  if (!all.length) {
    return (
      <section data-testid="today-board">
        {!embedded && <h2 className="text-[13px] font-medium text-[var(--foreground-muted)]">投递看板</h2>}
        <p className="mt-2 text-[13.5px] text-[var(--foreground-muted)]">
          还没有岗位。<Link href="/jobs" className="text-[var(--foreground)] hover:underline">去添加</Link>
        </p>
      </section>
    );
  }

  // 每个岗位最近的一件未完成事项（笔试、面试、截止）。
  const upcoming = new Map<number, Event>();
  [...(events?.items ?? [])]
    .filter((e) => e.job_id != null && e.at)
    .sort((a, b) => a.at!.localeCompare(b.at!))
    .forEach((e) => { if (!upcoming.has(e.job_id!)) upcoming.set(e.job_id!, e); });

  const counts = new Map<string, number>();
  all.forEach((job) => (job.tags ?? []).forEach((t) => counts.set(t, (counts.get(t) ?? 0) + 1)));
  const tags = [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)! || a.localeCompare(b, "zh"));
  const shown = tag ? all.filter((job) => job.tags?.includes(tag)) : all;
  const ended = shown.filter((job) => ENDED.includes(job.status)).sort(byScore);

  const drop = (target: string, raw: string) => {
    setOver(null);
    const job = all.find((j) => String(j.id) === raw);
    if (!job) return;
    const status = target === "ended" ? (ENDED.includes(job.status) ? job.status : "closed") : (target as JobStatus);
    if (job.status !== status) void write("save", { type: "job", id: job.id, data: { status } });
  };
  const dropZone = (key: string) => ({
    "data-over": over === key || undefined,
    onDragOver: (e: DragEvent) => { e.preventDefault(); setOver(key); },
    onDragLeave: () => setOver((cur) => (cur === key ? null : cur)),
    onDrop: (e: DragEvent) => { e.preventDefault(); drop(key, e.dataTransfer.getData("text/plain")); },
  });
  const saveTags = (job: Job, value: string[]) => void write("save", { type: "job", id: job.id, data: tagPatch(job, value) });

  const card = (job: Job) => {
    const event = upcoming.get(job.id);
    return (
      <li key={job.id} className="job-card" draggable={editing !== job.id}
        onDragStart={(e) => { e.dataTransfer.setData("text/plain", String(job.id)); e.dataTransfer.effectAllowed = "move"; }}>
        <Link href={"/jobs/" + job.id} className="job-card-title" title={[job.company, job.title].filter(Boolean).join(" · ")}>
          <span className="font-medium">{job.company || "未填公司"}</span>
          {job.title && <span className="job-card-sub"> · {job.title}</span>}
        </Link>
        <div className="job-meta">
          {job.score != null && <span className="tabular-nums" title={(job.reasons ?? []).join("\n")}>{job.score} 分</span>}
          {event ? <span>{when(event.at)} {event.title}</span> : job.applied_at ? <span>{job.applied_at.slice(5)} 投递</span> : null}
          {(job.tags ?? []).map((t) => (
            <button key={t} type="button" onClick={() => setTag(t)} title={(job.auto_tags?.includes(t) ? "Agent 自动打的 · " : "") + "只看 #" + t}>#{t}</button>
          ))}
          <button type="button" className="job-meta-add" onClick={() => setEditing(job.id)}>{job.tags?.length ? "改标签" : "＋标签"}</button>
        </div>
        {editing === job.id && (
          <TagInput value={job.tags ?? []} options={tags} onChange={(value) => saveTags(job, value)} onClose={() => setEditing(null)} />
        )}
      </li>
    );
  };

  const column = (key: string, name: string, list: Job[]) => (
    <section key={key} aria-label={name} className="job-col" {...dropZone(key)}>
      <h3 className="job-col-head">
        {name}<span>{list.length}</span>
        {key === "ended" && <button type="button" onClick={() => setShowEnded(false)}>收起</button>}
      </h3>
      <ul className="job-col-list">{list.map(card)}</ul>
    </section>
  );

  return (
    <section data-testid="today-board" className="job-board">
      <div className="job-board-head">
        {!embedded && <h2 className="font-medium text-[var(--foreground-muted)]">投递看板</h2>}
        {tags.length > 0 && (
          <div className="job-tag-filter" role="group" aria-label="按标签筛选">
            <button type="button" aria-pressed={!tag} onClick={() => setTag(null)}>全部</button>
            {tags.map((t) => (
              <button key={t} type="button" aria-pressed={tag === t} onClick={() => setTag(tag === t ? null : t)}>
                #{t}<span>{counts.get(t)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="job-board-cols">
        {OPEN.map((s) => column(s, JOB_STATUS[s], shown.filter((job) => job.status === s).sort(byScore)))}
        {showEnded ? column("ended", "已结束", ended) : (
          <button type="button" className="job-col-folded" onClick={() => setShowEnded(true)} {...dropZone("ended")}>
            已结束 {ended.length} ›
          </button>
        )}
      </div>
    </section>
  );
}
