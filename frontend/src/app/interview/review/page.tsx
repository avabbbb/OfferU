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
import { Mic, Plus, Square, Trash2, Upload, X } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { safeClientErrorMessage } from "@/lib/safe-error";
import {
  createReview,
  deleteReview,
  emptyQuestion,
  extractQuestions,
  listReviews,
  saveReview,
  transcribeAudio,
  type InterviewReview,
  type ReviewOutcome,
  type ReviewQuestion,
} from "@/lib/interviewReviews";

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
function Field({ value, onChange, placeholder, className = "", label }: { value: string; onChange: (v: string) => void; placeholder: string; className?: string; label: string }) {
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
      className={`block w-full resize-none overflow-hidden bg-transparent leading-relaxed text-[var(--foreground)] outline-none placeholder:text-[var(--foreground-faint)] ${className}`}
    />
  );
}

function QuestionBlock({ index, item, onChange, onRemove, practiceHref }: { index: number; item: ReviewQuestion; onChange: (next: ReviewQuestion) => void; onRemove: () => void; practiceHref: string | null }) {
  const set = (key: keyof ReviewQuestion) => (value: string) => onChange({ ...item, [key]: value });
  const row = (label: string, key: keyof ReviewQuestion, placeholder: string) => (
    <div className="grid grid-cols-[96px_1fr] gap-3 py-1">
      <span className="pt-[3px] text-[12.5px] text-[var(--foreground-muted)]">{label}</span>
      <Field label={label} value={item[key]} onChange={set(key)} placeholder={placeholder} className="text-[14px]" />
    </div>
  );
  return (
    <li className="group border-t border-[var(--border)] py-4 first:border-t-0" data-testid="review-question">
      <div className="flex items-start gap-3">
        <span className="w-5 shrink-0 pt-[2px] text-[13px] tabular-nums text-[var(--foreground-faint)]">{index + 1}</span>
        <div className="min-w-0 flex-1">
          <Field label={`第 ${index + 1} 题`} value={item.question} onChange={set("question")} placeholder="面试官问了什么" className="text-[15px] font-medium" />
          <div className="mt-2">
            {row("我怎么答的", "answer", "当时说了哪些要点")}
            {row("卡在哪", "reflection", "哪里没答好，下次怎么说")}
            {row("面试官反应", "reaction", "追问、打断、点头……")}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          {practiceHref && item.question.trim() && (
            <Link href={practiceHref} className="rounded-md px-2 py-1 text-[12.5px] text-[var(--foreground-muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]">练这题</Link>
          )}
          <button type="button" onClick={onRemove} aria-label={`删除第 ${index + 1} 题`} className="grid h-7 w-7 place-items-center rounded-md text-[var(--foreground-muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]"><X size={14} /></button>
        </div>
      </div>
    </li>
  );
}

/** 录音 / 上传录音 / 粘贴文字 → 原文 → 拆成题。 */
function TranscriptPanel({ transcript, onTranscript, onQuestions }: { transcript: string; onTranscript: (text: string) => void; onQuestions: (items: ReviewQuestion[]) => void }) {
  const [open, setOpen] = useState(Boolean(transcript));
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
    setBusy("transcribe"); setError(""); setOpen(true);
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
      setOpen(true);
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

  const quiet = "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] text-[var(--foreground-muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)] disabled:opacity-40";
  return (
    <section className="rounded-xl border border-[var(--border)] px-4 py-3" data-testid="review-transcript">
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-2 text-[13px] font-medium text-[var(--foreground)]">从录音整理</span>
        {recording ? (
          <button type="button" className={quiet} onClick={() => recorderRef.current?.stop()}>
            <Square size={13} className="fill-current" /> 停止并转写 · {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
          </button>
        ) : (
          <button type="button" className={quiet} onClick={startRecording} disabled={Boolean(busy)}><Mic size={14} /> 录音</button>
        )}
        <button type="button" className={quiet} onClick={() => fileRef.current?.click()} disabled={Boolean(busy) || recording}><Upload size={14} /> 上传录音</button>
        {!open && <button type="button" className={quiet} onClick={() => setOpen(true)}>粘贴文字</button>}
        <input ref={fileRef} type="file" accept="audio/*,.m4a,.mp3,.wav,.webm" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void transcribe(file, file.name); }} />
        {busy === "transcribe" && <span className="text-[12.5px] text-[var(--foreground-muted)]">正在转写…</span>}
      </div>
      {open && (
        <div className="mt-3 border-t border-[var(--border)] pt-3">
          <textarea
            aria-label="面试原文"
            value={transcript}
            onChange={(event) => onTranscript(event.target.value)}
            placeholder="把录音转写或面试笔记贴在这里，例如飞书妙记、通义听悟导出的文字。"
            className="h-40 w-full resize-y bg-transparent text-[13.5px] leading-relaxed text-[var(--foreground)] outline-none placeholder:text-[var(--foreground-faint)]"
          />
          <div className="flex items-center justify-between gap-3">
            <p className="text-[12px] text-[var(--foreground-faint)]">录音转完文字就删除，只保留原文。</p>
            <button type="button" onClick={extract} disabled={!transcript.trim() || Boolean(busy)} className="rounded-md border border-[var(--border-strong)] px-3 py-1.5 text-[13px] font-medium text-[var(--foreground)] hover:bg-[var(--surface-muted)] disabled:opacity-40" data-testid="review-extract">
              {busy === "extract" ? "正在拆题…" : "拆成题目"}
            </button>
          </div>
        </div>
      )}
      {error && <p className="mt-2 text-[12.5px] text-[var(--danger,#b42318)]">{error}</p>}
    </section>
  );
}

function Editor({ review, onChange, onDelete }: { review: InterviewReview; onChange: (next: InterviewReview) => void; onDelete: () => void }) {
  const set = <K extends keyof InterviewReview>(key: K, value: InterviewReview[K]) => onChange({ ...review, [key]: value });
  const setQuestion = (index: number, next: ReviewQuestion) => set("questions", review.questions.map((q, i) => (i === index ? next : q)));
  const practice = (indexes?: number[]) => {
    const picked = (indexes ?? review.questions.map((_, i) => i)).filter((i) => review.questions[i]?.question.trim());
    return picked.length ? `/interview/ai?review=${review.id}&q=${picked.slice(0, 10).join(",")}` : null;
  };
  const allPractice = practice();
  const meta = "bg-transparent text-[13.5px] text-[var(--foreground)] outline-none placeholder:text-[var(--foreground-faint)]";

  return (
    <article className="min-w-0 flex-1" data-testid="review-editor">
      <div className="flex items-start justify-between gap-4">
        <input aria-label="公司" value={review.company} onChange={(e) => set("company", e.target.value)} placeholder="公司" style={{ fontSize: 22 }} className="min-w-0 flex-1 bg-transparent text-[22px] font-semibold tracking-tight text-[var(--foreground)] outline-none placeholder:text-[var(--foreground-faint)]" />
        <div className="flex shrink-0 items-center gap-1">
          {allPractice && <Link href={allPractice} className="rounded-md border border-[var(--border-strong)] px-3 py-1.5 text-[13px] font-medium text-[var(--foreground)] hover:bg-[var(--surface-muted)]" data-testid="review-practice-all">模拟练习这 {Math.min(10, review.questions.filter((q) => q.question.trim()).length)} 题</Link>}
          <button type="button" onClick={onDelete} aria-label="删除这场复盘" title="删除这场复盘" className="grid h-8 w-8 place-items-center rounded-md text-[var(--foreground-muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]"><Trash2 size={15} /></button>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-[var(--foreground-muted)]">
        <input aria-label="岗位" value={review.role} onChange={(e) => set("role", e.target.value)} placeholder="岗位" className={`${meta} w-44`} />
        <input aria-label="轮次" value={review.round_label} onChange={(e) => set("round_label", e.target.value)} placeholder="一面 / 二面 / HR 面" list="review-rounds" className={`${meta} w-32`} />
        <datalist id="review-rounds">{["一面", "二面", "三面", "HR 面", "终面", "笔试"].map((r) => <option key={r} value={r} />)}</datalist>
        <input aria-label="面试日期" type="date" value={review.interviewed_on ?? ""} onChange={(e) => set("interviewed_on", e.target.value || null)} className={`${meta} w-36`} />
        <div role="radiogroup" aria-label="结果" className="inline-flex rounded-lg bg-[var(--surface-muted)] p-0.5">
          {OUTCOMES.map((o) => (
            <button key={o.id} type="button" role="radio" aria-checked={review.outcome === o.id} onClick={() => set("outcome", o.id)} className={`rounded-md px-2.5 py-1 text-[12.5px] ${review.outcome === o.id ? "bg-[var(--surface)] font-medium text-[var(--foreground)] shadow-sm" : "text-[var(--foreground-muted)]"}`}>{o.label}</button>
          ))}
        </div>
      </div>

      <div className="mt-6">
        <TranscriptPanel
          transcript={review.transcript}
          onTranscript={(text) => set("transcript", text)}
          onQuestions={(items) => set("questions", [...review.questions.filter((q) => q.question.trim() || q.answer.trim()), ...items])}
        />
      </div>

      <h2 className="mt-8 text-[13px] font-medium text-[var(--foreground-muted)]">被问到的题</h2>
      <ol className="mt-1">
        {review.questions.map((item, index) => (
          <QuestionBlock key={index} index={index} item={item} onChange={(next) => setQuestion(index, next)} onRemove={() => set("questions", review.questions.filter((_, i) => i !== index))} practiceHref={practice([index])} />
        ))}
      </ol>
      <button type="button" onClick={() => set("questions", [...review.questions, emptyQuestion()])} className="mt-1 inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] text-[var(--foreground-muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]" data-testid="review-add-question">
        <Plus size={14} /> 添加一道题
      </button>

      <h2 className="mt-8 text-[13px] font-medium text-[var(--foreground-muted)]">整体感受</h2>
      <Field label="整体感受" value={review.summary} onChange={(v) => set("summary", v)} placeholder="这一轮整体怎么样，下次最想改的一件事" className="mt-2 text-[14px]" />
    </article>
  );
}

export default function InterviewReviewPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedId = Number(searchParams.get("id") || 0);
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
  if (!reviews) body = <p className="py-16 text-center text-[13px] text-[var(--foreground-muted)]">{error || "正在读取…"}</p>;
  else if (!current) {
    body = (
      <div className="grid min-h-[40vh] place-items-center text-center" data-testid="review-empty">
        <div>
          <p className="text-[15px] font-medium text-[var(--foreground)]">还没有复盘</p>
          <p className="mt-2 text-[13.5px] text-[var(--foreground-muted)]">面完趁还记得，把被问到的题记下来。可以手写，也可以录音。</p>
          <button type="button" onClick={create} className="mt-5 rounded-md bg-[var(--foreground)] px-3.5 py-2 text-[13px] font-medium text-[var(--surface)]">新建复盘</button>
        </div>
      </div>
    );
  } else {
    body = (
      <div className="flex gap-10">
        <aside className="w-56 shrink-0" aria-label="复盘列表">
          <button type="button" onClick={create} className="mb-2 inline-flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] text-[var(--foreground-muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]" data-testid="review-new">
            <Plus size={14} /> 新建复盘
          </button>
          <ul className="space-y-0.5">
            {reviews.map((review) => {
              const active = review.id === current.id;
              const outcome = OUTCOMES.find((o) => o.id === review.outcome)?.label;
              return (
                <li key={review.id}>
                  <button type="button" onClick={() => select(review.id)} aria-current={active ? "page" : undefined} className={`w-full rounded-md px-2.5 py-2 text-left ${active ? "bg-[var(--surface-muted)]" : "hover:bg-[var(--surface-muted)]"}`}>
                    <span className="block truncate text-[13.5px] font-medium text-[var(--foreground)]">{reviewTitle(review)}</span>
                    <span className="mt-0.5 block truncate text-[12px] text-[var(--foreground-muted)]">{[formatDay(review.interviewed_on), outcome].filter(Boolean).join(" · ")}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>
        <Editor key={current.id} review={current} onChange={update} onDelete={() => remove(current)} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="复盘"
        description="每场真实面试一页：被问到什么、怎么答的、卡在哪。答不好的题可以直接拿去模拟练。"
        actions={saveState && <span className="text-[12.5px] text-[var(--foreground-faint)]" data-testid="review-save-state">{saveState === "saving" ? "正在保存…" : "已保存"}</span>}
      />
      {error && reviews && <p className="text-[12.5px] text-[var(--danger,#b42318)]">{error}</p>}
      {body}
    </div>
  );
}
