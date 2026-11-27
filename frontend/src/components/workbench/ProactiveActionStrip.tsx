"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR, { mutate as globalMutate } from "swr";
import { ArrowRight, CheckCheck, Sparkles } from "lucide-react";

import { Button, Pill, type Tone } from "@/components/ui";
import { agentSupportApi, type ProactiveAction, type ProactiveSnapshot } from "@/lib/api";
import { composeToAgent } from "@/lib/agentCompose";
import { write } from "@/lib/core";

const PRIORITY_META: Record<ProactiveAction["priority"], { label: string; tone: Tone }> = {
  urgent: { label: "优先处理", tone: "orange" },
  high: { label: "建议先做", tone: "purple" },
  normal: { label: "推进下一步", tone: "gray" },
};

/**
 * Hark-style Proactive Action Buttons: surfaces concrete, evidence-backed next actions
 * derived from real OfferU records and executes them in one tap (direct deterministic write
 * for memory confirmation, or dispatching a scoped prompt directly to the Agent).
 */
export function ProactiveActionStrip({
  variant = "cards",
  maxItems = 3,
  onRunPrompt,
  initialActions,
}: {
  variant?: "cards" | "compact";
  maxItems?: number;
  /** Provided inside AgentPanel so clicks send immediately; omitted on TodayPage to open Agent via composeToAgent. */
  onRunPrompt?: (prompt: string, jobId?: number | null) => void;
  /** Optional injected actions (tests). */
  initialActions?: ProactiveAction[];
}) {
  const { data, mutate } = useSWR<ProactiveSnapshot>(
    initialActions ? null : "agent-proactive",
    () => agentSupportApi.proactive(),
    { refreshInterval: 8000, revalidateOnFocus: true },
  );
  const [busyId, setBusyId] = useState("");
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");

  const actions = (initialActions ?? data?.actions ?? []).slice(0, maxItems);
  if (actions.length === 0) return null;

  const execute = async (action: ProactiveAction) => {
    setError("");
    setFeedback("");
    if (action.direct_action === "confirm_memories" && action.record_ids?.length) {
      setBusyId(action.id);
      try {
        for (const id of action.record_ids) {
          await write("save", { type: "memory", id, data: { confirmed: true } });
        }
        setFeedback(`已确认 ${action.record_ids.length} 条记忆生效，可在「最近改动」撤销。`);
        await mutate();
        await globalMutate("agent-proactive");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "确认记忆失败，请稍后重试。");
      } finally {
        setBusyId("");
      }
      return;
    }

    if (onRunPrompt) {
      onRunPrompt(action.prompt, action.job_id);
      return;
    }
    composeToAgent({ message: action.prompt, jobId: action.job_id });
  };

  if (variant === "compact") {
    return (
      <div className="w-full space-y-2 text-left" data-testid="proactive-actions-compact">
        <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--ou-text-secondary)]">
          <Sparkles size={13} aria-hidden className="text-[var(--ou-color-purple)]" />
          <span>为你准备好的下一步</span>
        </div>
        <div className="space-y-2">
          {actions.map((action, index) => {
            const meta = PRIORITY_META[action.priority];
            const busy = busyId === action.id;
            return (
              <div key={action.id} className="ou-sheet flex flex-col gap-2 p-3" data-testid={`proactive-action-${action.kind}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="text-xs font-semibold text-[var(--ou-text-primary)]">{action.title}</p>
                    <p className="text-xs leading-relaxed text-[var(--ou-text-secondary)]">{action.reason}</p>
                  </div>
                  <Pill tone={meta.tone}>{meta.label}</Pill>
                </div>
                <div className="flex items-center justify-end gap-2">
                  <Button
                    variant={index === 0 ? "primary" : "secondary"}
                    size="sm"
                    disabled={Boolean(busyId)}
                    onClick={() => void execute(action)}
                  >
                    {action.direct_action === "confirm_memories" ? <CheckCheck size={13} aria-hidden /> : <ArrowRight size={13} aria-hidden />}
                    {busy ? "处理中…" : action.button_label}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
        {feedback && <p role="status" className="text-xs text-[var(--ou-tone-green-text)]">{feedback}</p>}
        {error && <p role="alert" className="text-xs text-[var(--ou-tone-red-text)]">{error}</p>}
      </div>
    );
  }

  return (
    <section className="space-y-3" aria-label="Agent 主动建议" data-testid="proactive-actions-strip">
      <div className="flex items-center gap-2">
        <Sparkles size={14} aria-hidden className="text-[var(--ou-color-purple)]" />
        <h2 className="text-xs font-semibold text-[var(--ou-text-secondary)]">建议现在处理</h2>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        {actions.map((action, index) => {
          const meta = PRIORITY_META[action.priority];
          const busy = busyId === action.id;
          return (
            <div key={action.id} className="ou-sheet flex flex-col justify-between gap-3 p-4" data-testid={`proactive-action-${action.kind}`}>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Pill tone={meta.tone}>{meta.label}</Pill>
                  {action.route && action.route !== "/" && (
                    <Link href={action.route} className="text-xs text-[var(--ou-text-secondary)] hover:text-[var(--ou-text-primary)]">
                      查看
                    </Link>
                  )}
                </div>
                <p className="text-sm font-semibold text-[var(--ou-text-primary)]">{action.title}</p>
                <p className="text-xs leading-relaxed text-[var(--ou-text-secondary)]">{action.reason}</p>
              </div>
              <div className="flex items-center justify-end">
                <Button
                  variant={index === 0 ? "primary" : "secondary"}
                  size="sm"
                  disabled={Boolean(busyId)}
                  onClick={() => void execute(action)}
                >
                  {action.direct_action === "confirm_memories" ? <CheckCheck size={13} aria-hidden /> : <ArrowRight size={13} aria-hidden />}
                  {busy ? "处理中…" : action.button_label}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
      {feedback && <p role="status" className="text-xs text-[var(--ou-tone-green-text)]">{feedback}</p>}
      {error && <p role="alert" className="text-xs text-[var(--ou-tone-red-text)]">{error}</p>}
    </section>
  );
}
