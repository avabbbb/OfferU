"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import MarkdownIt from "markdown-it";
import { Button } from "@heroui/react";
import { FileText, MessageSquare, Play, SendHorizonal, Square } from "lucide-react";
import { streamOptimizeAgentChat, OptimizeAgentStreamEvent, type OptimizeSessionDetail } from "@/lib/hooks";
import { request } from "@/lib/api";
import { cleanRichHtml } from "@/app/resume/components/templates/shared";
import { safeClientErrorMessage } from "@/lib/safe-error";

const md = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true,
  typographer: true,
});

function preprocessMarkdown(content: string): string {
  return content
    .replace(/\*\*\s+(.+?)\s+\*\*/g, "**$1**")
    .replace(/\*\s+(.+?)\s+\*/g, "*$1*");
}

interface Suggestion {
  type: string;
  section_title?: string;
  original: string;
  suggested: string;
  reason: string;
  injected_keywords?: string[];
  matched_jd_requirements?: string[];
  interview_reference?: string;
  diff?: {
    deleted: string[];
    added: string[];
  };
}

interface ConfirmRequestData {
  tool: string;
  args: Record<string, any>;
  summary: string;
  processed?: boolean;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  suggestions?: Suggestion[];
  resume_id?: number;
  proposal_id?: string;
  confirmRequest?: ConfirmRequestData;
}

interface OptimizeChatPanelProps {
  jobIds: number[];
  mode: "per_job" | "combined";
  disabled: boolean;
  /** "profile" | "job" | free text; explains why starting is not possible yet. */
  blockedReason?: string;
  profileId: number | null;
  referenceResumeId: number | null;
  loadSessionId?: string | null;
  onLoadSessionConsumed?: () => void;
}

const PHASES = [
  { key: "confirming", label: "确认目标" },
  { key: "analyzing", label: "分析差距" },
  { key: "framework", label: "确认框架" },
  { key: "rewriting", label: "逐段改写" },
  { key: "completed", label: "生成提案" },
];

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

function SuggestionCard({ suggestion, index }: { suggestion: Suggestion; index: number }) {
  const removed = suggestion.diff?.deleted?.length ? suggestion.diff.deleted : suggestion.original ? [suggestion.original] : [];
  const added = suggestion.diff?.added?.length ? suggestion.diff.added : suggestion.suggested ? [suggestion.suggested] : [];
  const requirements = suggestion.matched_jd_requirements || [];
  const keywords = suggestion.injected_keywords || [];
  return (
    <article className="overflow-hidden rounded-[10px] border border-[var(--border)] bg-white">
      <header className="flex items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2">
        <span className="text-xs font-semibold text-[var(--foreground)]">
          {String(index + 1).padStart(2, "0")} · {suggestion.section_title || "修改建议"}
        </span>
        {requirements.length > 0 && (
          <span className="truncate text-[11px] text-[var(--foreground-muted)]">对应 {requirements.length} 条岗位要求</span>
        )}
      </header>
      <div className="grid gap-px bg-[var(--border)] sm:grid-cols-2">
        <div className="bg-white p-3">
          <p className="mb-1 text-[11px] font-semibold text-[var(--foreground-muted)]">原文</p>
          {removed.length ? (
            removed.map((text, i) => (
              <p key={i} className="text-[13px] leading-relaxed text-[var(--foreground-muted)] line-through decoration-[var(--primary-red)]/40">{text}</p>
            ))
          ) : (
            <p className="text-[13px] text-[var(--foreground-muted)]">新增内容</p>
          )}
        </div>
        <div className="bg-[#f3f8f4] p-3">
          <p className="mb-1 text-[11px] font-semibold text-[#13804f]">建议改为</p>
          {added.map((text, i) => (
            <SafeHtmlContent key={i} content={text} className="prose-chat text-[13px] leading-relaxed text-[var(--foreground)]" />
          ))}
        </div>
      </div>
      {(suggestion.reason || requirements.length > 0 || keywords.length > 0) && (
        <footer className="space-y-1.5 border-t border-[var(--border)] px-3 py-2 text-[12px] leading-relaxed text-[var(--foreground-soft)]">
          {suggestion.reason && <p>{suggestion.reason}</p>}
          {(requirements.length > 0 || keywords.length > 0) && (
            <div className="flex flex-wrap gap-1">
              {requirements.map((item) => (
                <span key={`r-${item}`} className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[11px]">{item}</span>
              ))}
              {keywords.map((item) => (
                <span key={`k-${item}`} className="rounded-full bg-[var(--surface-muted)] px-2 py-0.5 text-[11px] text-[var(--foreground-muted)]">#{item}</span>
              ))}
            </div>
          )}
        </footer>
      )}
    </article>
  );
}

const QUICK_REPLIES: Record<string, string[]> = {
  confirming: ["目标没问题，继续", "我更想突出项目经历"],
  analyzing: ["先说最大的差距", "哪些要求我完全没有证据？"],
  framework: ["按这个框架继续", "把最相关的经历放到最前面"],
  rewriting: ["这段再量化一些", "语气更简洁", "这一段保持原样"],
};

let _msgCounter = 0;
function nextMsgId(): string {
  return `msg_${++_msgCounter}_${Date.now().toString(36)}`;
}

function RenderedMarkdown({ content }: { content: string }) {
  const html = useMemo(() => md.render(preprocessMarkdown(content)), [content]);
  return (
    <div
      className="prose-chat"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** Render sanitized HTML content (for diff added / suggested content) */
function SafeHtmlContent({ content, className }: { content: string; className?: string }) {
  const html = useMemo(() => cleanRichHtml(content), [content]);
  return (
    <div
      className={className}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function OptimizeChatPanel({ jobIds, mode, disabled, blockedReason = "", profileId, referenceResumeId, loadSessionId, onLoadSessionConsumed }: OptimizeChatPanelProps) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [phase, setPhase] = useState<string>("idle");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [progressLabel, setProgressLabel] = useState<string>("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const streamingMsgIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, progressLabel]);

  // Load an existing session when loadSessionId is provided
  useEffect(() => {
    if (!loadSessionId) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const data = await request<OptimizeSessionDetail>(
          `/api/optimize/agent/sessions/${loadSessionId}`
        );
        if (!cancelled) {
          setSessionId(data.session_id);
          setPhase(data.phase || "idle");
          const history: ChatMessage[] = (data.messages || []).map((m: any, i: number) => {
            const cr = m.confirm_request as ConfirmRequestData | undefined;
            return {
              id: nextMsgId(),
              role: m.role === "user" ? "user" as const : "assistant" as const,
              content: m.content || "",
              suggestions: m.suggestions,
              resume_id: m.resume_id,
              proposal_id: m.proposal_id,
              // Mark all historical confirm requests as processed
              confirmRequest: cr ? { ...cr, processed: true } : undefined,
            };
          });

          // If there's a pending action, add an active confirm request message
          if (data.pending_action) {
            const pa = data.pending_action;
            history.push({
              id: nextMsgId(),
              role: "assistant",
              content: pa.summary || `等待确认: ${pa.tool}`,
              confirmRequest: {
                tool: pa.tool,
                args: pa.args || {},
                summary: pa.summary || `等待确认: ${pa.tool}`,
              },
            });
          }
          if (data.resume_optimization_proposal_id) {
            history.push({
              id: nextMsgId(),
              role: "assistant",
              content: "当前会话已有可审核简历提案。",
              proposal_id: data.resume_optimization_proposal_id,
            });
          }

          setMessages(history);
        }
      } catch (err: any) {
        if (!cancelled) {
          setMessages([{ id: nextMsgId(), role: "assistant", content: `加载会话失败: ${safeClientErrorMessage(err, "请稍后重试")}` }]);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          onLoadSessionConsumed?.();
        }
      }
    };
    void load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onLoadSessionConsumed is a stable callback; omitting to avoid re-triggering
  }, [loadSessionId]);

  const startSession = async () => {
    if (jobIds.length === 0) return;
    setLoading(true);
    try {
      const data = await request<{
        session_id?: string;
        phase?: string;
        assistant_message?: string;
      }>("/api/optimize/agent/start", {
        method: "POST",
        body: JSON.stringify({
          job_ids: jobIds,
          mode,
          profile_id: profileId,
          reference_resume_id: referenceResumeId,
        }),
      });
      if (data.session_id) {
        setSessionId(data.session_id);
        setPhase(data.phase || "confirming");
        if (data.assistant_message) {
          setMessages([{ id: nextMsgId(), role: "assistant", content: data.assistant_message }]);
        }
      }
    } catch (err: any) {
      setMessages([{ id: nextMsgId(), role: "assistant", content: `启动失败: ${safeClientErrorMessage(err, "请稍后重试")}` }]);
    } finally {
      setLoading(false);
    }
  };

  // Shared stream event handler used by both sendMessage and sendConfirmAction
  const handleStreamEvent = useCallback((event: OptimizeAgentStreamEvent) => {
    // token event — append to streaming message
    if (event.token) {
      const tokenText = event.token;
      setProgressLabel("");
      if (!streamingMsgIdRef.current) {
        const msgId = nextMsgId();
        streamingMsgIdRef.current = msgId;
        setMessages((prev) => [...prev, { id: msgId, role: "assistant", content: tokenText }]);
      } else {
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === streamingMsgIdRef.current
              ? { ...msg, content: msg.content + tokenText }
              : msg
          )
        );
      }
      return;
    }

    // progress event
    if (event.progress && event.label) {
      setProgressLabel(event.label);
    }

    // error event
    if (event.error) {
      streamingMsgIdRef.current = null;
      setMessages((prev) => [
        ...prev,
        {
          id: nextMsgId(),
          role: "assistant",
          content: safeClientErrorMessage(event.message || event.error, "分析出错，请稍后重试"),
        },
      ]);
    }

    // assistant message (final response — replace streaming message if exists)
    if (event.assistant_message) {
      const assistantContent = event.assistant_message;
      const streamingId = streamingMsgIdRef.current;
      streamingMsgIdRef.current = null;
      if (streamingId) {
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === streamingId
              ? {
                  ...msg,
                  content: assistantContent,
                  suggestions: event.suggestions,
                  resume_id: event.resume_id,
                  proposal_id: event.proposal_id,
                }
              : msg
          )
        );
      } else {
        setMessages((prev) => [
          ...prev,
          {
            id: nextMsgId(),
            role: "assistant",
            content: assistantContent,
            suggestions: event.suggestions,
            resume_id: event.resume_id,
            proposal_id: event.proposal_id,
          },
        ]);
      }
    }

    // phase update
    if (event.phase) {
      setPhase(event.phase);
    }

    // confirm_request event
    if (event.confirm_request) {
      const cr = event.confirm_request;
      streamingMsgIdRef.current = null;
      const confirmData: ConfirmRequestData = {
        tool: cr.tool,
        args: cr.args,
        summary: cr.summary,
      };
      setMessages((prev) => [
        ...prev,
        {
          id: nextMsgId(),
          role: "assistant",
          content: cr.summary,
          confirmRequest: confirmData,
        },
      ]);
    }
  }, []);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || !sessionId || loading) return;

    const userMsg: ChatMessage = { id: nextMsgId(), role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);
    setProgressLabel("AI 正在思考...");

    // abort any previous request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamOptimizeAgentChat(
        { session_id: sessionId, message: text, action: "reply" },
        {
          signal: controller.signal,
          onEvent: handleStreamEvent,
        }
      );
    } catch (err: any) {
      if (err.name === "AbortError") return;
      setMessages((prev) => [
        ...prev,
        { id: nextMsgId(), role: "assistant", content: `发送失败: ${safeClientErrorMessage(err, "请稍后重试")}` },
      ]);
    } finally {
      setLoading(false);
      setProgressLabel("");
      streamingMsgIdRef.current = null;
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    }
  }, [input, sessionId, loading, handleStreamEvent]);

  const sendConfirmAction = useCallback(async (action: "confirm" | "reject") => {
    if (!sessionId || loading) return;

    const label = action === "confirm" ? "确认" : "取消";
    const userMsg: ChatMessage = { id: nextMsgId(), role: "user", content: label };
    setMessages((prev) => [...prev, userMsg]);

    // Mark the active confirm request as processed
    setMessages((prev) =>
      prev.map((msg) =>
        msg.confirmRequest && !msg.confirmRequest.processed
          ? { ...msg, confirmRequest: { ...msg.confirmRequest, processed: true } }
          : msg
      )
    );

    setLoading(true);
    setProgressLabel("AI 正在处理...");

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamOptimizeAgentChat(
        { session_id: sessionId, message: label, action },
        {
          signal: controller.signal,
          onEvent: handleStreamEvent,
        }
      );
    } catch (err: any) {
      if (err.name === "AbortError") return;
      setMessages((prev) => [
        ...prev,
        { id: nextMsgId(), role: "assistant", content: `操作失败: ${safeClientErrorMessage(err, "请稍后重试")}` },
      ]);
    } finally {
      setLoading(false);
      setProgressLabel("");
      streamingMsgIdRef.current = null;
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    }
  }, [sessionId, loading, handleStreamEvent]);

  // cleanup on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const handleStopGeneration = useCallback(() => {
    abortRef.current?.abort();
    // Append interrupted indicator to the current streaming message
    const streamingId = streamingMsgIdRef.current;
    if (streamingId) {
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === streamingId
            ? { ...msg, content: msg.content + "\n\n*[已中断]*" }
            : msg
        )
      );
    }
    setLoading(false);
    streamingMsgIdRef.current = null;
    setProgressLabel("");
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void sendMessage();
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {phase !== "idle" && (
        <ol aria-label="定制进度" className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--border)] px-5 py-2 text-xs">
          {PHASES.map((item, index) => {
            const current = PHASES.findIndex((p) => p.key === phase);
            const state = index < current ? "done" : index === current ? "active" : "todo";
            return (
              <li key={item.key} className="flex items-center gap-1 whitespace-nowrap">
                {index > 0 && <span className="mx-1 h-px w-4 bg-[var(--border)]" />}
                <span
                  className={
                    state === "active"
                      ? "font-semibold text-[var(--foreground)]"
                      : state === "done"
                        ? "text-[var(--foreground-soft)]"
                        : "text-[var(--foreground-muted)]"
                  }
                >
                  {state === "done" ? "✓ " : ""}{item.label}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto p-5 md:p-6 custom-scrollbar"
        >
          {messages.length === 0 && (
            <div className="mx-auto flex min-h-64 max-w-md flex-col items-center justify-center gap-4 text-center">
              <MessageSquare size={36} className="text-[var(--foreground-muted)]" />
              <div className="space-y-1">
                <p className="text-[15px] font-semibold text-[var(--foreground)]">按这个岗位改写简历</p>
                <p className="text-sm text-[var(--foreground-muted)]">
                  AI 会先确认目标、分析差距，再逐段给出修改。每一条都要你审核，你接受后才会生成正式简历。
                </p>
              </div>
              {blockedReason ? (
                <BlockedHint reason={blockedReason} />
              ) : (
                <Button
                  className="bauhaus-button bauhaus-button-red"
                  startContent={<Play size={16} />}
                  onPress={startSession}
                  isDisabled={disabled || jobIds.length === 0 || loading}
                  isLoading={loading}
                >
                  开始定制
                </Button>
              )}
            </div>
          )}
          <div className="space-y-4">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`text-sm leading-relaxed text-[var(--foreground)] ${
                    msg.role === "user"
                      ? "max-w-[75%] rounded-[14px] rounded-br-[4px] bg-[var(--foreground)] px-4 py-2.5 text-[var(--surface)]"
                      : "w-full max-w-[720px]"
                  }`}
                >
                  {msg.role === "assistant" ? (
                    <>
                      <RenderedMarkdown content={msg.content} />

                      {msg.suggestions && msg.suggestions.length > 0 && (
                        <div className="mt-3 space-y-3">
                          {msg.suggestions.map((sug, idx) => <SuggestionCard key={idx} suggestion={sug} index={idx} />)}
                        </div>
                      )}
                      {msg.confirmRequest && (
                        <div className="mt-3 border border-[var(--border-strong)]/15 bg-[var(--surface-muted)] p-4">
                          <p className="text-sm font-bold text-[var(--foreground)]">{msg.confirmRequest.summary}</p>
                          <div className="mt-3 flex gap-2">
                            <Button
                              size="sm"
                              className="bauhaus-button bauhaus-button-red !min-h-8"
                              onPress={() => void sendConfirmAction("confirm")}
                              isDisabled={loading || msg.confirmRequest.processed}
                            >
                              确认
                            </Button>
                            <Button
                              size="sm"
                              className="bauhaus-button bauhaus-button-outline !min-h-8"
                              onPress={() => void sendConfirmAction("reject")}
                              isDisabled={loading || msg.confirmRequest.processed}
                            >
                              取消
                            </Button>
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="whitespace-pre-wrap">{msg.content}</div>
                  )}

                  {msg.resume_id && (
                    <Link
                      href={`/resume/${msg.resume_id}`}
                      className="mt-3 flex items-center gap-3 border border-[var(--border-strong)]/15 bg-[var(--surface-muted)] p-3 transition-transform hover:-translate-y-0.5"
                    >
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center border border-[var(--border-strong)] bg-[var(--surface-muted)]">
                        <FileText size={18} className="text-[var(--foreground)]" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-bold text-[var(--foreground)]">打开定制简历</p>
                        <p className="mt-0.5 text-xs font-medium text-[var(--foreground-muted)]">
                          点击进入编辑器
                        </p>
                      </div>
                    </Link>
                  )}

                  {msg.proposal_id && !msg.resume_id && (
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-[var(--border)] bg-[var(--surface-muted)] p-3">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-[var(--foreground)]">简历提案已生成，等你审核</p>
                        <p className="mt-0.5 text-xs text-[var(--foreground-muted)]">逐条查看修改和证据，接受后才会写入简历。</p>
                      </div>
                      {jobIds[0] ? (
                        <Link
                          href={`/jobs/${jobIds[0]}?focus=materials`}
                          className="bauhaus-button bauhaus-button-sm bauhaus-button-red shrink-0"
                        >
                          去审核
                        </Link>
                      ) : null}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {loading && progressLabel && messages.length > 0 && (
              <div className="flex justify-start">
                <div className="border border-[var(--border-strong)]/15 bg-[var(--surface-muted)] px-4 py-3 text-sm text-[var(--foreground-muted)] shadow-[1px_1px_0_0_rgba(18,18,18,0.08)]">
                  <span className="inline-block animate-pulse">●</span>{" "}
                  {progressLabel}
                </div>
              </div>
            )}
          </div>
        </div>

        {sessionId ? (
          <div className="shrink-0 space-y-2 border-t border-[var(--border)] p-3">
            {!loading && (QUICK_REPLIES[phase] || []).length > 0 && (
              <div className="flex flex-wrap gap-1.5" aria-label="快捷回复">
                {(QUICK_REPLIES[phase] || []).map((text) => (
                  <button
                    key={text}
                    type="button"
                    onClick={() => setInput(text)}
                    className="rounded-full border border-[var(--border)] px-3 py-1 text-xs text-[var(--foreground-muted)] transition-colors hover:border-[var(--foreground)] hover:text-[var(--foreground)]"
                  >
                    {text}
                  </button>
                ))}
              </div>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void sendMessage();
              }}
              className="flex items-end gap-2 rounded-[12px] border border-[var(--border)] bg-white p-1.5 focus-within:border-[var(--foreground)]"
            >
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={loading ? "AI 正在处理…" : "回复 AI，或说说你想怎么改（Enter 发送，Shift+Enter 换行）"}
                rows={2}
                className="max-h-40 min-h-[44px] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-[var(--foreground)] placeholder:text-[var(--foreground-muted)] focus:outline-none"
                disabled={loading}
              />
              {loading ? (
                <button
                  type="button"
                  onClick={handleStopGeneration}
                  aria-label="停止生成"
                  className="flex h-9 shrink-0 items-center gap-1.5 rounded-[9px] border border-[var(--border)] px-3 text-xs font-semibold text-[var(--foreground)] hover:bg-[var(--surface-muted)]"
                >
                  <Square size={12} fill="currentColor" /> 停止
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!input.trim()}
                  aria-label="发送"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] bg-[var(--foreground)] text-[var(--surface)] transition-opacity disabled:opacity-30"
                >
                  <SendHorizonal size={15} />
                </button>
              )}
            </form>
          </div>
        ) : (
          messages.length > 0 && (
            <div className="shrink-0 border-t border-[var(--border-strong)]/12 p-4">
              <Button
                className="bauhaus-button bauhaus-button-red w-full"
                startContent={<Play size={16} />}
                onPress={startSession}
                isDisabled={disabled || jobIds.length === 0 || loading}
                isLoading={loading}
              >
                重新开始
              </Button>
            </div>
          )
        )}
      </div>
    </div>
  );
}
