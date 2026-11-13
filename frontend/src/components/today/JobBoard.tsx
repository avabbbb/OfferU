"use client";

import Link from "next/link";
import { Plus } from "lucide-react";
import { type DragEvent, type ReactNode, useState } from "react";

import { TagInput } from "@/components/core/TagInput";
import { StatusPill } from "@/components/jobs/JobsTable";
import { type Event, JOB_STATUS, type Job, type JobStatus, useTool, when, write } from "@/lib/core";
import { tagPatch } from "@/lib/jobView";

const OPEN: JobStatus[] = ["saved", "applied", "test", "interview", "offer"];
const ENDED: JobStatus[] = ["rejected", "closed"];
const byScore = (a: Job, b: Job) => (b.score ?? -1) - (a.score ?? -1);

// 看板（色卡 v2 + 层级模型）：列 = L0 画布上的浅色分区（--ou-bg-control），卡片 = L2（白底 + 1px 分隔线 + 1/2 阴影，悬停抬起一级）。
// 列宽随窗口流动（--ou-kanban-column：16–22rem），窄屏横向滚动并按列吸附；颜色只留给列头的状态胶囊。
const muted = "text-[var(--foreground-muted)]";
const faint = "text-[var(--foreground-faint)]";
const ghostBtn = "rounded px-1.5 py-0.5 hover:bg-[var(--surface-hover)]";

// 投递看板：一列一个阶段，列头「状态胶囊 + 灰色数量」；卡片拖到另一列就改状态；列底「+ 新建」在该阶段加一条。卡片拖到另一列就改状态（一条改动，可撤销）。
// 未通过和不投了合成「已结束」，默认收起；顶上按标签筛，卡片上点 #标签 也是筛。
export function JobBoard({ embedded = false }: { embedded?: boolean } = {}) {
  const { data: jobs } = useTool<{ items: Job[] }>("list", { type: "job", limit: 500 }, 5000);
  const { data: events } = useTool<{ items: Event[] }>("list", { type: "event", done: false, limit: 500 }, 5000);
  const [tag, setTag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [showEnded, setShowEnded] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [error, setError] = useState("");
  if (!jobs) return null;
  const all = jobs.items;

  if (!all.length) {
    return (
      <section data-testid="today-board">
        {!embedded && <h2 className={"text-[13px] font-medium " + muted}>投递看板</h2>}
        <p className={"mt-2 text-[13.5px] " + muted}>
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
  const addIn = async (status: JobStatus) => {
    setError("");
    try {
      await write("save", { type: "job", data: { status } });
    } catch (e) {
      setError(e instanceof Error ? e.message : "没能新建记录");
    }
  };

  const card = (job: Job, index: number) => {
    const event = upcoming.get(job.id);
    return (
      <li key={job.id} data-testid="job-card" draggable={editing !== job.id}
        onDragStart={(e) => { e.dataTransfer.setData("text/plain", String(job.id)); e.dataTransfer.effectAllowed = "move"; }}
        className="ou-card ou-enter group min-h-10 cursor-grab px-3 py-2.5 active:cursor-grabbing"
        style={{ ["--i" as string]: Math.min(index, 8) }}>
        <Link href={"/jobs/" + job.id} title={[job.company, job.title].filter(Boolean).join(" · ")}
          className="ou-kanban-title block truncate">
          {job.company || <span className={faint}>未填公司</span>}
        </Link>
        {job.title && <div className="ou-kanban-subtitle truncate">{job.title}</div>}
        <div className="ou-kanban-meta mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1">
          {job.score != null && <span className="tabular-nums" title={(job.reasons ?? []).join("\n")}>{job.score} 分</span>}
          {event ? <span>{when(event.at)} {event.title}</span> : job.applied_at ? <span>{job.applied_at.slice(5)} 投递</span> : null}
          {(job.tags ?? []).map((t) => (
            <button key={t} type="button" onClick={() => setTag(t)} title={(job.auto_tags?.includes(t) ? "Agent 自动打的 · " : "") + "只看 #" + t}
              className="ou-kanban-tag">{t}</button>
          ))}
          <button type="button" onClick={() => setEditing(job.id)}
            className={"opacity-0 hover:text-[var(--foreground)] group-hover:opacity-100 focus-visible:opacity-100 " + faint}>
            {job.tags?.length ? "改标签" : "+ 标签"}
          </button>
        </div>
        {editing === job.id && (
          <TagInput value={job.tags ?? []} options={tags} onChange={(value) => saveTags(job, value)} onClose={() => setEditing(null)} />
        )}
      </li>
    );
  };

  const column = (key: string, list: Job[], head: ReactNode, add?: JobStatus) => (
    <section key={key} aria-label={key === "ended" ? "已结束" : JOB_STATUS[key as JobStatus]} {...dropZone(key)}
      className="ou-kanban-column">
      <h3 className="ou-kanban-head">
        {head}<span className={"tabular-nums " + faint}>{list.length}</span>
        {key === "ended" && <button type="button" onClick={() => setShowEnded(false)} className={"ml-auto " + ghostBtn + " " + muted}>收起</button>}
      </h3>
      <ul className="mt-1 flex min-h-10 list-none flex-col gap-2">{list.map(card)}</ul>
      {add && (
        <button type="button" onClick={() => void addIn(add)} aria-label={"在「" + JOB_STATUS[add] + "」新建"}
          className="ou-kanban-add">
          <Plus size={15} strokeWidth={1.75} aria-hidden /> 新建
        </button>
      )}
    </section>
  );

  return (
    <section data-testid="today-board" className="text-[13.5px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {!embedded && <h2 className={"text-[13px] font-medium " + muted}>投递看板</h2>}
        {tags.length > 0 && (
          <div className={"flex flex-wrap items-center gap-0.5 text-[13px] " + muted} role="group" aria-label="按标签筛选">
            <button type="button" aria-pressed={!tag} onClick={() => setTag(null)}
              className={ghostBtn + " aria-pressed:bg-[var(--surface-hover)] aria-pressed:text-[var(--foreground)]"}>全部</button>
            {tags.map((t) => (
              <button key={t} type="button" aria-pressed={tag === t} onClick={() => setTag(tag === t ? null : t)}
                className={ghostBtn + " aria-pressed:bg-[var(--surface-hover)] aria-pressed:text-[var(--foreground)]"}>
                {t}<span className={"ml-1 tabular-nums " + faint}>{counts.get(t)}</span>
              </button>
            ))}
          </div>
        )}
        {error && <span className="ou-field-error" role="alert">{error}</span>}
      </div>
      <div className="ou-kanban-track">
        {OPEN.map((s) => column(s, shown.filter((job) => job.status === s).sort(byScore), <StatusPill status={s} />, s))}
        {showEnded ? column("ended", ended, <span className={muted}>已结束</span>) : (
          <button type="button" onClick={() => setShowEnded(true)} {...dropZone("ended")}
            className={"flex h-9 shrink-0 items-center gap-2 rounded-lg px-3 hover:bg-[var(--surface-hover)] data-[over]:bg-[var(--surface-hover)] " + muted}>
            已结束<span className={"tabular-nums " + faint}>{ended.length}</span>
          </button>
        )}
      </div>
    </section>
  );
}
