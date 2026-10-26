"use client";

import Link from "next/link";
import { useState } from "react";

import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { type Event, JOB_STATUS, type Job, type JobStatus, useTool, when } from "@/lib/core";

const ACTIVE: JobStatus[] = ["saved", "applied", "test", "interview", "offer"];
const ENDED: JobStatus[] = ["rejected", "closed"];
const sum = (counts: Partial<Record<JobStatus, number>>, statuses: JobStatus[]) =>
  statuses.reduce((n, s) => n + (counts[s] ?? 0), 0);

/** 今天页的投递进度：一行各阶段个数，点开看每个岗位在哪一步、下一件事是什么。 */
export function ProgressBoard({ counts }: { counts: Partial<Record<JobStatus, number>> }) {
  const [open, setOpen] = useState(false);
  const active = sum(counts, ACTIVE);
  const ended = sum(counts, ENDED);

  if (!active && !ended) {
    return (
      <section data-testid="today-progress">
        <h2 className="text-[13px] font-medium text-[var(--foreground-muted)]">投递进度</h2>
        <p className="mt-2 text-[13.5px] text-[var(--foreground-muted)]">
          还没有岗位。<Link href="/jobs" className="text-[var(--foreground)] hover:underline">去添加</Link>
        </p>
      </section>
    );
  }

  return (
    <section data-testid="today-progress">
      <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog"
        className="flex w-full items-center gap-4 rounded-lg border border-[var(--border)] px-4 py-3 text-left transition-colors hover:bg-[var(--surface)]">
        <span className="shrink-0 text-[13px] font-medium text-[var(--foreground-muted)]">投递进度</span>
        <span className="flex flex-1 flex-wrap gap-x-4 gap-y-1 text-[13px]">
          {ACTIVE.map((s) => (
            <span key={s} className={counts[s] ? "text-[var(--foreground)]" : "text-[var(--foreground-muted)]"}>
              {JOB_STATUS[s]} <span className="font-medium tabular-nums">{counts[s] ?? 0}</span>
            </span>
          ))}
        </span>
        {ended > 0 && <span className="shrink-0 text-[12px] text-[var(--foreground-muted)]">已结束 {ended}</span>}
        <span aria-hidden className="text-[var(--foreground-muted)]">›</span>
      </button>
      {open && <BoardDialog onClose={() => setOpen(false)} />}
    </section>
  );
}

function BoardDialog({ onClose }: { onClose: () => void }) {
  const { data: jobs } = useTool<{ items: Job[] }>("list", { type: "job", limit: 500 }, 5000);
  const { data: events } = useTool<{ items: Event[] }>("list", { type: "event", done: false, limit: 500 }, 5000);
  const [showEnded, setShowEnded] = useState(false);

  // 每个岗位最近的一件未完成事项。
  const next = new Map<number, Event>();
  [...(events?.items ?? [])]
    .filter((e) => e.job_id != null && e.at)
    .sort((a, b) => a.at!.localeCompare(b.at!))
    .forEach((e) => { if (!next.has(e.job_id!)) next.set(e.job_id!, e); });

  const items = jobs?.items ?? [];
  const groups = (statuses: JobStatus[]) =>
    statuses.map((s) => [s, items.filter((j) => j.status === s)] as const).filter(([, list]) => list.length > 0);
  const endedGroups = groups(ENDED);

  const renderGroup = ([status, list]: readonly [JobStatus, Job[]]) => (
    <div key={status} data-testid={"progress-group-" + status}>
      <h3 className="text-[12px] text-[var(--foreground-muted)]">{JOB_STATUS[status]} · {list.length}</h3>
      <ul className="divide-y divide-[var(--border)]">
        {list.map((job) => {
          const event = next.get(job.id);
          return (
            <li key={job.id} className="flex items-center gap-3 py-2.5">
              <Link href={"/jobs/" + job.id} onClick={onClose} className="min-w-0 flex-1 truncate hover:underline">
                <span className="text-[14px] font-medium text-[var(--foreground)]">{job.company || "未填公司"}</span>
                <span className="ml-2 text-[13.5px] text-[var(--foreground-muted)]">{job.title}</span>
              </Link>
              {event ? (
                <span className="shrink-0 text-[12px] text-[var(--foreground-muted)]">{when(event.at)} {event.title}</span>
              ) : job.applied_at ? (
                <span className="shrink-0 text-[12px] text-[var(--foreground-muted)]">{job.applied_at.slice(5)} 投递</span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );

  return (
    <SettingsDialog isOpen onClose={onClose} title="投递进度">
      {!jobs ? (
        <p className="text-[13.5px] text-[var(--foreground-muted)]">加载中…</p>
      ) : (
        <>
          {groups(ACTIVE).map(renderGroup)}
          {endedGroups.length > 0 && (
            <div>
              <button type="button" onClick={() => setShowEnded((v) => !v)}
                className="text-[12px] text-[var(--foreground-muted)] hover:text-[var(--foreground)]">
                {showEnded ? "收起已结束" : "已结束 " + endedGroups.reduce((n, [, l]) => n + l.length, 0) + " 个"}
              </button>
              {showEnded && <div className="mt-3 space-y-5">{endedGroups.map(renderGroup)}</div>}
            </div>
          )}
          <Link href="/jobs" onClick={onClose} className="block text-[13px] text-[var(--foreground-muted)] hover:text-[var(--foreground)]">
            在岗位页改状态 ›
          </Link>
        </>
      )}
    </SettingsDialog>
  );
}
