"use client";

// 排队托盘：Run 在跑时按 Tab 排进来的消息，这一轮结束后依次发出（lib/agentSteerQueue）。
// 每条可以「插话」（Run 在跑时直接交给它）/「发送」（空闲时）、拉回输入框改、删掉。

import { CornerDownRight, PenLine, Send, X, Zap } from "lucide-react";
import type { QueuedMessage } from "@/lib/agentSteerQueue";

export function AgentQueueTray({ items, busy, paused = false, onSend, onEdit, onRemove }: {
  items: readonly QueuedMessage[];
  /** 有 Run 在跑：「插话」；否则「发送」。 */
  busy: boolean;
  /** 上一轮出错 / 在等用户处理：先不自动发。 */
  paused?: boolean;
  onSend: (id: string) => void;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  if (!items.length) return null;
  const waiting = items.some((item) => !item.armed);
  return (
    <div className="agent-queue-tray" data-testid="agent-queue-tray">
      <p className="agent-queue-tray__head">
        排队 · {items.length}
        <span className="agent-queue-tray__hint">{busy ? "这一轮结束后依次发送" : paused ? "已暂停，点发送继续" : waiting ? "上次留下的，点发送才会发" : "依次发送中"}</span>
      </p>
      <ul className="agent-queue-tray__list" aria-label="排队的消息">
        {items.map((item) => (
          <li key={item.id} className="agent-queue-tray__row" data-testid="agent-queue-item" data-armed={item.armed || undefined}>
            <CornerDownRight size={12} aria-hidden className="agent-queue-tray__icon" />
            <span className="agent-queue-tray__text" title={item.text}>{item.text}</span>
            <button type="button" className="agent-queue-tray__btn" onClick={() => onSend(item.id)}
              aria-label={busy ? "现在插话" : "现在发送"} title={busy ? "现在插话（交给正在跑的这一轮）" : "现在发送"} data-testid="agent-queue-send">
              {busy ? <Zap size={12} aria-hidden /> : <Send size={12} aria-hidden />}
            </button>
            <button type="button" className="agent-queue-tray__btn" onClick={() => onEdit(item.id)} aria-label="拉回输入框修改" title="拉回输入框修改" data-testid="agent-queue-edit">
              <PenLine size={12} aria-hidden />
            </button>
            <button type="button" className="agent-queue-tray__btn" onClick={() => onRemove(item.id)} aria-label="从队列删除" title="从队列删除" data-testid="agent-queue-remove">
              <X size={12} aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
