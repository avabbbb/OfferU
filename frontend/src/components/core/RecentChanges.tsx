"use client";

import { useState } from "react";

import { type Change, write } from "@/lib/core";

/** 谁改了什么，一键撤销。Agent 直接写，靠这里兜底。 */
export function RecentChanges({ items }: { items: Change[] }) {
  const [busy, setBusy] = useState<number | null>(null);
  if (!items.length) return null;
  return (
    <section>
      <h2 className="text-[13px] font-medium text-[var(--foreground-muted)]">最近改动</h2>
      <ul className="mt-2 divide-y divide-[var(--border)]">
        {items.map((change) => (
          <li key={change.id} className="flex items-baseline justify-between gap-4 py-2 text-[13px]">
            <span className={change.undone_at ? "text-[var(--foreground-muted)] line-through" : "text-[var(--foreground)]"}>
              {change.summary}
              <span className="ml-2 text-[12px] text-[var(--foreground-muted)]">{change.actor} · {change.at.slice(5, 16).replace("T", " ")}</span>
            </span>
            {!change.undone_at && (
              <button type="button" disabled={busy === change.id} className="shrink-0 text-[12px] text-[var(--foreground-muted)] hover:text-[var(--foreground)]"
                onClick={async () => { setBusy(change.id); try { await write("undo", { change_id: change.id }); } finally { setBusy(null); } }}>
                撤销
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
