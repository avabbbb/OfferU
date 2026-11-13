"use client";

import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

import { LabelPicker, type LabelOption, Pill, Tag, toneOf } from "@/components/ui";
import { JOB_STATUS, type Job, type JobStatus } from "@/lib/core";
import { STATUS_ORDER, STATUS_TONE, tagPatch } from "@/lib/jobView";
import { write } from "@/lib/core";

// 岗位上的两个选择器都走 components/ui 的 LabelPicker（色点 + 名字、悬停才出勾选框、搜不到就创建）：
// 状态是单选、不能新建；标签是多选，可以就地新建（新建 = 给这个岗位加上这个标签，写完才显示「已创建」）。

const STATUS_OPTIONS: LabelOption[] = STATUS_ORDER.map((s) => ({ value: s, label: JOB_STATUS[s], tone: STATUS_TONE[s] }));

export const saveJobTags = (job: Job, tags: string[]) => write("save", { type: "job", id: job.id, data: tagPatch(job, tags) });

export function StatusPicker({ job, trigger, onPick, align }: { job: Job; trigger: ReactNode; onPick?: (s: JobStatus) => void; align?: "start" | "end" }) {
  return (
    <LabelPicker label="投递状态" placeholder="改成…" multiple={false} align={align} options={STATUS_OPTIONS} value={[job.status]}
      trigger={trigger}
      onChange={([s]) => {
        if (!s || s === job.status) return;
        if (onPick) onPick(s as JobStatus);
        else void write("save", { type: "job", id: job.id, data: { status: s } });
      }} />
  );
}

export function TagPicker({ job, options, trigger, align }: { job: Job; options: string[]; trigger: ReactNode; align?: "start" | "end" }) {
  const tags = job.tags ?? [];
  const all = [...new Set([...tags, ...options])];
  return (
    <LabelPicker label="标签" placeholder="搜索或创建标签…" align={align} value={tags}
      options={all.map((t) => ({ value: t, label: t, tone: toneOf(t), hint: job.auto_tags?.includes(t) ? "Agent" : undefined }))}
      onChange={(next) => void saveJobTags(job, next.slice(0, 12))}
      onCreate={(name) => (tags.includes(name) || tags.length >= 12 ? undefined : saveJobTags(job, [...tags, name]))}
      trigger={trigger} />
  );
}

export function JobTag({ text, onClick, title }: { text: string; onClick?: () => void; title?: string }) {
  return <Tag tone={toneOf(text)} onClick={onClick} title={title ?? text}>{text}</Tag>;
}

/** 详情页 / 记录抽屉里的状态：状态胶囊 + ▾，点开是单选的 LabelPicker（代替原生下拉）。 */
export function StatusSelect({ job }: { job: Job }) {
  return (
    <StatusPicker job={job} trigger={
      <button type="button" aria-label={"投递状态：" + JOB_STATUS[job.status]} className="ou-pressable inline-flex max-w-full items-center gap-1 rounded-full">
        <Pill tone={STATUS_TONE[job.status]}>{JOB_STATUS[job.status]}</Pill>
        <ChevronDown size={13} strokeWidth={1.75} className="text-[var(--foreground-faint)]" aria-hidden />
      </button>
    } />
  );
}
