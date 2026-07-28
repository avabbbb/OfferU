"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Card,
  CardBody,
  Chip,
  ScrollShadow,
  Textarea,
} from "@nextui-org/react";
import {
  AlertTriangle,
  Bot,
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
  UserRound,
  Wrench,
  X,
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
import { useDraggableDock } from "./useDraggableDock";

interface DockMessage {
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

function toApiMessages(messages: DockMessage[]): HarnessAgentMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

export function HarnessAgentDock() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<DockMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content:
        "我是 OfferU 全局助手。现在我会先识别你是校招还是社招，再主动检查档案、岗位、简历、投递和面试日程里的风险。",
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
  const { dockRef, dockStyle, dragHandleProps, launcherDragHandleProps, consumeDragClick } = useDraggableDock({
    width: 440,
    height: 600,
  });

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
    if (open) refreshConversations();
  }, [open]);

  const sendMessage = async (text?: string, confirmedActionIds?: string[], skillId?: string) => {
    const content = (text ?? input).trim();
    const isConfirmation = Boolean(confirmedActionIds?.length);
    if ((!content && !isConfirmation) || loading) return;

    const userMessage: DockMessage | null = isConfirmation
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
      const assistantMessage: DockMessage = {
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
      setError(err.message || "全局助手请求失败");
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
        content:
          "新对话已开始。先告诉我你是校招/应届/实习，还是社招/跳槽，我会按对应路径主动检查。",
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

  if (!open) {
    return (
      <Button
        isIconOnly
        aria-label="打开 OfferU 全局助手"
        title="打开 OfferU 全局助手。按住可拖动。"
        {...launcherDragHandleProps}
        onPress={() => {
          if (consumeDragClick()) return;
          setOpen(true);
        }}
        style={dockStyle}
        className="fixed bottom-24 right-5 z-50 h-14 w-14 cursor-move touch-none border-2 border-black bg-[#F0C020] text-black shadow-[4px_4px_0_0_rgba(18,18,18,0.35)] md:bottom-6"
      >
        <Bot size={22} />
      </Button>
    );
  }

  return (
    <section
      ref={dockRef}
      style={dockStyle}
      className="fixed bottom-24 right-4 z-50 flex max-h-[82vh] w-[min(92vw,440px)] flex-col overflow-hidden border-2 border-black bg-white shadow-[6px_6px_0_0_rgba(18,18,18,0.35)] md:bottom-6 md:right-6"
    >
      <header
        {...dragHandleProps}
        className="flex cursor-move select-none items-center justify-between border-b-2 border-black bg-[var(--surface-muted)] px-4 py-3 touch-none"
      >
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center border-2 border-black bg-[#F0C020] text-black">
            <Sparkles size={17} />
          </div>
          <div className="min-w-0">
            <button
              type="button"
              onClick={() => setHistoryOpen((value) => !value)}
              className="flex max-w-[180px] items-center gap-1 text-left text-[11px] font-black uppercase tracking-[0.08em] text-black/65 hover:text-black"
              title="打开历史对话"
            >
              <History size={12} />
              <span className="truncate">{conversationTitle || "历史对话"}</span>
            </button>
            <h2 className="truncate text-base font-black text-black">OfferU 全局助手</h2>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Chip size="sm" className="border border-black bg-white text-[10px] font-semibold text-black">
            <UserRound size={12} />
            {STAGE_LABELS[latestStage] || latestStage}
          </Chip>
          <Chip size="sm" className="border border-black bg-white text-[10px] font-semibold text-black">
            {latestMode}
          </Chip>
          <Button
            isIconOnly
            size="sm"
            variant="light"
            aria-label="关闭助手"
            onPress={() => setOpen(false)}
            className="min-w-8 text-black"
          >
            <X size={16} />
          </Button>
        </div>
      </header>

      {historyOpen && (
        <div className="border-b-2 border-black bg-white px-4 py-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-black text-black">历史对话</p>
            <Button
              size="sm"
              startContent={<Plus size={13} />}
              onPress={startNewConversation}
              className="h-8 border-2 border-black bg-[#F0C020] px-2 text-xs font-black text-black"
            >
              新建
            </Button>
          </div>
          <div className="max-h-40 space-y-2 overflow-y-auto">
            {conversations.length === 0 && (
              <p className="border border-black/20 bg-[var(--surface-muted)] px-3 py-2 text-xs font-semibold text-black/60">
                暂无历史对话
              </p>
            )}
            {conversations.map((conversation) => (
              <div
                key={conversation.id}
                className={`flex items-center gap-2 border px-2 py-2 ${
                  conversation.id === conversationId ? "border-black bg-[#FFF4D8]" : "border-black/20 bg-white"
                }`}
              >
                <button
                  type="button"
                  onClick={() => loadConversation(conversation.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <p className="truncate text-xs font-black text-black">{conversation.title || "历史对话"}</p>
                  <p className="mt-0.5 truncate text-[11px] font-medium text-black/55">
                    {conversation.message_count} 条 / {conversation.last_message}
                  </p>
                </button>
                <Button
                  isIconOnly
                  size="sm"
                  variant="light"
                  aria-label="删除历史对话"
                  onPress={() => removeConversation(conversation.id)}
                  className="min-w-8 text-[#D02020]"
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2 border-b border-black/10 px-4 py-3">
        {QUICK_ACTIONS.map((action) => (
          <Chip
            key={action.label}
            className="cursor-pointer border-2 border-black bg-white px-2 text-xs font-semibold text-black"
            onClick={() => sendMessage(action.prompt, undefined, action.skillId)}
          >
            {action.label}
          </Chip>
        ))}
      </div>

      <div className="flex items-center justify-between border-b border-black/10 px-4 py-2">
        <p className="text-[11px] font-semibold text-black/65">可导入 Codex / Claude Code / 本地 Markdown 或 JSON 记忆</p>
        <div className="flex items-center gap-2">
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
          <Button
            isIconOnly
            size="sm"
            variant="light"
            aria-label="导入本地记忆"
            onPress={() => fileInputRef.current?.click()}
            className="min-w-8 text-black"
          >
            <Upload size={15} />
          </Button>
          <Button
            isIconOnly
            size="sm"
            variant="light"
            aria-label="导出助手记忆"
            onPress={exportMemory}
            className="min-w-8 text-black"
          >
            <Download size={15} />
          </Button>
        </div>
      </div>

      <ScrollShadow className="min-h-[19rem] flex-1 overflow-y-auto px-4 py-3">
        <div className="space-y-4">
          {messages.map((message) => (
            <DockMessageBubble key={message.id} message={message} onSuggestion={sendMessage} />
          ))}
          {loading && (
            <div className="inline-flex items-center gap-2 border-2 border-black bg-white px-3 py-2 text-sm font-medium text-black/65">
              <Loader2 size={14} className="animate-spin" />
              {progressText}
            </div>
          )}
        </div>
      </ScrollShadow>

      {hasPendingActions && (
        <div className="border-t-2 border-black bg-[#F7E4E1] px-4 py-3">
          <p className="text-xs font-bold text-black">需要确认的动作</p>
          <div className="mt-2 space-y-2">
            {pendingActions.map((action) => (
              <div key={action.id} className="border border-black bg-white px-3 py-2 text-xs font-medium text-black">
                {action.summary}
              </div>
            ))}
          </div>
          <Button
            onPress={confirmPendingActions}
            isDisabled={loading}
            startContent={loading ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
            className="bauhaus-button bauhaus-button-red mt-3 !w-full !justify-center !py-2 !text-xs"
          >
            确认执行
          </Button>
        </div>
      )}

      {error && (
        <div className="border-t border-black bg-[#D02020] px-4 py-2 text-xs font-semibold text-white">
          {error}
        </div>
      )}

      <footer className="border-t-2 border-black bg-white p-3">
        <div className="flex items-end gap-2">
          <Textarea
            value={input}
            onValueChange={setInput}
            minRows={1}
            maxRows={3}
            placeholder="告诉我你是校招还是社招，或者直接说你要推进哪一步..."
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
            className="bauhaus-button bauhaus-button-red !min-h-10 !min-w-10 !px-0 !py-0"
          >
            {loading ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
          </Button>
        </div>
      </footer>
    </section>
  );
}

function DockMessageBubble({
  message,
  onSuggestion,
}: {
  message: DockMessage;
  onSuggestion: (prompt: string) => void;
}) {
  const isUser = message.role === "user";
  const response = message.response;

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[92%] ${isUser ? "text-right" : ""}`}>
        <div
          className={`inline-block whitespace-pre-wrap border-2 border-black px-3 py-2 text-sm font-medium leading-6 shadow-[2px_2px_0_0_rgba(18,18,18,0.18)] ${
            isUser ? "bg-[#F7E4E1] text-black" : "bg-white text-black"
          }`}
        >
          {message.content}
        </div>
        {response && (
          <div className="mt-3 space-y-3 text-left">
            {response.alerts && response.alerts.length > 0 && <AlertList alerts={response.alerts} />}
            {response.proactive_suggestions && response.proactive_suggestions.length > 0 && (
              <SuggestionList suggestions={response.proactive_suggestions} onSuggestion={onSuggestion} />
            )}
            {response.transferable_skills_summary && (
              <Card className="rounded-none border-2 border-black shadow-none">
                <CardBody className="p-3 text-xs font-medium leading-5 text-black/75">
                  {response.transferable_skills_summary}
                </CardBody>
              </Card>
            )}
            {response.career_paths && response.career_paths.length > 0 && <CareerPathList paths={response.career_paths} />}
            {response.job_cards && response.job_cards.length > 0 && <JobCardList jobs={response.job_cards} />}
            {response.tool_calls && response.tool_calls.length > 0 && <ToolCallList calls={response.tool_calls} />}
            {response.next_steps && response.next_steps.length > 0 && (
              <ul className="space-y-1 border border-black/20 bg-[var(--surface-muted)] p-3 text-xs font-medium text-black/70">
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
    <div className="space-y-2">
      {alerts.map((alert) => (
        <div key={alert.code} className="border-2 border-black bg-[#FFF4D8] p-3 text-xs text-black">
          <div className="flex items-start gap-2">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-[#D02020]" />
            <div>
              <p className="font-black">{alert.title}</p>
              <p className="mt-1 font-medium leading-5 text-black/70">{alert.message}</p>
              {alert.action && <p className="mt-1 font-bold text-black">{alert.action}</p>}
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
    <div className="space-y-2">
      {suggestions.map((suggestion) => (
        <button
          key={`${suggestion.title}-${suggestion.prompt}`}
          type="button"
          onClick={() => onSuggestion(suggestion.prompt)}
          className="w-full border-2 border-black bg-white p-3 text-left text-xs text-black shadow-[2px_2px_0_0_rgba(18,18,18,0.16)] transition-transform hover:-translate-y-0.5"
        >
          <p className="font-black">{suggestion.title}</p>
          <p className="mt-1 font-medium leading-5 text-black/65">{suggestion.description}</p>
        </button>
      ))}
    </div>
  );
}

function CareerPathList({ paths }: { paths: HarnessAgentCareerPath[] }) {
  return (
    <div className="space-y-2">
      {paths.map((path) => (
        <Card key={path.title} className="rounded-none border-2 border-black bg-white shadow-none">
          <CardBody className="p-3">
            <div className="flex items-start gap-2">
              <Sparkles size={15} className="mt-1 shrink-0 text-[#D02020]" />
              <div className="min-w-0">
                <p className="text-sm font-black text-black">{path.title}</p>
                <p className="mt-1 text-[11px] font-semibold text-black/55">{path.industry}</p>
                <p className="mt-2 text-xs font-medium leading-5 text-black/70">{path.fit_reason}</p>
                <p className="mt-2 text-xs font-semibold text-black">{path.salary_range}</p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {path.search_keywords.map((keyword) => (
                    <Chip key={keyword} size="sm" className="border border-black bg-[#F0C020] text-[10px] text-black">
                      {keyword}
                    </Chip>
                  ))}
                </div>
              </div>
            </div>
          </CardBody>
        </Card>
      ))}
    </div>
  );
}

function JobCardList({ jobs }: { jobs: HarnessAgentJobCard[] }) {
  return (
    <div className="space-y-2">
      {jobs.map((job) => (
        <Card key={job.id} className="rounded-none border-2 border-black bg-white shadow-none">
          <CardBody className="p-3">
            <div className="flex items-start gap-2">
              <Briefcase size={15} className="mt-1 shrink-0 text-[#2060D0]" />
              <div className="min-w-0">
                <p className="text-sm font-black text-black">{job.company}</p>
                <p className="mt-1 text-xs font-semibold text-black/70">{job.title}</p>
                <p className="mt-1 text-[11px] font-medium text-black/55">
                  {[job.location, job.salary_text, job.source].filter(Boolean).join(" / ")}
                </p>
                {job.apply_url && (
                  <a
                    href={job.apply_url}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-block text-xs font-bold text-[#D02020] underline"
                  >
                    打开投递链接
                  </a>
                )}
              </div>
            </div>
          </CardBody>
        </Card>
      ))}
    </div>
  );
}

function ToolCallList({ calls }: { calls: HarnessAgentResponse["tool_calls"] }) {
  return (
    <div className="space-y-2">
      {calls.map((call, index) => {
        const presentation = presentHarnessToolCall(call);
        return (
          <details key={`${call.tool}-${index}`} className="border border-black/25 bg-white p-2 text-xs text-black/65">
            <summary className="flex cursor-pointer items-center gap-2 font-bold text-black">
              <Wrench size={13} />
              {call.tool}
            </summary>
            {presentation && <p className="mt-2 border-l-4 border-[#F0C020] pl-2 font-bold leading-5 text-black">{presentation}</p>}
            <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap bg-[#F0F0F0] p-2">
              {previewJson(call.result)}
            </pre>
          </details>
        );
      })}
    </div>
  );
}
