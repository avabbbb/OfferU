"use client";

import Link from "next/link";
import { useState } from "react";

import { EVENT_KIND, type Event, type EventKind, when, write } from "@/lib/core";

export function EventRow({ event, showJob = true }: { event: Event; showJob?: boolean }) {
  const [done, setDone] = useState(Boolean(event.done));
  return (
    <li className="flex items-baseline gap-3 py-2 text-[13.5px]">
      <input type="checkbox" checked={done} aria-label={`完成 ${event.title}`} className="translate-y-[2px]"
        onChange={async (e) => { setDone(e.target.checked); await write("save", { type: "event", id: event.id, data: { done: e.target.checked } }); }} />
      <span className={`min-w-0 flex-1 ${done ? "text-[var(--foreground-muted)] line-through" : "text-[var(--foreground)]"}`}>
        {event.title}
        {showJob && event.job_id && event.job_label && (
          <Link href={`/jobs/${event.job_id}`} className="ml-2 text-[12px] text-[var(--foreground-muted)] hover:text-[var(--foreground)]">{event.job_label}</Link>
        )}
      </span>
      <span className="shrink-0 text-[12px] text-[var(--foreground-muted)]">
        {event.kind && event.kind !== "todo" ? `${EVENT_KIND[event.kind]} · ` : ""}{when(event.at)}
      </span>
    </li>
  );
}

/** 加一件事：标题 + 可选时间和类型。自然语言（「周四晚上百度笔试」）交给内置助手。 */
export function AddEvent({ jobId }: { jobId?: number }) {
  const [title, setTitle] = useState("");
  const [at, setAt] = useState("");
  const [kind, setKind] = useState<EventKind>("todo");
  const add = async () => {
    if (!title.trim()) return;
    await write("save", { type: "event", data: { title: title.trim(), kind, at: at || null, job_id: jobId ?? null } });
    setTitle("");
    setAt("");
  };
  const field = "rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-[13px] text-[var(--foreground)] outline-none focus:border-[var(--foreground-muted)]";
  return (
    <form className="mt-2 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void add(); }}>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="加一件事" aria-label="事项" style={{ fontSize: 13 }} className={`${field} min-w-[200px] flex-1`} />
      <select value={kind} onChange={(e) => setKind(e.target.value as EventKind)} aria-label="类型" style={{ fontSize: 13 }} className={field}>
        {Object.entries(EVENT_KIND).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </select>
      <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} aria-label="时间" style={{ fontSize: 13 }} className={field} />
      <button type="submit" style={{ fontSize: 13 }} disabled={!title.trim()} className="rounded-md bg-[var(--foreground)] px-3 py-1.5 text-[13px] font-medium text-[var(--background)] disabled:opacity-40">添加</button>
    </form>
  );
}
