"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Check, Sparkles } from "lucide-react";
import { submitInterviewDebrief, type CareerTask } from "@/lib/hooks";
import { safeClientErrorMessage } from "@/lib/safe-error";

type BriefingQuestion = {
  question?: string;
  why_needed?: string;
  unlocks?: string;
};

type InterviewLifecycle = {
  mode?: "prepare" | "debrief" | "learning_review";
  calendar_event_id?: number;
  summary?: string;
  focus_areas?: string[];
  practice_questions?: string[];
  learning_candidates?: Array<{ title?: string; summary?: string }>;
};

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function InterviewLifecycleCard({
  task,
  onSubmitted,
}: {
  task: CareerTask;
  onSubmitted?: () => void;
}) {
  const input = isObject(task.input) ? task.input : {};
  const result = isObject(task.result) ? task.result : {};
  const briefing = isObject(result.briefing) ? result.briefing : {};
  const lifecycle = isObject(briefing.interview_lifecycle)
    ? briefing.interview_lifecycle as InterviewLifecycle
    : null;
  const eventType = String(input.event_type || "");
  const calendarEventId = Number(input.calendar_event_id || lifecycle?.calendar_event_id || 0);
  const questions = Array.isArray(briefing.questions)
    ? briefing.questions as BriefingQuestion[]
    : [];
  const actions = Array.isArray(briefing.actions)
    ? briefing.actions as Array<Record<string, any>>
    : [];
  const [answers, setAnswers] = useState<string[]>(() => questions.map(() => ""));
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  const questionKey = questions.map((question) => String(question.question || "")).join("\u0000");

  useEffect(() => {
    setAnswers((current) => current.length === questions.length
      ? current
      : questions.map(() => ""));
  }, [task.task_id, questionKey, questions.length]);

  if (!eventType.startsWith("INTERVIEW_") || !calendarEventId) return null;

  const active = task.status === "queued" || task.status === "running";
  const mode = lifecycle?.mode;
  const title = mode === "prepare"
    ? "OfferU 为这场面试准备了什么"
    : mode === "debrief"
      ? "花几分钟回顾这场面试"
      : mode === "learning_review"
        ? "面试学习候选已整理"
        : "面试任务状态";

  const handleSubmit = async () => {
    setSubmitting(true);
    setError("");
    try {
      await submitInterviewDebrief(calendarEventId, answers);
      setSubmitted(true);
      onSubmitted?.();
    } catch (submitError) {
      setError(safeClientErrorMessage(submitError, "复盘暂时没有提交成功，请稍后重试"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section
      className="rounded-xl border border-[var(--primary-yellow)]/40 bg-[var(--surface)] p-4"
      data-testid="interview-lifecycle-card"
      aria-labelledby={`interview-lifecycle-${task.task_id}`}
    >
      <div className="flex items-start gap-2">
        <Sparkles size={15} className="mt-0.5 shrink-0 text-[var(--primary-yellow)]" />
        <div className="min-w-0 flex-1">
          <h3 id={`interview-lifecycle-${task.task_id}`} className="text-[13px] font-semibold text-[var(--foreground)]">
            {title}
          </h3>
          <p className="mt-1 text-[12px] leading-5 text-[var(--foreground-muted)]">
            {lifecycle?.summary || briefing.situation_summary || "OfferU 正在结合岗位和职业证据整理面试下一步。"}
          </p>
        </div>
      </div>

      {active && (
        <p className="mt-3 text-[12px] text-[var(--foreground-muted)]">
          {task.error || "职业 Agent 正在读取这场面试的岗位背景和相关学习…"}
        </p>
      )}
      {(task.status === "failed" || task.status === "blocked") && (
        <p role="alert" className="mt-3 flex items-center gap-2 text-[12px] text-[var(--primary-red)]">
          <AlertTriangle size={13} /> {task.error || "这次面试分析没有完成。"}
        </p>
      )}

      {mode === "prepare" && (
        <div className="mt-3 space-y-3">
          {actions.map((action, index) => (
            <div key={String(action.dedupe_key || index)} className="rounded-lg border border-[var(--border)] p-3">
              <p className="text-[12px] font-semibold text-[var(--foreground)]">{String(action.objective || "准备重点")}</p>
              <p className="mt-1 text-[12px] leading-5 text-[var(--foreground-muted)]">为什么现在：{String(action.why_now || "")}</p>
              <p className="mt-1 text-[11px] leading-5 text-[var(--foreground-muted)]">预期结果：{String(action.expected_outcome || "")}</p>
            </div>
          ))}
          {lifecycle?.focus_areas?.length ? (
            <div>
              <p className="text-[11px] font-semibold text-[var(--foreground)]">建议聚焦</p>
              <ul className="mt-1 list-disc space-y-1 pl-4 text-[12px] text-[var(--foreground-muted)]">
                {lifecycle.focus_areas.map((focus, index) => <li key={`${index}-${focus}`}>{focus}</li>)}
              </ul>
            </div>
          ) : null}
          {lifecycle?.practice_questions?.length ? (
            <div className="rounded-lg bg-[var(--surface-muted)] p-3">
              <p className="text-[11px] font-semibold text-[var(--foreground)]">可以先练习</p>
              {lifecycle.practice_questions.map((question, index) => (
                <p key={`${index}-${question}`} className="mt-1 text-[12px] leading-5 text-[var(--foreground-muted)]">{question}</p>
              ))}
            </div>
          ) : null}
        </div>
      )}

      {mode === "debrief" && (
        <div className="mt-3 space-y-3">
          {submitted ? (
            <p className="flex items-center gap-2 text-[12px] font-medium text-[var(--foreground)]">
              <Check size={14} className="text-[var(--primary-blue)]" /> 已提交，OfferU 正在整理学习候选。
            </p>
          ) : (
            <>
              {questions.map((question, index) => (
                <label key={`${index}-${question.question || "question"}`} className="block">
                  <span className="block text-[12px] font-semibold text-[var(--foreground)]">
                    {question.question || `复盘问题 ${index + 1}`}
                  </span>
                  {question.why_needed ? (
                    <span className="mt-0.5 block text-[11px] leading-5 text-[var(--foreground-muted)]">{question.why_needed}</span>
                  ) : null}
                  <textarea
                    value={answers[index] || ""}
                    onChange={(event) => setAnswers((current) => current.map((value, itemIndex) => itemIndex === index ? event.target.value : value))}
                    maxLength={5000}
                    rows={2}
                    className="mt-1 w-full rounded-lg border border-[var(--border)] bg-white px-3 py-2 text-[12px] leading-5 text-[var(--foreground)] outline-none focus:border-[var(--foreground-muted)]"
                  />
                </label>
              ))}
              {error ? <p role="alert" className="text-[12px] text-[var(--primary-red)]">{error}</p> : null}
              <button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={submitting || !answers.some((answer) => answer.trim())}
                className="bauhaus-button bauhaus-button-yellow !px-3 !py-2 !text-[11px] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? "提交中…" : "整理复盘学习"}
              </button>
            </>
          )}
        </div>
      )}

      {mode === "learning_review" && (
        <div className="mt-3 space-y-2">
          {lifecycle?.learning_candidates?.length ? (
            lifecycle.learning_candidates.map((candidate, index) => (
              <div key={`${index}-${candidate.title || "learning"}`} className="rounded-lg border border-[var(--border)] p-3">
                <p className="text-[12px] font-semibold text-[var(--foreground)]">{candidate.title || "学习候选"}</p>
                <p className="mt-1 text-[12px] leading-5 text-[var(--foreground-muted)]">{candidate.summary || ""}</p>
              </div>
            ))
          ) : (
            <p className="text-[12px] text-[var(--foreground-muted)]">这次复盘没有形成有直接回答证据的学习候选。</p>
          )}
          <p className="text-[11px] text-[var(--foreground-muted)]">候选仅作为职业假设；不会自动写入已验证档案。</p>
          <Link href="/profile" className="inline-flex text-[12px] font-semibold text-[var(--foreground)] underline underline-offset-2">
            在个人资料中查看并审核
          </Link>
        </div>
      )}
    </section>
  );
}
