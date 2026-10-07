"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import MarkdownIt from "markdown-it";
import { Button, Spinner } from "@heroui/react";
import { CheckCircle2, CircleAlert, FileText, MessageSquare, Play, RefreshCw, Square } from "lucide-react";
import { RunReviewPanel } from "@/components/workbench/RunReviewPanel";
import { agentRuntimeApi, type AgentRunRecord } from "@/lib/api";
import { safeClientErrorMessage } from "@/lib/safe-error";
import {
  resumeIdFromRun,
  runStatusLabel,
  tailorResumeGoal,
  tailorResumeTaskId,
} from "./runtimeTailorResume";

const md = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true,
  typographer: true,
});

function RenderedMarkdown({ content }: { content: string }) {
  const html = useMemo(() => md.render(content), [content]);
  return <div className="prose-chat" dangerouslySetInnerHTML={{ __html: html }} />;
}

interface OptimizeChatPanelProps {
  jobIds: number[];
  mode: "per_job" | "combined";
  disabled: boolean;
  blockedReason?: string;
  profileId: number | null;
  referenceResumeId: number | null;
  loadRunId?: string | null;
  onLoadRunConsumed?: () => void;
}

function BlockedHint({ reason }: { reason: string }) {
  if (reason === "profile") {
    return (
      <p className="text-sm text-[var(--foreground-muted)]">
        档案里还没有已确认的经历，AI 没有可用的事实。
        <Link href="/profile" className="ml-1 font-semibold text-[var(--foreground)] underline">去补充档案</Link>
      </p>
    );
  }
  if (reason === "job") {
    return <p className="text-sm text-[var(--foreground-muted)]">先在左侧选一个目标岗位。</p>;
  }
  return reason ? <p className="text-sm text-[var(--foreground-muted)]">{reason}</p> : null;
}

function eventMessage(event: { type: string; payload?: Record<string, any> }) {
  if (event.type !== "assistant.message") return "";
  const payload = event.payload || {};
  return String(payload.message || payload.content || payload.assistant_message || "").trim();
}

function finalAssistantMessage(run: AgentRunRecord | null) {
  const result = run?.final_result;
  if (!result || typeof result !== "object") return "";
  return String(result.assistant_message || result.message || result.summary || "").trim();
}

function statusHint(run: AgentRunRecord | null) {
  if (!run) return "";
  if (run.status === "waiting_input") return "需要一个真实取舍后才能继续；回答不会批准任何简历修改。";
  if (run.status === "waiting_decision" || run.status === "waiting_confirmation") return "修改已经进入独立审核；只有你的审核会产生采用回执。";
  if (run.status === "interrupted") return "Run 已持久化，可以从同一个 Run 恢复。";
  if (run.status === "failed") return run.failure_reason || "这次 Run 失败了；你可以查看原因后重新开始。";
  if (run.status === "blocked") return run.failure_reason || "当前能力或配置阻止了继续执行。";
  if (run.status === "completed") return "这个 Run 已结束。岗位专用简历和审核结果保留在同一个 Job Workspace。";
  return "Agent 正在读取岗位、档案与简历证据，并把结果物化到 Job Workspace。";
}

export function OptimizeChatPanel({
  jobIds,
  mode,
  disabled,
  blockedReason = "",
  profileId,
  referenceResumeId,
  loadRunId,
  onLoadRunConsumed,
}: OptimizeChatPanelProps) {
  const jobId = jobIds[0] ?? null;
  const [run, setRun] = useState<AgentRunRecord | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [loading, setLoading] = useState(false);
  const [progressLabel, setProgressLabel] = useState("");
  const [error, setError] = useState("");
  const [pollExhausted, setPollExhausted] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const pollCountRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  void mode;
  void profileId;

  const loadRun = useCallback(async (runId: string, includeEvents = false) => {
    try {
      const { run: nextRun } = await agentRuntimeApi.run(runId);
      setRun(nextRun);
      if (includeEvents) {
        const history = await agentRuntimeApi.events(runId, 0, AbortSignal.timeout(8000));
        const saved = (history.events || []).map(eventMessage).filter(Boolean);
        const finalMessage = finalAssistantMessage(nextRun);
        if (finalMessage && !saved.includes(finalMessage)) saved.push(finalMessage);
        setMessages(saved);
      } else {
        const finalMessage = finalAssistantMessage(nextRun);
        if (finalMessage) {
          setMessages((current) => current.includes(finalMessage) ? current : [...current, finalMessage]);
        }
      }
      setError("");
      return nextRun;
    } catch (err) {
      setError(safeClientErrorMessage(err, "读取 Runtime Run 失败"));
      return null;
    }
  }, []);

  useEffect(() => {
    if (!jobId) {
      setRun(null);
      setMessages([]);
      return;
    }
    let cancelled = false;
    const restore = async () => {
      const requestedRunId = loadRunId;
      try {
        if (requestedRunId) {
          if (!cancelled) await loadRun(requestedRunId, true);
          return;
        }
        const result = await agentRuntimeApi.runs({
          task_id: tailorResumeTaskId(jobId),
          limit: 1,
        });
        const latest = (result.runs || []).find((item) => item.skill_id === "tailor_resume");
        if (latest && !cancelled) await loadRun(latest.id, true);
      } catch (err) {
        if (!cancelled) setError(safeClientErrorMessage(err, "恢复上次简历定制失败"));
      } finally {
        if (!cancelled && requestedRunId) onLoadRunConsumed?.();
      }
    };
    void restore();
    return () => { cancelled = true; };
  }, [jobId, loadRunId, loadRun, onLoadRunConsumed]);

  useEffect(() => {
    if (!run || !["queued", "running"].includes(run.status)) {
      pollCountRef.current = 0;
      setPollExhausted(false);
      return;
    }
    const timer = window.setInterval(() => {
      if (pollCountRef.current >= 20) {
        window.clearInterval(timer);
        setPollExhausted(true);
        return;
      }
      pollCountRef.current += 1;
      void loadRun(run.id);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [run?.id, run?.status, loadRun]);

  useEffect(() => {
    const handler = (event: Event) => {
      const runId = String((event as CustomEvent<{ run_id?: string }>).detail?.run_id || "");
      if (!run?.id || runId !== run.id) return;
      void loadRun(run.id);
    };
    window.addEventListener("offeru-run-review-refresh", handler);
    return () => window.removeEventListener("offeru-run-review-refresh", handler);
  }, [run?.id, loadRun]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, streamingText, progressLabel, run?.status]);

  useEffect(() => () => {
    abortRef.current?.abort();
  }, []);

  const startRun = useCallback(async () => {
    if (!jobId || disabled || loading) return;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setLoading(true);
    setRun(null);
    setMessages([]);
    setStreamingText("");
    setProgressLabel("正在启动统一 Runtime Run…");
    setError("");
    try {
      const response = await agentRuntimeApi.start(
        {
          message: tailorResumeGoal(jobId, referenceResumeId),
          skill_id: "tailor_resume",
          task_id: tailorResumeTaskId(jobId),
        },
        (event, data) => {
          if (event === "assistant.delta" || event === "message.delta") {
            const delta = String(data?.payload?.delta || "");
            if (delta) {
              setProgressLabel("");
              setStreamingText((current) => current + delta);
            }
          } else if (event === "input.required") {
            setProgressLabel("需要你的一个取舍后继续…");
          } else if (event === "proposal.plan_ready" || event === "decision.plan_proposed" || event === "approval.requested") {
            setProgressLabel("改动组已生成，等待你审核…");
          } else if (event === "tool.started" || event === "operation.started") {
            setProgressLabel("正在读取或准备 OfferU 数据…");
          } else if (event === "stream.reconnecting") {
            setProgressLabel("连接中断，正在恢复同一个 Run…");
          }
        },
        controller.signal,
      );
      setRun(response.run);
      const finalMessage = String(response.assistant_message || "").trim();
      if (finalMessage) {
        setMessages((current) => current.includes(finalMessage) ? current : [...current, finalMessage]);
      }
      setStreamingText("");
      if (!response.ok) throw new Error(response.errors?.join("；") || "简历定制 Run 启动失败");
    } catch (err: any) {
      if (err?.name !== "AbortError") setError(safeClientErrorMessage(err, "简历定制失败"));
    } finally {
      setLoading(false);
      setProgressLabel("");
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [jobId, disabled, loading, referenceResumeId]);

  const stopRun = useCallback(async () => {
    abortRef.current?.abort();
    if (run?.id) {
      try {
        const result = await agentRuntimeApi.abort(run.id);
        setRun(result.run);
      } catch (err) {
        setError(safeClientErrorMessage(err, "取消 Run 失败"));
      }
    }
    setLoading(false);
    setProgressLabel("");
  }, [run?.id]);

  const resumeInterrupted = useCallback(async () => {
    if (!run?.id || loading) return;
    setLoading(true);
    setError("");
    try {
      const response = await agentRuntimeApi.resume(run.id);
      setRun(response.run);
      const message = String(response.assistant_message || "").trim();
      if (message) setMessages((current) => [...current, message]);
      if (!response.ok) throw new Error(response.errors?.join("；") || "恢复 Run 失败");
    } catch (err) {
      setError(safeClientErrorMessage(err, "恢复 Run 失败"));
    } finally {
      setLoading(false);
    }
  }, [run?.id, loading]);

  const handleReviewChanged = (result: { run?: { id?: string; status?: string } & Record<string, unknown>; continuation?: { assistant_message?: string } | null }) => {
    const continuationMessage = String(result.continuation?.assistant_message || "").trim();
    if (continuationMessage) setMessages((current) => [...current, continuationMessage]);
    if (run?.id) {
      window.setTimeout(() => void loadRun(run.id), 300);
      window.setTimeout(() => void loadRun(run.id), 1500);
    }
  };

  const resumeId = resumeIdFromRun(run);
  const waitingForReview = Boolean(run && ["waiting_decision", "waiting_confirmation"].includes(run.status));
  const terminalFailure = Boolean(run && ["failed", "blocked", "cancelled"].includes(run.status));

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--border)] px-5 py-2.5 text-xs">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${
            run?.status === "completed"
              ? "bg-[var(--primary-green)]"
              : terminalFailure
                ? "bg-[var(--primary-red)]"
                : run
                  ? "bg-[var(--primary-yellow)]"
                  : "bg-[var(--border-strong)]"
          }`} />
          <span className="font-semibold text-[var(--foreground)]">{run ? runStatusLabel(run.status) : "尚未开始"}</span>
          {run?.id && <span className="font-mono text-[10px] text-[var(--foreground-muted)]">{run.id}</span>}
        </div>
        {run?.id && (
          <button
            type="button"
            aria-label="刷新当前 Run"
            onClick={() => void loadRun(run.id, true)}
            className="rounded-md p-1.5 text-[var(--foreground-muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]"
          >
            <RefreshCw size={13} />
          </button>
        )}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-5 md:p-6 custom-scrollbar">
        {!run && messages.length === 0 && !loading ? (
          <div className="mx-auto flex min-h-64 max-w-lg flex-col items-center justify-center gap-4 text-center">
            <MessageSquare size={36} className="text-[var(--foreground-muted)]" />
            <div className="space-y-1">
              <p className="text-[15px] font-semibold text-[var(--foreground)]">用统一 Runtime 定制这个岗位的简历</p>
              <p className="text-sm leading-relaxed text-[var(--foreground-muted)]">
                这里不再启动第二套 Optimize Agent。一个 tailor_resume Run 会读取 Job / Profile / Resume，在确有取舍时用 Ask，最后把 section-level 修改交给 Proposal v2 审核。
              </p>
            </div>
            {blockedReason ? (
              <BlockedHint reason={blockedReason} />
            ) : (
              <Button
                className="bauhaus-button bauhaus-button-red"
                startContent={<Play size={16} />}
                onPress={() => void startRun()}
                isDisabled={disabled || !jobId}
              >
                开始定制
              </Button>
            )}
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-4">
            {run && (
              <section className="rounded-[10px] border border-[var(--border)] bg-[var(--surface-muted)] p-4">
                <p className="text-xs font-semibold text-[var(--foreground-muted)]">当前步骤</p>
                <p className="mt-1 text-sm font-semibold text-[var(--foreground)]">{runStatusLabel(run.status)}</p>
                <p className="mt-1 text-sm leading-relaxed text-[var(--foreground-soft)]">{statusHint(run)}</p>
              </section>
            )}

            {messages.map((message, index) => (
              <div key={`${index}-${message.slice(0, 24)}`} className="rounded-[10px] border border-[var(--border)] bg-white p-4 text-sm leading-relaxed text-[var(--foreground)]">
                <RenderedMarkdown content={message} />
              </div>
            ))}

            {streamingText && (
              <div className="rounded-[10px] border border-[var(--border)] bg-white p-4 text-sm leading-relaxed text-[var(--foreground)]">
                <RenderedMarkdown content={streamingText} />
              </div>
            )}

            {(loading || progressLabel) && (
              <div className="flex items-center gap-2 rounded-[10px] border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-3 text-sm text-[var(--foreground-muted)]">
                <Spinner size="sm" color="warning" />
                <span>{progressLabel || "Agent 正在处理…"}</span>
              </div>
            )}

            {run && (run.status === "waiting_input" || waitingForReview) && (
              <section className="overflow-hidden rounded-[10px] border border-[var(--border)] bg-white" data-testid="optimize-runtime-review">
                <div className="border-b border-[var(--border)] px-4 py-3">
                  <p className="text-sm font-semibold text-[var(--foreground)]">
                    {run.status === "waiting_input" ? "需要你做一个真实取舍" : "审核 section-level 改动组"}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-[var(--foreground-muted)]">
                    这里直接复用 Runtime 的 Ask / Proposal v2。Ask 只表达偏好，不批准修改；采用决定会生成持久 receipt，并让同一个 Run 继续。
                  </p>
                </div>
                <RunReviewPanel runId={run.id} onChanged={handleReviewChanged} />
              </section>
            )}

            {run?.status === "completed" && jobId && (
              <section className="rounded-[10px] border border-emerald-300 bg-emerald-50 p-4" data-testid="optimize-runtime-completed">
                <div className="flex items-start gap-3">
                  <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-emerald-700" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-emerald-950">定制 Run 已完成</p>
                    <p className="mt-1 text-xs leading-relaxed text-emerald-900">结果、Proposal receipt 和岗位专用简历都保留在 canonical Job Workspace；关闭 Desktop 后重新打开仍从 Runtime / Workspace 回读。</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Link href={`/jobs/${jobId}?focus=materials`} className="bauhaus-button bauhaus-button-sm bauhaus-button-red">回到 Job Workspace</Link>
                      {resumeId && (
                        <Link href={`/resume/${resumeId}`} className="bauhaus-button bauhaus-button-sm bauhaus-button-outline">
                          <FileText size={13} /> 打开岗位简历
                        </Link>
                      )}
                    </div>
                  </div>
                </div>
              </section>
            )}

            {run?.status === "interrupted" && (
              <section className="rounded-[10px] border border-[var(--border)] bg-[var(--surface-muted)] p-4">
                <p className="text-sm font-semibold text-[var(--foreground)]">这个 Run 被中断，但状态已保存。</p>
                <Button className="bauhaus-button bauhaus-button-red mt-3 !px-4 !py-2.5 !text-[12px]" onPress={() => void resumeInterrupted()} isLoading={loading}>
                  从同一个 Run 继续
                </Button>
              </section>
            )}

            {terminalFailure && (
              <section className="rounded-[10px] border border-red-300 bg-red-50 p-4">
                <div className="flex items-start gap-2">
                  <CircleAlert size={17} className="mt-0.5 shrink-0 text-red-700" />
                  <div>
                    <p className="text-sm font-semibold text-red-950">这一步没有完成</p>
                    <p className="mt-1 text-xs leading-relaxed text-red-900">{run?.failure_reason || "检查 Agent / Provider 配置后可以重新启动一次新的定制 Run；已写入的 Workspace 状态不会丢失。"}</p>
                  </div>
                </div>
                <div className="mt-3 flex gap-2">
                  <Link href="/settings" className="bauhaus-button bauhaus-button-sm bauhaus-button-outline">检查设置</Link>
                  <Button className="bauhaus-button bauhaus-button-red !px-3 !py-2 !text-[11px]" onPress={() => void startRun()} isLoading={loading}>重新开始</Button>
                </div>
              </section>
            )}

            {pollExhausted && run && ["queued", "running"].includes(run.status) && (
              <p className="text-xs text-[var(--foreground-muted)]">自动刷新已暂停，避免无限轮询。Run 仍保存在 Runtime；可使用右上角刷新读取最新状态。</p>
            )}

            {error && <p role="alert" className="rounded-[10px] border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>}
          </div>
        )}
      </div>

      {(loading || (run && ["queued", "running"].includes(run.status))) && (
        <div className="shrink-0 border-t border-[var(--border)] p-3">
          <button
            type="button"
            onClick={() => void stopRun()}
            className="flex w-full items-center justify-center gap-2 rounded-[9px] border border-[var(--border)] px-3 py-2.5 text-xs font-semibold text-[var(--foreground)] hover:bg-[var(--surface-muted)]"
          >
            <Square size={12} fill="currentColor" /> 停止当前 Run
          </button>
        </div>
      )}
    </div>
  );
}
