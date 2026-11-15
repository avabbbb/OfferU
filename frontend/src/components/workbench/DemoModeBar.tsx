"use client";

import { useSyncExternalStore } from "react";

import { getBridgeState, subscribeBridge } from "@/lib/bridge";
import { SHOWCASE } from "@/lib/showcase";

function useBridge() {
  return useSyncExternalStore(subscribeBridge, getBridgeState, getBridgeState);
}

/** A single status line. Data actions live in Settings → 数据. */
export function DemoModeBar() {
  const bridge = useBridge();
  if (!SHOWCASE) return null;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-[var(--border)] pb-3 text-[12px] text-[var(--foreground-muted)]">
      <span className="text-[var(--foreground)]">{bridge.active ? "本机数据" : "示例数据"}</span>
      <span aria-hidden="true">·</span>
      <span>{bridge.active ? "127.0.0.1:8766" : "只存在这个浏览器，不和别人共享"}</span>
      <span aria-hidden="true">·</span>
      <span>{bridge.active ? "读取本机 offeru.db" : "内置 Agent 用你的 Key"}</span>
    </div>
  );
}
