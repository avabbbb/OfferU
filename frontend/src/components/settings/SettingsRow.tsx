"use client";

import { ChevronRight } from "lucide-react";

export function SettingsRow({
  rowKey,
  title,
  status,
  onOpen,
}: {
  rowKey: string;
  title: string;
  status?: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={"settings-row-" + rowKey}
      onClick={onOpen}
      className="flex w-full items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-[var(--surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--border-strong)]"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-[var(--foreground)]">{title}</span>
        {status && <span className="mt-0.5 block truncate text-xs text-[var(--foreground-muted)]">{status}</span>}
      </span>
      <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-[var(--foreground-muted)]" />
    </button>
  );
}
