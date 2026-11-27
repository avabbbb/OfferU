"use client";

import { useState } from "react";
import Link from "next/link";
import { Briefcase, Calendar, Check, ExternalLink, FileText, RotateCcw } from "lucide-react";

import { Button, Pill, type Tone } from "@/components/ui";
import { EVENT_KIND, JOB_STATUS, write, type EventKind, type JobStatus } from "@/lib/core";
import type { ToolExecutionState } from "@/lib/embeddedAgentStream";
import { extractOutputPanels } from "@/lib/agentToolPresentation";

const DOC_KIND_LABEL: Record<string, string> = {
  resume: "简历",
  evaluation: "岗位评估",
  research: "公司调研",
  apply_chat: "网申问答",
  email: "邮件草稿",
  review: "面试复盘",
  note: "笔记",
};

function scoreTone(score: number): Tone {
  if (score >= 80) return "green";
  if (score >= 65) return "blue";
  return "orange";
}

/**
 * Hark-style interactive output panels: turns real tool writes / evaluations in an Agent turn
 * into clickable mini-cards (Job, Event, Doc, Memory confirm, Undo strip) directly in the stream.
 */
export function AgentOutputPanels({
  executions,
  onPrompt,
}: {
  executions: Record<string, ToolExecutionState>;
  onPrompt?: (prompt: string, jobId?: number | null) => void;
}) {
  const model = extractOutputPanels(Object.values(executions));
  const [doneEvents, setDoneEvents] = useState<Record<number, boolean>>({});
  const [confirmedMemories, setConfirmedMemories] = useState<Record<number, boolean>>({});
  const [undoneChanges, setUndoneChanges] = useState<Record<number, boolean>>({});
  const [busyKey, setBusyKey] = useState("");
  const [error, setError] = useState("");

  const hasContent = model.jobs.length > 0
    || model.events.length > 0
    || model.docs.length > 0
    || model.pendingMemories.length > 0
    || model.changes.length > 0;
  if (!hasContent) return null;

  const markEventDone = async (id: number) => {
    setBusyKey(`event:${id}`);
    setError("");
    try {
      await write("save", { type: "event", id, data: { done: true } });
      setDoneEvents((prev) => ({ ...prev, [id]: true }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "标记完成失败");
    } finally {
      setBusyKey("");
    }
  };

  const confirmMemory = async (id: number) => {
    setBusyKey(`memory:${id}`);
    setError("");
    try {
      await write("save", { type: "memory", id, data: { confirmed: true } });
      setConfirmedMemories((prev) => ({ ...prev, [id]: true }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "确认记忆失败");
    } finally {
      setBusyKey("");
    }
  };

  const undo = async (changeId: number) => {
    setBusyKey(`undo:${changeId}`);
    setError("");
    try {
      await write("undo", { change_id: changeId });
      setUndoneChanges((prev) => ({ ...prev, [changeId]: true }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "撤销失败");
    } finally {
      setBusyKey("");
    }
  };

  return (
    <div className="space-y-2" data-testid="agent-output-panels">
      {model.jobs.map((job) => (
        <div key={`job-${job.id}`} className="ou-sheet space-y-2 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <Briefcase size={14} aria-hidden className="shrink-0 text-[var(--ou-text-secondary)]" />
              <span className="truncate text-xs font-semibold text-[var(--ou-text-primary)]">
                {[job.company, job.title].filter(Boolean).join(" · ")}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              {typeof job.score === "number" && <Pill tone={scoreTone(job.score)}>{job.score} 分</Pill>}
              {job.status && <Pill tone="gray">{JOB_STATUS[job.status as JobStatus] ?? job.status}</Pill>}
            </div>
          </div>
          {job.reason && (
            <p className="text-xs leading-relaxed text-[var(--ou-text-secondary)]">{job.reason}</p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/jobs/${job.id}`} className="ou-button ou-button-secondary ou-button-sm">
              查看岗位
            </Link>
            {onPrompt && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onPrompt(`请按岗位「${[job.company, job.title].filter(Boolean).join(" · ")}」（#${job.id}）的 JD 帮我定制一份简历。`, job.id)}
              >
                定制简历
              </Button>
            )}
          </div>
        </div>
      ))}

      {model.events.map((event) => {
        const isDone = Boolean(event.done || doneEvents[event.id]);
        return (
          <div key={`event-${event.id}`} className="ou-sheet space-y-2 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1.5">
                <Calendar size={14} aria-hidden className="shrink-0 text-[var(--ou-text-secondary)]" />
                <span className="truncate text-xs font-semibold text-[var(--ou-text-primary)]">{event.title}</span>
              </div>
              {event.kind && <Pill tone="orange">{EVENT_KIND[event.kind as EventKind] ?? event.kind}</Pill>}
            </div>
            {event.at && (
              <p className="text-xs text-[var(--ou-text-secondary)]">{event.at.replace("T", " ")}</p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {!isDone ? (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busyKey === `event:${event.id}`}
                  onClick={() => void markEventDone(event.id)}
                >
                  <Check size={13} aria-hidden />
                  标记完成
                </Button>
              ) : (
                <Pill tone="green">已完成</Pill>
              )}
              {event.url && (
                <a
                  href={event.url}
                  target="_blank"
                  rel="noreferrer"
                  className="ou-button ou-button-ghost ou-button-sm"
                >
                  <ExternalLink size={13} aria-hidden />
                  打开链接
                </a>
              )}
            </div>
          </div>
        );
      })}

      {model.docs.map((doc) => {
        const target = doc.kind === "resume" ? `/resume/${doc.id}` : doc.jobId ? `/jobs/${doc.jobId}` : "/resume";
        return (
          <div key={`doc-${doc.id}`} className="ou-sheet flex flex-wrap items-center justify-between gap-2 p-3">
            <div className="flex min-w-0 items-center gap-1.5">
              <FileText size={14} aria-hidden className="shrink-0 text-[var(--ou-text-secondary)]" />
              <span className="truncate text-xs font-semibold text-[var(--ou-text-primary)]">{doc.title}</span>
              <Pill tone="purple">{DOC_KIND_LABEL[doc.kind] ?? doc.kind}</Pill>
            </div>
            <Link href={target} className="ou-button ou-button-secondary ou-button-sm">
              打开文档
            </Link>
          </div>
        );
      })}

      {model.pendingMemories.length > 0 && (
        <div className="ou-sheet space-y-2 p-3">
          <p className="text-xs font-medium text-[var(--ou-text-secondary)]">新记录的待确认记忆</p>
          <div className="space-y-1.5">
            {model.pendingMemories.map((memory) => {
              const confirmed = Boolean(confirmedMemories[memory.id]);
              return (
                <div key={`mem-${memory.id}`} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs text-[var(--ou-text-primary)]">{memory.title}</span>
                  {confirmed ? (
                    <Pill tone="green">已确认</Pill>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busyKey === `memory:${memory.id}`}
                      onClick={() => void confirmMemory(memory.id)}
                    >
                      <Check size={13} aria-hidden />
                      确认生效
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {model.changes.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-[var(--ou-text-secondary)]">
          {model.changes.map((change) => (
            <span key={`chg-${change.changeId}`} className="inline-flex items-center gap-1">
              <span>已写入 {change.summary}</span>
              {undoneChanges[change.changeId] ? (
                <Pill tone="gray">已撤销</Pill>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busyKey === `undo:${change.changeId}`}
                  onClick={() => void undo(change.changeId)}
                >
                  <RotateCcw size={12} aria-hidden />
                  撤销
                </Button>
              )}
            </span>
          ))}
        </div>
      )}

      {error && <p role="alert" className="text-xs text-[var(--ou-tone-red-text)]">{error}</p>}
    </div>
  );
}
