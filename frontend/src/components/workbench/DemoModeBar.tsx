"use client";

import { useState, useSyncExternalStore } from "react";

import {
  connectLocalBridge,
  disconnectLocalBridge,
  getBridgeState,
  probeLocalBridge,
  subscribeBridge,
} from "@/lib/bridge";
import { refreshAll } from "@/lib/core";
import { SHOWCASE, resetShowcase } from "@/lib/showcase";
import { DemoDataDialog } from "./DemoDataDialog";

function useBridge() {
  return useSyncExternalStore(subscribeBridge, getBridgeState, getBridgeState);
}

/** The static showcase has no backend. This bar states where the data lives and
 *  offers an explicit, token-paired switch to the loopback OfferU backend. */
export function DemoModeBar() {
  const bridge = useBridge();
  const [open, setOpen] = useState(false);
  const [dataOpen, setDataOpen] = useState(false);
  const [token, setToken] = useState("");
  const [probing, setProbing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  if (!SHOWCASE) return null;

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
      setOpen(false);
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
  };

  const clear = async () => {
    if (!window.confirm("清空这个浏览器里的演示数据，恢复示例内容？演示数据是虚构的，不要填真实证件或手机号。")) return;
    await resetShowcase();
    await refreshAll();
    setNotice("演示数据已恢复为示例内容。");
  };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] pb-3 text-[12px] text-[var(--foreground-muted)]">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[var(--foreground)]">{bridge.active ? "本机数据" : "演示版"}</span>
          <span aria-hidden="true">·</span>
          <span>{bridge.active ? "127.0.0.1:8766" : "示例数据 · 只存在这个浏览器"}</span>
          {bridge.active && <span aria-hidden="true">·</span>}
          {bridge.active && <span>外置 Agent 可用</span>}
          {!bridge.active && <span aria-hidden="true">·</span>}
          {!bridge.active && <span>内置 Agent 用你的 Key · 外置 Agent 需本机</span>}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {notice && <span role="status">{notice}</span>}
          {!bridge.active && <button type="button" onClick={() => setDataOpen(true)} className="hover:text-[var(--foreground)]">数据包 / 同步</button>}
          {!bridge.active && <button type="button" onClick={() => void clear()} className="hover:text-[var(--foreground)]">清空演示数据</button>}
          {bridge.active ? (
            <button type="button" onClick={() => void disconnect()} className="hover:text-[var(--foreground)]">断开本机</button>
          ) : (
            <button type="button" onClick={() => { setOpen(true); void check(); }} className="text-[var(--foreground)] hover:underline">连接本机 OfferU</button>
          )}
        </div>
      </div>

      {open && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 p-4" role="dialog" aria-modal="true" aria-labelledby="bridge-title">
          <div className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface-opaque)] p-5 text-[13px] shadow-[0_12px_36px_var(--shadow-medium)]">
            <div className="flex items-start justify-between gap-3">
              <h2 id="bridge-title" className="text-[15px] font-semibold text-[var(--foreground)]">连接本机 OfferU</h2>
              <button type="button" onClick={() => setOpen(false)} className="text-[var(--foreground-muted)] hover:text-[var(--foreground)]" aria-label="关闭">关闭</button>
            </div>
            <p className="mt-2 leading-relaxed text-[var(--foreground-muted)]">
              连接后，这个页面会读写本机 <code>offeru.db</code>，外置 Agent 通过本机 MCP 操作同一份数据。断开后回到浏览器演示数据，两边不自动同步。
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
          </div>
        </div>
      )}
      <DemoDataDialog open={dataOpen} onClose={() => setDataOpen(false)} />
    </>
  );
}
