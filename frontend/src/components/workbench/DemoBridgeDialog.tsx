"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import {
  connectLocalBridge,
  disconnectLocalBridge,
  getBridgeState,
  probeLocalBridge,
  subscribeBridge,
} from "@/lib/bridge";
import { refreshAll } from "@/lib/core";

function useBridge() {
  return useSyncExternalStore(subscribeBridge, getBridgeState, getBridgeState);
}

export function DemoBridgeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const bridge = useBridge();
  const [token, setToken] = useState("");
  const [probing, setProbing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!open || bridge.active) return;
    let active = true;
    setProbing(true);
    void probeLocalBridge().then((result) => {
      if (!active) return;
      if (result.available) setNotice(`发现本机 OfferU ${result.version || ""}${result.mcpEnabled ? " · MCP 已启用" : ""}`);
    }).finally(() => {
      if (active) setProbing(false);
    });
    return () => { active = false; };
  }, [open, bridge.active]);

  if (!open) return null;

  const check = async () => {
    setProbing(true);
    setError("");
    setNotice("");
    try {
      const result = await probeLocalBridge();
      if (result.available) setNotice(`发现本机 OfferU ${result.version || ""}${result.mcpEnabled ? " · MCP 已启用" : ""}`);
    } finally {
      setProbing(false);
    }
  };

  const connect = async () => {
    setBusy(true);
    setError("");
    try {
      await connectLocalBridge(token);
      setToken("");
      onClose();
      await refreshAll();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "连接失败");
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    disconnectLocalBridge();
    await refreshAll();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 p-4" role="dialog" aria-modal="true" aria-labelledby="bridge-title">
      <div className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface-opaque)] p-5 text-[13px] shadow-[0_12px_36px_var(--shadow-medium)]">
        <div className="flex items-start justify-between gap-3">
          <h2 id="bridge-title" className="text-[15px] font-semibold text-[var(--foreground)]">连接本机 OfferU</h2>
          <button type="button" onClick={onClose} className="text-[var(--foreground-muted)] hover:text-[var(--foreground)]" aria-label="关闭">关闭</button>
        </div>

        {bridge.active ? (
          <>
            <p className="mt-2 leading-relaxed text-[var(--foreground-muted)]">
              当前页面读写本机 <code>offeru.db</code>，外置 Agent 通过本机 MCP 操作同一份数据。断开后回到浏览器示例数据，两边不自动同步。
            </p>
            <p className="mt-3 text-[12px] text-[var(--foreground)]">已连接 127.0.0.1:8766{bridge.version ? ` · ${bridge.version}` : ""}</p>
            <div className="mt-4 flex gap-2">
              <button type="button" onClick={() => void disconnect()} className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[12px] text-[var(--foreground)]">断开本机</button>
              <button type="button" onClick={onClose} className="rounded-md bg-[var(--foreground)] px-3 py-1.5 text-[12px] text-[var(--background)]">关闭</button>
            </div>
          </>
        ) : (
          <>
            <p className="mt-2 leading-relaxed text-[var(--foreground-muted)]">
              连接后，这个页面会读写本机 <code>offeru.db</code>，外置 Agent 通过本机 MCP 操作同一份数据。断开后回到浏览器示例数据，两边不自动同步。
            </p>
            <div className="mt-3 rounded-md border border-[var(--border)] bg-[var(--surface)] p-3 text-[12px] leading-relaxed text-[var(--foreground-muted)]">
              <p>1. 在本机运行 <code>offeru start</code>。</p>
              <p>2. 打开 <code>http://127.0.0.1:8766/api/pairing</code> 复制 token。</p>
              <p>3. 粘贴到这里。token 只在当前标签页内存里。</p>
            </div>
            <label className="mt-4 block text-[12px] text-[var(--foreground-muted)]">
              配对 token
              <input
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 font-mono text-[12px] text-[var(--foreground)] outline-none focus:border-[var(--border-strong)]"
                placeholder="粘贴 /api/pairing 返回的 token"
              />
            </label>
            {error && <p role="alert" className="mt-2 text-[12px] text-[var(--foreground)]">{error}</p>}
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => void connect()} disabled={busy || !token.trim()} className="rounded-md bg-[var(--foreground)] px-3 py-1.5 text-[12px] text-[var(--background)] disabled:opacity-50">
                {busy ? "连接中…" : "连接"}
              </button>
              <button type="button" onClick={() => void check()} disabled={probing} className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[12px] text-[var(--foreground)] disabled:opacity-50">
                {probing ? "检查中…" : "检查本机"}
              </button>
              <span className="text-[12px] text-[var(--foreground-muted)]">{notice}</span>
            </div>
            <p className="mt-4 border-t border-[var(--border)] pt-3 text-[12px] leading-relaxed text-[var(--foreground-muted)]">
              外置 Agent：本机运行 <code>offeru connect</code> 注册 Skill / MCP；命令行用 <code>offeru tool overview '{"{}"}'</code>。线上静态页本身不提供 MCP。
            </p>
          </>
        )}
      </div>
    </div>
  );
}
