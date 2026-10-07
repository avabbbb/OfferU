"use client";

import Link from "next/link";
import { Button, Spinner } from "@heroui/react";
import { ArrowRight } from "lucide-react";

/**
 * One "what now" for the Job Workspace, projected from the backend
 * pre-application state machine (`stage`) plus the Role Intelligence task.
 * It never invents progress: every branch maps to a real stage, and every
 * stuck branch offers a way out that does not depend on the AI finishing.
 */
export type JobNextStepAction =
  | { kind: "scroll"; target: string; label: string }
  | { kind: "link"; href: string; label: string }
  | { kind: "run"; run: () => void; label: string; busy?: boolean };

type Props = {
  stage: string;
  loading: boolean;
  taskStatus?: string;
  taskError?: string;
  canRetryTask: boolean;
  hasResumeProposal: boolean;
  interviewFirst: boolean;
  jobId: number;
  preparing: boolean;
  onRetryTask: () => void;
  onPrepareDecision: () => void;
  onManualDecision: () => void;
  onOpenResumeWorkspace: () => void;
};

type Step = {
  title: string;
  body: string;
  tone: "action" | "waiting" | "blocked" | "done";
  primary?: JobNextStepAction;
  secondary?: JobNextStepAction;
};

const CONFIG_ERROR = /api\s*key|未配置|provider|runtime|认证|unauthor|401|403/i;

export function scrollToWorkspaceSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function resolveStep(p: Props): Step {
  const manual: JobNextStepAction = { kind: "run", run: p.onManualDecision, label: "不用 AI，我自己决定" };
  const taskFailed = p.taskStatus === "failed" || p.taskStatus === "blocked";
  const taskActive = p.taskStatus === "queued" || p.taskStatus === "running";

  if (p.interviewFirst) {
    return {
      title: "准备面试",
      body: "已进入面试阶段。先看岗位情报里的证据缺口，再针对缺口练习。",
      tone: "action",
      primary: { kind: "scroll", target: "role-intelligence-panel", label: "查看缺口与练习方向" },
    };
  }

  switch (p.stage) {
    case "needs_job_description":
      return { title: "缺少职位描述", body: "没有 JD 就无法分析岗位要求。重新保存这个岗位时粘贴完整职位描述。", tone: "blocked", primary: { kind: "link", href: "/jobs", label: "回到机会列表" } };
    case "needs_profile_evidence":
      return { title: "先补充档案", body: "档案里还没有已确认的经历，OfferU 无法判断你能证明什么。", tone: "blocked", primary: { kind: "link", href: "/profile", label: "去补充档案" } };
    case "needs_research":
    case "research_running":
      if (taskFailed) {
        const configIssue = CONFIG_ERROR.test(p.taskError || "");
        return {
          title: configIssue ? "岗位情报没跑起来：缺少可用的 AI 配置" : "岗位情报准备失败",
          body: configIssue ? "在设置里连接模型或本机 Agent，然后回来重试。" : (p.taskError || "任务失败，可以重试。"),
          tone: "blocked",
          primary: configIssue
            ? { kind: "link", href: "/settings", label: "去设置" }
            : p.canRetryTask ? { kind: "run", run: p.onRetryTask, label: "重试" } : { kind: "link", href: "/settings", label: "检查设置" },
          secondary: configIssue && p.canRetryTask ? { kind: "run", run: p.onRetryTask, label: "已配置，重试" } : undefined,
        };
      }
      return {
        title: "正在准备岗位情报",
        body: taskActive || p.stage === "research_running" ? "OfferU 正在对比同类岗位和你的档案，完成后这里会提示你审核。" : "岗位情报还没开始。",
        tone: "waiting",
      };
    case "research_failed":
      return { title: "调研失败", body: "这次调研没有拿到可用证据。可以重试岗位情报，或者直接自己决定。", tone: "blocked", primary: p.canRetryTask ? { kind: "run", run: p.onRetryTask, label: "重试" } : { kind: "link", href: "/settings", label: "检查设置" } };
    case "research_needs_review":
      return { title: "审核调研证据", body: "AI 找到的证据还不能直接用。看一眼来源，接受后才会进入投前判断。", tone: "action", primary: { kind: "scroll", target: "job-research-handback", label: "去审核证据" } };
    case "research_rejected":
      return { title: "你拒绝了这次调研", body: "需要一份你认可的调研才能进入投前判断。可以重新跑岗位情报。", tone: "blocked", primary: p.canRetryTask ? { kind: "run", run: p.onRetryTask, label: "重新调研" } : { kind: "scroll", target: "job-research-handback", label: "查看调研" } };
    case "needs_decision":
      return { title: "生成投前建议", body: "证据已确认。让 AI 给出投不投的建议，最后由你确认。", tone: "action", primary: { kind: "run", run: p.onPrepareDecision, label: "生成建议", busy: p.preparing }, secondary: manual };
    case "needs_decision_review":
      return { title: "确认投不投", body: "AI 的建议已就绪。确认或改成你的决定后，才能进入简历定制。", tone: "action", primary: { kind: "scroll", target: "pre-application-decision", label: "去确认决定" } };
    case "completed_no_go":
      return { title: "已决定不投", body: "这个岗位的准备已结束。", tone: "done" };
    case "completed_insufficient_evidence":
      return { title: "证据不足，暂不投", body: "补充档案后可以重新判断。", tone: "done", primary: { kind: "link", href: "/profile", label: "去补充档案" } };
    case "ready_for_resume_proposal":
      return { title: "定制这份简历", body: "已决定投递。下一步按这个岗位生成简历修改提案。", tone: "action", primary: { kind: "link", href: `/optimize?job_ids=${p.jobId}`, label: "开始简历定制" } };
    case "resume_proposal_ready":
      return p.hasResumeProposal
        ? { title: "审核简历提案", body: "逐条看修改和证据，接受后打开这个岗位专属的简历。", tone: "action", primary: { kind: "scroll", target: "resume-proposal", label: "去审核提案" }, secondary: { kind: "run", run: p.onOpenResumeWorkspace, label: "打开岗位简历" } }
        : { title: "正在生成简历提案", body: "完成后会出现在材料区。", tone: "waiting" };
    default:
      return { title: "正在读取岗位状态", body: "", tone: "waiting" };
  }
}

function ActionButton({ action, primary }: { action: JobNextStepAction; primary: boolean }) {
  const className = primary
    ? "bauhaus-button bauhaus-button-red !px-4 !py-2.5 !text-[12px]"
    : "bauhaus-button bauhaus-button-outline !px-4 !py-2.5 !text-[12px]";
  if (action.kind === "link") {
    return <Button as={Link} href={action.href} className={className} endContent={primary ? <ArrowRight size={14} /> : undefined}>{action.label}</Button>;
  }
  if (action.kind === "scroll") {
    return <Button onPress={() => scrollToWorkspaceSection(action.target)} className={className} endContent={primary ? <ArrowRight size={14} /> : undefined}>{action.label}</Button>;
  }
  return <Button onPress={action.run} isLoading={action.busy} className={className}>{action.label}</Button>;
}

const TONE_DOT: Record<Step["tone"], string> = {
  action: "bg-[var(--primary-red)]",
  waiting: "bg-[var(--primary-yellow)]",
  blocked: "bg-[var(--primary-red)]",
  done: "bg-[var(--foreground-muted)]",
};

export function JobNextStepCard(props: Props) {
  const step = props.loading && !props.stage ? null : resolveStep(props);
  return (
    <section data-testid="job-next-step" aria-live="polite" className="bauhaus-panel bg-white p-5">
      {!step ? (
        <div className="flex items-center gap-2 text-sm text-[var(--foreground-muted)]"><Spinner size="sm" color="warning" /> 正在读取岗位状态…</div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0 max-w-2xl">
            <p className="flex items-center gap-2 text-xs font-semibold text-[var(--foreground-muted)]">
              <span className={`inline-block h-2 w-2 rounded-full ${TONE_DOT[step.tone]} ${step.tone === "waiting" ? "animate-pulse" : ""}`} />
              下一步
            </p>
            <h2 className="mt-1 text-xl font-semibold tracking-tight text-[var(--foreground)]">{step.title}</h2>
            {step.body && <p className="mt-1 text-sm leading-relaxed text-[var(--foreground-soft)]">{step.body}</p>}
          </div>
          {(step.primary || step.secondary) && (
            <div className="flex flex-wrap gap-2">
              {step.secondary && <ActionButton action={step.secondary} primary={false} />}
              {step.primary && <ActionButton action={step.primary} primary />}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
