/**
 * 页面把一段意图交给 OfferU Agent 的唯一通道（例如简历画布上攒好的修改意见）。
 *
 * Agent 面板是按需挂载的：事件发出时它可能还不存在。所以消息先进邮箱，
 * 面板挂载时取走，已挂载的面板通过事件立即收到。面板按 D-1 规则发送：
 * 正在运行就引导或排队，绝不丢、绝不锁。
 */

export interface AgentComposeRequest {
  message: string;
  skillId?: string;
}

export const AGENT_COMPOSE_EVENT = "offeru-agent-compose";

const mailbox: AgentComposeRequest[] = [];

export function composeToAgent(request: AgentComposeRequest) {
  const message = request.message.trim();
  if (!message) return;
  mailbox.push({ ...request, message });
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(AGENT_COMPOSE_EVENT));
  }
}

export function drainAgentCompose(): AgentComposeRequest[] {
  return mailbox.splice(0, mailbox.length);
}
