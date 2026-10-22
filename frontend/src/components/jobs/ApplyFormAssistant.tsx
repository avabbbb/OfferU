"use client";

import Link from "next/link";
import { Fragment, useState } from "react";
import useSWR from "swr";

import { request } from "@/lib/api";
import { SHOWCASE } from "@/lib/showcase";
import { safeClientErrorMessage } from "@/lib/safe-error";

type Block = { title: string; text: string; sources: Array<{ id: string; label: string }>; unsupported: string[] };
type NewFact = { quote: string; title: string; proposal_id: number | null };
type Message = { role: "user" | "assistant"; text: string; blocks?: Block[]; new_facts?: NewFact[]; by?: string };
type Turn = { user?: { message: Message; index: number }; versions: Array<{ message: Message; index: number }> };

/** 同一句话的多次回答是版本，像 ChatGPT 一样可以翻看。 */
function toTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = [];
  messages.forEach((message, index) => {
    if (message.role === "user") turns.push({ user: { message, index }, versions: [] });
    else if (turns.length) turns[turns.length - 1].versions.push({ message, index });
    else turns.push({ versions: [{ message, index }] });
  });
  return turns;
}
type Form = { id: number; status: "waiting" | "ready"; messages: Message[] };

const muted = "text-[var(--foreground-muted)]";
const small = { fontSize: 12 };

/** 数字在档案里找不到的句子：标红加一个小小的「无依据」。 */
function Marked({ text, marks }: { text: string; marks: string[] }) {
  if (!marks.length) return <>{text}</>;
  const parts = text.split(new RegExp(`(${marks.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`));
  return <>{parts.map((part, i) => marks.includes(part)
    ? <mark key={i} title="档案里找不到依据" className="rounded-sm bg-amber-50 text-amber-800 underline decoration-dotted decoration-amber-500">{part}<sup className="ml-0.5 text-[10px]">无依据</sup></mark>
    : <Fragment key={i}>{part}</Fragment>)}</>;
}

function CopyBlock({ block }: { block: Block }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-[12px] font-medium text-[var(--foreground)]">{block.title || "可复制内容"}</span>
        <button type="button" style={small} className="shrink-0 font-medium text-[var(--foreground)] hover:underline"
          onClick={() => void navigator.clipboard.writeText(block.text).then(() => setCopied(true))}>
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-6 text-[var(--foreground)]"><Marked text={block.text} marks={block.unsupported} /></p>
      <p className={`mt-1 text-[12px] ${muted}`}>{block.text.length} 字{block.sources.length ? ` · 来自：${block.sources.map((s) => s.label).join("、")}` : ""}</p>
    </div>
  );
}

/** 用户在对话里说了档案里没有的经历：点了才生成待确认的档案修改。 */
function NewFacts({ formId, index, facts, onSaved }: { formId: number; index: number; facts: NewFact[]; onSaved: (form: Form) => void }) {
  const [saving, setSaving] = useState(-1);
  if (!facts.length) return null;
  const save = async (fact: number) => {
    setSaving(fact);
    try {
      const result = await request<{ form: Form }>(`/api/apply-forms/${formId}/facts`, { method: "POST", body: JSON.stringify({ message: index, fact }) });
      onSaved(result.form);
    } finally {
      setSaving(-1);
    }
  };
  return (
    <div className="space-y-1.5">
      {facts.map((fact, i) => (
        <div key={i} className={`flex items-baseline justify-between gap-4 text-[12px] ${muted}`}>
          <span>档案里还没有：「{fact.quote}」</span>
          {fact.proposal_id
            ? <Link href="/resume?mode=profile" className="shrink-0 hover:text-[var(--foreground)]">已加入待确认 · 去确认</Link>
            : <button type="button" disabled={saving === i} onClick={() => void save(i)} style={small}
                className="shrink-0 font-medium text-[var(--foreground)] hover:underline disabled:opacity-50">存进档案</button>}
        </div>
      ))}
    </div>
  );
}

/** 用户贴的整页文字很长：默认只露前几行。 */
function UserMessage({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const short = text.split("\n").slice(0, 4).join("\n").slice(0, 160);
  const long = short.length < text.length;
  return (
    <div className="ml-auto max-w-[85%] rounded-lg bg-[var(--background)] px-3 py-2">
      <p className="whitespace-pre-wrap text-[13px] leading-6 text-[var(--foreground)]">{long && !open ? `${short}…` : text}</p>
      {long && <button type="button" onClick={() => setOpen(!open)} style={small} className={`${muted} hover:text-[var(--foreground)]`}>{open ? "收起" : `展开全部（${text.length} 字）`}</button>}
    </div>
  );
}

/** 官网投递助手：围绕这个岗位的对话。贴官网页面、说要求，每段要粘贴的内容单独复制。不打开、不填写、不提交网站。 */
export function ApplyFormAssistant({ jobId }: { jobId: number }) {
  const key = `/api/jobs/${jobId}/apply-form`;
  const { data, mutate } = useSWR<{ form: Form | null }>(SHOWCASE ? null : key, (path: string) => request(path), {
    refreshInterval: (latest) => (latest?.form?.status === "waiting" ? 3000 : 0),
  });
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [promptCopied, setPromptCopied] = useState(false);
  const [picked, setPicked] = useState<Record<number, number>>({});
  if (!data) return null;
  const form = data.form;
  const messages = form?.messages ?? [];

  const turns = toTurns(messages);
  const send = async (fresh = false, retry = false) => {
    setBusy(true);
    setError("");
    try {
      const body = retry ? { retry: true } : { text, new: fresh };
      const result = await request<{ form: Form }>(key, { method: "POST", body: JSON.stringify(body) });
      await mutate(result, { revalidate: false });
      if (retry) setPicked((current) => ({ ...current, [turns.length - 1]: Number.MAX_SAFE_INTEGER }));
      else setText("");
    } catch (cause) {
      setError(safeClientErrorMessage(cause, "没发出去，请再试一次。"));
    } finally {
      setBusy(false);
    }
  };
  const agentPrompt = form ? `用 OfferU 官网投递助手回复对话 #${form.id}。` : "";

  return (
    <section id="apply-form" aria-labelledby="apply-form-title" className="scroll-mt-6 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
      <div className="flex items-start justify-between gap-6">
        <div>
          <h2 id="apply-form-title" className="text-[17px] font-semibold tracking-tight text-[var(--foreground)]">官网投递助手</h2>
          <p className={`mt-1 text-[13px] leading-6 ${muted}`}>
            把招聘官网在线简历页全选复制贴进来，顺便说要求，比如「官网还要个人优势，300 字」。每段要填的内容可以单独复制；不会打开或提交网站。
          </p>
        </div>
        {messages.length > 0 && (
          <button type="button" onClick={() => void mutate({ form: null }, { revalidate: false })} style={small}
            className={`shrink-0 ${muted} hover:text-[var(--foreground)]`}>新对话</button>
        )}
      </div>

      {messages.length > 0 && (
        <div className="mt-4 space-y-4">
          {turns.map((turn, t) => {
            const count = turn.versions.length;
            const v = Math.min(picked[t] ?? count - 1, count - 1);
            const shown = turn.versions[v];
            const last = t === turns.length - 1;
            return (
              <Fragment key={t}>
                {turn.user && <UserMessage text={turn.user.message.text} />}
                {shown && (
                  <div className="space-y-2">
                    {shown.message.text && <p className="whitespace-pre-wrap text-[13px] leading-6 text-[var(--foreground)]">{shown.message.text}</p>}
                    {(shown.message.blocks ?? []).map((block, i) => <CopyBlock key={i} block={block} />)}
                    {form && <NewFacts formId={form.id} index={shown.index} facts={shown.message.new_facts ?? []}
                      onSaved={(saved) => void mutate({ form: saved }, { revalidate: false })} />}
                    {(count > 1 || (last && form?.status === "ready")) && (
                      <div className={`flex items-center gap-3 text-[12px] ${muted}`}>
                        {count > 1 && (
                          <span className="inline-flex items-center gap-1.5">
                            <button type="button" aria-label="上一个版本" disabled={v === 0} onClick={() => setPicked({ ...picked, [t]: v - 1 })} className="px-1 text-[15px] leading-none disabled:opacity-30 hover:text-[var(--foreground)]">‹</button>
                            {v + 1} / {count}
                            <button type="button" aria-label="下一个版本" disabled={v === count - 1} onClick={() => setPicked({ ...picked, [t]: v + 1 })} className="px-1 text-[15px] leading-none disabled:opacity-30 hover:text-[var(--foreground)]">›</button>
                          </span>
                        )}
                        {last && form?.status === "ready" && (
                          <button type="button" disabled={busy} onClick={() => void send(false, true)} className="hover:text-[var(--foreground)] disabled:opacity-50">重新回答</button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </Fragment>
            );
          })}
          {form?.status === "waiting" && (
            <div className="rounded-lg bg-[var(--background)] p-3">
              <p className="text-[13px] text-[var(--foreground)]">没有可用的内置模型，让你的 Agent 来回复，把这句话发给它：</p>
              <div className="mt-1.5 flex items-center justify-between gap-4">
                <code className="text-[13px] text-[var(--foreground)]">{agentPrompt}</code>
                <button type="button" style={small} className="shrink-0 font-medium text-[var(--foreground)] hover:underline"
                  onClick={() => void navigator.clipboard.writeText(agentPrompt).then(() => setPromptCopied(true))}>
                  {promptCopied ? "已复制" : "复制"}
                </button>
              </div>
              <p className={`mt-1.5 text-[12px] ${muted}`}>回复后这里会自动显示。</p>
            </div>
          )}
        </div>
      )}

      <div className="mt-4">
        <textarea value={text} onChange={(event) => setText(event.target.value)} rows={messages.length ? 3 : 7} style={{ fontSize: 13 }}
          aria-label="发给官网投递助手" placeholder={messages.length ? "继续说要求，比如「项目职责压到 200 字」「改成三条要点」" : "粘贴招聘官网在线简历页的全部文字，再写上你的要求"}
          onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && text.trim()) void send(!form); }}
          className="w-full rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 leading-6 text-[var(--foreground)] outline-none focus:border-[var(--foreground-muted)]" />
        <div className="mt-2 flex items-center gap-3">
          <button type="button" onClick={() => void send(!form)} disabled={busy || !text.trim()}
            style={{ color: "var(--background)", fontSize: 13 }}
            className="inline-flex items-center rounded-lg bg-[var(--foreground)] px-3 py-1.5 font-medium disabled:opacity-50">
            {busy ? "正在回复…" : "发送"}
          </button>
          <span className={`text-[12px] ${muted}`}>Ctrl + Enter 发送</span>
        </div>
        {error && <p role="alert" className="mt-2 text-[12px] text-red-700">{error}</p>}
      </div>
    </section>
  );
}
