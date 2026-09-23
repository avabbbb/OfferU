"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@nextui-org/react";
import { ArrowLeft, ArrowRight, Briefcase, Brain, FileText, PlugZap, X } from "lucide-react";
import { AgentConnectionPanel } from "@/components/workbench/AgentConnectionPanel";
import { MemorySetup } from "./MemorySetup";
import { ResumeSetup } from "./ResumeSetup";
import { useSetupProgress } from "./useSetupProgress";

interface OnboardingWizardProps {
  wizardStep: number;
  onStepChange: (step: number) => void;
  onComplete: () => void;
  onSkip: () => void;
}

const STEPS = [
  { title: "连接你的 AI", icon: PlugZap },
  { title: "导入简历", icon: FileText },
  { title: "整理 AI 记忆", icon: Brain },
  { title: "保存目标岗位", icon: Briefcase },
];

export function OnboardingWizard({ wizardStep, onStepChange, onComplete, onSkip }: OnboardingWizardProps) {
  const router = useRouter();
  const progress = useSetupProgress();
  const [busy, setBusy] = useState(false);
  const step = Math.max(0, Math.min(wizardStep, STEPS.length - 1));
  const activeStep = STEPS[step];
  const StepIcon = activeStep.icon;

  useEffect(() => {
    if (!progress.loading && progress.coreComplete) onComplete();
  }, [onComplete, progress.coreComplete, progress.loading]);

  const advance = async () => {
    await progress.refresh();
    onStepChange(Math.min(step + 1, STEPS.length - 1));
  };
  const goToJobs = () => {
    onComplete();
    router.push("/jobs?setup=1");
  };
  const goToEmail = () => {
    onComplete();
    router.push("/email");
  };

  return (
    <div className="fixed inset-0 z-[90] overflow-y-auto bg-black/45 p-3 sm:p-6" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
      <section className="mx-auto my-3 max-w-4xl overflow-hidden rounded-2xl border border-[var(--border-strong)] bg-[var(--surface)] shadow-2xl sm:my-8">
        <header className="flex items-start justify-between gap-4 border-b border-[var(--border)] px-5 py-5 sm:px-8">
          <div>
            <p className="text-xs font-semibold text-[var(--foreground-muted)]">OfferU · 快速开始</p>
            <h1 id="onboarding-title" className="mt-1 text-xl font-semibold sm:text-2xl">把一个岗位，变成可准备的工作区</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--foreground-muted)]">
              先连接熟悉的 AI，再用可核对的经历和目标岗位开始。你可以随时离开，进度会保留。
            </p>
          </div>
          <button type="button" onClick={onSkip} disabled={busy} aria-label="稍后设置" className="rounded-lg p-2 text-[var(--foreground-muted)] hover:bg-[var(--surface-muted)] disabled:opacity-50">
            <X size={18} />
          </button>
        </header>

        <div className="border-b border-[var(--border)] px-5 py-4 sm:px-8">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <StepIcon size={16} />
              <span className="text-sm font-semibold">{activeStep.title}</span>
            </div>
            <span className="text-xs text-[var(--foreground-muted)]">第 {step + 1} 步，共 {STEPS.length} 步</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-[var(--surface-muted)]" role="progressbar" aria-valuemin={0} aria-valuemax={STEPS.length} aria-valuenow={step + 1}>
            <div className="h-full bg-[var(--foreground)] transition-[width]" style={{ width: String(((step + 1) / STEPS.length) * 100) + "%" }} />
          </div>
        </div>

        <div className="max-h-[65vh] overflow-y-auto px-5 py-5 sm:px-8 sm:py-7">
          {step === 0 && (
            <div className="space-y-4">
              <p className="text-sm leading-6 text-[var(--foreground-muted)]">
                OfferU 会检查本机已安装的 Agent，并在支持时安装接入 Skill；已有登录由 Agent 自己管理。
              </p>
              {progress.connectedAgent && <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">已验证 {progress.connectedAgent.name} 可以使用 OfferU。</p>}
              <AgentConnectionPanel />
              <p className="text-xs leading-5 text-[var(--foreground-muted)]">暂时没有可用 Agent 也可以继续。连接状态不会因为复制指令或跳过此步而被标记为完成。</p>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-4">
              <p className="text-sm leading-6 text-[var(--foreground-muted)]">
                选择一份简历。OfferU 在本机提取内容，展示来源和候选经历；只有你确认的条目才进入职业档案。
              </p>
              <ResumeSetup
                profile={progress.profile.data}
                onBusy={setBusy}
                onDone={() => { void advance(); }}
              />
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <p className="text-sm leading-6 text-[var(--foreground-muted)]">
                这是可选步骤。你选择的内容会进入待审核线索，不会自动成为已验证经历。
              </p>
              <MemorySetup onBusy={setBusy} onDone={() => { void advance(); }} />
            </div>
          )}

          {step === 3 && (
            <div className="space-y-5">
              <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-5">
                <p className="text-xs font-semibold text-[var(--foreground-muted)]">下一步</p>
                <h2 className="mt-2 text-lg font-semibold">
                  {progress.jobs.data?.items?.length ? "你的岗位已经在工作区里" : "把正在考虑的岗位交给 OfferU"}
                </h2>
                <p className="mt-2 text-sm leading-6 text-[var(--foreground-muted)]">
                  {progress.jobs.data?.items?.length
                    ? "打开岗位工作区，查看准备进展和接下来需要你审核的内容。"
                    : "在招聘页面点击 OfferU 扩展进行当前页采集，或在岗位页粘贴职位描述。保存岗位不会代表已经投递。"}
                </p>
                <Button color="primary" className="mt-4" endContent={<ArrowRight size={15} />} onPress={goToJobs}>
                  {progress.jobs.data?.items?.length ? "打开岗位工作区" : "开始保存目标岗位"}
                </Button>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs leading-5 text-[var(--foreground-muted)]">求职邮箱同步是可选的，只读整理进展并交由你确认。</p>
                <button type="button" onClick={goToEmail} className="text-sm font-medium underline underline-offset-4">现在连接邮箱</button>
              </div>
            </div>
          )}

          {progress.error && (
            <p role="status" className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
              部分设置状态暂时无法读取；已保存的数据不会受影响。可以稍后重试。
            </p>
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] px-5 py-4 sm:px-8">
          <div>
            {step > 0 ? (
              <Button variant="light" isDisabled={busy} startContent={<ArrowLeft size={15} />} onPress={() => onStepChange(step - 1)}>上一步</Button>
            ) : (
              <Button variant="light" isDisabled={busy} onPress={onSkip}>稍后设置</Button>
            )}
          </div>
          {step === 0 && <Button variant="light" isDisabled={busy} endContent={<ArrowRight size={15} />} onPress={() => onStepChange(1)}>继续</Button>}
          {step === 1 && <Button variant="light" isDisabled={busy} onPress={() => onStepChange(2)}>稍后导入简历</Button>}
          {step === 2 && <Button variant="light" isDisabled={busy} onPress={() => onStepChange(3)}>跳过记忆</Button>}
          {step === 3 && <Button variant="light" isDisabled={busy} onPress={onSkip}>返回 Today</Button>}
        </footer>
      </section>
    </div>
  );
}
