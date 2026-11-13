"use client";

import Link from "next/link";
import { Plus } from "lucide-react";
import { type DragEvent, type ReactNode, useState } from "react";

import { JobTag, TagPicker } from "@/components/jobs/JobPickers";
import { StatusPill } from "@/components/jobs/JobsTable";
import { liftDragImage } from "@/lib/dragLift";
import { STATUS_TONE } from "@/lib/jobView";
import { type Event, JOB_STATUS, type Job, type JobStatus, useTool, when, write } from "@/lib/core";

const OPEN: JobStatus[] = ["saved", "applied", "test", "interview", "offer"];
const ENDED: JobStatus[] = ["rejected", "closed"];
const byScore = (a: Job, b: Job) => (b.score ?? -1) - (a.score ?? -1);

// 看板（Glass v3 + Inspora「Event Swatch」）：列 = 渐变上的浅玻璃分区；卡片 = 按状态取色的粉彩色块（.ou-swatch：内侧白边、底边略深、16px 圆角），
// 悬停轻轻放大，拖起来微倾 + 阴影变深。列宽在 13.5–22rem 之间平分可用宽度，1440 宽下五列放得下；再窄才在自己的轨道里横滚。
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
      <li key={job.id} data-testid="job-card" draggable
        onDragStart={(e) => { e.dataTransfer.setData("text/plain", String(job.id)); e.dataTransfer.effectAllowed = "move"; liftDragImage(e); }}
        className={`ou-swatch ou-tone-${STATUS_TONE[job.status]} ou-kanban-card ou-enter group`}
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
            <JobTag key={t} text={t} onClick={() => setTag(t)} title={(job.auto_tags?.includes(t) ? "Agent 自动打的 · " : "") + "只看 #" + t} />
          ))}
          <TagPicker job={job} options={tags} trigger={
            <button type="button" className={"opacity-0 hover:text-[var(--foreground)] group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 " + faint}>
              {job.tags?.length ? "改标签" : "+ 标签"}
            </button>
          } />
        </div>
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
      <ul className="mt-1 flex min-h-10 list-none flex-col">{list.map(card)}</ul>
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
          <div className="ou-segment flex-wrap" role="group" aria-label="按标签筛选">
            <button type="button" aria-pressed={!tag} onClick={() => setTag(null)}
              className="ou-kanban-filter">全部</button>
            {tags.map((t) => (
              <button key={t} type="button" aria-pressed={tag === t} onClick={() => setTag(tag === t ? null : t)}
                className="ou-kanban-filter">
                {t}<span className="tabular-nums">{counts.get(t)}</span>
              </button>
            ))}
          </div>
        )}
        {error && <span className="ou-field-error" role="alert">{error}</span>}
        {!showEnded && (
          <button type="button" onClick={() => setShowEnded(true)} {...dropZone("ended")}
            className={"ou-kanban-ended ml-auto " + muted}>
            已结束<span className={"tabular-nums " + faint}>{ended.length}</span>
          </button>
        )}
      </div>
      <div className="ou-kanban-track">
        {OPEN.map((s) => column(s, shown.filter((job) => job.status === s).sort(byScore), <StatusPill status={s} />, s))}
        {showEnded && column("ended", ended, <span className={muted}>已结束</span>)}
      </div>
    </section>
  );
}
