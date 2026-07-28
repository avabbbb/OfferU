"use client";

import { Button } from "@nextui-org/react";
import { ListChecks, Save, Sparkles } from "lucide-react";

interface ArchiveIntroCardProps {
  name: string;
  jobIntention: string;
  updatedAt?: string;
  onImport: () => void;
  onOnboarding: () => void;
  onSave: () => void | Promise<void>;
  saving: boolean;
}

function formatUpdatedAt(value?: string) {
  if (!value) return "尚未保存";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "最近已更新";
  return `更新于 ${date.toLocaleDateString("zh-CN", {
    month: "numeric",
    day: "numeric",
  })}`;
}

export default function ArchiveIntroCard(props: ArchiveIntroCardProps) {
  const displayName = props.name.trim() || "个人档案";
  const initial = displayName.slice(0, 1).toUpperCase();

  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-3">
        <div className="profile-woven-accent flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-[var(--border-strong)] text-[14px] font-semibold text-[var(--foreground)]">
          {initial}
        </div>
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-[var(--foreground-muted)]">个人档案</p>
          <h1 className="mt-0.5 truncate text-[22px] font-semibold tracking-tight text-[var(--foreground)]">
            {displayName}
          </h1>
          <p className="mt-0.5 truncate text-[12px] text-[var(--foreground-muted)]">
            {[props.jobIntention.trim() || "方向待确认", formatUpdatedAt(props.updatedAt)].join(" · ")}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
        <Button
          startContent={<ListChecks size={14} />}
          className="bauhaus-button bauhaus-button-sm"
          onPress={props.onOnboarding}
        >
          建档向导
        </Button>
        <Button
          startContent={<Sparkles size={14} />}
          className="bauhaus-button bauhaus-button-sm"
          onPress={props.onImport}
        >
          AI 导入
        </Button>
        <Button
          startContent={<Save size={14} />}
          isLoading={props.saving}
          className="bauhaus-button bauhaus-button-sm !bg-[var(--foreground)] !px-3 !text-white hover:!bg-[var(--foreground-soft)]"
          onPress={props.onSave}
        >
          保存
        </Button>
      </div>
    </header>
  );
}
