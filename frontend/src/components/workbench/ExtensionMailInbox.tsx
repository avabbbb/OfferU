"use client";

import { useEffect } from "react";

import { composeToAgent } from "@/lib/agentCompose";
import { getExtensionMail, handoffPrompt } from "@/lib/local/extensionMail";

/**
 * 用户在邮箱网页点「交给 OfferU」的邮件：页面打开时和插件通知时取走，交给内置 Agent（和手动贴邀约邮件同一条流程）。
 * 没有插件时什么都不做，不渲染任何东西。
 */
export function ExtensionMailInbox() {
  useEffect(() => {
    const ext = getExtensionMail();
    if (!ext) return undefined;
    let busy = false;
    const take = async () => {
      if (busy) return;
      busy = true;
      try {
        if (!(await ext.detect())) return;
        for (const message of await ext.takeInbox()) composeToAgent({ message: handoffPrompt(message) });
      } finally {
        busy = false;
      }
    };
    void take();
    return ext.onIncoming(() => void take());
  }, []);
  return null;
}
