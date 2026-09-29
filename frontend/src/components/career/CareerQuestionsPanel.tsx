"use client";

// =============================================
// 职业问题面板 —— OfferU 在准备过程中需要用户澄清的问题。
// 回答通过 POST /api/profile/career-questions/{task_id}/answers 保存为
// 待审核证据（status=pending），不直接写入已验证档案；被接受后触发
// onAccepted（例如刷新受影响提案）。所有状态都来自 GET 返回的持久化记录。
// =============================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Check, LoaderCircle, SendHorizonal } from "lucide-react";
import {
  careerQuestionsApi,
  type CareerQuestion,
  type CareerQuestionAnswer,
} from "@/lib/api";
import { safeClientErrorMessage } from "@/lib/safe-error";

const ANSWER_STATUS_LABELS: Record<string, string> = {
  pending: "待审核",
  deferred: "稍后处理",
  accepted: "已采纳",
  rejected: "已拒绝",
  revoked: "已撤销",
  invalidated: "已失效",
};

function answerStatusLabel(status: string | undefined): string {
  return ANSWER_STATUS_LABELS[status || ""] ?? status ?? "";
}

function isReusableAnswer(answer: CareerQuestionAnswer | null | undefined): boolean {
  return Boolean(answer && ["rejected", "revoked", "invalidated", "deferred"].includes(String(answer.status)));
}

interface QuestionRowProps {
  taskId: string;
  question: CareerQuestion;
  defaultProposalId?: string;
  onSubmitted(): void;
}

function CareerQuestionRow({ taskId, question, defaultProposalId, onSubmitted }: QuestionRowProps) {
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const answer = question.answer ?? null;
  const answered = Boolean(answer && answer.status);
  const editable = !answered || isReusableAnswer(answer);

  const submit = async () => {
    const text = draft.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      await careerQuestionsApi.submit(taskId, {
        question_index: question.question_index,
        answer: text,
        proposal_id: question.resume_proposal_id || defaultProposalId || undefined,
      });
      setDraft("");
      setEditing(false);
      onSubmitted();
    } catch (submitError) {
      setError(safeClientErrorMessage(submitError, "回答暂时没有保存成功，请稍后重试"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <article
      className="rounded-lg border border-[var(--border)] px-3 py-2.5"
      data-testid={`career-question-${question.question_index}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h4 className="text-[12.5px] font-medium leading-5 text-[var(--foreground)]">
          {question.question}
        </h4>
        <div className="flex shrink-0 items-center gap-1.5">
          {question.optional ? (
            <span className="rounded-full bg-[var(--surface-muted)] px-2 py-0.5 text-[10.5px] text-[var(--foreground-muted)]">可选</span>
          ) : null}
          {answered ? (
            <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${
              answer?.status === "accepted"
                ? "bg-[var(--status-sage)] text-[var(--primary-green)]"
                : answer?.status === "pending"
                  ? "bg-[var(--primary-yellow)]/15 text-[var(--primary-yellow)]"
                  : "bg-[var(--surface-muted)] text-[var(--foreground-muted)]"
            }`}>
              {answerStatusLabel(answer?.status)}
            </span>
          ) : null}
        </div>
      </div>

      {question.requirement ? (
        <p className="mt-1 text-[11.5px] leading-5 text-[var(--foreground-muted)]">
          岗位要求原文：{question.requirement}
        </p>
      ) : null}
      {question.why_needed ? (
        <p className="mt-1 text-[11.5px] leading-5 text-[var(--foreground-muted)]">
          想了解：{question.why_needed}
        </p>
      ) : null}
      {question.unlocks ? (
        <p className="mt-0.5 text-[11.5px] leading-5 text-[var(--foreground-muted)]">
          这会帮助我们：{question.unlocks}
        </p>
      ) : null}

      {answered ? (
        <div className="mt-2 rounded-md bg-[var(--surface-muted)]/60 px-3 py-2">
          <p className="text-[11.5px] font-medium text-[var(--foreground-muted)]">
            你的回答{answer?.status === "accepted" ? "（已纳入职业档案）" : answer?.status === "pending" ? "（已保存，等待审核）" : ""}
          </p>
          <p className="mt-1 whitespace-pre-wrap text-[12.5px] leading-5 text-[var(--foreground-soft)]">
            {answer?.answer}
          </p>
          {answer?.reviewed_at ? (
            <p className="mt-1 text-[10.5px] text-[var(--foreground-faint)]">
              审核于 {answer.reviewed_at}
            </p>
          ) : null}
        </div>
      ) : null}

      {editable ? (
        <div className="mt-2">
          {(editing || !answered) ? (
            <>
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                maxLength={5000}
                rows={2}
                placeholder="写下事实性回答；会作为待审核证据保存，不会自动写进档案。"
                aria-label={`回答：${question.question}`}
                className="w-full rounded-md border border-[var(--border-strong)]/20 bg-[var(--surface)] px-3 py-2 text-[12.5px] leading-5 text-[var(--foreground)] outline-none focus:border-[var(--primary-blue)]"
              />
              {error ? (
                <p role="alert" className="mt-1 flex items-center gap-1.5 text-[11.5px] text-[var(--primary-red)]">
                  <AlertCircle size={12} /> {error}
                </p>
              ) : null}
              <div className="mt-1.5 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={submitting || !draft.trim()}
                  className="inline-flex items-center gap-1.5 rounded-md bg-[var(--foreground)] px-2.5 py-1.5 text-[11.5px] font-medium text-white transition-colors hover:bg-[var(--foreground-soft)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {submitting ? <LoaderCircle size={12} className="animate-spin" /> : <SendHorizonal size={12} />}
                  保存回答
                </button>
                {answered && editing ? (
                  <button
                    type="button"
                    onClick={() => { setEditing(false); setDraft(""); setError(""); }}
                    className="rounded px-2 py-1.5 text-[11.5px] font-medium text-[var(--foreground-muted)] hover:bg-[var(--surface-muted)]"
                  >
                    取消
                  </button>
                ) : null}
              </div>
            </>
          ) : (
            <button
              type="button"
              onClick={() => { setDraft(answer?.answer || ""); setEditing(true); }}
              className="rounded px-2 py-1 text-[11.5px] font-medium text-[var(--accent-clay)] hover:bg-[var(--surface-muted)]"
            >
              修改回答
            </button>
          )}
        </div>
      ) : null}
    </article>
  );
}

export function CareerQuestionsPanel({
  taskId,
  proposalId,
  heading = "OfferU 想确认",
  onAccepted,
  fallback,
}: {
  taskId: string;
  /** 默认简历提案 id（问题自身未携带 resume_proposal_id 时使用）。 */
  proposalId?: string;
  heading?: string;
  /** 有回答被审核接受后触发（用于刷新受影响提案等）。 */
  onAccepted?: () => void;
  /** 后端没有返回问题时渲染的只读回退（例如简报内嵌问题）。 */
  fallback?: React.ReactNode;
}) {
  const [questions, setQuestions] = useState<CareerQuestion[] | null>(null);
  const [error, setError] = useState("");
  const acceptedSeenRef = useRef<Set<number>>(new Set());
  const submittedRef = useRef(false);

  const reload = useCallback(async () => {
    if (!taskId) return;
    try {
      const response = await careerQuestionsApi.list(taskId);
      const list = Array.isArray(response.questions) ? response.questions : [];
      setQuestions(list);
      setError("");
      const acceptedNow = new Set(
        list
          .filter((question) => question.answer?.status === "accepted")
          .map((question) => question.question_index),
      );
      // 只有"本次会话里新出现的 accepted"才触发刷新，避免挂载时误报。
      const hasNewlyAccepted = [...acceptedNow].some((index) => !acceptedSeenRef.current.has(index));
      if (submittedRef.current && hasNewlyAccepted) {
        onAccepted?.();
      }
      acceptedSeenRef.current = acceptedNow;
    } catch (loadError) {
      setError(safeClientErrorMessage(loadError, "问题列表暂时无法读取"));
      setQuestions((current) => current ?? []);
    }
  }, [taskId, onAccepted]);

  useEffect(() => {
    setQuestions(null);
    setError("");
    acceptedSeenRef.current = new Set();
    submittedRef.current = false;
    void reload();
  }, [reload]);

  const markSubmitted = useCallback(() => {
    submittedRef.current = true;
    void reload();
  }, [reload]);

  const content = useMemo(() => {
    if (questions === null) {
      return (
        <p className="flex items-center gap-2 text-[12px] text-[var(--foreground-muted)]">
          <LoaderCircle size={13} className="animate-spin" /> 正在读取待确认问题…
        </p>
      );
    }
    if (questions.length === 0) return null;
    return (
      <div className="space-y-2">
        {questions.map((question) => (
          <CareerQuestionRow
            key={question.question_index}
            taskId={taskId}
            question={question}
            defaultProposalId={proposalId}
            onSubmitted={markSubmitted}
          />
        ))}
      </div>
    );
  }, [questions, taskId, proposalId, markSubmitted]);

  if (questions !== null && questions.length === 0 && !error) return <>{fallback ?? null}</>;

  return (
    <section
      data-testid="career-questions-panel"
      className="rounded-lg bg-[var(--surface-muted)] px-3 py-2.5"
      aria-label={heading}
    >
      <p className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--foreground)]">
        <Check size={12} className="text-[var(--foreground-muted)]" /> {heading}
      </p>
      {error ? (
        <p role="alert" className="mt-1 flex items-center gap-1.5 text-[11.5px] text-[var(--primary-red)]">
          <AlertCircle size={12} /> {error}
        </p>
      ) : null}
      <div className="mt-2">{content}</div>
    </section>
  );
}

export default CareerQuestionsPanel;
