"use client";

// =============================================
// Built-in Ask（Proposal v2）
// Agent 在需要偏好/策略输入时持久化 AgentInputRequest；
// 这里渲染结构化选项 + 自由文本，回答经普通 POST 提交
// （不是授权，不走桌面审批 token），随后同一 Run 继续。
// =============================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HelpCircle, Loader2, RefreshCw } from "lucide-react";
import { agentRuntimeApi } from "@/lib/api";
import {
  normalizeInputRequest,
  type AgentInputAnswerResult,
  type AgentInputRequestView,
} from "@/lib/agentAsk";
import { safeClientErrorMessage } from "@/lib/safe-error";

const REFRESH_INTERVAL_MS = 4000;

/** 推荐项预选；单选只取第一个推荐项，多选不超过上限。 */
export function initialSelection(request: AgentInputRequestView): string[] {
  const recommended = (request.options || [])
    .filter((option) => option.recommended)
    .map((option) => option.option_id);
  if (request.selection_mode !== "multiple") return recommended.slice(0, 1);
  return request.max_selections > 0 ? recommended.slice(0, request.max_selections) : recommended;
}

export function AgentAskCard({
  request,
  runId,
  onAnswered,
}: {
  request: AgentInputRequestView;
  runId: string;
  /** 提交成功后调用；参数为后端回答响应（可能含 continuation）。 */
  onAnswered?: (result: AgentInputAnswerResult) => void;
}) {
  const [selected, setSelected] = useState<string[]>(() => initialSelection(request));
  const [freeText, setFreeText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [answered, setAnswered] = useState(false);
  const [error, setError] = useState("");
  // 每个请求固定一个 answer_id，重试与重复提交保持幂等。
  const answerId = useMemo(() => crypto.randomUUID(), [request.request_id]);

  const options = request.options || [];
  const isSingle = request.selection_mode !== "multiple";
  const maxSelections = isSingle ? 1 : request.max_selections || 0;
  const minSelections = Math.max(request.min_selections || 0, 1);
  const hasFreeText = request.allow_free_text && freeText.trim().length > 0;
  const canSubmit =
    !submitting
    && !answered
    && (selected.length >= minSelections || hasFreeText);
  const atMax = !isSingle && maxSelections > 0 && selected.length >= maxSelections;

  const chooseOption = (optionId: string) => {
    setSelected((current) => {
      if (isSingle) return [optionId];
      if (current.includes(optionId)) return current.filter((id) => id !== optionId);
      if (maxSelections > 0 && current.length >= maxSelections) return current;
      return [...current, optionId];
    });
  };

  const submit = async (skip = false) => {
    if (skip ? submitting || answered || !request.allow_skip : !canSubmit) return;
    setSubmitting(true);
    setError("");
    try {
      const result = await agentRuntimeApi.answerInputRequest(runId, request.request_id, {
        answer_id: answerId,
        selected_option_ids: skip ? [] : selected,
        free_text: skip ? "" : freeText.trim(),
        ...(skip ? { skipped: true } : {}),
      });
      if (result.ok === false || result.errors?.length) {
        throw new Error(result.errors?.join("；") || "回答未能保存");
      }
      setAnswered(true);
      onAnswered?.(result);
    } catch (err) {
      setError(safeClientErrorMessage(err, "提交回答失败"));
    } finally {
      setSubmitting(false);
    }
  };

  if (answered) {
    return (
      <section
        aria-label={`已回答：${request.question}`}
        className="agent-card px-3 py-2 text-[12px] text-[var(--foreground-soft)]"
      >
        已提交回答；OfferU 正在继续当前任务。
      </section>
    );
  }

  return (
    <section
      aria-label={`助手提问：${request.question}`}
      className="agent-ask space-y-2 px-3 py-2.5"
    >
      <div className="flex items-start gap-1.5">
        <HelpCircle size={14} className="mt-0.5 shrink-0 text-[var(--foreground)]" />
        <div className="min-w-0">
          <p className="text-[12.5px] font-semibold leading-5 text-[var(--foreground)]">
            {request.question}
          </p>
          {request.reason && (
            <p className="mt-0.5 text-[10.5px] leading-4 text-[var(--foreground-muted)]">
              {request.reason}
            </p>
          )}
        </div>
      </div>

      {options.length > 0 && (
        <fieldset className="space-y-0.5">
          <legend className="sr-only">
            {isSingle
              ? "单选"
              : maxSelections > 0
                ? `多选，最多 ${maxSelections} 项`
                : "多选"}
          </legend>
          {!isSingle && (
            <p className="text-[10.5px] leading-4 text-[var(--foreground-muted)]">
              可多选{maxSelections > 0 ? `，最多 ${maxSelections} 项` : ""}
              {request.min_selections > 1 ? `，至少 ${request.min_selections} 项` : ""}
            </p>
          )}
          {options.map((option) => {
            const checked = selected.includes(option.option_id);
            const disabled = !checked && atMax;
            return (
              <label
                key={option.option_id}
                className={`agent-ask-option flex cursor-pointer items-start gap-2 rounded-md px-2 py-1 text-[12px] leading-5 transition-colors ${
                  checked
                    ? "bg-white/80 text-[var(--foreground)] ring-1 ring-[var(--border-strong)]"
                    : "text-[var(--foreground-soft)] hover:bg-white/50"
                }`}
              >
                <input
                  type={isSingle ? "radio" : "checkbox"}
                  name={isSingle ? `ask-${request.request_id}` : undefined}
                  className="mt-[5px] accent-[var(--foreground)]"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => chooseOption(option.option_id)}
                />
                <span>
                  <span className="font-medium">{option.label}</span>
                  {option.recommended && (
                    <span className="ml-1.5 rounded-sm border border-[var(--border)] px-1 text-[10px] text-[var(--foreground-muted)]">
                      推荐
                    </span>
                  )}
                  {option.description && (
                    <span className="block text-[10.5px] text-[var(--foreground-muted)]">
                      {option.description}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </fieldset>
      )}

      {request.allow_free_text && (
        <textarea
          aria-label={`自由回答：${request.question}`}
          value={freeText}
          onChange={(event) => setFreeText(event.target.value)}
          rows={2}
          placeholder={options.length > 0 ? "其他 / 补充说明（可选）" : "输入你的回答…"}
          className="w-full rounded-md border border-[var(--border)] bg-white/70 px-2 py-1.5 text-[12px] leading-5 text-[var(--foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--foreground)]"
        />
      )}

      {error && (
        <p role="alert" className="text-[11px] leading-4 text-[var(--primary-red)]">
          {error}
        </p>
      )}

      <div className="flex items-center justify-end gap-2">
        {request.allow_skip && (
          <button
            type="button"
            aria-label={`跳过：${request.question}`}
            disabled={submitting}
            onClick={() => void submit(true)}
            className="text-[11px] text-[var(--foreground-muted)] underline-offset-2 hover:text-[var(--foreground)] hover:underline disabled:opacity-50"
          >
            跳过，让 OfferU 按推荐继续
          </button>
        )}
        <button
          type="button"
          aria-label={`提交回答：${request.question}`}
          disabled={!canSubmit}
          onClick={() => void submit()}
          className="bauhaus-button bauhaus-button-red !min-h-7 !justify-center !px-2.5 !py-0.5 !text-[11px] disabled:opacity-50"
        >
          {submitting ? <Loader2 size={12} className="animate-spin" /> : null}
          提交回答
        </button>
      </div>
    </section>
  );
}

/**
 * 轮询某个 Run 的待答 Ask 请求并渲染回答卡片；
 * 回答成功后通过 onChanged 让父级继续跟踪同一个 Run。
 */
export function AgentAskPanel({
  runId,
  onAnswered,
  onPendingChange,
}: {
  runId: string;
  onAnswered?: (result: AgentInputAnswerResult) => void;
  /** 待答数量变化时通知父级，用于呈现任务状态；普通对话仍保持可用。 */
  onPendingChange?: (pending: number) => void;
}) {
  const [requests, setRequests] = useState<AgentInputRequestView[]>([]);
  const [error, setError] = useState("");
  const loadingRef = useRef(false);
  const mountedRef = useRef(false);
  const onPendingChangeRef = useRef(onPendingChange);
  onPendingChangeRef.current = onPendingChange;

  const setPending = useCallback((items: AgentInputRequestView[]) => {
    setRequests(items);
    onPendingChangeRef.current?.(items.length);
  }, []);

  const load = useCallback(async (quiet = true) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const result = await agentRuntimeApi.inputRequestsPending(runId);
      if (!mountedRef.current) return;
      const items = (result.requests || [])
        .map(normalizeInputRequest)
        .filter((item) => item.status === "pending");
      setPending(items);
      setError("");
    } catch (err) {
      if (mountedRef.current) setError(safeClientErrorMessage(err, "待回答问题暂时无法读取"));
    } finally {
      loadingRef.current = false;
    }
    void quiet;
  }, [runId, setPending]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    const refresh = () => {
      if (document.visibilityState !== "hidden") void load();
    };
    const timer = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      onPendingChangeRef.current?.(0);
    };
  }, [load]);

  if (requests.length === 0 && !error) return null;

  return (
    <div className="agent-bar space-y-1.5 border-t border-[var(--border)] px-3.5 py-2.5">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold text-[var(--foreground)]">
          助手需要你确认偏好后继续
        </p>
        <button
          type="button"
          aria-label="刷新待回答问题"
          onClick={() => void load(false)}
          className="rounded-md p-1 text-[var(--foreground-muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]"
        >
          <RefreshCw size={12} />
        </button>
      </div>
      {error && (
        <p role="alert" className="rounded-md border border-[var(--status-blush)] bg-[var(--status-blush)]/40 px-2 py-1 text-[11px] text-[var(--primary-red)]">
          {error}
        </p>
      )}
      {requests.map((request) => (
        <AgentAskCard key={request.request_id} request={request} runId={runId} onAnswered={onAnswered} />
      ))}
    </div>
  );
}
