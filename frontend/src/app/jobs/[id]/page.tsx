"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { AddEvent, EventRow } from "@/components/core/EventList";
import { type Doc, type Event, type Job, tool, useTool, write } from "@/lib/core";

import { StatusSelect } from "../page";

function LongText({ job, field, label, placeholder }: { job: Job; field: "jd" | "notes"; label: string; placeholder: string }) {
  const [value, setValue] = useState(job[field] ?? "");
  useEffect(() => setValue(job[field] ?? ""), [job, field]);
  return (
    <section>
      <h2 className="text-[13px] font-medium text-[var(--foreground-muted)]">{label}</h2>
      <textarea value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} aria-label={label}
        rows={field === "jd" ? 10 : 4}
        onBlur={() => { if (value !== (job[field] ?? "")) void write("save", { type: "job", id: job.id, data: { [field]: value || null } }); }}
        style={{ fontSize: 13 }} className="mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 text-[13px] leading-6 text-[var(--foreground)] outline-none focus:border-[var(--foreground-muted)]" />
    </section>
  );
}

export default function JobDetailPage() {
  const id = Number(useParams().id);
  const router = useRouter();
  const { data, error } = useTool<{ record: Job; events: Event[]; docs: Doc[] }>("get", { type: "job", id }, 5000);
  if (error) return <p className="px-6 py-10 text-[13.5px] text-[var(--foreground-muted)]">这个岗位不存在了。<Link href="/jobs" className="underline">回到岗位</Link></p>;
  if (!data) return null;
  const job = data.record;
  return (
    <div className="mx-auto max-w-3xl space-y-8 px-6 py-10">
      <div>
        <Link href="/jobs" className="text-[13px] text-[var(--foreground-muted)] hover:text-[var(--foreground)]">← 岗位</Link>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-[24px] font-semibold tracking-tight text-[var(--foreground)]">
            {job.company} <span className="font-normal text-[var(--foreground-muted)]">{job.title}</span>
          </h1>
          <StatusSelect job={job} />
        </div>
        {job.url && <a href={job.url} target="_blank" rel="noreferrer" className="mt-1 block truncate text-[13px] text-[var(--foreground-muted)] hover:underline">{job.url}</a>}
      </div>

      <section>
        <h2 className="text-[13px] font-medium text-[var(--foreground-muted)]">事项</h2>
        <ul className="divide-y divide-[var(--border)]">{data.events.map((event) => <EventRow key={event.id} event={event} showJob={false} />)}</ul>
        <AddEvent jobId={job.id} />
      </section>

      <section>
        <div className="flex items-baseline justify-between">
          <h2 className="text-[13px] font-medium text-[var(--foreground-muted)]">材料</h2>
          <button type="button" className="text-[12.5px] text-[var(--foreground-muted)] hover:text-[var(--foreground)]" onClick={async () => {
            // 复制主简历（没挂岗位的那份），挂到这个岗位下面再改。
            const { items } = await tool<{ items: Doc[] }>("list", { type: "doc", kind: "resume", full: true, limit: 200 });
            const base = items.filter((d) => !d.job_id).sort((a, b) => a.id - b.id)[0];
            if (!base) { router.push("/resume"); return; }
            const { record } = await write<{ record: Doc }>("save", { type: "doc", data: { kind: "resume", job_id: job.id, title: "简历 · " + (job.company ?? job.title), resume: base.resume, style: base.style, template: base.template } });
            router.push(`/resume/${record.id}`);
          }}>为这个岗位复制一份简历</button>
        </div>
        {data.docs.length ? (
          <ul className="divide-y divide-[var(--border)]">
            {data.docs.map((doc) => (
              <li key={doc.id} className="py-2 text-[13.5px]">
                <Link href={doc.kind === "resume" ? `/resume/${doc.id}` : `/jobs/${job.id}`} className="text-[var(--foreground)] hover:underline">{doc.label}</Link>
              </li>
            ))}
          </ul>
        ) : <p className="mt-2 text-[13px] text-[var(--foreground-muted)]">还没有。定制简历、网申回答、面试复盘都会放在这里。</p>}
      </section>

      <LongText job={job} field="jd" label="岗位描述" placeholder="贴岗位 JD，Agent 改简历、写网申都会用到" />
      <LongText job={job} field="notes" label="备注" placeholder="内推人、薪资、面试官说了什么……" />

      <button type="button" style={{ fontSize: 13 }} className="text-[13px] text-[var(--foreground-muted)] hover:text-[var(--foreground)]"
        onClick={async () => { await write("delete", { type: "job", id: job.id }); router.push("/jobs"); }}>
        删除这个岗位（可在今天页撤销）
      </button>
    </div>
  );
}
