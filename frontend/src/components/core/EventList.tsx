"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Button, DatePicker, Input, Select } from "@/components/ui";
import { EVENT_KIND, type Event, type EventKind, when, write } from "@/lib/core";

export function EventRow({ event, showJob = true }: { event: Event; showJob?: boolean }) {
  // 勾选先在本地生效；服务器一变（撤销、Agent 改了）就跟着变，写失败就退回去。
  const [done, setDone] = useState(Boolean(event.done));
  useEffect(() => setDone(Boolean(event.done)), [event.done]);
  const toggle = async (next: boolean) => {
    setDone(next);
    try {
      await write("save", { type: "event", id: event.id, data: { done: next } });
    } catch {
      setDone(!next);
    }
  };
  return (
    <li className="flex items-baseline gap-3 py-2 text-[13.5px]">
      <input type="checkbox" checked={done} aria-label={"完成 " + event.title} className="translate-y-[2px]"
        onChange={(e) => void toggle(e.target.checked)} />
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
  // 一行：输入框占满，类型 Select、时间 DatePicker、添加按钮都是 components/ui 的胶囊（不再用原生下拉和日期框）。
  return (
    <form className="ou-add-event" onSubmit={(e) => { e.preventDefault(); void add(); }}>
      <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="加一件事" aria-label="事项" className="ou-input-sm" />
      <Select size="sm" className="ou-add-event-kind" aria-label="类型" value={kind} onValueChange={(v) => setKind(v as EventKind)}
        options={Object.entries(EVENT_KIND).map(([value, label]) => ({ value, label }))} />
      <DatePicker withTime size="sm" className="ou-add-event-at" aria-label="时间" placeholder="时间（可不填）" value={at} onChange={setAt} />
      <Button type="submit" size="sm" variant="primary" disabled={!title.trim()}>添加</Button>
    </form>
  );
}
