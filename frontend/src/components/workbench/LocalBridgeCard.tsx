"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { RefreshCw, Unplug, Usb } from "lucide-react";

import { Button, Dialog, Field, Input, Pill } from "@/components/ui";
import {
  connectLocalBridgeInput,
  disconnectLocalBridge,
  getBridgeState,
  hasSavedBridgeToken,
  probeLocalBridge,
  restoreLocalBridge,
  subscribeBridge,
} from "@/lib/bridge";
import { refreshAll } from "@/lib/core";

function useBridge() {
  return useSyncExternalStore(subscribeBridge, getBridgeState, getBridgeState);
}

/**
 * Local-web (offeru.avabbbb.com) companion bridge card: lets the hosted web UI pair with
 * the user's loopback OfferU companion (127.0.0.1:8766) so CLI / external Agents and the
 * web page read and write the exact same local offeru.db without S3/R2 sync.
 */
export function LocalBridgeCard() {
  const bridge = useBridge();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [probing, setProbing] = useState(false);
  const [probeInfo, setProbeInfo] = useState<{ available: boolean; version?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [formError, setFormError] = useState("");
  const saved = !bridge.active && hasSavedBridgeToken();

  useEffect(() => {
    if (!open || bridge.active) return;
    let alive = true;
    setProbing(true);
    setFormError("");
    void probeLocalBridge()
      .then((result) => { if (alive) setProbeInfo(result); })
      .finally(() => { if (alive) setProbing(false); });
    return () => { alive = false; };
  }, [open, bridge.active]);

  const reprobe = async () => {
    setProbing(true);
    setFormError("");
    try {
      setProbeInfo(await probeLocalBridge());
    } finally {
      setProbing(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    setFormError("");
    try {
      await connectLocalBridgeInput(input);
      setInput("");
      setOpen(false);
      await refreshAll();
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "连接本机失败，请检查配对信息。");
    } finally {
      setBusy(false);
    }
  };

  const reconnect = async () => {
    setReconnecting(true);
    try {
      const ok = await restoreLocalBridge(2000);
      if (ok) await refreshAll();
      else setOpen(true);
    } finally {
      setReconnecting(false);
    }
  };

  const disconnect = async () => {
    disconnectLocalBridge();
    await refreshAll();
  };

  return (
    <div className="ou-sheet space-y-3 p-4" data-testid="local-bridge-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Usb size={15} aria-hidden className="text-[var(--ou-text-secondary)]" />
          <p className="text-sm font-semibold text-[var(--ou-text-primary)]">
            {bridge.active ? "已连接本机 OfferU" : "连接本机 OfferU（CLI 直连网页版）"}
          </p>
        </div>
        <Pill tone={bridge.active ? "green" : "gray"}>
          {bridge.active
            ? `本机 · 127.0.0.1:8766${bridge.version ? ` · v${bridge.version}` : ""}`
            : "浏览器本地存储"}
        </Pill>
      </div>

      <p className="text-xs leading-relaxed text-[var(--ou-text-secondary)]">
        {bridge.active
          ? "当前网页直接读写本机 offeru.db，CLI 与外置 Agent 的改动会实时显示在网页上，无需配置 S3 / R2 同步。"
          : "默认数据存在浏览器里，本机 CLI 读不到。连接本机 OfferU（127.0.0.1:8766）后，CLI 与外置 Agent 可直接操作这个网页的数据，无需 S3 / R2。"}
      </p>

      {!bridge.active && bridge.error && (
        <p role="alert" className="text-xs text-[var(--ou-tone-red-text)]">{bridge.error}</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {bridge.active ? (
          <Button variant="secondary" size="sm" onClick={() => void disconnect()}>
            <Unplug size={14} aria-hidden />
            断开本机
          </Button>
        ) : (
          <>
            <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
              连接本机 OfferU
            </Button>
            {saved && (
              <Button variant="secondary" size="sm" disabled={reconnecting} onClick={() => void reconnect()}>
                <RefreshCw size={14} aria-hidden />
                {reconnecting ? "重连中…" : "重新连接"}
              </Button>
            )}
          </>
        )}
      </div>

      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="连接本机 OfferU"
        description="配对后，当前网页直接读写本机 offeru.db，与 CLI / 外置 Agent 实时共享同一份数据。"
        footer={(
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>取消</Button>
            <Button variant="primary" onClick={() => void submit()} disabled={busy || !input.trim()}>
              {busy ? "连接中…" : "连接"}
            </Button>
          </>
        )}
      >
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            {probing ? (
              <span role="status" className="text-xs text-[var(--ou-text-muted)]">正在检测本机 127.0.0.1:8766…</span>
            ) : probeInfo?.available ? (
              <Pill tone="green">已发现本机 OfferU{probeInfo.version ? ` v${probeInfo.version}` : ""}</Pill>
            ) : (
              <Pill tone="orange">未检测到本机 OfferU</Pill>
            )}
            <Button variant="ghost" size="sm" disabled={probing} onClick={() => void reprobe()}>
              <RefreshCw size={13} aria-hidden />
              重新检测
            </Button>
          </div>

          <div className="space-y-1.5 rounded-[var(--ou-radius-control)] bg-[var(--ou-bg-subtle)] p-3 text-xs leading-relaxed text-[var(--ou-text-secondary)]">
            <p>1. 推荐：在终端运行 <code>offeru start --web</code>，浏览器会自动打开一键配对链接，无需复制。</p>
            <p>2. 手动：粘贴终端输出的 <code>Web:</code> 配对链接、配对码，或 <code>http://127.0.0.1:8766/api/pairing</code> 返回的 token。</p>
          </div>

          <Field
            label="配对链接 / 配对码 / Token"
            error={formError}
            hint="仅保存在当前浏览器本地，只发往本机 127.0.0.1:8766，不会上传到任何服务器。"
          >
            {(id) => (
              <Input
                id={id}
                type="password"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && input.trim() && !busy) {
                    event.preventDefault();
                    void submit();
                  }
                }}
                placeholder="粘贴 #/pair/... 链接、配对码或 token"
                autoComplete="off"
                spellCheck={false}
              />
            )}
          </Field>
        </div>
      </Dialog>
    </div>
  );
}
