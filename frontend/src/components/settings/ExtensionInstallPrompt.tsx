// Non-blocking suggestion to install the OfferU browser extension (web build only).
// When and why it shows: src/lib/local/extensionPrompt.ts. Model calls keep working through
// the /llm-proxy fallback whether or not the user follows it.

import { useEffect, useSyncExternalStore } from "react";

import { Button } from "@/components/ui";
import { useConfig } from "@/lib/hooks";
import { LOCAL_WEB } from "@/lib/local/mode";
import { getExtensionPromptStore } from "@/lib/local/llmTransport";
import {
  baseUrlNeedsRelay,
  EXTENSION_STORE_URL,
  extensionInstallUrl,
  learnedRelayHosts,
} from "@/lib/local/extensionPrompt";

interface ConfigLike {
  active_llm_config_id?: string;
  llm_api_configs?: Array<{ id?: string; base_url?: string }>;
}

/** Base URL of the active model config, if any. */
export function activeBaseUrl(config: ConfigLike | undefined): string {
  const configs = config?.llm_api_configs || [];
  const active = configs.find((item) => item.id === config?.active_llm_config_id) || configs[0];
  return active?.base_url || "";
}

function ConfiguredProviderWatcher() {
  const { data } = useConfig();
  const baseUrl = activeBaseUrl(data as ConfigLike | undefined);
  useEffect(() => {
    if (baseUrlNeedsRelay(baseUrl, learnedRelayHosts())) getExtensionPromptStore().report("configured");
  }, [baseUrl]);
  return null;
}

export function ExtensionInstallPrompt() {
  if (!LOCAL_WEB) return null;
  return <ExtensionInstallPromptView />;
}

function ExtensionInstallPromptView() {
  const store = getExtensionPromptStore();
  const view = useSyncExternalStore(store.subscribe, store.view, store.view);
  const installUrl = extensionInstallUrl();
  return (
    <>
      <ConfiguredProviderWatcher />
      {view.visible && (
        <div
          role="status"
          aria-live="polite"
          data-testid="extension-install-prompt"
          className="fixed bottom-4 left-4 z-[55] w-[320px] max-w-[calc(100vw-2rem)] rounded-lg border border-[var(--border)] bg-[var(--surface-opaque)] p-4 text-sm shadow-lg"
        >
          <p className="font-medium text-[var(--foreground)]">
            {view.trigger === "quota" ? "共享转发通道今天已满" : "安装 OfferU 浏览器扩展，模型请求直连"}
          </p>
          <p className="mt-1 text-[var(--foreground-muted)]">
            {view.trigger === "quota"
              ? "你的模型服务不支持网页直接访问，只能经 OfferU 的共享转发，而它的免费额度已用完。装上扩展后请求由浏览器直接发给模型服务，不受这个额度限制。"
              : "你的模型服务不支持网页直接访问，现在经 OfferU 的共享转发（不保存内容）。装上扩展后由浏览器直接请求：更快，也不占共享转发额度。"}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <a href={installUrl} target="_blank" rel="noopener noreferrer" className="ou-button ou-button-primary ou-button-sm">
              {EXTENSION_STORE_URL ? "安装扩展" : "查看安装方法"}
            </a>
            <Button size="sm" variant="ghost" onClick={() => store.dismiss()}>稍后</Button>
            <Button size="sm" variant="ghost" onClick={() => store.neverRemind()}>不再提醒</Button>
          </div>
        </div>
      )}
    </>
  );
}
