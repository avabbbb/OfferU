"use client";

// 历史对话浮层：顶上一个搜索框（打开即聚焦），下面是对话列表。
// 键盘：↑/↓ 移动高亮、Enter 打开、Delete 删除高亮那条、Esc 先清空搜索再关闭；焦点一直在搜索框里。
// 规则来自 avabbbb/Flovart@28c79bf:hooks/useListboxKeyboard.ts（已移植到 lib/useListboxKeyboard.ts）；
// 外观沿用 OfferU 原有的 .agent-history / .agent-history-row。

import { useMemo, useState } from "react";
import { Briefcase, Plus, Search, Trash2 } from "lucide-react";
import type { AgentConversationSummary } from "@/lib/api";
import { useListboxKeyboard } from "@/lib/useListboxKeyboard";

export function filterConversations(
  conversations: AgentConversationSummary[],
  query: string,
  scope: "all" | "projects" = "all",
): AgentConversationSummary[] {
  const scoped = scope === "projects" ? conversations.filter((item) => Boolean(item.job_id)) : conversations;
  const q = query.trim().toLowerCase();
  if (!q) return scoped;
  return scoped.filter((item) => `${item.title || ""}\n${item.last_message || ""}`.toLowerCase().includes(q));
}

export function AgentHistoryList({ conversations, currentId, jobLabels, onOpen, onDelete, onNew, onClose }: {
  conversations: AgentConversationSummary[];
  currentId: string | null;
  jobLabels?: Record<number, string>;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"all" | "projects">("all");
  const projectCount = useMemo(() => conversations.filter((item) => Boolean(item.job_id)).length, [conversations]);
  const items = useMemo(() => filterConversations(conversations, query, scope), [conversations, query, scope]);
  const listbox = useListboxKeyboard<AgentConversationSummary>({
    items,
    query,
    onQueryChange: setQuery,
    onClose,
    onSelect: (item) => onOpen(item.id),
    initialIndex: Math.max(0, items.findIndex((item) => item.id === currentId)),
  });

  return (
    <div className="agent-history" data-testid="agent-history" {...listbox.getContainerProps({
      onKeyDown: (event) => {
        if (event.key !== "Delete" || listbox.activeIndex < 0) return;
        // 搜索框里光标不在末尾时，Delete 还是删字。
        const field = event.target as HTMLInputElement;
        if (field.tagName === "INPUT" && (field.selectionStart ?? 0) < field.value.length) return;
        const target = items[listbox.activeIndex];
        if (!target) return;
        event.preventDefault();
        onDelete(target.id);
      },
    })}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1" role="tablist" aria-label="对话范围">
          <button
            type="button"
            role="tab"
            aria-selected={scope === "all"}
            onClick={() => setScope("all")}
            className={`ou-button ou-button-sm ${scope === "all" ? "ou-button-secondary" : "ou-button-ghost"}`}
          >
            全部
          </button>
          {projectCount > 0 && (
            <button
              type="button"
              role="tab"
              aria-selected={scope === "projects"}
              onClick={() => setScope("projects")}
              className={`ou-button ou-button-sm ${scope === "projects" ? "ou-button-secondary" : "ou-button-ghost"}`}
            >
              <Briefcase size={12} aria-hidden />
              岗位项目 ({projectCount})
            </button>
          )}
        </div>
        <button type="button" onClick={onNew} className="ou-button ou-button-secondary ou-button-sm">
          <Plus size={12} />
          新建
        </button>
      </div>
      <label className="agent-history-search">
        <Search size={13} aria-hidden />
        <input {...listbox.getInputProps({ value: query, onChange: (event) => setQuery(event.target.value), placeholder: "搜索对话 · ↑↓ 选择 · Enter 打开 · Del 删除", "aria-label": "搜索历史对话" })} />
      </label>
      <div {...listbox.getListboxProps({ className: "max-h-40 space-y-1 overflow-y-auto", "aria-label": "历史对话" })}>
        {items.length === 0 && (
          <p className="rounded-md px-2 py-1.5 text-[length:var(--agent-fs-xs)] text-[var(--foreground-muted)]">{conversations.length ? "没有匹配的对话" : "暂无历史对话"}</p>
        )}
        {items.map((conversation, index) => {
          const projectName = conversation.job_id ? (jobLabels?.[conversation.job_id] || `岗位 #${conversation.job_id}`) : "";
          return (
            <div
              key={conversation.id}
              {...listbox.getOptionProps(index, { className: "agent-history-row", onClick: () => onOpen(conversation.id) })}
              aria-selected={conversation.id === currentId}
              data-current={conversation.id === currentId || undefined}
            >
              <span className="min-w-0 flex-1 text-left">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-[length:var(--agent-fs-sm)] font-medium text-[var(--foreground)]">
                    {conversation.title || "历史对话"}
                  </span>
                  {projectName && (
                    <span className="ou-pill ou-tone-purple shrink-0">
                      <span className="truncate">{projectName}</span>
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block truncate text-[length:var(--agent-fs-xs)] text-[var(--foreground-muted)]">
                  {conversation.message_count} 条 / {conversation.last_message}
                </span>
              </span>
              <button
                type="button"
                tabIndex={-1}
                aria-label="删除历史对话"
                onClick={(event) => { event.stopPropagation(); onDelete(conversation.id); }}
                className="agent-history-delete"
              >
                <Trash2 size={13} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
