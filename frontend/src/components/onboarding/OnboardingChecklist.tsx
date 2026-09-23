"use client";

import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, Briefcase, FileText, RotateCcw, Sparkles } from "lucide-react";
import { useOnboarding } from "@/lib/useOnboarding";
import { useSetupProgress } from "./useSetupProgress";

const STEP_CONFIG = {
  agent: {
    label: "连接本机 AI",
    description: "检查已安装的 Agent；OfferU 不会替你登录，也不会把复制指令当作已连接。",
    wizardStep: 0,
    icon: Sparkles,
  },
  profile: {
    label: "建立职业档案",
    description: "导入简历并确认有来源的经历，形成可用于岗位准备的档案。",
    wizardStep: 1,
    icon: FileText,
  },
  job: {
    label: "保存首个岗位",
    description: "采集当前招聘页，或在岗位工作区粘贴职位描述；保存不代表已经投递。",
    wizardStep: 3,
    icon: Briefcase,
  },
} as const;

export function OnboardingChecklist() {
  const router = useRouter();
  const onboarding = useOnboarding();
  const progress = useSetupProgress();

  if (!onboarding.hydrated || (progress.loading && !progress.error)) return null;

  const steps = progress.steps
    .filter((step) => step.key in STEP_CONFIG)
    .map((step) => ({
      ...STEP_CONFIG[step.key as keyof typeof STEP_CONFIG],
      key: step.key,
      done: step.done,
    }));
  const pending = steps.filter((step) => !step.done);
  if (!pending.length) return null;

  const completedCount = steps.length - pending.length;
  const progressPercent = (completedCount / steps.length) * 100;

  return (
    <motion.section
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      className="bauhaus-panel overflow-hidden bg-[var(--surface)]"
      aria-labelledby="setup-checklist-title"
    >
      <div className="grid gap-0 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="border-b border-black/15 p-6 lg:border-b-0 lg:border-r md:p-8">
          <p className="bauhaus-label text-black/55">快速开始</p>
          <h2 id="setup-checklist-title" className="mt-2 text-2xl font-bold md:text-3xl">从一个岗位开始</h2>
          <p className="mt-3 max-w-xl text-sm font-medium leading-relaxed text-black/70 md:text-base">
            OfferU 会根据你确认的职业经历和目标岗位，整理需要准备的下一步。
          </p>
          {progress.error ? (
            <p role="status" className="mt-6 text-xs leading-5 text-amber-800">部分进度暂时无法读取；恢复连接后会按已保存的数据更新。</p>
          ) : (
            <>
              <div className="mt-6 h-3.5 border border-black/15 bg-[var(--surface-muted)] p-0.5">
                <motion.div className="h-full bg-[var(--primary-yellow)]" animate={{ width: String(progressPercent) + "%" }} />
              </div>
              <p className="mt-2 text-xs text-black/60">已完成 {completedCount}/{steps.length}</p>
            </>
          )}
          <button type="button" onClick={() => onboarding.openWizardAt(0)} className="bauhaus-button bauhaus-button-yellow mt-6">
            <RotateCcw size={16} strokeWidth={2.2} />
            重新查看引导
          </button>
        </div>

        <div className="bg-[var(--surface-muted)] p-4 text-black md:p-5">
          <div className="grid gap-4">
            <AnimatePresence initial={false}>
              {pending.map((step) => {
                const Icon = step.icon;
                return (
                  <motion.div
                    key={step.key}
                    layout
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="bauhaus-panel-sm bg-[var(--surface)] p-4 md:p-5"
                  >
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                      <div className="flex items-start gap-4">
                        <div className="flex h-12 w-12 shrink-0 items-center justify-center border border-black/20 bg-[#f3ead2]">
                          <Icon size={20} strokeWidth={2.2} />
                        </div>
                        <div>
                          <p className="bauhaus-label opacity-65">待完成步骤</p>
                          <h3 className="mt-1 text-lg font-semibold">{step.label}</h3>
                          <p className="mt-2 max-w-xl text-sm font-medium leading-relaxed opacity-80">{step.description}</p>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => onboarding.openWizardAt(step.wizardStep)}
                        className="bauhaus-button bauhaus-button-red bauhaus-button-sm"
                      >
                        继续设置
                        <ArrowRight size={14} strokeWidth={2.2} />
                      </button>
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
          <button type="button" onClick={() => router.push("/email")} className="mt-4 text-xs font-medium text-[var(--foreground-muted)] underline underline-offset-4">
            可选：连接只读求职邮箱
          </button>
        </div>
      </div>
    </motion.section>
  );
}

export function OnboardingTriggerButton() {
  const onboarding = useOnboarding();
  if (!onboarding.hydrated) return null;
  return (
    <button type="button" onClick={() => onboarding.resetWizard()} className="bauhaus-button bauhaus-button-blue">
      <Sparkles size={16} strokeWidth={2.2} />
      快速开始
    </button>
  );
}
