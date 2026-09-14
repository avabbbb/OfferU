// =============================================
// Onboarding 状态管理 Hook
// =============================================
// localStorage 持久化，跟踪 Wizard 是否完成 + 各步骤完成状态
// Dashboard Checklist 根据真实数据动态判断步骤完成情况
// 使用 storage event + custom event 实现跨组件同步
// =============================================

"use client";

import { useState, useEffect, useCallback } from "react";

const STORAGE_KEY = "offeru_onboarding";
const SYNC_EVENT = "offeru_onboarding_sync";

export interface OnboardingState {
  wizardCompleted: boolean;   // 全屏 Wizard 是否已完成/跳过
  wizardSkipped: boolean;     // 是否跳过 Wizard
  agentConnected: boolean;    // Step 1: 本机 Agent 检查通过
  resumeCreated: boolean;     // Step 2: 是否已创建简历
  jobsScraped: boolean;       // Step 3: 是否已保存岗位
}

const DEFAULT_STATE: OnboardingState = {
  wizardCompleted: false,
  wizardSkipped: false,
  agentConnected: false,
  resumeCreated: false,
  jobsScraped: false,
};

function loadState(): OnboardingState {
  if (typeof window === "undefined") return DEFAULT_STATE;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch {}
  return DEFAULT_STATE;
}

function saveState(state: OnboardingState) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  // 广播变更给同页面内其他 hook 实例
  window.dispatchEvent(new CustomEvent(SYNC_EVENT));
}

export function useOnboarding() {
  const [state, setState] = useState<OnboardingState>(DEFAULT_STATE);
  const [hydrated, setHydrated] = useState(false);

  // 客户端 hydration
  useEffect(() => {
    setState(loadState());
    setHydrated(true);
  }, []);

  // 监听同页面内其他 hook 实例的变更
  useEffect(() => {
    const handleSync = () => setState(loadState());
    window.addEventListener(SYNC_EVENT, handleSync);
    return () => window.removeEventListener(SYNC_EVENT, handleSync);
  }, []);

  const update = useCallback((partial: Partial<OnboardingState>) => {
    setState((prev) => {
      const next = { ...prev, ...partial };
      saveState(next);
      return next;
    });
  }, []);

  /** 标记 Wizard 完成 */
  const completeWizard = useCallback(() => {
    update({ wizardCompleted: true });
  }, [update]);

  /** 标记 Wizard 跳过 */
  const skipWizard = useCallback(() => {
    update({ wizardCompleted: true, wizardSkipped: true });
  }, [update]);

  /** 重置引导（Dashboard 入口可再次打开 Wizard） */
  const resetWizard = useCallback(() => {
    update({ wizardCompleted: false, wizardSkipped: false });
  }, [update]);

  /** 根据真实数据刷新步骤状态 */
  const syncFromData = useCallback(
    (data: { hasAgentConnection: boolean; hasResume: boolean; hasJobs: boolean }) => {
      const current = loadState();
      const next = {
        ...current,
        agentConnected: data.hasAgentConnection,
        resumeCreated: data.hasResume,
        jobsScraped: data.hasJobs,
      };
      setState(next);
      saveState(next);
    },
    []
  );

  /** 所有引导步骤完成 */
  const allStepsCompleted =
    state.agentConnected && state.resumeCreated && state.jobsScraped;

  /** 是否应该显示 Wizard */
  const shouldShowWizard = hydrated && !state.wizardCompleted;

  return {
    ...state,
    hydrated,
    allStepsCompleted,
    shouldShowWizard,
    completeWizard,
    skipWizard,
    resetWizard,
    syncFromData,
    update,
  };
}
