"use client";

import { useMemo, useState } from "react";
import { mutate as globalMutate } from "swr";
import { Check, CheckCheck, Plus, Search, Trash2 } from "lucide-react";

import { Button, Dialog, Field, Input, Pill } from "@/components/ui";
import { MEMORY_KIND, useTool, write, type Memory, type MemoryKind } from "@/lib/core";

/**
 * Hark-style Memory Layer Governance Dialog: transparent view of what the Agent remembers,
 * active preference rules injected into every prompt, one-tap confirmation for pending
 * Agent-written memories, quick "+ remember preference", and undoable "forget".
 */
export function AgentMemoryDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data, mutate } = useTool<{ items: Memory[] }>("list", { type: "memory" });
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [prefTitle, setPrefTitle] = useState("");
  const [prefBody, setPrefBody] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");

  const items = data?.items ?? [];
  const pending = useMemo(() => items.filter((item) => item.confirmed === false), [items]);
  const preferences = useMemo(() => items.filter((item) => item.confirmed !== false && item.kind === "preference"), [items]);
  const confirmed = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items
      .filter((item) => item.confirmed !== false && item.kind !== "preference")
      .filter((item) => !q || `${item.title || ""}\n${item.body || ""}`.toLowerCase().includes(q));
  }, [items, query]);

  const refresh = async () => {
    await mutate();
    await globalMutate("agent-proactive");
  };

  const confirmOne = async (id: number) => {
    setBusyKey(`confirm:${id}`);
    setError("");
    setFeedback("");
    try {
      await write("save", { type: "memory", id, data: { confirmed: true } });
      setFeedback("已确认生效，可在「最近改动」撤销。");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "确认失败");
    } finally {
      setBusyKey("");
    }
  };

  const confirmAll = async () => {
    if (!pending.length) return;
    setBusyKey("confirm-all");
    setError("");
    setFeedback("");
    try {
      for (const item of pending) {
        await write("save", { type: "memory", id: item.id, data: { confirmed: true } });
      }
      setFeedback(`已全部确认 ${pending.length} 条记忆，后续定制简历和网申回答会自动使用。`);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "批量确认失败");
    } finally {
      setBusyKey("");
    }
  };

  const forgetOne = async (id: number) => {
    setBusyKey(`forget:${id}`);
    setError("");
    setFeedback("");
    try {
      await write("delete", { type: "memory", id });
      setFeedback("已忘记这条记忆（可在「最近改动」撤销恢复）。");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "删除失败");
    } finally {
      setBusyKey("");
    }
  };

  const addPreference = async () => {
    const title = prefTitle.trim();
    const body = prefBody.trim();
    if (!title) return;
    setBusyKey("add-pref");
    setError("");
    setFeedback("");
    try {
      await write("save", {
        type: "memory",
        data: { kind: "preference", title, body: body || title },
      });
      setPrefTitle("");
      setPrefBody("");
      setAdding(false);
      setFeedback("已记住这条偏好，之后每轮对话都会遵守。");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存偏好失败");
    } finally {
      setBusyKey("");
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Agent 长期记忆"
      description="查看 Agent 当前记住了什么、确认待生效经历、添加偏好规则，或随时让它忘记某条内容（所有改动可撤销）。"
    >
      <div className="max-h-[65vh] space-y-5 overflow-y-auto pr-1" data-testid="agent-memory-dialog">
        {feedback && <p role="status" className="text-xs text-[var(--ou-tone-green-text)]">{feedback}</p>}
        {error && <p role="alert" className="text-xs text-[var(--ou-tone-red-text)]">{error}</p>}

        {/* 1. Pending confirmation */}
        {pending.length > 0 && (
          <section className="space-y-2.5" aria-label="待确认记忆">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <h3 className="text-xs font-semibold text-[var(--ou-text-primary)]">待确认记忆</h3>
                <Pill tone="orange">{pending.length} 条</Pill>
              </div>
              <Button variant="primary" size="sm" disabled={Boolean(busyKey)} onClick={() => void confirmAll()}>
                <CheckCheck size={13} aria-hidden />
                {busyKey === "confirm-all" ? "确认中…" : "全部确认"}
              </Button>
            </div>
            <ul className="space-y-2">
              {pending.map((item) => (
                <li key={item.id} className="ou-sheet flex items-start justify-between gap-3 p-3" data-testid={`memory-pending-${item.id}`}>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Pill tone="gray">{MEMORY_KIND[item.kind as MemoryKind] ?? "其他"}</Pill>
                      <span className="text-xs font-semibold text-[var(--ou-text-primary)]">{item.title || "未命名记忆"}</span>
                    </div>
                    {item.body && <p className="line-clamp-2 text-xs text-[var(--ou-text-secondary)]">{item.body}</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button variant="secondary" size="sm" disabled={Boolean(busyKey)} onClick={() => void confirmOne(item.id)}>
                      <Check size={13} aria-hidden />
                      确认
                    </Button>
                    <Button variant="ghost" size="sm" aria-label="忘记" disabled={Boolean(busyKey)} onClick={() => void forgetOne(item.id)}>
                      <Trash2 size={13} aria-hidden />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* 2. Preferences & rules */}
        <section className="space-y-2.5" aria-label="生效中的偏好与规则">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <h3 className="text-xs font-semibold text-[var(--ou-text-primary)]">生效中的偏好与口径</h3>
              <Pill tone="purple">{preferences.length} 条</Pill>
            </div>
            <Button variant="secondary" size="sm" onClick={() => setAdding((v) => !v)}>
              <Plus size={13} aria-hidden />
              记住一条偏好
            </Button>
          </div>

          {adding && (
            <div className="ou-sheet space-y-3 p-3" data-testid="memory-add-pref-form">
              <Field label="偏好主题" hint="例：期望城市 / 简历措辞偏好 / 不看外包">
                {(id) => (
                  <Input
                    id={id}
                    value={prefTitle}
                    onChange={(event) => setPrefTitle(event.target.value)}
                    placeholder="如：目标岗位方向"
                  />
                )}
              </Field>
              <Field label="具体规则（可选）">
                {(id) => (
                  <Input
                    id={id}
                    value={prefBody}
                    onChange={(event) => setPrefBody(event.target.value)}
                    placeholder="如：优先深圳和杭州的 AI 产品 / Agent 架构岗"
                  />
                )}
              </Field>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>取消</Button>
                <Button variant="primary" size="sm" disabled={!prefTitle.trim() || Boolean(busyKey)} onClick={() => void addPreference()}>
                  {busyKey === "add-pref" ? "保存中…" : "记住"}
                </Button>
              </div>
            </div>
          )}

          {preferences.length === 0 ? (
            <p className="text-xs text-[var(--ou-text-muted)]">还没有保存偏好规则。记住偏好后，每次对话与简历改写都会自动遵守。</p>
          ) : (
            <ul className="space-y-1.5">
              {preferences.map((item) => (
                <li key={item.id} className="ou-sheet flex items-start justify-between gap-3 p-3">
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="text-xs font-semibold text-[var(--ou-text-primary)]">{item.title}</p>
                    {item.body && item.body !== item.title && (
                      <p className="text-xs text-[var(--ou-text-secondary)]">{item.body}</p>
                    )}
                  </div>
                  <Button variant="ghost" size="sm" aria-label={`忘记 ${item.title}`} disabled={Boolean(busyKey)} onClick={() => void forgetOne(item.id)}>
                    <Trash2 size={13} aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 3. Confirmed memories */}
        <section className="space-y-2.5" aria-label="已确认档案记忆">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold text-[var(--ou-text-primary)]">已确认档案记忆</h3>
            <Pill tone="green">{confirmed.length} 条</Pill>
          </div>
          <div className="relative flex items-center">
            <Search size={13} aria-hidden className="pointer-events-none absolute left-3 text-[var(--ou-text-muted)]" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索已确认的经历、项目或技能"
              aria-label="搜索已确认记忆"
              className="pl-8"
            />
          </div>
          {confirmed.length === 0 ? (
            <p className="text-xs text-[var(--ou-text-muted)]">{items.length ? "没有匹配的已确认记忆" : "还没有已确认记忆"}</p>
          ) : (
            <ul className="space-y-1.5">
              {confirmed.map((item) => (
                <li key={item.id} className="ou-sheet flex items-start justify-between gap-3 p-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Pill tone="gray">{MEMORY_KIND[item.kind as MemoryKind] ?? "其他"}</Pill>
                      <span className="text-xs font-semibold text-[var(--ou-text-primary)]">{item.title || "未命名记忆"}</span>
                    </div>
                    {item.body && <p className="line-clamp-2 text-xs text-[var(--ou-text-secondary)]">{item.body}</p>}
                  </div>
                  <Button variant="ghost" size="sm" aria-label={`忘记 ${item.title}`} disabled={Boolean(busyKey)} onClick={() => void forgetOne(item.id)}>
                    <Trash2 size={13} aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Dialog>
  );
}
