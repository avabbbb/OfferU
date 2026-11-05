"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { AddEvent, EventRow } from "@/components/core/EventList";
import { type Doc, type Event, type Job, tool, useTool, write } from "@/lib/core";
import { ResearchCard } from "@/components/core/ResearchCard";

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

function ApplyChat({ job }: { job: Job }) {
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState("");
  const [err, setErr] = useState("");
  const hasJd = Boolean(job.jd?.trim());
  return (
    <section>
      <h2 className="text-[13px] font-medium text-[var(--foreground-muted)]">官网网申问答</h2>
      <p className="mt-1 text-[12.5px] text-[var(--foreground-muted)]">贴官网上的问题，按 JD 和这个岗位的定制简历回答；问答存在材料里的「官网投递对话」，可撤销。</p>
      <textarea value={question} onChange={(e) => setQuestion(e.target.value)} rows={3} aria-label="官网问题"
        placeholder={hasJd ? "比如：请描述一个你主导的项目（500 字以内）" : "先在下面贴 JD"}
        style={{ fontSize: 13 }} className="mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 text-[13px] leading-6 text-[var(--foreground)] outline-none focus:border-[var(--foreground-muted)]" />
      <button type="button" disabled={busy || !hasJd || !question.trim()}
        className="mt-1 text-[12.5px] text-[var(--foreground-muted)] hover:text-[var(--foreground)] disabled:opacity-50"
        onClick={async () => {
          setBusy(true); setErr("");
          try {
            const out = await write<{ answer: string }>("apply_answer", { job_id: job.id, question });
            setAnswer(out.answer); setQuestion("");
          } catch (e) {
            setErr(e instanceof Error ? e.message : "没答出来，再试一次");
          } finally {
            setBusy(false);
          }
        }}>{busy ? "正在写…" : "回答"}</button>
      {err && <p className="mt-1 text-[12.5px] text-red-600">{err}</p>}
      {answer && <div className="mt-2 whitespace-pre-wrap rounded-lg border border-[var(--border)] p-3 text-[13px] leading-6 text-[var(--foreground)]">{answer}</div>}
    </section>
  );
}

type Draft = { to: string; cc: string[]; subject: string; body: string; attachment?: string | null; attach_error?: string | null; rules: string[] };

function EmailDraft({ job }: { job: Job }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const mailto = draft
    ? "mailto:" + draft.to + "?subject=" + encodeURIComponent(draft.subject) + "&body=" + encodeURIComponent(draft.body)
      + (draft.cc.length ? "&cc=" + encodeURIComponent(draft.cc.join(",")) : "")
    : "";
  return (
    <section>
      <div className="flex items-baseline justify-between">
        <h2 className="text-[13px] font-medium text-[var(--foreground-muted)]">邮件投递</h2>
        <button type="button" disabled={busy} className="text-[12.5px] text-[var(--foreground-muted)] hover:text-[var(--foreground)] disabled:opacity-50"
          onClick={async () => {
            setBusy(true); setErr("");
            try { setDraft(await write<Draft>("draft_email", { job_id: job.id })); }
            catch (e) { setErr(e instanceof Error ? e.message : "草稿没写出来"); }
            finally { setBusy(false); }
          }}>{busy ? "正在写…" : draft ? "重写草稿" : "写投递邮件"}</button>
      </div>
      {err && <p className="mt-1 text-[12.5px] text-red-600">{err}</p>}
      {draft && (
        <div className="mt-2 space-y-2 rounded-lg border border-[var(--border)] p-3 text-[13px] leading-6 text-[var(--foreground)]">
          <p><span className="text-[var(--foreground-muted)]">收件人：</span>{[draft.to, ...draft.cc].join("，")}</p>
          <p><span className="text-[var(--foreground-muted)]">标题：</span>{draft.subject}</p>
          {draft.rules.length > 0 && (
            <ul className="list-disc pl-5 text-[12.5px] text-[var(--foreground-muted)]">
              {draft.rules.map((rule) => <li key={rule}>JD 要求：{rule}</li>)}
            </ul>
          )}
          <p className="whitespace-pre-wrap">{draft.body}</p>
          <p className="text-[12.5px] text-[var(--foreground-muted)]">
            {draft.attachment ? "附件：" + draft.attachment : draft.attach_error ?? "还没有简历，附件要自己加"}
          </p>
          <a href={mailto} className="inline-block text-[12.5px] underline">在邮件客户端打开（附件要自己拖进去，确认后再发）</a>
        </div>
      )}
    </section>
  );
}

// 岗位评估：有报告就分层展示，没有就给按钮；重评覆盖同一份报告（可撤销）。
function Evaluation({ job, docs }: { job: Job; docs: Doc[] }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  const doc = docs.find((d) => d.kind === "evaluation");
  const hasJd = Boolean(job.jd?.trim());
  const run = async () => {
    setBusy(true); setErr("");
    try {
      await write("evaluate_jobs", { ids: [job.id] });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-1">
      {doc && <ResearchCard docId={doc.id} />}
      <div className="flex flex-wrap items-center gap-3 text-[12.5px] text-[var(--foreground-muted)]">
        {job.score != null && <span>匹配 {job.score} 分</span>}
        <button type="button" disabled={busy || !hasJd} onClick={() => void run()} className="hover:text-[var(--foreground)] disabled:opacity-60">
          {busy ? "正在评估，要几十秒…" : doc ? "重新评估" : hasJd ? "评估这个岗位" : "贴了 JD 才能评估"}
        </button>
        {err && <span className="text-red-700">{err}</span>}
      </div>
      {job.greeting && (
        <div className="rounded-lg border border-[var(--border)] px-3 py-2">
          <div className="mb-1 flex items-center gap-2 text-[12.5px] text-[var(--foreground-muted)]">打招呼语
            <button type="button" onClick={() => void navigator.clipboard.writeText(job.greeting ?? "").then(() => setCopied(true))}
              className="hover:text-[var(--foreground)]">{copied ? "已复制" : "复制"}</button>
          </div>
          <p className="whitespace-pre-wrap text-[13px] leading-6 text-[var(--foreground)]">{job.greeting}</p>
        </div>
      )}
    </div>
  );
}

// 岗位（L0）：收集时从 JD 拆出来的结构化信息。一屏露本质、招聘类型等和关键词；要求拆条折叠，硬性要求默认展开。
const POSTING_META = [["hire_type", "招聘类型"], ["team", "部门"], ["years", "年限"], ["education", "学历"], ["salary", "薪资"], ["job_code", "编号"], ["posted_at", "发布日"]] as const;
const POSTING_LISTS = [["hard_reqs", "硬性要求"], ["responsibilities", "职责"], ["soft_reqs", "加分项"]] as const;

function PostingSection({ job }: { job: Job }) {
  const p = job.posting;
  if (!p) return null;
  const meta = POSTING_META.filter(([key]) => p[key]).map(([key, name]) => ({ key, name, value: String(p[key]) }));
  const lists = POSTING_LISTS.map(([key, name]) => ({ key, name, items: p[key] ?? [] })).filter((l) => l.items.length);
  const keywords = p.keywords ?? [];
  const collaborators = p.collaborators ?? [];
  const needs = new Map((p.evidence ?? []).map((e) => [e.req, e.need]));
  if (!meta.length && !lists.length && !p.essence && !keywords.length && !collaborators.length) return null;
  return (
    <section className="space-y-3">
      <h2 className="text-[13px] font-medium text-[var(--foreground-muted)]">岗位</h2>
      {p.essence && (
        <p className="text-[14px] leading-6 text-[var(--foreground)]">{p.essence}
          <span title="由 JD 概括，不是原文" className="notion-tag" data-tone="gray">推断</span>
        </p>
      )}
      {meta.length > 0 && (
        <dl className="flex flex-wrap gap-x-5 gap-y-1 text-[12.5px]">
          {meta.map((m) => (
            <div key={m.key} className="flex gap-1"><dt className="text-[var(--foreground-muted)]">{m.name}</dt><dd className="text-[var(--foreground)]">{m.value}</dd></div>
          ))}
        </dl>
      )}
      {keywords.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {keywords.map((k) => <span key={k} className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[12px] text-[var(--foreground)]">{k}</span>)}
        </div>
      )}
      {collaborators.length > 0 && (
        <p className="text-[12.5px] leading-6 text-[var(--foreground)]"><span className="text-[var(--foreground-muted)]">协作对象 </span>{collaborators.join("、")}
          <span title="由 JD 推断，不是原文" className="notion-tag" data-tone="gray">推断</span>
        </p>
      )}
      {lists.map((l) => (
        <details key={l.key} open={l.key === "hard_reqs"} className="rounded-lg border border-[var(--border)] px-3 py-2">
          <summary className="cursor-pointer select-none text-[13px] text-[var(--foreground)]">{l.name} <span className="text-[12px] text-[var(--foreground-muted)]">{l.items.length} 条</span></summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-[13px] leading-6 text-[var(--foreground)]">{l.items.map((t, i) => {
            const need = l.key === "hard_reqs" ? needs.get(t) : undefined;
            return (
              <li key={i}>{t}
                {need && <span className="block text-[12.5px] text-[var(--foreground-muted)]">准备：{need} <span title="由 JD 推断，不是原文" className="notion-tag" data-tone="gray">推断</span></span>}
              </li>
            );
          })}</ol>
        </details>
      ))}
    </section>
  );
}

export default function JobDetailPage() {
  const id = Number(useParams().id);
  const router = useRouter();
  const [tailoring, setTailoring] = useState("");
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

      <Evaluation job={job} docs={data.docs} />
      <PostingSection job={job} />
      {data.docs.filter((d) => d.kind === "research").map((d) => <ResearchCard key={d.id} docId={d.id} />)}

      <section>
        <h2 className="text-[13px] font-medium text-[var(--foreground-muted)]">事项</h2>
        <ul className="divide-y divide-[var(--border)]">{data.events.map((event) => <EventRow key={event.id} event={event} showJob={false} />)}</ul>
        <AddEvent jobId={job.id} />
      </section>

      <section>
        <div className="flex items-baseline justify-between">
          <h2 className="text-[13px] font-medium text-[var(--foreground-muted)]">材料</h2>
          <button type="button" disabled={Boolean(tailoring) && tailoring !== "定制失败，再试一次"} className="text-[12.5px] text-[var(--foreground-muted)] hover:text-[var(--foreground)] disabled:opacity-60" onClick={async () => {
            // 复制主简历（没挂岗位的那份），挂到这个岗位下面，再按 JD 改写。复制和改写各是一条改动，都能撤销。
            const { items } = await tool<{ items: Doc[] }>("list", { type: "doc", kind: "resume", full: true, limit: 200 });
            const base = items.filter((d) => !d.job_id).sort((a, b) => a.id - b.id)[0];
            if (!base) { router.push("/resume"); return; }
            const { record } = await write<{ record: Doc }>("save", { type: "doc", data: { kind: "resume", job_id: job.id, title: "简历 · " + (job.company ?? job.title), resume: base.resume, style: base.style, template: base.template } });
            if (!job.jd?.trim()) { router.push(`/resume/${record.id}`); return; }
            setTailoring("正在按 JD 定制，要一两分钟…");
            try {
              await write("tailor_resume", { id: record.id, job_id: job.id });
              router.push(`/resume/${record.id}`);
            } catch {
              setTailoring("定制失败，再试一次");
            }
          }}>{tailoring || (job.jd?.trim() ? "按 JD 定制一份简历" : "复制一份简历（贴了 JD 才能定制）")}</button>
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

      <ApplyChat job={job} />

      <EmailDraft job={job} />

      <LongText job={job} field="jd" label="岗位描述" placeholder="贴岗位 JD，Agent 改简历、写网申都会用到" />
      <LongText job={job} field="notes" label="备注" placeholder="内推人、薪资、面试官说了什么……" />

      <button type="button" style={{ fontSize: 13 }} className="text-[13px] text-[var(--foreground-muted)] hover:text-[var(--foreground)]"
        onClick={async () => { await write("delete", { type: "job", id: job.id }); router.push("/jobs"); }}>
        删除这个岗位（可在今天页撤销）
      </button>
    </div>
  );
}
