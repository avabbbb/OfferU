"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Card, CardBody, Textarea } from "@nextui-org/react";
import { ArrowLeft, ArrowRight, Bot, SkipForward } from "lucide-react";
import { BulletConfirmCard, type BulletCandidate } from "./BulletConfirmCard";
import { profileApi } from "@/lib/api";
import { safeClientErrorMessage } from "@/lib/safe-error";

export type ChatTopic = "education" | "internship" | "project" | "activity" | "skill";

interface ChatMessage {
  id: string;
  role: "ai" | "user";
  content: string;
  bullet?: BulletCandidate;
}

interface ChatPanelProps {
  topic: ChatTopic;
  topicLabel: string;
  onNextTopic: () => void;
  onPrevTopic: () => void;
  onBulletConfirmed: () => void;
  isLastTopic: boolean;
  isFirstTopic: boolean;
}

const TOPIC_GREETINGS: Record<ChatTopic, string> = {
  education: "先聊教育经历。你不用只写学校专业，可以补：绩点/排名、核心课程、论文/研究、奖学金、和目标岗位有关的一门课。",
  internship: "聊实习或工作经历时，按「公司/岗位 - 你负责什么 - 做出了什么结果」说就行。数字不确定也可以先给范围。",
  project: "聊项目经历时，先说背景、你的角色、具体动作和结果。作品链接、用户数、比赛名、上线情况都很有用。",
  activity: "聊校园、社团、志愿者或比赛经历时，重点不是头衔，而是你拉了什么资源、组织了多少人、解决了什么问题。",
  skill: "最后补技能和证书。可以按工具、方法、语言、证书、AI 工具使用经验来讲，不需要一次说完整。",
};

const PROMPT_SCAFFOLDS: Record<ChatTopic, { label: string; text: string }[]> = {
  education: [
    {
      label: "课程亮点",
      text: "我在学校/专业里比较能证明目标岗位能力的是：课程/论文/研究主题是...我做了...结果/成绩是...",
    },
    {
      label: "成绩证明",
      text: "我的 GPA/排名/奖学金情况是...如果和岗位有关，我想突出的是...",
    },
  ],
  internship: [
    {
      label: "实习 STAR",
      text: "我在...公司/组织做...岗位，当时目标是...我负责...最后带来了...数据/反馈是...",
    },
    {
      label: "补数字",
      text: "这段经历里可以量化的是：人数...金额...增长/下降...周期...排名/覆盖范围...",
    },
  ],
  project: [
    {
      label: "项目框架",
      text: "项目叫...背景是...我是...角色，主要做了...上线/参赛/交付结果是...用户数/成绩/反馈是...",
    },
    {
      label: "作品证明",
      text: "这个项目能拿出来看的东西有：链接/报告/原型/视频/代码...我最想让面试官看到的是...",
    },
  ],
  activity: [
    {
      label: "组织经历",
      text: "我在...活动/社团里负责...我协调了...人/资源，最后活动规模/赞助/参与/反馈是...",
    },
    {
      label: "比赛经历",
      text: "我参加过...比赛，担任...角色，负责...最后获得...名次/奖项/评审反馈...",
    },
  ],
  skill: [
    {
      label: "工具清单",
      text: "我会的工具/技能有：...熟练度分别是...其中最适合目标岗位的是...",
    },
    {
      label: "AI 工具",
      text: "我用过的 AI/数据/办公工具有...用它们完成过...效率或结果变化是...",
    },
  ],
};

const TOPIC_PLACEHOLDERS: Record<ChatTopic, string> = {
  education: "写学校/专业之外的亮点：课程、成绩、论文、奖学金、研究...",
  internship: "按公司/岗位、你负责什么、结果数字来写...",
  project: "按背景、角色、动作、结果、作品链接来写...",
  activity: "写活动/社团/比赛里的资源、规模、贡献和结果...",
  skill: "写工具、方法、语言、证书、AI 工具和熟练度...",
};

function toBulletCandidate(payload: any): BulletCandidate | null {
  if (!payload || typeof payload !== "object") return null;
  const content = payload.content_json && typeof payload.content_json === "object" ? payload.content_json : {};
  const text =
    String(content.bullet || payload.description || payload.content || "").trim() ||
    String(payload.title || "待确认条目").trim();

  if (typeof payload.session_id !== "number" || typeof payload.index !== "number") {
    return null;
  }

  return {
    session_id: payload.session_id,
    bullet_index: payload.index,
    title: String(payload.title || "待确认条目"),
    description: text,
    confidence: Number(payload.confidence ?? 0.7),
  };
}

export function ChatPanel({
  topic,
  topicLabel,
  onNextTopic,
  onPrevTopic,
  onBulletConfirmed,
  isLastTopic,
  isFirstTopic,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [sessionId, setSessionId] = useState<number | undefined>(undefined);
  const idRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setMessages([
      {
        id: `msg-${++idRef.current}`,
        role: "ai",
        content: TOPIC_GREETINGS[topic],
      },
    ]);
    setSessionId(undefined);
    setText("");
    abortRef.current?.abort();
  }, [topic]);

  const pushMessage = useCallback((role: "ai" | "user", content: string) => {
    setMessages((prev) => [...prev, { id: `msg-${++idRef.current}`, role, content }]);
  }, []);

  // 跳过建议：从对话中移除该候选卡片（用户明确不想采纳）。
  const handleSkipBullet = useCallback((id: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== id));
  }, []);

  const handleSend = useCallback(async () => {
    const content = text.trim();
    if (!content || isTyping) return;

    setText("");
    pushMessage("user", content);
    setIsTyping(true);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await profileApi.chat({
        topic,
        message: content,
        session_id: sessionId,
      });

      if (!res.ok) {
        throw new Error(`API ${res.status}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("无法读取响应流");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        if (controller.signal.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split(/\r?\n\r?\n/);
        buffer = chunks.pop() || "";

        for (const chunk of chunks) {
          const lines = chunk.trim().split(/\r?\n/);
          let eventType = "";
          let dataLine = "";

          for (const line of lines) {
            if (line.startsWith("event:")) eventType = line.slice(6).trim();
            if (line.startsWith("data:")) dataLine = line.slice(5).trim();
          }

          if (!dataLine) continue;

          try {
            const parsed = JSON.parse(dataLine);

            if (eventType === "ai_message") {
              const aiText = String(parsed.content || "").trim();
              if (aiText) pushMessage("ai", aiText);
            }

            if (eventType === "bullet_candidate") {
              const bullet = toBulletCandidate(parsed);
              if (bullet) {
                setMessages((prev) => [
                  ...prev,
                  {
                    id: `msg-${++idRef.current}`,
                    role: "ai",
                    content: "",
                    bullet,
                  },
                ]);
              }
            }

            if (typeof parsed.session_id === "number") {
              setSessionId(parsed.session_id);
            }

            if (eventType === "error") {
              pushMessage(
                "ai",
                `⚠️ ${safeClientErrorMessage(parsed.message || parsed.detail, "请求失败")}`,
              );
            }
          } catch {
            // 忽略单个坏事件
          }
        }
      }

      reader.releaseLock();
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        pushMessage("ai", "⚠️ 网络错误，请稍后重试");
      }
    } finally {
      setIsTyping(false);
    }
  }, [isTyping, pushMessage, sessionId, text, topic]);

  return (
    <Card className="h-full bg-white/5 border border-white/10 flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/10">
        <Bot size={18} className="text-blue-400" />
        <span className="text-sm font-medium text-white">AI 对话引导 · {topicLabel}</span>
      </div>

      <CardBody className="flex-1 min-h-0 overflow-y-auto gap-3">
        {messages.map((msg) => {
          if (msg.bullet) {
            return (
              <BulletConfirmCard
                key={msg.id}
                bullet={msg.bullet}
                onConfirmed={onBulletConfirmed}
                onSkipped={() => handleSkipBullet(msg.id)}
              />
            );
          }

          const mine = msg.role === "user";
          return (
            <div key={msg.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[88%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap ${mine ? "bg-blue-500 text-white" : "bg-white/10 text-white/85"}`}>
                {msg.content}
              </div>
            </div>
          );
        })}
      </CardBody>

      <div className="px-4 pb-3 pt-2 border-t border-white/10 space-y-2">
        <div className="flex flex-wrap gap-2">
          {PROMPT_SCAFFOLDS[topic].map((prompt) => (
            <Button
              key={prompt.label}
              size="sm"
              variant="flat"
              className="h-7 bg-white/10 px-2 text-xs text-white/70"
              onPress={() => setText(prompt.text)}
            >
              {prompt.label}
            </Button>
          ))}
        </div>
        <div className="flex items-end gap-2">
          <Textarea
            value={text}
            onValueChange={setText}
            minRows={1}
            maxRows={4}
            placeholder={TOPIC_PLACEHOLDERS[topic]}
            variant="bordered"
            classNames={{
              input: "text-sm text-white/90",
              inputWrapper: "bg-white/5 border-white/15",
            }}
          />
          <Button color="primary" isLoading={isTyping} onPress={handleSend}>
            发送
          </Button>
        </div>

        <div className="flex items-center justify-between">
          <Button
            size="sm"
            variant="light"
            startContent={<ArrowLeft size={14} />}
            isDisabled={isFirstTopic}
            onPress={onPrevTopic}
          >
            上一步
          </Button>

          <Button
            size="sm"
            variant="flat"
            startContent={<SkipForward size={14} />}
            className="text-white/50"
            onPress={onNextTopic}
          >
            跳过主题
          </Button>

          <Button
            size="sm"
            color="primary"
            endContent={<ArrowRight size={14} />}
            isDisabled={isLastTopic}
            onPress={onNextTopic}
          >
            {isLastTopic ? "完成" : "下一主题"}
          </Button>
        </div>
      </div>
    </Card>
  );
}
