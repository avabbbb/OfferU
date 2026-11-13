"use client";

import Link from "next/link";
import { type ReactNode, useEffect, useState } from "react";

import { JobTag, StatusSelect, TagPicker } from "@/components/jobs/JobPickers";
import { type Job } from "@/lib/core";

import { saveJob } from "./JobsTable";
import { ctl, ghost } from "./ViewPanels";

// 右侧记录详情（同飞书「展开记录」）：∧∨ 按当前表格顺序切换，Esc 关闭；改动失焦即存。完整页（JD、评估、投递）走「查看详情」。

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="pt-1.5 text-[12.5px] text-[var(--foreground-muted)]">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function Field({ job, field, type = "text", placeholder }: { job: Job; field: "company" | "title" | "city" | "url" | "applied_at"; type?: string; placeholder?: string }) {
  const initial = field === "applied_at" ? job.applied_at?.slice(0, 10) ?? "" : job[field] ?? "";
  const [v, setV] = useState(initial);
  useEffect(() => setV(initial), [initial, job.id]);
  return (
    <input type={type} value={v} placeholder={placeholder} aria-label={field} onChange={(e) => setV(e.target.value)}
      onBlur={() => { const t = v.trim(); if (t !== initial) void saveJob(job, { [field]: t || null }); }}
      onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) e.currentTarget.blur(); }}
      className={ctl + " w-full"} />
  );
}

function Notes({ job }: { job: Job }) {
  const initial = job.notes ?? "";
  const [v, setV] = useState(initial);
  useEffect(() => setV(initial), [initial, job.id]);
  return (
    <textarea value={v} rows={4} aria-label="备注" placeholder="记点什么" onChange={(e) => setV(e.target.value)}
      onBlur={() => { if (v !== initial) void saveJob(job, { notes: v || null }); }}
      className={ctl + " w-full resize-y leading-6"} />
  );
}

export function RecordDrawer({ job, index, total, tagOptions, onPrev, onNext, onClose }: {
  job: Job;
  index: number;
  total: number;
  tagOptions: string[];
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === "Escape" && !(t && t.closest("input, textarea, select"))) onClose();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);

  return (
    <aside aria-label="岗位详情" style={{ width: "min(480px, 100vw)", boxShadow: "-8px 0 24px var(--shadow-soft)" }}
      className="fixed inset-y-0 right-0 z-50 flex flex-col border-l border-[var(--border)] bg-[var(--surface-opaque)] text-[13px] text-[var(--foreground)]">
      <header className="flex items-center gap-1 border-b border-[var(--border)] px-3 py-2">
        <button type="button" aria-label="上一条" title="上一条" disabled={index <= 0} onClick={onPrev} className={ghost}>∧</button>
        <button type="button" aria-label="下一条" title="下一条" disabled={index < 0 || index >= total - 1} onClick={onNext} className={ghost}>∨</button>
        {index >= 0 && <span className="text-[12px] tabular-nums text-[var(--foreground-muted)]">{index + 1} / {total}</span>}
        <Link href={"/jobs/" + job.id} className={ghost + " ml-auto"}>查看详情</Link>
        <button type="button" aria-label="关闭" title="关闭（Esc）" onClick={onClose} className={ghost}>×</button>
      </header>
      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
        <div>
          <h2 className="text-[18px] font-semibold">{job.company || "未填公司"}</h2>
          <p className="mt-0.5 text-[14px] text-[var(--foreground-soft)]">{job.title}</p>
          {job.posting?.essence && (
            <p className="mt-2 text-[12.5px] leading-5 text-[var(--foreground-muted)]" title="由 JD 概括，不是原文">
              {job.posting.essence}<span className="ml-1 text-[11px] opacity-70">推断</span>
            </p>
          )}
        </div>
        <dl className="grid gap-x-3 gap-y-2" style={{ gridTemplateColumns: "72px minmax(0, 1fr)" }}>
          <Row label="状态">
            <div className="pt-1"><StatusSelect job={job} /></div>
          </Row>
          <Row label="公司"><Field job={job} field="company" /></Row>
          <Row label="岗位"><Field job={job} field="title" /></Row>
          <Row label="城市"><Field job={job} field="city" /></Row>
          <Row label="招聘类型"><p className="pt-1.5">{job.posting?.hire_type || <span className="text-[var(--foreground-faint)]">—</span>}</p></Row>
          <Row label="标签">
            <TagPicker job={job} options={tagOptions} trigger={
              <button type="button" className="flex min-h-7 w-full flex-wrap items-center gap-1 rounded-md px-1 py-1 text-left hover:bg-[var(--surface-hover)]">
                {(job.tags ?? []).map((t) => <JobTag key={t} text={t} />)}
                {!job.tags?.length && <span className="text-[var(--foreground-faint)]">+ 标签</span>}
              </button>
            } />
          </Row>
          <Row label="评分">
            <div className="pt-1.5">
              {job.score != null ? <span className="tabular-nums">{job.score}</span> : <span className="text-[var(--foreground-faint)]">还没评估</span>}
              {!!job.reasons?.length && (
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[12.5px] leading-5 text-[var(--foreground-muted)]">
                  {job.reasons.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              )}
            </div>
          </Row>
          <Row label="投递日"><Field job={job} field="applied_at" type="date" /></Row>
          <Row label="链接">
            <div className="flex items-center gap-1">
              <Field job={job} field="url" placeholder="岗位链接" />
              {job.url && <a href={job.url} target="_blank" rel="noreferrer" className={ghost + " shrink-0"}>打开</a>}
            </div>
          </Row>
          <Row label="收藏日"><p className="pt-1.5 tabular-nums">{job.created_at?.slice(0, 10)}</p></Row>
        </dl>
        <section>
          <h3 className="mb-1.5 text-[12.5px] text-[var(--foreground-muted)]">备注</h3>
          <Notes job={job} />
        </section>
      </div>
    </aside>
  );
}
