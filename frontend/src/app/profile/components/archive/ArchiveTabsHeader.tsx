"use client";

import { motion } from "framer-motion";
import { FileOutput, LayoutList, Settings2, Sheet } from "lucide-react";
import type { ArchiveTab } from "@/lib/personalArchive";

export type ProfileArchiveView = "overview" | ArchiveTab;

interface ArchiveTabsHeaderProps {
  activeView: ProfileArchiveView;
  onViewChange: (view: ProfileArchiveView) => void;
  onOpenSettings: () => void;
}

export default function ArchiveTabsHeader(props: ArchiveTabsHeaderProps) {
  const views = [
    { key: "overview" as const, label: "档案总览", icon: LayoutList },
    { key: "resume" as const, label: "简历输出", icon: FileOutput },
    { key: "application" as const, label: "网申输出", icon: Sheet },
  ];

  return (
    <div className="flex items-center justify-between gap-3 border-y border-[var(--border)] py-2">
      <div className="flex min-w-0 items-center gap-0.5">
        {views.map((view) => {
          const Icon = view.icon;
          const active = props.activeView === view.key;
          return (
            <button
              key={view.key}
              type="button"
              onClick={() => props.onViewChange(view.key)}
              aria-pressed={active}
              className={`relative flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12.5px] font-medium transition-colors duration-[var(--dur-quick)] ${
                active
                  ? "text-[var(--foreground)]"
                  : "text-[var(--foreground-muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]"
              }`}
            >
              {active && (
                <motion.span
                  layoutId="profile-view-active"
                  className="absolute inset-0 rounded-md bg-[var(--surface-muted)]"
                  transition={{ type: "spring", stiffness: 360, damping: 38, mass: 0.75 }}
                />
              )}
              <Icon size={13} strokeWidth={1.75} className="relative z-10" />
              <span className="relative z-10">{view.label}</span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        aria-label="打开档案同步设置"
        onClick={props.onOpenSettings}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--foreground-muted)] transition-colors duration-[var(--dur-quick)] hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]"
      >
        <Settings2 size={15} strokeWidth={1.75} />
      </button>
    </div>
  );
}
