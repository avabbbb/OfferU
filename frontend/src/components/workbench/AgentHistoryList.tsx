"use client";

// 历史对话浮层：顶上一个搜索框（打开即聚焦），下面是对话列表。
// 键盘：↑/↓ 移动高亮、Enter 打开、Delete 删除高亮那条、Esc 先清空搜索再关闭；焦点一直在搜索框里。
// 规则来自 avabbbb/Flovart@28c79bf:hooks/useListboxKeyboard.ts（已移植到 lib/useListboxKeyboard.ts）；
// 外观沿用 OfferU 原有的 .agent-history / .agent-history-row。

import { useMemo, useState } from "react";
import { Plus, Search, Trash2 } from "lucide-react";
import type { AgentConversationSummary } from "@/lib/api";
import { useListboxKeyboard } from "@/lib/useListboxKeyboard";

export function filterConversations(conversations: AgentConversationSummary[], query: string): AgentConversationSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return conversations;
  return conversations.filter((item) => `${item.title || ""}\n${item.last_message || ""}`.toLowerCase().includes(q));
}

export function AgentHistoryList({ conversations, currentId, onOpen, onDelete, onNew, onClose }: {
  conversations: AgentConversationSummary[];
  currentId: string | null;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const items = useMemo(() => filterConversations(conversations, query), [conversations, query]);
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
      <div className="mb-2 flex items-center justify-between">
        <p className="px-1 text-[length:var(--agent-fs-xs)] font-medium text-[var(--foreground-muted)]">历史对话</p>
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
        {items.map((conversation, index) => (
          <div
            key={conversation.id}
            {...listbox.getOptionProps(index, { className: "agent-history-row", onClick: () => onOpen(conversation.id) })}
            aria-selected={conversation.id === currentId}
            data-current={conversation.id === currentId || undefined}
          >
            <span className="min-w-0 flex-1 text-left">
              <span className="block truncate text-[length:var(--agent-fs-sm)] font-medium text-[var(--foreground)]">
                {conversation.title || "历史对话"}
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
        ))}
      </div>
    </div>
  );
}
