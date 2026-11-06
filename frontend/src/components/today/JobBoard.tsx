"use client";

import Link from "next/link";
import { Plus } from "lucide-react";
import { type DragEvent, type ReactNode, useState } from "react";

import { TagInput } from "@/components/core/TagInput";
import { StatusPill } from "@/components/jobs/JobsTable";
import { type Event, JOB_STATUS, type Job, type JobStatus, useTool, when, write } from "@/lib/core";
import { STATUS_TONE, tagPatch } from "@/lib/jobView";

const OPEN: JobStatus[] = ["saved", "applied", "test", "interview", "offer"];
const ENDED: JobStatus[] = ["rejected", "closed"];
const byScore = (a: Job, b: Job) => (b.score ?? -1) - (a.score ?? -1);

// 照 Notion 看板：列和卡片都染组的颜色。列底极淡；卡片白底 + 同色 1px 细边 + 小阴影；列底「+ 新建」是同色字 + 同色细边。
const COL_TINT: Record<string, string> = {
  slate: "bg-slate-100/60", blue: "bg-blue-50/70", yellow: "bg-amber-50/70", orange: "bg-orange-50/70",
  green: "bg-emerald-50/70", red: "bg-rose-50/70", gray: "bg-neutral-100/60",
};
const RING: Record<string, string> = {
  slate: "ring-slate-200", blue: "ring-blue-100", yellow: "ring-amber-100", orange: "ring-orange-100",
  green: "ring-emerald-100", red: "ring-rose-100", gray: "ring-neutral-200",
};
const ADD_TEXT: Record<string, string> = {
  slate: "text-slate-500", blue: "text-blue-600", yellow: "text-amber-600", orange: "text-orange-600",
  green: "text-emerald-600", red: "text-rose-600", gray: "text-neutral-500",
};
const muted = "text-[var(--foreground-muted)]";
const faint = "text-[var(--foreground-faint)]";
const ghostBtn = "rounded px-1.5 py-0.5 hover:bg-[var(--surface-hover)]";

// 投递看板（Notion 式）：一列一个阶段（260px 宽、10px 圆角、列间 12px），列头「状态色块 + 灰色数量」，列有极淡的同色底；
// 卡片白底、同色细边、小阴影，悬停变灰；列底「+ 新建」在该阶段加一条。卡片拖到另一列就改状态（一条改动，可撤销）。
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

  const card = (tone: string) => (job: Job) => {
    const event = upcoming.get(job.id);
    return (
      <li key={job.id} data-testid="job-card" draggable={editing !== job.id}
        onDragStart={(e) => { e.dataTransfer.setData("text/plain", String(job.id)); e.dataTransfer.effectAllowed = "move"; }}
        className={"group min-h-10 cursor-grab rounded-[10px] bg-[var(--surface-opaque)] px-2.5 py-2 shadow-sm ring-1 hover:bg-[var(--surface-hover)] active:cursor-grabbing " + (RING[tone] ?? RING.gray)}>
        <Link href={"/jobs/" + job.id} title={[job.company, job.title].filter(Boolean).join(" · ")}
          className="block truncate text-[15px] font-medium leading-[22px] text-[var(--foreground)]">
          {job.company || <span className={faint}>未填公司</span>}
        </Link>
        {job.title && <div className={"truncate text-[12.5px] leading-5 " + muted}>{job.title}</div>}
        <div className={"mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] " + muted}>
          {job.score != null && <span className="tabular-nums" title={(job.reasons ?? []).join("\n")}>{job.score} 分</span>}
          {event ? <span>{when(event.at)} {event.title}</span> : job.applied_at ? <span>{job.applied_at.slice(5)} 投递</span> : null}
          {(job.tags ?? []).map((t) => (
            <button key={t} type="button" onClick={() => setTag(t)} title={(job.auto_tags?.includes(t) ? "Agent 自动打的 · " : "") + "只看 #" + t}
              className="rounded bg-[var(--surface-hover)] px-1 leading-[18px] hover:text-[var(--foreground)]">{t}</button>
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

  const column = (key: string, list: Job[], head: ReactNode, tone: string, add?: JobStatus) => (
    <section key={key} aria-label={key === "ended" ? "已结束" : JOB_STATUS[key as JobStatus]} {...dropZone(key)}
      className={"flex w-[276px] shrink-0 flex-col rounded-[10px] px-2 pb-2 pt-1.5 transition-shadow data-[over]:shadow-[inset_0_0_0_2px_rgba(35,131,226,0.35)] " + (COL_TINT[tone] ?? COL_TINT.gray)}>
      <h3 className="flex h-7 items-center gap-2 px-1 text-[13px] font-normal">
        {head}<span className={"tabular-nums " + faint}>{list.length}</span>
        {key === "ended" && <button type="button" onClick={() => setShowEnded(false)} className={"ml-auto " + ghostBtn + " " + muted}>收起</button>}
      </h3>
      <ul className="mt-1 flex min-h-10 list-none flex-col gap-2">{list.map(card(tone))}</ul>
      {add && (
        <button type="button" onClick={() => void addIn(add)} aria-label={"在「" + JOB_STATUS[add] + "」新建"}
          className={"mt-2 flex min-h-10 items-center gap-2 rounded-[10px] px-2.5 text-[15px] ring-1 hover:bg-[var(--background)] " + (ADD_TEXT[tone] ?? ADD_TEXT.gray) + " " + (RING[tone] ?? RING.gray)}>
          <Plus size={16} strokeWidth={1.75} /> 新建
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
        {error && <span className="text-[13px] text-red-600">{error}</span>}
      </div>
      <div className="mt-2 flex items-start gap-3 overflow-x-auto pb-4">
        {OPEN.map((s) => column(s, shown.filter((job) => job.status === s).sort(byScore), <StatusPill status={s} />, STATUS_TONE[s], s))}
        {showEnded ? column("ended", ended, <span className={muted}>已结束</span>, "gray") : (
          <button type="button" onClick={() => setShowEnded(true)} {...dropZone("ended")}
            className={"flex h-9 shrink-0 items-center gap-2 rounded-lg px-3 hover:bg-[var(--surface-hover)] data-[over]:bg-[var(--surface-hover)] " + muted}>
            已结束<span className={"tabular-nums " + faint}>{ended.length}</span>
          </button>
        )}
      </div>
    </section>
  );
}
