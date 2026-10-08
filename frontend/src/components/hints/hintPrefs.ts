// =============================================
// 安静提示（Quiet Hints）偏好
// 默认开启；用户可在设置里整体关闭。只存在本机 localStorage，
// 读写失败（隐私模式 / 配额）时退回默认值，绝不抛错打断界面。
// =============================================

import { useEffect, useState } from "react";

export const HINTS_STORAGE_KEY = "offeru.quietHints.enabled";
const HINTS_EVENT = "offeru:quiet-hints-changed";

export function readHintsEnabled(): boolean {
  try {
    return window.localStorage.getItem(HINTS_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function setHintsEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(HINTS_STORAGE_KEY, enabled ? "true" : "false");
  } catch {
    // 存不下也不影响当前会话：下面的事件仍会同步本页状态。
  }
  window.dispatchEvent(new CustomEvent(HINTS_EVENT, { detail: enabled }));
}

export function useHintsEnabled(): [boolean, (enabled: boolean) => void] {
  const [enabled, setEnabled] = useState<boolean>(() => readHintsEnabled());

  useEffect(() => {
    const sync = () => setEnabled(readHintsEnabled());
    window.addEventListener(HINTS_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(HINTS_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  return [enabled, setHintsEnabled];
}
