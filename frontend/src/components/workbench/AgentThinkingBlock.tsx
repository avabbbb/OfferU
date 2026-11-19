"use client";

// 思考块：模型的思考过程（reasoning.delta，只在线推送、不落盘）。
// 思考时展开并计时；正文一开始（endedAt 有值）就自动收起成「已思考 N 秒」，用户手动展开 / 收起后不再自动改。

import { ChevronRight, Sparkles } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { thinkingLabel } from "@/lib/agentStreaming";

export function AgentThinkingBlock({ text, startedAt, endedAt }: {
  text: string;
  /** 开始时间（ms）。 */
  startedAt: number;
  /** 结束时间（ms）；null = 还在思考。 */
  endedAt: number | null;
}) {
  const thinking = endedAt == null;
  const [open, setOpen] = useState(thinking);
  const userToggled = useRef(false);
  const [now, setNow] = useState(() => Date.now());
  const bodyRef = useRef<HTMLDivElement>(null);

  // 计时：只在思考中每秒走一次。
  useEffect(() => {
    if (!thinking) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [thinking]);

  // 正文开始 → 自动收起（除非用户自己动过）。
  useEffect(() => {
    if (!thinking && !userToggled.current) setOpen(false);
  }, [thinking]);

  // 思考中跟住最新一行。
  useLayoutEffect(() => {
    if (thinking && open && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [text, thinking, open]);

  const label = thinkingLabel(startedAt, endedAt, now);
  return (
    <div className="agent-thinking" data-state={thinking ? "active" : "done"} data-testid="agent-thinking">
      <button type="button" className="agent-thinking__head" aria-expanded={open}
        onClick={() => { userToggled.current = true; setOpen((value) => !value); }}>
        <Sparkles size={12} aria-hidden className="agent-thinking__icon" />
        <span className={thinking ? "agent-thinking__label ou-shimmer" : "agent-thinking__label"}>{label}</span>
        <ChevronRight size={12} aria-hidden className="agent-thinking__chevron" />
      </button>
      {open && (
        <div ref={bodyRef} className="agent-thinking__body custom-scrollbar" data-testid="agent-thinking-body">{text}</div>
      )}
    </div>
  );
}
