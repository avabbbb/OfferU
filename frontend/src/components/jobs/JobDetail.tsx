"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import {
  CalendarClock, ChevronDown, ChevronLeft, ChevronRight, ClipboardList, ExternalLink, FileText, Gauge, Maximize2, MessageSquareText,
  NotebookPen, ScrollText, Send, Telescope,
} from "lucide-react";

import { AddEvent, EventRow } from "@/components/core/EventList";
import { ResearchCard } from "@/components/core/ResearchCard";
import { PageError, PageLoading } from "@/components/layout/PageState";
import { DisclosurePanel } from "@/components/settings/SettingsLayout";
import { Pill } from "@/components/ui";
import { type Doc, type Event, JOB_STATUS, type Job, refreshAll, tool, useTool, when, write } from "@/lib/core";
import { evaluateJobs } from "@/lib/evaluate";

import { JobTag, StatusPicker } from "./JobPickers";
import { STAGE_TONE } from "./stage";
import "@/styles/jobs.css";

// 岗位详情（Apple HIG）：页头说清「哪家、什么岗、到哪一步」；焦点卡只有匹配分、一句本质和一个墨黑的下一步；
// 评估、要求、JD、事项、材料、投递助手、备注都收进分组卡片里的披露行，点开再看。
// 同一个组件给 /jobs/:id 整页、宽屏列表右侧详情、窄屏推入详情用。

type SectionKey = "evaluation" | "posting" | "jd" | "events" | "docs" | "assist" | "notes" | "research";
type Detail = { record: Job; events: Event[]; docs: Doc[] };

const SPRING = { type: "spring", stiffness: 420, damping: 40 } as const;

function Section({ id, icon, title, summary, open, onToggle, children, testId }: {
  id: SectionKey;
  icon: ReactNode;
  title: string;
  summary?: ReactNode;
  open: boolean;
  onToggle: (id: SectionKey) => void;
  children: ReactNode;
  testId?: string;
}) {
  const panel = useId();
  return (
    <div className="jb-section" data-open={open ? "" : undefined} data-testid={testId}>
      <button type="button" className="jb-section-toggle" aria-expanded={open} aria-controls={panel} onClick={() => onToggle(id)}>
        <span className="ou-tile" aria-hidden="true">{icon}</span>
        <span className="jb-section-title">{title}</span>
        <span className="jb-section-summary">{summary}</span>
        <ChevronRight size={16} className="jb-section-chevron" aria-hidden="true" />
      </button>
      <DisclosurePanel open={open} id={panel}>
        <div className="jb-section-body">{children}</div>
      </DisclosurePanel>
    </div>
  );
}

function LongText({ job, field, label, placeholder, textareaRef }: { job: Job; field: "jd" | "notes"; label: string; placeholder: string; textareaRef?: React.Ref<HTMLTextAreaElement> }) {
  const [value, setValue] = useState(job[field] ?? "");
  useEffect(() => setValue(job[field] ?? ""), [job, field]);
  return (
    <textarea ref={textareaRef} value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} aria-label={label}
      rows={field === "jd" ? 10 : 4} data-doc={field === "jd" ? "" : undefined}
      onBlur={() => { if (value !== (job[field] ?? "")) void write("save", { type: "job", id: job.id, data: { [field]: value || null } }); }}
      className="jb-textarea" />
  );
}

function ApplyChat({ job }: { job: Job }) {
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState("");
  const [err, setErr] = useState("");
  const hasJd = Boolean(job.jd?.trim());
  return (
    <div className="jb-block">
      <h4 className="jb-subhead">官网网申问答</h4>
      <p>贴官网上的问题，按 JD 和这个岗位的定制简历回答；问答存在材料里的「官网投递对话」，可撤销。</p>
      <textarea value={question} onChange={(e) => setQuestion(e.target.value)} rows={3} aria-label="官网问题"
        placeholder={hasJd ? "比如：请描述一个你主导的项目（500 字以内）" : "先在下面贴 JD"} className="jb-textarea" />
      <div className="jb-actions">
        <button type="button" disabled={busy || !hasJd || !question.trim()} className="jb-text"
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
        {err && <span role="alert" className="jb-error">{err}</span>}
      </div>
      {answer && <div className="jb-paper">{answer}</div>}
    </div>
  );
}

type Draft = { to: string; cc: string[]; subject: string; body: string; attachment?: string | null; attach_error?: string | null; rules: string[] };

function EmailDraft({ job, autoStart }: { job: Job; autoStart?: number }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const mailto = draft
    ? "mailto:" + draft.to + "?subject=" + encodeURIComponent(draft.subject) + "&body=" + encodeURIComponent(draft.body)
      + (draft.cc.length ? "&cc=" + encodeURIComponent(draft.cc.join(",")) : "")
    : "";
  const run = async () => {
    setBusy(true); setErr("");
    try { setDraft(await write<Draft>("draft_email", { job_id: job.id })); }
    catch (e) { setErr(e instanceof Error ? e.message : "草稿没写出来"); }
    finally { setBusy(false); }
  };
  // 焦点卡的「写投递邮件」：打开这一节并直接开写。
  useEffect(() => { if (autoStart) void run(); }, [autoStart]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="jb-block">
      <h4 className="jb-subhead">邮件投递</h4>
      <div className="jb-actions">
        <button type="button" disabled={busy} className="jb-text" onClick={() => void run()}>{busy ? "正在写…" : draft ? "重写草稿" : "写投递邮件"}</button>
        {err && <span role="alert" className="jb-error">{err}</span>}
      </div>
      {draft && (
        <div className="jb-block">
          <dl className="jb-kv">
            <div><dt>收件人</dt><dd>{[draft.to, ...draft.cc].join("，")}</dd></div>
            <div><dt>标题</dt><dd>{draft.subject}</dd></div>
          </dl>
          {draft.rules.length > 0 && (
            <ul className="jb-list">{draft.rules.map((rule) => <li key={rule}>JD 要求：{rule}</li>)}</ul>
          )}
          <div className="jb-paper">{draft.body}</div>
          <p>{draft.attachment ? "附件：" + draft.attachment : draft.attach_error ?? "还没有简历，附件要自己加"}</p>
          <div className="jb-actions">
            <a href={mailto} className="jb-text"><Send size={14} aria-hidden="true" />在邮件客户端打开（附件要自己拖进去，确认后再发）</a>
          </div>
        </div>
      )}
    </div>
  );
}

// 岗位要求：收集时从 JD 拆出来的结构化信息。本质放在焦点卡里，这里是招聘类型等、关键词、拆条的要求。
const POSTING_META = [["hire_type", "招聘类型"], ["team", "部门"], ["years", "年限"], ["education", "学历"], ["salary", "薪资"], ["job_code", "编号"], ["posted_at", "发布日"]] as const;
const POSTING_LISTS = [["hard_reqs", "硬性要求"], ["responsibilities", "职责"], ["soft_reqs", "加分项"]] as const;

function postingParts(job: Job) {
  const p = job.posting;
  if (!p) return null;
  const meta = POSTING_META.filter(([key]) => p[key]).map(([key, name]) => ({ key, name, value: String(p[key]) }));
  const lists = POSTING_LISTS.map(([key, name]) => ({ key, name, items: p[key] ?? [] })).filter((l) => l.items.length);
  const keywords = p.keywords ?? [];
  const collaborators = p.collaborators ?? [];
  if (!meta.length && !lists.length && !keywords.length && !collaborators.length) return null;
  return { meta, lists, keywords, collaborators, needs: new Map((p.evidence ?? []).map((e) => [e.req, e.need])) };
}

function PostingBody({ parts }: { parts: NonNullable<ReturnType<typeof postingParts>> }) {
  const { meta, lists, keywords, collaborators, needs } = parts;
  return (
    <>
      {meta.length > 0 && (
        <dl className="jb-kv">{meta.map((m) => <div key={m.key}><dt>{m.name}</dt><dd>{m.value}</dd></div>)}</dl>
      )}
      {keywords.length > 0 && <div className="jb-keywords">{keywords.map((k) => <span key={k} className="jb-keyword">{k}</span>)}</div>}
      {collaborators.length > 0 && (
        <p><span className="jb-subhead">协作对象 </span>{collaborators.join("、")}<span className="jb-infer" title="由 JD 推断，不是原文">推断</span></p>
      )}
      {lists.map((l) => (
        <div key={l.key} className="jb-block">
          <h4 className="jb-subhead">{l.name} · {l.items.length} 条</h4>
          <ol className="jb-list">{l.items.map((t, i) => {
            const need = l.key === "hard_reqs" ? needs.get(t) : undefined;
            return (
              <li key={i}>{t}
                {need && <span className="jb-list-note">准备：{need}<span className="jb-infer" title="由 JD 推断，不是原文">推断</span></span>}
              </li>
            );
          })}</ol>
        </div>
      ))}
    </>
  );
}

/** 评估：给焦点卡和评估一节共用一份进度。 */
function useEvaluate(job: Job) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [err, setErr] = useState("");
  const run = async () => {
    setBusy(true); setErr(""); setProgress("");
    try {
      await evaluateJobs([job.id], new AbortController().signal, (event) => {
        if (event.type === "job_start") setProgress(event.total > 1 ? `${event.index}/${event.total}` : "");
        if (event.type === "done") void refreshAll();
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false); setProgress("");
    }
  };
  return { busy, err, run, label: busy ? (progress ? `正在评估 ${progress}…` : "正在评估，要几十秒…") : "" };
}

/** 定制简历：复制主简历（没挂岗位的那份），挂到这个岗位下面，再按 JD 改写。复制和改写各是一条改动，都能撤销。 */
function useTailor(job: Job) {
  const router = useRouter();
  const [state, setState] = useState("");
  const run = async () => {
    const { items } = await tool<{ items: Doc[] }>("list", { type: "doc", kind: "resume", full: true, limit: 200 });
    const base = items.filter((d) => !d.job_id).sort((a, b) => a.id - b.id)[0];
    if (!base) { router.push("/resume"); return; }
    const { record } = await write<{ record: Doc }>("save", { type: "doc", data: { kind: "resume", job_id: job.id, title: "简历 · " + (job.company ?? job.title), resume: base.resume, style: base.style, template: base.template } });
    if (!job.jd?.trim()) { router.push(`/resume/${record.id}`); return; }
    setState("正在按 JD 定制，要一两分钟…");
    try {
      await write("tailor_resume", { id: record.id, job_id: job.id });
      router.push(`/resume/${record.id}`);
    } catch {
      setState("定制失败，再试一次");
    }
  };
  const busy = Boolean(state) && state !== "定制失败，再试一次";
  return { state, busy, run };
}

type NextStep = { key: string; label: string; hint?: string; href?: string; run?: () => void; disabled?: boolean };

function JobDetailBody({ data, mode, onBack }: { data: Detail; mode: "page" | "pane" | "push"; onBack?: () => void }) {
  const router = useRouter();
  const job = data.record;
  const evaluation = data.docs.find((d) => d.kind === "evaluation");
  const research = data.docs.filter((d) => d.kind === "research");
  const resumes = data.docs.filter((d) => d.kind === "resume");
  const hasJd = Boolean(job.jd?.trim());
  const posting = postingParts(job);
  const evaluate = useEvaluate(job);
  const tailor = useTailor(job);
  const [open, setOpen] = useState<SectionKey[]>([]);
  const [copied, setCopied] = useState(false);
  const [mailKick, setMailKick] = useState(0);
  const jdRef = useRef<HTMLTextAreaElement>(null);
  const sectionRefs = useRef<Partial<Record<SectionKey, HTMLDivElement | null>>>({});

  useEffect(() => { setOpen([]); setCopied(false); }, [job.id]);
  const toggle = (key: SectionKey) => setOpen((list) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]));
  const reveal = (key: SectionKey, then?: () => void) => {
    setOpen((list) => (list.includes(key) ? list : [...list, key]));
    window.setTimeout(() => { sectionRefs.current[key]?.scrollIntoView({ block: "nearest", behavior: "smooth" }); then?.(); }, 260);
  };

  const upcoming = data.events.filter((e) => !e.done).sort((a, b) => (a.at ?? "~").localeCompare(b.at ?? "~"))[0];
  const tailorLabel = tailor.state || (hasJd ? "按 JD 定制一份简历" : "复制一份简历（贴了 JD 才能定制）");

  // 唯一的下一步：先有 JD → 评估 → 定制简历 → 投递 → 跟进事项。
  const next: NextStep | null = !hasJd
    ? { key: "jd", label: "贴岗位描述", hint: "有了 JD 才能评估、定制简历和写网申", run: () => reveal("jd", () => jdRef.current?.focus()) }
    : !evaluation && job.score == null
      ? { key: "evaluate", label: evaluate.label || "评估这个岗位", hint: "看匹配度、风险和要补的证据", run: () => void evaluate.run(), disabled: evaluate.busy }
      : !resumes.length
        ? { key: "tailor", label: tailor.state || "按 JD 定制简历", hint: "复制主简历，按这份 JD 改写", run: () => void tailor.run(), disabled: tailor.busy }
        : job.status === "saved"
          ? job.url
            ? { key: "apply", label: "去官网投递", hint: "投完把阶段改成「已投递」", href: job.url }
            : { key: "mail", label: "写投递邮件", hint: "发送前会先给你看草稿", run: () => reveal("assist", () => setMailKick((n) => n + 1)) }
          : job.status === "applied" || job.status === "test" || job.status === "interview"
            ? { key: "event", label: "记一条进展", hint: upcoming ? `下一项：${upcoming.title}${upcoming.at ? " · " + when(upcoming.at) : ""}` : "笔试、面试时间记下来会出现在今天页", run: () => reveal("events") }
            : null;

  const scoreLabel = job.score != null ? `${job.score} 分` : evaluation ? "已评估" : "还没评估";
  const company = job.company || "未填公司";
  const initial = Array.from(company)[0] ?? "?";
  const sectionRef = (key: SectionKey) => (el: HTMLDivElement | null) => { sectionRefs.current[key] = el; };

  return (
    <div className="jb-detail" data-testid="job-detail">
      {mode === "push" && (
        <div className="jb-topbar">
          <button type="button" className="jb-back" onClick={onBack} data-testid="jobs-back"><ChevronLeft size={20} aria-hidden="true" />岗位</button>
          <Link href={"/jobs/" + job.id} className="jb-icon" aria-label="在单独页面打开" title="在单独页面打开"><Maximize2 size={16} aria-hidden="true" /></Link>
        </div>
      )}
      {mode === "page" && (
        <div className="jb-topbar">
          <Link href="/jobs" className="jb-back"><ChevronLeft size={20} aria-hidden="true" />岗位</Link>
        </div>
      )}

      <header className="jb-dhead">
        <div className="jb-dhead-top">
          <span className="jb-mono" data-size="lg" aria-hidden="true">{initial}</span>
          <span className="jb-company">{company}{job.city && <small> · {job.city}</small>}</span>
          {mode === "pane" && (
            <Link href={"/jobs/" + job.id} className="jb-icon ml-auto" aria-label="展开到岗位详情页" title="展开到详情页"><Maximize2 size={16} aria-hidden="true" /></Link>
          )}
        </div>
        <h1 className="jb-role">{job.title || "未填岗位"}</h1>
        <div className="jb-dmeta">
          <StatusPicker job={job} tones={STAGE_TONE} align="start" trigger={
            <button type="button" aria-label={"投递状态：" + JOB_STATUS[job.status]} className="jb-stage-btn" data-testid="job-stage">
              <Pill tone={STAGE_TONE[job.status]}>{JOB_STATUS[job.status]}</Pill>
              <ChevronDown size={13} strokeWidth={1.75} aria-hidden />
            </button>
          } />
          {(job.tags ?? []).slice(0, 4).map((t) => <JobTag key={t} text={t} />)}
          {job.url && (
            <a href={job.url} target="_blank" rel="noreferrer" className="jb-text" title={job.url}><ExternalLink size={14} aria-hidden="true" />岗位原文</a>
          )}
        </div>
      </header>

      <motion.section className="jb-hero" aria-label="匹配和下一步" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={SPRING} key={job.id}>
        <div className="jb-hero-score">
          <span className="jb-hero-num" data-empty={job.score == null ? "" : undefined}>{job.score ?? "—"}</span>
          <span className="jb-hero-label">匹配分</span>
        </div>
        <div className="jb-hero-body">
          <p className="jb-hero-essence">
            {job.posting?.essence || (hasJd ? "还没拆出岗位要点" : "还没有岗位描述")}
            {job.posting?.essence && <span className="jb-infer" title="由 JD 概括，不是原文">推断</span>}
          </p>
          {!!job.reasons?.length && <p className="jb-hero-why">{job.reasons.slice(0, 2).join("；")}</p>}
        </div>
        {(next || evaluate.err) && (
          <div className="jb-hero-actions">
            {next && (next.href
              ? <a href={next.href} target="_blank" rel="noreferrer" className="jb-primary" data-testid="job-next-step">{next.label}<ExternalLink size={15} aria-hidden="true" /></a>
              : <button type="button" className="jb-primary" onClick={next.run} disabled={next.disabled} data-testid="job-next-step">{next.label}</button>)}
            {next?.hint && <span className="jb-hero-hint">{next.hint}</span>}
            {evaluate.err && <span role="alert" className="jb-error">{evaluate.err}</span>}
          </div>
        )}
      </motion.section>

      <div className="jb-block">
        <h3 className="jb-card-label">了解岗位</h3>
        <div className="jb-card">
          <div ref={sectionRef("evaluation")}>
            <Section id="evaluation" icon={<Gauge size={16} />} title="匹配评估" summary={scoreLabel} open={open.includes("evaluation")} onToggle={toggle} testId="job-section-evaluation">
              {evaluation ? <ResearchCard docId={evaluation.id} /> : <p>{hasJd ? "还没评估。评估会给出匹配度、最大风险和要补的证据。" : "先贴岗位描述，才能评估。"}</p>}
              {!!job.reasons?.length && <ul className="jb-list">{job.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}
              {job.greeting && (
                <div className="jb-block">
                  <h4 className="jb-subhead">打招呼语</h4>
                  <div className="jb-paper">{job.greeting}</div>
                </div>
              )}
              <div className="jb-actions">
                {(evaluation || next?.key !== "evaluate") && (
                  <button type="button" className="jb-text" disabled={evaluate.busy || !hasJd} onClick={() => void evaluate.run()}>
                    {evaluate.label || (evaluation ? "重新评估" : hasJd ? "评估这个岗位" : "贴了 JD 才能评估")}
                  </button>
                )}
                {job.greeting && (
                  <button type="button" className="jb-text" onClick={() => void navigator.clipboard.writeText(job.greeting ?? "").then(() => setCopied(true))}>{copied ? "已复制" : "复制打招呼语"}</button>
                )}
              </div>
            </Section>
          </div>
          {posting && (
            <Section id="posting" icon={<ClipboardList size={16} />} title="岗位要求"
              summary={posting.lists.map((l) => `${l.name} ${l.items.length}`).join(" · ") || posting.keywords.slice(0, 3).join(" · ")}
              open={open.includes("posting")} onToggle={toggle} testId="job-section-posting">
              <PostingBody parts={posting} />
            </Section>
          )}
          <div ref={sectionRef("jd")}>
            <Section id="jd" icon={<ScrollText size={16} />} title="岗位描述" summary={hasJd ? `${job.jd!.trim().length} 字` : "还没贴"} open={open.includes("jd")} onToggle={toggle} testId="job-section-jd">
              <LongText job={job} field="jd" label="岗位描述" placeholder="贴岗位 JD，Agent 改简历、写网申都会用到" textareaRef={jdRef} />
            </Section>
          </div>
          {research.length > 0 && (
            <Section id="research" icon={<Telescope size={16} />} title="公司调研" summary={`${research.length} 份`} open={open.includes("research")} onToggle={toggle}>
              {research.map((d) => <ResearchCard key={d.id} docId={d.id} />)}
            </Section>
          )}
        </div>
      </div>

      <div className="jb-block">
        <h3 className="jb-card-label">推进</h3>
        <div className="jb-card">
          <div ref={sectionRef("events")}>
            <Section id="events" icon={<CalendarClock size={16} />} title="事项"
              summary={data.events.length ? (upcoming ? `${upcoming.title}${upcoming.at ? " · " + when(upcoming.at) : ""}` : `${data.events.length} 项，都完成了`) : "还没有"}
              open={open.includes("events")} onToggle={toggle} testId="job-section-events">
              {data.events.length > 0 && <ul className="jb-events">{data.events.map((event) => <EventRow key={event.id} event={event} showJob={false} />)}</ul>}
              <div className="jb-events-add"><AddEvent jobId={job.id} /></div>
            </Section>
          </div>
          <Section id="docs" icon={<FileText size={16} />} title="材料" summary={data.docs.length ? `${data.docs.length} 份` : "还没有"} open={open.includes("docs")} onToggle={toggle} testId="job-section-docs">
            {data.docs.length ? (
              <ul className="jb-docs">
                {data.docs.map((doc) => (
                  <li key={doc.id}>
                    <Link href={doc.kind === "resume" ? `/resume/${doc.id}` : `/jobs/${job.id}`} className="jb-doc"><FileText size={15} aria-hidden="true" className="text-[var(--ou-text-tertiary)]" />{doc.label ?? doc.title}</Link>
                  </li>
                ))}
              </ul>
            ) : <p>还没有。定制简历、网申回答、面试复盘都会放在这里。</p>}
            <div className="jb-actions">
              <button type="button" className="jb-text" disabled={tailor.busy} onClick={() => void tailor.run()}>{tailorLabel}</button>
            </div>
          </Section>
          <div ref={sectionRef("assist")}>
            <Section id="assist" icon={<MessageSquareText size={16} />} title="投递助手" summary="网申问答 · 投递邮件" open={open.includes("assist")} onToggle={toggle} testId="job-section-assist">
              <ApplyChat job={job} />
              <EmailDraft job={job} autoStart={mailKick} />
            </Section>
          </div>
          <Section id="notes" icon={<NotebookPen size={16} />} title="备注" summary={job.notes?.trim() ? job.notes.trim().split("\n")[0] : "内推人、薪资…"} open={open.includes("notes")} onToggle={toggle} testId="job-section-notes">
            <LongText job={job} field="notes" label="备注" placeholder="内推人、薪资、面试官说了什么……" />
          </Section>
        </div>
      </div>

      <div className="jb-foot">
        <button type="button" className="jb-text" data-tone="danger"
          onClick={async () => { await write("delete", { type: "job", id: job.id }); router.push("/jobs"); }}>
          删除这个岗位（可在今天页撤销）
        </button>
      </div>
    </div>
  );
}

/** 读一个岗位并渲染详情；加载 / 失败 / 不存在都走 PageState。 */
export function JobDetail({ id, mode = "page", onBack }: { id: number; mode?: "page" | "pane" | "push"; onBack?: () => void }) {
  const { data, error, mutate } = useTool<Detail>("get", { type: "job", id }, 5000);
  if (error && !data) {
    const missing = (error as { status?: number; code?: string }).status === 404 || (error as { code?: string }).code === "not_found";
    if (missing) {
      return (
        <div className="jb-empty">
          <p className="jb-empty-title">这个岗位不存在了</p>
          {mode === "push" ? <button type="button" className="jb-text" onClick={onBack}>回到岗位</button> : <Link href="/jobs" className="jb-text">回到岗位</Link>}
        </div>
      );
    }
    return <PageError title="岗位没能读出来" error={error} onRetry={() => void mutate()} />;
  }
  if (!data) return <PageLoading label="正在打开岗位…" rows={5} />;
  return <JobDetailBody data={data} mode={mode} onBack={onBack} />;
}
