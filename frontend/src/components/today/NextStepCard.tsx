"use client";

import { useState } from "react";
import useSWR from "swr";
import { ArrowRight } from "lucide-react";

import Link from "next/link";
import { request } from "@/lib/api";
import { useAgentConnectionOptional } from "@/lib/agentConnection";
import { SHOWCASE } from "@/lib/showcase";
import { safeClientErrorMessage } from "@/lib/safe-error";

type Step = { key: string; title: string; reason: string; href: string; cta: string };
type Question = {
  key: string;
  question: string;
  options: Array<{ id: string; label: string }>;
  text: string;
  link?: { label: string; href: string } | null;
};
export type CareerNextStep = {
  stage: string;
  stage_label: string;
  next_step: Step | null;
  alternate: Step | null;
  questions: Question[];
};

const PATH = "/api/career/next-step";

/** 阶段、唯一的下一步和今天的问题。与 Agent 读到的是同一份规则结果（services/career_stage）。 */
export function NextStepCard({ rephrased = {} }: { rephrased?: Record<string, string> }) {
  const { data, mutate } = useSWR<CareerNextStep>(SHOWCASE ? null : PATH, (path: string) => request<CareerNextStep>(path));
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const agent = useAgentConnectionOptional();
  if (!data) return null;

  const answer = async (question: Question, choice: string, text = "") => {
    setBusy(question.key);
    setError("");
    try {
      const result = await request<{ next: CareerNextStep }>("/api/career/check-in", {
        method: "POST",
        body: JSON.stringify({ key: question.key, choice, text, question: question.question }),
      });
      await mutate(result.next, { revalidate: false });
    } catch (cause) {
      setError(safeClientErrorMessage(cause, "没保存上，请再试一次。"));
    } finally {
      setBusy("");
    }
  };

  const step = data.next_step;
  return (
    <section aria-labelledby="today-next-step" className="rounded-xl border border-[var(--border)] bg-[var(--surface)]">
      <div className="p-5">
        <p className="text-[12px] text-[var(--foreground-muted)]">你现在：{data.stage_label}</p>
        {step ? (
          <div className="mt-3 flex items-start justify-between gap-6">
            <div className="min-w-0">
              <h2 id="today-next-step" className="text-[17px] font-semibold tracking-tight text-[var(--foreground)]">{step.title}</h2>
              <p className="mt-1 text-[13px] leading-6 text-[var(--foreground-muted)]">{step.reason}</p>
            </div>
            {step.href === "#agent" ? (
              <button type="button" onClick={() => agent?.setOpen(true)} style={{ color: "var(--background)" }}
                className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-[var(--foreground)] px-3 py-1.5 text-[13px] font-medium">
                {step.cta}<ArrowRight size={13} />
              </button>
            ) : step.href !== "/" && (
              <Link href={step.href} style={{ color: "var(--background)" }}
                className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-[var(--foreground)] px-3 py-1.5 text-[13px] font-medium">
                {step.cta}<ArrowRight size={13} />
              </Link>
            )}
          </div>
        ) : (
          <h2 id="today-next-step" className="mt-3 text-[17px] font-semibold text-[var(--foreground)]">今天没有必须做的事</h2>
        )}
        {data.alternate && (data.alternate.href === "#agent" ? (
          <button type="button" onClick={() => agent?.setOpen(true)} className="mt-3 inline-block text-[12px] text-[var(--foreground-muted)] hover:text-[var(--foreground)]">
            或者：{data.alternate.title} →
          </button>
        ) : (
          <Link href={data.alternate.href} className="mt-3 inline-block text-[12px] text-[var(--foreground-muted)] hover:text-[var(--foreground)]">
            或者：{data.alternate.title} →
          </Link>
        ))}
      </div>

      {data.questions.length > 0 && (
        <div className="space-y-4 border-t border-[var(--border)] p-5">
          {data.questions.map((question) => (
            <div key={question.key}>
              <p className="text-[13px] text-[var(--foreground)]">{rephrased[question.key] || question.question}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {question.options.map((option) => (
                  <button key={option.id} type="button" disabled={busy === question.key}
                    onClick={() => void answer(question, option.id)}
                    className="rounded-lg border border-[var(--border)] px-3 py-1 text-[12px] text-[var(--foreground)] transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-50">
                    {option.label}
                  </button>
                ))}
                {question.text && (
                  <form className="flex min-w-[260px] flex-1 gap-2" onSubmit={(event) => {
                    event.preventDefault();
                    const value = (drafts[question.key] || "").trim();
                    if (value) void answer(question, "", value);
                  }}>
                    <input value={drafts[question.key] || ""} placeholder={question.text}
                      onChange={(event) => setDrafts((current) => ({ ...current, [question.key]: event.target.value }))}
                      className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-transparent px-3 py-1 text-[12px] outline-none focus:border-[var(--foreground-muted)]" />
                    <button type="submit" disabled={busy === question.key || !(drafts[question.key] || "").trim()}
                      className="rounded-lg border border-[var(--border)] px-3 py-1 text-[12px] disabled:opacity-40">保存</button>
                  </form>
                )}
                {question.link && (
                  <Link href={question.link.href} className="text-[12px] text-[var(--foreground-muted)] underline-offset-2 hover:underline">{question.link.label}</Link>
                )}
              </div>
            </div>
          ))}
          {error && <p role="alert" className="text-[12px] text-[var(--primary-red)]">{error}</p>}
        </div>
      )}
    </section>
  );
}
