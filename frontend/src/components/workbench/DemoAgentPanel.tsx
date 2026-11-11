"use client";

import { useEffect, useRef, useState } from "react";
import { Bot, KeyRound, Loader2, Send, Settings2, Square, Trash2 } from "lucide-react";

import { AgentMarkdown } from "./AgentMarkdown";
import { runDemoAgent, type AgentConfig } from "@/lib/demo/agent";
import { refreshAll } from "@/lib/core";
import { clearAgentChat, loadAgentChat, saveAgentChat, type ChatLogItem } from "@/lib/demo/agentSession";
import { forgetAgentKey, loadAgentConfig, saveAgentConfig } from "@/lib/demo/keyVault";

const PRESETS = [
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { id: "siliconflow", label: "SiliconFlow", baseUrl: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen2.5-7B-Instruct" },
  { id: "custom", label: "自定义 OpenAI 兼容端点", baseUrl: "", model: "" },
] as const;

const WELCOME: ChatLogItem = {
  id: "welcome",
  role: "assistant",
  content: "我是 OfferU 的浏览器演示 Agent。可以帮你看看今天、查岗位、改状态、记待办或搜索记录。先用下面的配置填一个 OpenAI 兼容的模型 Key。",
  at: new Date().toISOString(),
};

type Activity = { id: string; text: string; done: boolean; failed: boolean };

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function DemoAgentPanel() {
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [messages, setMessages] = useState<ChatLogItem[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [activity, setActivity] = useState<Activity[]>([]);
  const [baseUrl, setBaseUrl] = useState<string>(PRESETS[0].baseUrl);
  const [model, setModel] = useState<string>(PRESETS[0].model);
  const [apiKey, setApiKey] = useState("");
  const [remember, setRemember] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([loadAgentConfig(), loadAgentChat()]).then(([saved, chat]) => {
      if (!active) return;
      setConfig(saved);
      setMessages(chat.length ? chat : [WELCOME]);
      if (saved) {
        setBaseUrl(saved.baseUrl);
        setModel(saved.model);
        setRemember(saved.remember);
        setEditing(!saved.apiKey);
      } else {
        setEditing(true);
      }
    }).catch((cause) => {
      if (!active) return;
      setError(cause instanceof Error ? cause.message : "读取 Agent 配置失败");
      setEditing(true);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, activity, busy]);

  const pickPreset = (id: string) => {
    const preset = PRESETS.find((item) => item.id === id);
    if (!preset) return;
    if (preset.baseUrl) setBaseUrl(preset.baseUrl);
    if (preset.model) setModel(preset.model);
  };

  const saveConfig = async () => {
    setError("");
    setNotice("");
    const key = apiKey.trim() || config?.apiKey || "";
    try {
      const saved = await saveAgentConfig({ baseUrl, model, apiKey: key, remember });
      setConfig(saved);
      setApiKey("");
      setEditing(false);
      setNotice(saved.remember ? "Key 已用设备密钥加密保存。" : "Key 只在本次页面内存里。" );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存配置失败");
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    if (!config?.apiKey) {
      setEditing(true);
      setError("先填 API Key。");
      return;
    }
    setInput("");
    setError("");
    setNotice("");
    setActivity([]);
    setBusy(true);
    const userItem: ChatLogItem = { id: `user-${Date.now()}`, role: "user", content: text, at: new Date().toISOString() };
    const assistantId = `assistant-${Date.now()}`;
    const history = messages.filter((item) => item.id !== "welcome");
    const assistantItem: ChatLogItem = { id: assistantId, role: "assistant", content: "", at: new Date().toISOString() };
    let assistantText = "";
    setMessages((current) => [...current, userItem, assistantItem]);
    void saveAgentChat([...history, userItem]);

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await runDemoAgent({
        config,
        history: history.map((item) => ({ role: item.role, content: item.content })),
        input: text,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === "text") {
            assistantText += event.text;
            setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, content: assistantText } : item));
          } else if (event.type === "tool_start") {
            setActivity((current) => [...current.slice(-6), { id: `${Date.now()}-start`, text: `调用 ${event.name} · ${event.summary}`, done: false, failed: false }]);
          } else if (event.type === "tool_end") {
            setActivity((current) => [...current.slice(-6), { id: `${Date.now()}-end`, text: `${event.name} ${event.ok ? "完成" : "失败"} · ${event.summary}`, done: true, failed: !event.ok }]);
            void refreshAll();
          }
        },
      });
      const finalText = assistantText || result;
      const finalMessages = [...history, userItem, { ...assistantItem, content: finalText }];
      setMessages(finalMessages);
      await saveAgentChat(finalMessages);
      await refreshAll();
    } catch (cause) {
      if (controller.signal.aborted) {
        setNotice("已停止。");
        const finalMessages = [...history, userItem, { ...assistantItem, content: assistantText || "（已停止）" }];
        setMessages(finalMessages);
        await saveAgentChat(finalMessages);
      } else {
        setError(cause instanceof Error ? cause.message : "Agent 运行失败");
        if (!assistantText) setMessages((current) => current.filter((item) => item.id !== assistantId));
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  };

  const stop = () => {
    abortRef.current?.abort();
  };

  const clearChat = async () => {
    if (!window.confirm("清空这个浏览器里的 Agent 对话？")) return;
    await clearAgentChat();
    setMessages([WELCOME]);
    setActivity([]);
    setNotice("对话已清空。");
  };

  const forget = async () => {
    if (!window.confirm("忘记已保存的 Key？之后需要重新填写。")) return;
    await forgetAgentKey();
    setConfig((current) => current ? { ...current, apiKey: "", remember: false } : current);
    setApiKey("");
    setRemember(false);
    setEditing(true);
    setNotice("Key 已从本机删除。");
  };

  if (loading) {
    return <div className="flex h-full items-center justify-center text-[13px] text-[var(--foreground-muted)]"><Loader2 size={16} className="mr-2 animate-spin" />读取 Agent 配置…</div>;
  }

  return (
    <section className="flex h-full min-h-0 flex-col bg-[var(--background)] text-[var(--foreground)]">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Bot size={16} strokeWidth={1.75} />
          <div className="min-w-0">
            <p className="truncate text-[13px] font-semibold">OfferU Agent</p>
            <p className="truncate text-[11px] text-[var(--foreground-muted)]">
              {config ? `${config.model} · ${hostOf(config.baseUrl)}` : "浏览器演示 · 尚未配置模型"}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {config && <button type="button" onClick={() => setEditing((value) => !value)} className="rounded p-1.5 text-[var(--foreground-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--foreground)]" aria-label="模型设置"><Settings2 size={14} /></button>}
          <button type="button" onClick={() => void clearChat()} className="rounded p-1.5 text-[var(--foreground-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--foreground)]" aria-label="清空对话"><Trash2 size={14} /></button>
        </div>
      </header>

      {editing ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
            <p className="flex items-center gap-2 text-[13px] font-medium"><KeyRound size={14} /> 模型配置</p>
            <p className="mt-1 text-[12px] leading-relaxed text-[var(--foreground-muted)]">
              Key 只用于浏览器直连你填的 provider，不经过 OfferU 服务器。记住 Key 会用设备密钥 AES-GCM 存 IndexedDB，但不防同源 XSS；共用电脑不要勾选。
            </p>
            <label className="mt-3 block text-[12px] text-[var(--foreground-muted)]">
              预设
              <select onChange={(event) => pickPreset(event.target.value)} className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-[13px] text-[var(--foreground)]" defaultValue="deepseek">
                {PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
              </select>
            </label>
            <label className="mt-3 block text-[12px] text-[var(--foreground-muted)]">
              Base URL
              <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 font-mono text-[12px] text-[var(--foreground)]" />
            </label>
            <label className="mt-3 block text-[12px] text-[var(--foreground-muted)]">
              模型
              <input value={model} onChange={(event) => setModel(event.target.value)} placeholder="模型名" className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-[13px] text-[var(--foreground)]" />
            </label>
            <label className="mt-3 block text-[12px] text-[var(--foreground-muted)]">
              API Key
              <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" spellCheck={false} placeholder={config?.apiKey ? "留空沿用已保存的 Key" : "sk-…"} className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 font-mono text-[12px] text-[var(--foreground)]" />
            </label>
            <label className="mt-3 flex items-center gap-2 text-[12px] text-[var(--foreground-muted)]">
              <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
              记住 Key（设备密钥加密，刷新后自动解锁）
            </label>
            {error && <p role="alert" className="mt-3 text-[12px] leading-relaxed text-[var(--foreground)]">{error}</p>}
            {notice && <p role="status" className="mt-3 text-[12px] leading-relaxed text-[var(--foreground-muted)]">{notice}</p>}
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => void saveConfig()} className="rounded-md bg-[var(--foreground)] px-3 py-1.5 text-[12px] text-[var(--background)]">保存并开始</button>
              {config && <button type="button" onClick={() => setEditing(false)} className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[12px]">取消</button>}
              {config?.remember && <button type="button" onClick={() => void forget()} className="text-[12px] text-[var(--foreground-muted)] underline">忘记 Key</button>}
            </div>
            <p className="mt-4 text-[11px] leading-relaxed text-[var(--foreground-muted)]">
              浏览器直连要求 provider 允许 CORS；请求失败时换一个兼容端点。演示站不代理模型请求。
            </p>
          </div>
        </div>
      ) : (
        <>
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            <div className="space-y-4">
              {messages.map((message) => (
                <div key={message.id} className={message.role === "user" ? "flex justify-end" : "flex justify-start"}>
                  <div className={message.role === "user"
                    ? "max-w-[88%] rounded-lg bg-[var(--foreground)] px-3 py-2 text-[13px] leading-relaxed text-[var(--background)]"
                    : "max-w-[94%] rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[13px] leading-relaxed"}>
                    {message.role === "assistant" && message.content
                      ? <AgentMarkdown text={message.content} />
                      : <p className="whitespace-pre-wrap">{message.content || "…"}</p>}
                  </div>
                </div>
              ))}
              {activity.length > 0 && (
                <ul className="space-y-1 border-l border-[var(--border)] pl-3 text-[11px] text-[var(--foreground-muted)]">
                  {activity.map((item) => <li key={item.id} className={item.failed ? "text-[var(--foreground)]" : ""}>{item.text}</li>)}
                </ul>
              )}
              {error && <p role="alert" className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-[12px] leading-relaxed">{error}</p>}
              {notice && <p role="status" className="text-[11px] text-[var(--foreground-muted)]">{notice}</p>}
            </div>
          </div>
          <div className="shrink-0 border-t border-[var(--border)] p-3">
            <div className="mb-2 flex flex-wrap gap-1.5">
              {["今天有什么要做的？", "把字节跳动推进到 offer", "搜一下蚂蚁的岗位"].map((prompt) => (
                <button key={prompt} type="button" disabled={busy} onClick={() => setInput(prompt)} className="rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--foreground-muted)] hover:text-[var(--foreground)] disabled:opacity-50">{prompt}</button>
              ))}
            </div>
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void send();
                  }
                }}
                rows={2}
                placeholder="问 OfferU，或让它改一条记录…"
                className="min-h-[54px] flex-1 resize-none rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[13px] leading-relaxed text-[var(--foreground)] outline-none focus:border-[var(--border-strong)]"
              />
              {busy ? (
                <button type="button" onClick={stop} className="flex h-9 w-9 items-center justify-center rounded-md border border-[var(--border)] text-[var(--foreground)]" aria-label="停止"><Square size={14} /></button>
              ) : (
                <button type="button" onClick={() => void send()} disabled={!input.trim()} className="flex h-9 w-9 items-center justify-center rounded-md bg-[var(--foreground)] text-[var(--background)] disabled:opacity-40" aria-label="发送"><Send size={15} /></button>
              )}
            </div>
            <p className="mt-2 text-[10.5px] text-[var(--foreground-muted)]">
              {config?.apiKey ? `Key 在${config.remember ? "本机加密存储" : "当前页面内存"} · 请求直连 ${hostOf(config.baseUrl)}` : "尚未配置模型"}
            </p>
          </div>
        </>
      )}
    </section>
  );
}
