"use client";

// =============================================
// 面试 · 复盘：一场真实面试一页。
// 被问到的题逐条记（题目 / 我怎么答的 / 卡在哪 / 面试官反应），
// 可以手动写，也可以录音或上传录音，转成文字后让 AI 拆成题。
// 每道题都能拿去模拟面试单独练。改动停顿后自动保存。
// =============================================

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, Mic, Plus, Square, Trash2, Upload, X } from "lucide-react";
import { motion } from "framer-motion";
import { PageHeader } from "@/components/layout/PageHeader";
import { DatePicker } from "@/components/ui";
import { Disclosure, Reveal, SPRING, Segmented } from "../kit";
import { safeClientErrorMessage } from "@/lib/safe-error";
import {
  createReview,
  deleteReview,
  emptyQuestion,
  extractQuestions,
  getWeakSpots,
  groupWeakSpots,
  listReviews,
  markApplicationRejected,
  saveReview,
  transcribeAudio,
  type InterviewReview,
  type ReviewOutcome,
  type ReviewQuestion,
  type WeakSpots as WeakSpotsResult,
} from "@/lib/interviewReviews";
import { write } from "@/lib/core";

const OUTCOMES: Array<{ id: ReviewOutcome; label: string }> = [
  { id: "pending", label: "等结果" },
  { id: "passed", label: "通过" },
  { id: "failed", label: "没过" },
];

const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

function reviewTitle(review: Pick<InterviewReview, "company" | "round_label">) {
  return [review.company || "未填公司", review.round_label].filter(Boolean).join(" · ");
}

function formatDay(day: string | null) {
  if (!day) return "";
  const [, m, d] = day.split("-");
  return `${Number(m)} 月 ${Number(d)} 日`;
}

/** 随内容长高的输入框，看起来像文档里的一段字。 */
function Field({ value, onChange, placeholder, className = "", label, size, autoFocus }: { value: string; onChange: (v: string) => void; placeholder: string; className?: string; label: string; size?: "lead"; autoFocus?: boolean }) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.style.height = "0px";
    node.style.height = `${node.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      rows={1}
      aria-label={label}
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      autoFocus={autoFocus}
      data-size={size}
      className={`iv-field-doc ${className}`}
    />
  );
}

const DETAIL_FIELDS: Array<{ key: "answer" | "reflection" | "reaction"; label: string; placeholder: string }> = [
  { key: "answer", label: "我怎么答的", placeholder: "当时说了哪些要点" },
  { key: "reflection", label: "卡在哪", placeholder: "哪里没答好，下次怎么说" },
  { key: "reaction", label: "面试官反应", placeholder: "追问、打断、点头……" },
];

function QuestionBlock({ index, item, onChange, onRemove, practiceHref }: { index: number; item: ReviewQuestion; onChange: (next: ReviewQuestion) => void; onRemove: () => void; practiceHref: string | null }) {
  const set = (key: keyof ReviewQuestion) => (value: string) => onChange({ ...item, [key]: value });
  // 空着的细节先收起来，点「+ 卡在哪」再展开那一格。
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const shown = DETAIL_FIELDS.filter((field) => item[field.key].trim() || opened.has(field.key));
  const hidden = DETAIL_FIELDS.filter((field) => !shown.includes(field));
  return (
    <motion.li layout="position" transition={SPRING} className="iv-q" data-testid="review-question">
      <div className="flex items-start gap-3">
        <span className="iv-q-num mt-0.5">{index + 1}</span>
        <div className="min-w-0 flex-1 pt-0.5">
          <Field label={`第 ${index + 1} 题`} value={item.question} onChange={set("question")} placeholder="面试官问了什么" size="lead" />
        </div>
        <button type="button" onClick={onRemove} aria-label={`删除第 ${index + 1} 题`} className="iv-icon-btn -my-2 -mr-2"><X size={15} /></button>
      </div>
      {shown.length > 0 && (
        <div className="iv-q-fields">
          {shown.map((field) => (
            <div key={field.key} className="iv-q-field">
              <span className="iv-label pt-[0.1rem]">{field.label}</span>
              <Field label={field.label} value={item[field.key]} onChange={set(field.key)} placeholder={field.placeholder} autoFocus={opened.has(field.key) && !item[field.key]} />
            </div>
          ))}
        </div>
      )}
      {(hidden.length > 0 || (practiceHref && item.question.trim())) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-1">
          {hidden.map((field) => (
            <button key={field.key} type="button" className="iv-quiet" onClick={() => setOpened((prev) => new Set(prev).add(field.key))}><Plus size={14} aria-hidden="true" /> {field.label}</button>
          ))}
          {practiceHref && item.question.trim() && <Link href={practiceHref} className="iv-quiet ml-auto">练这题 <ArrowRight size={14} aria-hidden="true" /></Link>}
        </div>
      )}
    </motion.li>
  );
}

/** 录音 / 上传录音 / 粘贴文字 → 原文 → 拆成题。 */
function TranscriptPanel({ transcript, onTranscript, onQuestions }: { transcript: string; onTranscript: (text: string) => void; onQuestions: (items: ReviewQuestion[]) => void }) {
  const [busy, setBusy] = useState<"" | "transcribe" | "extract">("");
  const [error, setError] = useState("");
  const [seconds, setSeconds] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(timer);
  }, [recording]);
  useEffect(() => () => recorderRef.current?.stream.getTracks().forEach((t) => t.stop()), []);

  const transcribe = async (blob: Blob, name: string) => {
    setBusy("transcribe"); setError("");
    try {
      const text = await transcribeAudio(blob, name);
      onTranscript(transcript ? `${transcript}\n\n${text}` : text);
    } catch (cause) {
      setError(safeClientErrorMessage(cause, "转写失败"));
    } finally {
      setBusy("");
    }
  };

  const startRecording = async () => {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => chunks.push(event.data);
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        recorderRef.current = null;
        setRecording(false);
        void transcribe(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }), recorder.mimeType.includes("mp4") ? "recording.mp4" : "recording.webm");
      };
      recorderRef.current = recorder;
      setSeconds(0);
      recorder.start();
      setRecording(true);
    } catch {
      setError("没有拿到麦克风权限。可以改为上传录音文件。");
    }
  };

  const extract = async () => {
    setBusy("extract"); setError("");
    try {
      const items = await extractQuestions(transcript);
      if (!items.length) setError("没有从原文里找到面试官的提问。");
      else onQuestions(items);
    } catch (cause) {
      setError(safeClientErrorMessage(cause, "拆题失败"));
    } finally {
      setBusy("");
    }
  };

  return (
    <Disclosure title="从录音或笔记整理" summary={recording ? `录音中 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : transcript ? "已有原文" : "录音 · 上传 · 粘贴"} defaultOpen={Boolean(transcript)} icon={<Mic size={15} aria-hidden="true" />} testId="review-transcript">
      <div className="flex flex-wrap items-center gap-1 -ml-3">
        {recording ? (
          <button type="button" className="iv-quiet" onClick={() => recorderRef.current?.stop()}>
            <Square size={13} className="fill-current" aria-hidden="true" /> 停止并转写 · {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
          </button>
        ) : (
          <button type="button" className="iv-quiet" onClick={startRecording} disabled={Boolean(busy)}><Mic size={15} aria-hidden="true" /> 录音</button>
        )}
        <button type="button" className="iv-quiet" onClick={() => fileRef.current?.click()} disabled={Boolean(busy) || recording}><Upload size={15} aria-hidden="true" /> 上传录音</button>
        <input ref={fileRef} type="file" accept="audio/*,.m4a,.mp3,.wav,.webm" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void transcribe(file, file.name); }} />
        {busy === "transcribe" && <span className="iv-meta">正在转写…</span>}
      </div>
      <textarea
        aria-label="面试原文"
        value={transcript}
        onChange={(event) => onTranscript(event.target.value)}
        placeholder="或者把录音转写、面试笔记贴在这里，例如飞书妙记、通义听悟导出的文字。"
        className="iv-textarea mt-2 h-40 text-[length:var(--ou-type-body)]"
      />
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p className="iv-meta">录音转完文字就删除，只保留原文。</p>
        <button type="button" onClick={extract} disabled={!transcript.trim() || Boolean(busy)} className="iv-secondary" data-testid="review-extract">
          {busy === "extract" ? "正在拆题…" : "拆成题目"}
        </button>
      </div>
      {error && <p className="iv-alert mt-3">{error}</p>}
    </Disclosure>
  );
}

/** 选了「没过」且关联了投递：问一句要不要把投递也标掉。改投递状态必须用户点了才做。 */
function RejectPrompt({ review, onDone }: { review: InterviewReview; onDone: () => void }) {
  const [state, setState] = useState<"" | "busy" | "done">("");
  const [error, setError] = useState("");
  const confirm = async () => {
    setState("busy"); setError("");
    try {
      await saveReview(review);
      await markApplicationRejected(review.id);
      setState("done");
    } catch (cause) {
      setState(""); setError(safeClientErrorMessage(cause, "没能更新投递"));
    }
  };
  if (state === "done") return <p className="iv-muted mt-4" data-testid="review-reject-done">投递已标成未通过。</p>;
  return (
    <Reveal>
      <div className="iv-card-flat mt-4 flex flex-wrap items-center gap-2" data-testid="review-reject-prompt">
        <span className="mr-auto text-[length:var(--ou-type-body)] text-[var(--ou-text-primary)]">要把投递也标成未通过吗？</span>
        <button type="button" onClick={onDone} className="iv-quiet">不用</button>
        <button type="button" onClick={confirm} disabled={state === "busy"} className="iv-secondary">标成未通过</button>
        {error && <span className="w-full text-[length:var(--ou-type-sm)] text-[var(--ou-tone-red-text)]">{error}</span>}
      </div>
    </Reveal>
  );
}

function Editor({ review, onChange, onDelete }: { review: InterviewReview; onChange: (next: InterviewReview) => void; onDelete: () => void }) {
  const [askReject, setAskReject] = useState(false);
  const set = <K extends keyof InterviewReview>(key: K, value: InterviewReview[K]) => {
    if (key === "outcome") setAskReject(value === "failed" && review.job_id != null);
    onChange({ ...review, [key]: value });
  };
  const setQuestion = (index: number, next: ReviewQuestion) => set("questions", review.questions.map((q, i) => (i === index ? next : q)));
  const practice = (indexes?: number[]) => {
    const picked = (indexes ?? review.questions.map((_, i) => i)).filter((i) => review.questions[i]?.question.trim());
    return picked.length ? `/interview/ai?review=${review.id}&q=${picked.slice(0, 10).join(",")}` : null;
  };
  const allPractice = practice();
  const practiceCount = Math.min(10, review.questions.filter((q) => q.question.trim()).length);

  return (
    <article className="min-w-0" data-testid="review-editor">
      <div className="flex items-start gap-2">
        <input aria-label="公司" value={review.company} onChange={(e) => set("company", e.target.value)} placeholder="公司" className="iv-title-input flex-1" />
        <button type="button" onClick={onDelete} aria-label="删除这场复盘" title="删除这场复盘" className="iv-icon-btn -mr-2"><Trash2 size={16} /></button>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input aria-label="岗位" value={review.role} onChange={(e) => set("role", e.target.value)} placeholder="岗位" className="iv-meta-input w-[min(16rem,100%)]" />
        <input aria-label="轮次" value={review.round_label} onChange={(e) => set("round_label", e.target.value)} placeholder="一面 / 二面 / HR 面" list="review-rounds" className="iv-meta-input w-36" />
        <datalist id="review-rounds">{["一面", "二面", "三面", "HR 面", "终面", "笔试"].map((r) => <option key={r} value={r} />)}</datalist>
        <div className="w-44 shrink-0"><DatePicker size="sm" aria-label="面试日期" placeholder="面试日期" value={review.interviewed_on ?? ""} onChange={(v) => set("interviewed_on", v || null)} /></div>
        <Segmented inline label="结果" value={review.outcome} options={OUTCOMES.map((o) => ({ value: o.id, label: o.label }))} onChange={(value) => set("outcome", value)} />
      </div>

      {askReject && <RejectPrompt review={review} onDone={() => setAskReject(false)} />}

      {allPractice && (
        <div className="iv-card-flat mt-6 flex flex-wrap items-center justify-between gap-3">
          <p className="iv-muted min-w-0">把这场被问到的 {practiceCount} 道题拿去模拟练一遍。</p>
          <Link href={allPractice} className="iv-primary" data-testid="review-practice-all">模拟练习这 {practiceCount} 题 <ArrowRight size={16} aria-hidden="true" /></Link>
        </div>
      )}

      <div className="mt-8 flex items-baseline justify-between gap-3">
        <h2 className="iv-h3">被问到的题</h2>
        <span className="iv-meta">{review.questions.length} 道</span>
      </div>
      <ol className="mt-3">
        {review.questions.map((item, index) => (
          <QuestionBlock key={index} index={index} item={item} onChange={(next) => setQuestion(index, next)} onRemove={() => set("questions", review.questions.filter((_, i) => i !== index))} practiceHref={practice([index])} />
        ))}
      </ol>
      <button type="button" onClick={() => set("questions", [...review.questions, emptyQuestion()])} className="iv-quiet mt-2 -ml-3" data-testid="review-add-question">
        <Plus size={15} aria-hidden="true" /> 添加一道题
      </button>

      <div className="mt-6">
        <TranscriptPanel
          transcript={review.transcript}
          onTranscript={(text) => set("transcript", text)}
          onQuestions={(items) => set("questions", [...review.questions.filter((q) => q.question.trim() || q.answer.trim()), ...items])}
        />
      </div>

      <section className="iv-card mt-8">
        <h2 className="iv-h3">整体感受</h2>
        <Field label="整体感受" value={review.summary} onChange={(v) => set("summary", v)} placeholder="这一轮整体怎么样，下次最想改的一件事" className="mt-2" />
        <SaveToMemory review={review} />
      </section>
    </article>
  );
}

/** 复盘写回档案：每道题（连同我怎么答、卡在哪）和整体感受各存一条记忆，之后定制简历、网申回答、岗位评估都会读到。 */
function SaveToMemory({ review }: { review: InterviewReview }) {
  const [state, setState] = useState<"" | "busy">("");
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState("");
  const where = [reviewTitle(review), review.role, review.interviewed_on].filter(Boolean).join(" · ");
  const items = [
    ...review.questions.filter((q) => q.question.trim()).map((q) => ({
      key: "q:" + q.question.trim(),
      title: "面试题：" + q.question.trim().slice(0, 60),
      body: ["题目：" + q.question.trim(), q.answer.trim() && "我的回答：" + q.answer.trim(), q.reflection.trim() && "卡在哪：" + q.reflection.trim(), "来自：" + where].filter(Boolean).join("\n"),
    })),
    ...(review.summary.trim() ? [{ key: "s:" + review.summary.trim(), title: "面试复盘：" + where, body: review.summary.trim() }] : []),
  ].filter((item) => !saved.has(item.key));
  const save = async () => {
    setState("busy"); setNotice("");
    let done = 0;
    try {
      for (const item of items) {
        await write("save", { type: "memory", data: { kind: "note", title: item.title, body: item.body, end: review.interviewed_on || undefined, tags: ["面试复盘", review.company].filter(Boolean) } });
        done += 1;
        setSaved((prev) => new Set(prev).add(item.key));
      }
      setNotice("存了 " + done + " 条进档案，在档案里可以改或撤销。");
    } catch (cause) {
      setNotice((done ? "存了 " + done + " 条，" : "") + safeClientErrorMessage(cause, "剩下的没存上，再点一次"));
    } finally {
      setState("");
    }
  };
  return (
    <div className="mt-4 flex flex-wrap items-center gap-3" data-testid="review-save-memory">
      <button type="button" onClick={save} disabled={!items.length || state === "busy"} className="iv-secondary">
        {state === "busy" ? "正在存…" : items.length ? "存进档案（" + items.length + " 条）" : "都存过了"}
      </button>
      {notice && <span role="status" className="iv-muted">{notice}</span>}
    </div>
  );
}

type Stuck = { ref: string; review: InterviewReview; item: ReviewQuestion };

function stuckQuestions(reviews: InterviewReview[]): Stuck[] {
  return reviews.flatMap((review) =>
    review.questions.map((item, i) => ({ ref: `${review.id}:${i}`, review, item })).filter(({ item }) => item.question.trim() && item.reflection.trim()),
  );
}

function StuckItem({ stuck }: { stuck: Stuck }) {
  return (
    <li>
      <Link href={`/interview/review?id=${stuck.review.id}`} className="-mx-3 block rounded-[var(--ou-radius-control)] px-3 py-3 hover:bg-[var(--ou-bg-hover)]">
        <span className="block text-[length:var(--ou-type-body)] font-medium text-[var(--ou-text-primary)]">{stuck.item.question}</span>
        <span className="iv-muted mt-1 block">{stuck.item.reflection}</span>
        <span className="iv-meta mt-1 block">{reviewTitle(stuck.review)}{stuck.review.interviewed_on ? ` · ${formatDay(stuck.review.interviewed_on)}` : ""}</span>
      </Link>
    </li>
  );
}

function WeakSpots({ reviews }: { reviews: InterviewReview[] }) {
  const stuck = stuckQuestions(reviews);
  const byRef = new Map(stuck.map((s) => [s.ref, s]));
  const [result, setResult] = useState<WeakSpotsResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    getWeakSpots().then(setResult).catch((cause) => setError(safeClientErrorMessage(cause, "读取归类失败")));
  }, []);
  const topics = result?.grouped_at ? result.topics : null;
  const sessions = new Set(stuck.map((s) => s.review.id)).size;

  const group = async () => {
    setBusy(true);
    setError("");
    try {
      setResult(await groupWeakSpots());
    } catch (cause) {
      setError(safeClientErrorMessage(cause, "归类失败"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="min-w-0" data-testid="review-weak-spots">
      <div className="iv-head">
        <div className="min-w-0">
          <h2 className="iv-title">反复卡住的题</h2>
          <p className="iv-lede">{stuck.length ? `${sessions} 场复盘里写了「卡在哪」的 ${stuck.length} 道题。` : "复盘里写了「卡在哪」的题会汇总到这里。"}</p>
        </div>
        {stuck.length > 0 && (
          <button type="button" onClick={group} disabled={busy} className={topics ? "iv-secondary" : "iv-primary"} data-testid="weak-group">
            {busy ? "正在归类…" : topics ? "重新归类" : "按考察点归类"}
          </button>
        )}
      </div>
      {error && <p className="iv-alert mt-4">{error}</p>}
      {topics && result?.stale && stuck.length > 0 && <p className="iv-muted mt-4" data-testid="weak-stale">归类之后复盘有改动，可以重新归类。</p>}

      {topics ? (
        <div className="mt-6 space-y-4">
          {topics.map((topic, index) => {
            const items = topic.refs.map((ref) => byRef.get(ref)).filter((s): s is Stuck => Boolean(s));
            if (!items.length) return null;
            const times = new Set(items.map((s) => s.review.id)).size;
            const refs = items.slice(0, 10).map((s) => s.ref).join(",");
            return (
              <Reveal key={topic.title + refs} delay={Math.min(index, 8) * 0.03}>
                <section className="iv-card" data-testid="weak-topic">
                  <div className="iv-row">
                    <div className="min-w-0">
                      <h3 className="iv-h3">{topic.title}</h3>
                      <p className="iv-meta mt-0.5">{times > 1 ? `${times} 场都卡过` : "卡过 1 次"} · {items.length} 道题</p>
                    </div>
                    <Link href={`/interview/ai?from=${refs}&topic=${encodeURIComponent(topic.title)}`} className="iv-secondary" data-testid="weak-practice">专练这组 <ArrowRight size={15} aria-hidden="true" /></Link>
                  </div>
                  {topic.advice && <p className="mt-3 text-[length:var(--ou-type-body)] text-[var(--ou-text-primary)]">{topic.advice}</p>}
                  <div className="mt-3">
                    <Disclosure title="看看是哪几道" summary={`${items.length} 道`}>
                      <ul className="divide-y divide-[var(--ou-line-separator)]">{items.map((s) => <StuckItem key={s.ref} stuck={s} />)}</ul>
                    </Disclosure>
                  </div>
                </section>
              </Reveal>
            );
          })}
        </div>
      ) : stuck.length > 0 && (
        <section className="iv-card mt-6">
          <ul className="divide-y divide-[var(--ou-line-separator)]">{stuck.map((s) => <StuckItem key={s.ref} stuck={s} />)}</ul>
        </section>
      )}
    </article>
  );
}

export default function InterviewReviewPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedId = Number(searchParams.get("id") || 0);
  const weakView = searchParams.get("view") === "weak";
  const [reviews, setReviews] = useState<InterviewReview[] | null>(null);
  const [error, setError] = useState("");
  const [saveState, setSaveState] = useState<"" | "saving" | "saved">("");
  const pending = useRef<Map<number, number>>(new Map());

  useEffect(() => {
    listReviews().then(setReviews).catch((cause) => setError(safeClientErrorMessage(cause, "读取复盘失败")));
  }, []);

  const select = useCallback((id: number) => router.push(`/interview/review?id=${id}`), [router]);
  const current = reviews?.find((r) => r.id === selectedId) ?? reviews?.[0] ?? null;

  const create = async () => {
    try {
      const created = await createReview({ interviewed_on: today(), questions: [emptyQuestion()] });
      setReviews((list) => [created, ...(list ?? [])]);
      select(created.id);
    } catch (cause) {
      setError(safeClientErrorMessage(cause, "新建复盘失败"));
    }
  };

  // 改动停顿 0.6 秒整份保存；每场复盘各自计时，切换时不会丢。
  const update = (next: InterviewReview) => {
    setReviews((list) => list?.map((r) => (r.id === next.id ? next : r)) ?? list);
    window.clearTimeout(pending.current.get(next.id));
    setSaveState("saving");
    pending.current.set(next.id, window.setTimeout(() => {
      pending.current.delete(next.id);
      saveReview(next)
        .then(() => setSaveState("saved"))
        .catch((cause) => { setSaveState(""); setError(safeClientErrorMessage(cause, "保存失败")); });
    }, 600));
  };

  const remove = async (review: InterviewReview) => {
    if (!window.confirm(`删除「${reviewTitle(review)}」的复盘？`)) return;
    window.clearTimeout(pending.current.get(review.id));
    try {
      await deleteReview(review.id);
      setReviews((list) => list?.filter((r) => r.id !== review.id) ?? list);
      router.push("/interview/review");
    } catch (cause) {
      setError(safeClientErrorMessage(cause, "删除失败"));
    }
  };

  let body: ReactNode;
  if (!reviews) body = <p className="iv-muted py-16 text-center">{error || "正在读取…"}</p>;
  else if (!current) {
    body = (
      <div className="iv-card iv-empty mx-auto max-w-lg" data-testid="review-empty">
        <p className="iv-h2">还没有复盘</p>
        <p className="iv-muted">面完趁还记得，把被问到的题记下来。可以手写，也可以录音。</p>
        <button type="button" onClick={create} className="iv-primary mt-3"><Plus size={16} aria-hidden="true" /> 新建复盘</button>
      </div>
    );
  } else {
    const stuckCount = stuckQuestions(reviews).length;
    body = (
      <div className="iv-review">
        <nav aria-label="复盘列表" className="min-w-0">
          <div className="iv-review-nav">
            <button type="button" onClick={create} className="iv-review-nav-item iv-review-new text-[length:var(--ou-type-sm)] font-medium text-[var(--ou-text-secondary)]" data-testid="review-new">
              <Plus size={15} aria-hidden="true" /> 新建复盘
            </button>
            <button type="button" onClick={() => router.push("/interview/review?view=weak")} aria-current={weakView ? "page" : undefined} className="iv-review-nav-item" data-testid="review-weak-link">
              {weakView && <motion.span layoutId="iv-review-hl" className="iv-highlight" transition={SPRING} aria-hidden="true" />}
              <span className="flex items-center justify-between gap-3 text-[length:var(--ou-type-body)] font-semibold">反复卡住的题<span className="iv-meta font-normal tabular-nums">{stuckCount || ""}</span></span>
            </button>
            <span className="iv-review-sep" aria-hidden="true" />
            {reviews.map((review) => {
              const active = !weakView && review.id === current.id;
              const outcome = OUTCOMES.find((o) => o.id === review.outcome)?.label;
              return (
                <button key={review.id} type="button" onClick={() => select(review.id)} aria-current={active ? "page" : undefined} className="iv-review-nav-item">
                  {active && <motion.span layoutId="iv-review-hl" className="iv-highlight" transition={SPRING} aria-hidden="true" />}
                  <span className="block truncate text-[length:var(--ou-type-body)] font-medium">{reviewTitle(review)}</span>
                  <span className="iv-meta mt-0.5 block truncate">{[formatDay(review.interviewed_on), outcome].filter(Boolean).join(" · ")}</span>
                </button>
              );
            })}
          </div>
        </nav>
        {weakView ? <WeakSpots reviews={reviews} /> : <Editor key={current.id} review={current} onChange={update} onDelete={() => remove(current)} />}
      </div>
    );
  }

  return (
    <div className="iv-page-wide space-y-6">
      <PageHeader
        title="复盘"
        description="每场真实面试一页：被问到什么、怎么答的、卡在哪。"
        actions={saveState && <span className="iv-meta" role="status" data-testid="review-save-state">{saveState === "saving" ? "正在保存…" : "已保存"}</span>}
      />
      {error && reviews && <p className="iv-alert">{error}</p>}
      {body}
    </div>
  );
}
