// The stable OfferU Agent Run UI protocol — port of
// backend/app/services/agent_runtime.py canonical_agent_run_event and
// routes/main_agent.py _runtime_response_from_run / _runtime_turn_is_finished.
// SSE event names and payload fields must match what frontend/src/lib/api.ts
// (agentRuntimeApi.start) and AgentPanel already consume.

import type { Json } from "../types";
import type { AgentRun } from "./run-state";

export const CANONICAL_AGENT_RUN_EVENT_TYPES = new Set([
  "run.started", "assistant.delta", "assistant.message", "reasoning.status",
  "tool.started", "tool.progress", "tool.completed", "tool.failed",
  "approval.requested", "approval.resolved", "task.progress",
  "run.completed", "run.failed", "run.cancelled", "run.blocked",
]);

const RUN_EVENT_MAP: Record<string, string> = {
  "run.created": "run.started",
  "run.started": "run.started",
  "runtime.session_started": "reasoning.status",
  "runtime.session_restarted": "reasoning.status",
  "runtime.session_stopped": "reasoning.status",
  "runtime.agent_started": "reasoning.status",
  "runtime.agent_settled": "reasoning.status",
  "runtime.turn_started": "reasoning.status",
  "runtime.turn_completed": "reasoning.status",
  "runtime.retry_started": "reasoning.status",
  "runtime.retry_completed": "reasoning.status",
  "runtime.compaction_started": "reasoning.status",
  "runtime.compaction_completed": "reasoning.status",
  "pi.agent_start": "reasoning.status",
  "pi.agent_settled": "reasoning.status",
  "pi.turn_start": "reasoning.status",
  "pi.turn_end": "reasoning.status",
  "message.delta": "assistant.delta",
  "assistant.delta": "assistant.delta",
  "message.completed": "assistant.message",
  "assistant.message": "assistant.message",
  "reasoning.status": "reasoning.status",
  "runtime.agent_completed": "assistant.message",
  "pi.agent_end": "assistant.message",
  "runtime.tool_started": "tool.started",
  "kernel.agent_start": "reasoning.status",
  "kernel.turn_start": "reasoning.status",
  "kernel.turn_end": "reasoning.status",
  "kernel.agent_end": "reasoning.status",
  "tool.started": "tool.started",
  "pi.tool_execution_start": "tool.started",
  "runtime.tool_progress": "tool.progress",
  "tool.progress": "tool.progress",
  "runtime.tool_completed": "tool.completed",
  "tool.completed": "tool.completed",
  "pi.tool_execution_end": "tool.completed",
  "runtime.tool_failed": "tool.failed",
  "tool.failed": "tool.failed",
  "operation.started": "tool.started",
  "operation.completed": "tool.completed",
  "operation.failed": "tool.failed",
  "action.pending": "approval.requested",
  "input.required": "approval.requested",
  "input.answered": "approval.resolved",
  "input.steered": "reasoning.status",
  "run.waiting_input": "approval.requested",
  "approval.requested": "approval.requested",
  "approval.resolved": "approval.resolved",
  "task.progress": "task.progress",
  "run.completed": "run.completed",
  "run.blocked": "run.blocked",
  "run.failed": "run.failed",
  "runtime.failed": "run.failed",
  "runtime.fatal": "run.failed",
  "run.cancelled": "run.cancelled",
  "run.aborted": "run.cancelled",
};

/** A raw host event as published to stream listeners / stored in the run log. */
export interface RawRunEvent {
  run_id?: string;
  type: string;
  payload?: Json;
  sequence?: number;
  event_id?: string;
  timestamp?: string;
  durable?: boolean;
  [key: string]: unknown;
}

export interface CanonicalRunEvent extends RawRunEvent {
  type: string;
  provider_event: string;
  payload: Json;
}

export function canonicalAgentRunEvent(event: RawRunEvent): CanonicalRunEvent {
  const raw = String(event.type || "runtime.event");
  const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload) ? event.payload : {};
  let mapped: string | undefined = RUN_EVENT_MAP[raw];
  if (raw === "run.turn_finished") {
    const status = String(payload.status || "").toLowerCase();
    mapped = ({ completed: "run.completed", failed: "run.failed", cancelled: "run.cancelled", blocked: "run.blocked" } as Record<string, string>)[status] || "reasoning.status";
  }
  if (raw === "runtime.blocked") mapped = "run.blocked";
  if (!mapped || !CANONICAL_AGENT_RUN_EVENT_TYPES.has(mapped)) mapped = "reasoning.status";
  return { ...event, type: mapped, provider_event: raw, payload: { ...payload, provider_event: raw } };
}

export const UNAVAILABLE_SKILL_DEFAULTS = { group: "system", status: "unavailable", featured: false, order: 9999, missing_capabilities: [] as string[] };

/** routes/main_agent.py _runtime_response_from_run: the final `message` frame of a followed run. */
export function runtimeResponseFromRun(run: AgentRun, conversationTitle = ""): Json {
  const finalResult = run.final_result && typeof run.final_result === "object" ? run.final_result : {};
  const activeSkill = finalResult.active_skill && typeof finalResult.active_skill === "object"
    ? finalResult.active_skill
    : { ...(run.skill_snapshot || {}), ...UNAVAILABLE_SKILL_DEFAULTS };
  const status = String(run.status || "");
  const failure = String(run.failure_reason || "").trim();
  const response: Json = {
    ok: !["failed", "cancelled", "interrupted"].includes(status),
    run,
    assistant_message: String(finalResult.assistant_message || ""),
    pending_action_count: Number(finalResult.pending_action_count || 0),
    active_skill: activeSkill,
    guardian: finalResult.guardian && typeof finalResult.guardian === "object" ? finalResult.guardian : {},
    conversation_id: String(run.conversation_id || ""),
    conversation_title: conversationTitle,
  };
  if (failure) response.errors = [failure];
  return response;
}

/** _runtime_turn_is_finished: terminal status, and for cursor_v1 runs the turn_finished flag. */
export function runtimeTurnIsFinished(run: AgentRun): boolean {
  if (!["completed", "failed", "cancelled", "interrupted"].includes(String(run.status || ""))) return false;
  const runtime = run.llm_runtime || {};
  if (runtime.stream_protocol === "cursor_v1") return (run.final_result || {}).turn_finished === true;
  return true;
}
