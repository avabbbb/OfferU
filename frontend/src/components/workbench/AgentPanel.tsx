"use client";

// =============================================
// OfferU 主 Agent 面板 — 右侧上下文栏 "OfferU" 模式 (ADR 0031)
// 由 HarnessAgentDock 迁移:去掉悬浮/拖拽外壳,扁平化为栏内面板。
// =============================================

import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Textarea } from "@nextui-org/react";
import {
  AlertTriangle,
  Briefcase,
  CheckCircle2,
  History,
  Download,
  Loader2,
  Plus,
  Send,
  Sparkles,
  Trash2,
  Upload,
  Wrench,
} from "lucide-react";
import {
  harnessAgentApi,
  type HarnessAgentCareerPath,
  type HarnessAgentConversationSummary,
  type HarnessAgentJobCard,
  type HarnessAgentMessage,
  type HarnessAgentProposedAction,
  type HarnessAgentResponse,
} from "@/lib/api";
import { presentHarnessToolCall } from "@/lib/harnessToolPresentation";
import { bauhausFieldClassNames } from "@/lib/bauhaus";

interface PanelMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  response?: HarnessAgentResponse;
}

const QUICK_ACTIONS = [
  {
    label: "确认身份",
    skillId: "profile_onboarding",
    prompt: "先问我几个问题，判断我是校招/应届/实习，还是社招/跳槽",
  },
  {
    label: "校招体检",
    skillId: "market_calibration",
    prompt: "按校招标准检查我的档案、简历、岗位和投递流程缺口",
  },
  {
    label: "每日岗位",
    skillId: "evaluate_job",
    prompt: "今天给我推荐一个最值得投的校招/实习岗位，并说明为什么",
  },
  {
    label: "异常检测",
    skillId: "tracker",
    prompt: "检查我的档案、岗位库、投递管理和面试日程有没有异常",
  },
];

const STAGE_LABELS: Record<string, string> = {
  campus: "校招",
  experienced: "社招",
  unknown: "待确认",
};

function previewJson(value: unknown) {
  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > 260 ? `${text.slice(0, 260)}...` : text;
  } catch {
    return String(value);
  }
}

function toApiMessages(messages: PanelMessage[]): HarnessAgentMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

export function AgentPanel() {
  const [messages, setMessages] = useState<PanelMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content:
        "我是 OfferU。我会结合你当前所在页面和选中的对象,检查档案、岗位、简历、投递和面试日程里的风险。",
    },
  ]);
  const [input, setInput] = useState("");
  const [pendingActions, setPendingActions] = useState<HarnessAgentProposedAction[]>([]);
  const [loading, setLoading] = useState(false);
  const [progressText, setProgressText] = useState("正在连接 Python AgentKernel...");
  const [error, setError] = useState("");
  const [importedStage, setImportedStage] = useState<string>("unknown");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversationTitle, setConversationTitle] = useState("新对话");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [conversations, setConversations] = useState<HarnessAgentConversationSummary[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const hasPendingActions = pendingActions.length > 0;

  const latestResponse = useMemo(() => {
    return [...messages].reverse().find((message) => message.response)?.response;
  }, [messages]);

  const latestMode = latestResponse?.active_skill?.name || latestResponse?.mode || "ready";
  const latestStage = latestResponse?.user_stage || importedStage || "unknown";

  const refreshConversations = async () => {
    try {
      const result = await harnessAgentApi.conversations();
      setConversations(result.conversations || []);
    } catch {
      setConversations([]);
    }
  };

  useEffect(() => {
    refreshConversations();
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  const sendMessage = async (text?: string, confirmedActionIds?: string[], skillId?: string) => {
    const content = (text ?? input).trim();
    const isConfirmation = Boolean(confirmedActionIds?.length);
    if ((!content && !isConfirmation) || loading) return;

    const userMessage: PanelMessage | null = isConfirmation
      ? null
      : {
          id: `user-${Date.now()}`,
          role: "user",
          content,
        };
    const nextMessages = userMessage ? [...messages, userMessage] : messages;

    setMessages(nextMessages);
    setInput("");
    setLoading(true);
    setProgressText(isConfirmation ? "正在恢复并执行已确认的 Run..." : "正在连接 Python AgentKernel...");
    setError("");

    try {
      const response = await harnessAgentApi.chat(
        {
          messages: toApiMessages(nextMessages),
          confirmed_action_ids: confirmedActionIds,
          conversation_id: conversationId,
          skill_id: skillId,
        },
        (event, data) => {
          if (event === "thinking") setProgressText("正在规划目标并选择工具...");
          if (event === "skill_selected") setProgressText(`已进入${data?.name || "求职"}技能，正在执行协议...`);
          if (event === "tool_call") setProgressText("正在读取真实数据并整理结果...");
        }
      );
      const assistantMessage: PanelMessage = {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content: response.assistant_message,
        response,
      };
      if (response.conversation_id) setConversationId(response.conversation_id);
      if (response.conversation_title) setConversationTitle(response.conversation_title);
      setMessages((prev) => [...prev, assistantMessage]);
      setPendingActions(response.proposed_actions || []);
      refreshConversations();
    } catch (err: any) {
      setError(err.message || "OfferU 请求失败");
    } finally {
      setLoading(false);
    }
  };

  const startNewConversation = () => {
    setConversationId(null);
    setConversationTitle("新对话");
    setPendingActions([]);
    setHistoryOpen(false);
    setMessages([
      {
        id: `welcome-${Date.now()}`,
        role: "assistant",
        content: "新对话已开始。先告诉我你是校招/应届/实习，还是社招/跳槽，我会按对应路径主动检查。",
      },
    ]);
  };

  const loadConversation = async (id: string) => {
    setError("");
    try {
      const conversation = await harnessAgentApi.conversation(id);
      setConversationId(conversation.id);
      setConversationTitle(conversation.title || "历史对话");
      setPendingActions([]);
      setHistoryOpen(false);
      setMessages(
        (conversation.messages || []).map((message, index) => ({
          id: `${conversation.id}-${index}`,
          role: message.role,
          content: message.content,
        }))
      );
    } catch (err: any) {
      setError(err.message || "加载历史对话失败");
    }
  };

  const removeConversation = async (id: string) => {
    setError("");
    try {
      await harnessAgentApi.deleteConversation(id);
      if (conversationId === id) startNewConversation();
      await refreshConversations();
    } catch (err: any) {
      setError(err.message || "删除历史对话失败");
    }
  };

  const confirmPendingActions = () => {
    sendMessage("", pendingActions.map((action) => action.id));
  };

  const exportMemory = async () => {
    setError("");
    try {
      const result = await harnessAgentApi.exportMemory("markdown");
      await navigator.clipboard.writeText(String(result.content || ""));
      setMessages((prev) => [
        ...prev,
        {
          id: `memory-export-${Date.now()}`,
          role: "assistant",
          content: "已把当前 Agent 记忆导出为 Markdown，并放到剪贴板。",
        },
      ]);
    } catch (err: any) {
      setError(err.message || "导出记忆失败");
    }
  };

  const importMemoryFile = async (file: File) => {
    setError("");
    try {
      const text = await file.text();
      const result = await harnessAgentApi.importMemory(text);
      setImportedStage(result.memory.user_stage);
      setMessages((prev) => [
        ...prev,
        {
          id: `memory-import-${Date.now()}`,
          role: "assistant",
          content: `已导入本地记忆。当前识别为：${STAGE_LABELS[result.memory.user_stage] || result.memory.user_stage}。`,
        },
      ]);
    } catch (err: any) {
      setError(err.message || "导入记忆失败");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 对话状态行 */}
      <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-2">
        <button
          type="button"
          onClick={() => setHistoryOpen((value) => !value)}
          className="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] font-medium text-[var(--foreground-soft)] transition-colors duration-[var(--dur-quick)] hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]"
          title="打开历史对话"
        >
          <History size={13} />
          <span className="truncate">{conversationTitle || "历史对话"}</span>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          <span className="bauhaus-chip !py-0.5 !text-[10.5px]">{STAGE_LABELS[latestStage] || latestStage}</span>
          <span className="bauhaus-chip !py-0.5 !text-[10.5px]">{latestMode}</span>
        </div>
      </div>

      {historyOpen && (
        <div className="border-b border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[12px] font-semibold text-[var(--foreground)]">历史对话</p>
            <button
              type="button"
              onClick={startNewConversation}
              className="bauhaus-button bauhaus-button-sm"
            >
              <Plus size={12} />
              新建
            </button>
          </div>
          <div className="max-h-40 space-y-1 overflow-y-auto">
            {conversations.length === 0 && (
              <p className="rounded-md px-2 py-1.5 text-[12px] text-[var(--foreground-muted)]">暂无历史对话</p>
            )}
            {conversations.map((conversation) => (
              <div
                key={conversation.id}
                className={`flex items-center gap-1 rounded-md px-2 py-1.5 transition-colors duration-[var(--dur-quick)] ${
                  conversation.id === conversationId
                    ? "bg-[var(--surface)] text-[var(--foreground)]"
                    : "hover:bg-[var(--surface-hover)]"
                }`}
              >
                <button
                  type="button"
                  onClick={() => loadConversation(conversation.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <p className="truncate text-[12px] font-medium text-[var(--foreground)]">
                    {conversation.title || "历史对话"}
                  </p>
                  <p className="mt-0.5 truncate text-[11px] text-[var(--foreground-muted)]">
                    {conversation.message_count} 条 / {conversation.last_message}
                  </p>
                </button>
                <button
                  type="button"
                  aria-label="删除历史对话"
                  onClick={() => removeConversation(conversation.id)}
                  className="rounded p-1 text-[var(--foreground-muted)] transition-colors duration-[var(--dur-quick)] hover:bg-[var(--status-blush)] hover:text-[var(--primary-red)]"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 快捷技能 */}
      <div className="flex flex-wrap gap-1.5 border-b border-[var(--border)] px-3 py-2">
        {QUICK_ACTIONS.map((action) => (
          <button
            key={action.label}
            type="button"
            onClick={() => sendMessage(action.prompt, undefined, action.skillId)}
            className="bauhaus-chip cursor-pointer transition-colors duration-[var(--dur-quick)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)] hover:text-[var(--foreground)]"
          >
            {action.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-0.5">
          <input
            ref={fileInputRef}
            type="file"
            accept=".md,.markdown,.json,.txt"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) importMemoryFile(file);
            }}
          />
          <button
            type="button"
            aria-label="导入本地记忆"
            title="导入 Codex / Claude Code / 本地 Markdown 或 JSON 记忆"
            onClick={() => fileInputRef.current?.click()}
            className="rounded-md p-1.5 text-[var(--foreground-muted)] transition-colors duration-[var(--dur-quick)] hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]"
          >
            <Upload size={14} />
          </button>
          <button
            type="button"
            aria-label="导出助手记忆"
            title="导出记忆为 Markdown"
            onClick={exportMemory}
            className="rounded-md p-1.5 text-[var(--foreground-muted)] transition-colors duration-[var(--dur-quick)] hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]"
          >
            <Download size={14} />
          </button>
        </div>
      </div>

      {/* 消息流 */}
      <div ref={scrollRef} className="custom-scrollbar min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div className="space-y-3">
          {messages.map((message) => (
            <PanelMessageBubble key={message.id} message={message} onSuggestion={sendMessage} />
          ))}
          {loading && (
            <div className="inline-flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-[12.5px] text-[var(--foreground-soft)]">
              <Loader2 size={13} className="animate-spin" />
              {progressText}
            </div>
          )}
        </div>
      </div>

      {hasPendingActions && (
        <div className="border-t border-[var(--border)] bg-[var(--status-blush)] px-3 py-2.5">
          <p className="text-[12px] font-semibold text-[var(--foreground)]">需要确认的动作</p>
          <div className="mt-1.5 space-y-1.5">
            {pendingActions.map((action) => (
              <div
                key={action.id}
                className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-[12px] text-[var(--foreground)]"
              >
                {action.summary}
              </div>
            ))}
          </div>
          <Button
            onPress={confirmPendingActions}
            isDisabled={loading}
            startContent={loading ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
            className="bauhaus-button bauhaus-button-red mt-2 !min-h-8 !w-full !justify-center !py-1 !text-[12px]"
          >
            确认执行
          </Button>
        </div>
      )}

      {error && (
        <div className="border-t border-[var(--border)] bg-[var(--status-blush)] px-3 py-1.5 text-[12px] font-medium text-[var(--primary-red)]">
          {error}
        </div>
      )}

      {/* 输入区 */}
      <footer className="border-t border-[var(--border)] p-2.5">
        <div className="flex items-end gap-1.5">
          <Textarea
            value={input}
            onValueChange={setInput}
            minRows={1}
            maxRows={4}
            placeholder="问 OfferU,或说你要推进哪一步..."
            variant="bordered"
            className="flex-1"
            classNames={bauhausFieldClassNames}
            isDisabled={loading}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                sendMessage();
              }
            }}
          />
          <Button
            isIconOnly
            aria-label="发送"
            onPress={() => sendMessage()}
            isDisabled={!input.trim() || loading}
            className="bauhaus-button bauhaus-button-outline !min-h-9 !min-w-9 !px-0 !py-0"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          </Button>
        </div>
      </footer>
    </div>
  );
}

function PanelMessageBubble({
  message,
  onSuggestion,
}: {
  message: PanelMessage;
  onSuggestion: (prompt: string) => void;
}) {
  const isUser = message.role === "user";
  const response = message.response;

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[94%] ${isUser ? "text-right" : ""}`}>
        <div
          className={`inline-block whitespace-pre-wrap rounded-lg border border-[var(--border)] px-3 py-2 text-left text-[13px] leading-6 ${
            isUser ? "bg-[var(--surface-muted)]" : "bg-[var(--surface)]"
          } text-[var(--foreground)]`}
        >
          {message.content}
        </div>
        {response && (
          <div className="mt-2 space-y-2 text-left">
            {response.alerts && response.alerts.length > 0 && <AlertList alerts={response.alerts} />}
            {response.proactive_suggestions && response.proactive_suggestions.length > 0 && (
              <SuggestionList suggestions={response.proactive_suggestions} onSuggestion={onSuggestion} />
            )}
            {response.transferable_skills_summary && (
              <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-2.5 text-[12px] leading-5 text-[var(--foreground-soft)]">
                {response.transferable_skills_summary}
              </div>
            )}
            {response.career_paths && response.career_paths.length > 0 && (
              <CareerPathList paths={response.career_paths} />
            )}
            {response.job_cards && response.job_cards.length > 0 && <JobCardList jobs={response.job_cards} />}
            {response.tool_calls && response.tool_calls.length > 0 && <ToolCallList calls={response.tool_calls} />}
            {response.next_steps && response.next_steps.length > 0 && (
              <ul className="space-y-1 rounded-md border border-[var(--border)] bg-[var(--surface-muted)] p-2.5 text-[12px] text-[var(--foreground-soft)]">
                {response.next_steps.map((step) => (
                  <li key={step}>- {step}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function AlertList({ alerts }: { alerts: NonNullable<HarnessAgentResponse["alerts"]> }) {
  return (
    <div className="space-y-1.5">
      {alerts.map((alert) => (
        <div
          key={alert.code}
          className="rounded-md border border-[var(--border)] bg-[var(--status-blush)] p-2.5 text-[12px] text-[var(--foreground)]"
        >
          <div className="flex items-start gap-2">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[var(--primary-red)]" />
            <div>
              <p className="font-semibold">{alert.title}</p>
              <p className="mt-0.5 leading-5 text-[var(--foreground-soft)]">{alert.message}</p>
              {alert.action && <p className="mt-0.5 font-medium">{alert.action}</p>}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function SuggestionList({
  suggestions,
  onSuggestion,
}: {
  suggestions: NonNullable<HarnessAgentResponse["proactive_suggestions"]>;
  onSuggestion: (prompt: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      {suggestions.map((suggestion) => (
        <button
          key={`${suggestion.title}-${suggestion.prompt}`}
          type="button"
          onClick={() => onSuggestion(suggestion.prompt)}
          className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] p-2.5 text-left text-[12px] text-[var(--foreground)] transition-colors duration-[var(--dur-quick)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-muted)]"
        >
          <p className="font-semibold">{suggestion.title}</p>
          <p className="mt-0.5 leading-5 text-[var(--foreground-soft)]">{suggestion.description}</p>
        </button>
      ))}
    </div>
  );
}

function CareerPathList({ paths }: { paths: HarnessAgentCareerPath[] }) {
  return (
    <div className="space-y-1.5">
      {paths.map((path) => (
        <div key={path.title} className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-2.5">
          <div className="flex items-start gap-2">
            <Sparkles size={14} className="mt-0.5 shrink-0 text-[var(--primary-yellow)]" />
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-[var(--foreground)]">{path.title}</p>
              <p className="mt-0.5 text-[11px] text-[var(--foreground-muted)]">{path.industry}</p>
              <p className="mt-1 text-[12px] leading-5 text-[var(--foreground-soft)]">{path.fit_reason}</p>
              <p className="mt-1 text-[12px] font-medium text-[var(--foreground)]">{path.salary_range}</p>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {path.search_keywords.map((keyword) => (
                  <span key={keyword} className="bauhaus-chip !py-0.5 !text-[10.5px]">
                    {keyword}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function JobCardList({ jobs }: { jobs: HarnessAgentJobCard[] }) {
  return (
    <div className="space-y-1.5">
      {jobs.map((job) => (
        <div key={job.id} className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-2.5">
          <div className="flex items-start gap-2">
            <Briefcase size={14} className="mt-0.5 shrink-0 text-[var(--primary-blue)]" />
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-[var(--foreground)]">{job.company}</p>
              <p className="mt-0.5 text-[12px] font-medium text-[var(--foreground-soft)]">{job.title}</p>
              <p className="mt-0.5 text-[11px] text-[var(--foreground-muted)]">
                {[job.location, job.salary_text, job.source].filter(Boolean).join(" / ")}
              </p>
              {job.apply_url && (
                <a
                  href={job.apply_url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-block text-[12px] font-medium text-[var(--primary-blue)] underline"
                >
                  打开投递链接
                </a>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ToolCallList({ calls }: { calls: HarnessAgentResponse["tool_calls"] }) {
  return (
    <div className="space-y-1.5">
      {calls.map((call, index) => {
        const presentation = presentHarnessToolCall(call);
        return (
          <details
            key={`${call.tool}-${index}`}
            className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-[12px] text-[var(--foreground-soft)]"
          >
            <summary className="flex cursor-pointer items-center gap-1.5 font-medium text-[var(--foreground)]">
              <Wrench size={12} />
              {call.tool}
            </summary>
            {presentation && (
              <p className="mt-1.5 border-l-2 border-[var(--border-strong)] pl-2 leading-5 text-[var(--foreground)]">
                {presentation}
              </p>
            )}
            <pre className="custom-scrollbar mt-1.5 max-h-28 overflow-auto whitespace-pre-wrap rounded bg-[var(--surface-muted)] p-2">
              {previewJson(call.result)}
            </pre>
          </details>
        );
      })}
    </div>
  );
}
