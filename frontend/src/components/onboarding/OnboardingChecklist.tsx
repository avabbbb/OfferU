"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowRight,
  Briefcase,
  CheckCircle2,
  FileText,
  Key,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { useOnboarding } from "@/lib/useOnboarding";
import { useConfig, useResumes } from "@/lib/hooks";

export function OnboardingChecklist({ hasJobs }: { hasJobs: boolean }) {
  const router = useRouter();
  const onboarding = useOnboarding();
  const {
    hydrated,
    allStepsCompleted,
    apiKeyConfigured,
    resumeCreated,
    jobsScraped,
    syncFromData,
  } = onboarding;
  const { data: config } = useConfig();
  const { data: resumes } = useResumes();

  useEffect(() => {
    if (!hydrated) return;

    const list = Array.isArray((config as { llm_api_configs?: unknown[] } | undefined)?.llm_api_configs)
      ? ((config as { llm_api_configs?: unknown[] }).llm_api_configs as Record<string, unknown>[])
      : [];

    const active =
      list.find((item) => item?.is_active) ||
      list.find(
        (item) =>
          item?.id ===
          (config as { active_llm_config_id?: string } | undefined)?.active_llm_config_id
      );

    const configMap = (config as Record<string, unknown> | undefined) || {};

    const hasApiKey = Boolean(
      (active &&
        (String(active.provider_id || "").toLowerCase() === "ollama" ||
          active.api_key)) ||
        configMap.deepseek_api_key ||
        configMap.openai_api_key ||
        configMap.qwen_api_key ||
        configMap.siliconflow_api_key ||
        configMap.gemini_api_key ||
        configMap.zhipu_api_key
    );

    const hasResume = Array.isArray(resumes) && resumes.length > 0;
    syncFromData({ hasApiKey, hasResume, hasJobs });
  }, [config, resumes, hasJobs, hydrated, syncFromData]);

  if (!hydrated || allStepsCompleted) return null;

  const steps = [
    {
      key: "apikey",
      label: "配置模型能力",
      description: "先设置访问密钥，再使用简历优化、分析和问答能力。",
      icon: Key,
      done: apiKeyConfigured,
      action: () => router.push("/settings"),
      actionLabel: "前往设置",
      panel: "bg-[#f3ead2] text-black",
      iconBox: "bg-[#fdfbf7] text-black",
    },
    {
      key: "resume",
      label: "创建第一份简历",
      description: "先建立基础简历，后续岗位匹配和优化才能更高效。",
      icon: FileText,
      done: resumeCreated,
      action: () => router.push("/resume"),
      actionLabel: "新建简历",
      panel: "bg-[var(--surface)] text-black",
      iconBox: "bg-[#e4ece6] text-black",
    },
    {
      key: "jobs",
      label: "抓取目标岗位",
      description: "连接平台并开始同步，让岗位库进入可筛选、可推进状态。",
      icon: Briefcase,
      done: jobsScraped,
      action: () => router.push("/scraper"),
      actionLabel: "开始抓取",
      panel: "bg-[#e4ece6] text-black",
      iconBox: "bg-[#f3ead2] text-black",
    },
  ];

  const completedCount = steps.filter((step) => step.done).length;
  const progressPercent = (completedCount / steps.length) * 100;
  const pendingSteps = steps.filter((step) => !step.done);

  return (
    <motion.section
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      className="bauhaus-panel overflow-hidden bg-[var(--surface)]"
    >
      <div className="grid gap-0 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="border-b border-black/15 p-6 lg:border-b-0 lg:border-r md:p-8">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="bauhaus-label text-black/55">快速开始</p>
              <h2 className="mt-2 text-2xl font-bold md:text-3xl">完成基础配置</h2>
              <p className="mt-3 max-w-xl text-sm font-medium leading-relaxed text-black/70 md:text-base">
                完成这三步后，抓取、简历和分析模块会进入稳定可用状态。
              </p>
            </div>

            <div className="bauhaus-panel-sm bg-[#f7ece9] px-4 py-3 text-center text-black">
              <p className="bauhaus-label text-black/60">进度</p>
              <p className="mt-1 text-2xl font-bold">
                {completedCount}/{steps.length}
              </p>
            </div>
          </div>

          <div className="mt-6 border border-black/15 bg-[var(--surface-muted)] p-1">
            <motion.div
              className="h-3.5 bg-[var(--primary-yellow)]"
              animate={{ width: `${progressPercent}%` }}
              transition={{ type: "spring", stiffness: 120, damping: 20 }}
            />
          </div>

          <div className="mt-6 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => onboarding.resetWizard()}
              className="bauhaus-button bauhaus-button-yellow"
            >
              <RotateCcw size={16} strokeWidth={2.2} />
              重新引导
            </button>
            <button
              type="button"
              onClick={() => router.push("/settings")}
              className="bauhaus-button bauhaus-button-outline"
            >
              <Sparkles size={16} strokeWidth={2.2} />
              系统配置
            </button>
          </div>
        </div>

        <div className="bg-[var(--surface-muted)] p-4 text-black md:p-5">
          <div className="grid gap-4">
            <AnimatePresence initial={false}>
              {pendingSteps.map((step) => {
                const Icon = step.icon;

                return (
                  <motion.div
                    key={step.key}
                    layout
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className={`bauhaus-panel-sm ${step.panel} p-4 md:p-5`}
                  >
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                      <div className="flex items-start gap-4">
                        <div
                          className={`flex h-12 w-12 shrink-0 items-center justify-center border border-black/20 ${step.iconBox}`}
                        >
                          <Icon size={20} strokeWidth={2.2} />
                        </div>
                        <div>
                          <p className="bauhaus-label opacity-65">待完成步骤</p>
                          <h3 className="mt-1 text-lg font-semibold">{step.label}</h3>
                          <p className="mt-2 max-w-xl text-sm font-medium leading-relaxed opacity-80">
                            {step.description}
                          </p>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={step.action}
                        className="bauhaus-button bauhaus-button-red bauhaus-button-sm"
                      >
                        {step.actionLabel}
                        <ArrowRight size={14} strokeWidth={2.2} />
                      </button>
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>

            {steps
              .filter((step) => step.done)
              .map((step) => (
                <div
                  key={step.key}
                  className="bauhaus-panel-sm flex items-center gap-3 bg-[var(--surface)] px-4 py-3 text-black/70"
                >
                  <div className="flex h-9 w-9 items-center justify-center border border-black/20 bg-[#f3ead2]">
                    <CheckCircle2 size={18} strokeWidth={2.2} />
                  </div>
                  <div>
                    <p className="bauhaus-label text-black/45">已完成</p>
                    <p className="text-sm font-semibold">{step.label}</p>
                  </div>
                </div>
              ))}
          </div>
        </div>
      </div>
    </motion.section>
  );
}

export function OnboardingTriggerButton() {
  const onboarding = useOnboarding();

  if (!onboarding.hydrated) return null;

  return (
    <button
      type="button"
      onClick={() => onboarding.resetWizard()}
      className="bauhaus-button bauhaus-button-blue"
    >
      <Sparkles size={16} strokeWidth={2.2} />
      快速开始
    </button>
  );
}
