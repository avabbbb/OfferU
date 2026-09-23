"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "offeru_onboarding";
const SYNC_EVENT = "offeru_onboarding_sync";
const MAX_STEP = 3;

export type SetupStep = "agent" | "profile" | "job" | "email" | "today";

export interface OnboardingState {
  wizardCompleted: boolean;
  wizardSkipped: boolean;
  wizardStep: number;
}

const DEFAULT_STATE: OnboardingState = {
  wizardCompleted: false,
  wizardSkipped: false,
  wizardStep: 0,
};

function normalizeStep(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.max(0, Math.min(value, MAX_STEP))
    : 0;
}

function loadState(): OnboardingState {
  if (typeof window === "undefined") return DEFAULT_STATE;
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "null");
    if (!parsed || typeof parsed !== "object") return DEFAULT_STATE;
    const value = parsed as Record<string, unknown>;
    return {
      wizardCompleted: value.wizardCompleted === true,
      wizardSkipped: value.wizardSkipped === true,
      wizardStep: normalizeStep(value.wizardStep),
    };
  } catch {
    return DEFAULT_STATE;
  }
}

function saveState(state: OnboardingState) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Keep the current session usable when storage is blocked or full.
  }
}

export function useOnboarding() {
  const [state, setState] = useState<OnboardingState>(DEFAULT_STATE);
  const stateRef = useRef(DEFAULT_STATE);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const loaded = loadState();
    stateRef.current = loaded;
    setState(loaded);
    setHydrated(true);
  }, []);

  useEffect(() => {
    const handleSync = (event?: Event) => {
      const synced = (event as CustomEvent<OnboardingState> | undefined)?.detail;
      const loaded = synced
        ? { ...synced, wizardStep: normalizeStep(synced.wizardStep) }
        : loadState();
      stateRef.current = loaded;
      setState(loaded);
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY || event.key === null) handleSync();
    };
    window.addEventListener(SYNC_EVENT, handleSync);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener(SYNC_EVENT, handleSync);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  const update = useCallback((partial: Partial<OnboardingState>) => {
    const current = stateRef.current;
    const next = { ...current, ...partial, wizardStep: normalizeStep(partial.wizardStep ?? current.wizardStep) };
    stateRef.current = next;
    setState(next);
    saveState(next);
    window.dispatchEvent(new CustomEvent(SYNC_EVENT, { detail: next }));
  }, []);

  const setWizardStep = useCallback((wizardStep: number) => {
    update({ wizardStep: normalizeStep(wizardStep) });
  }, [update]);

  const completeWizard = useCallback(() => update({ wizardCompleted: true }), [update]);
  const skipWizard = useCallback(() => update({ wizardCompleted: true, wizardSkipped: true }), [update]);
  const openWizardAt = useCallback((wizardStep = 0) => {
    update({ wizardCompleted: false, wizardSkipped: false, wizardStep: normalizeStep(wizardStep) });
  }, [update]);
  const resetWizard = useCallback(() => openWizardAt(0), [openWizardAt]);

  return {
    ...state,
    hydrated,
    shouldShowWizard: hydrated && !state.wizardCompleted,
    setWizardStep,
    completeWizard,
    skipWizard,
    openWizardAt,
    resetWizard,
  };
}
