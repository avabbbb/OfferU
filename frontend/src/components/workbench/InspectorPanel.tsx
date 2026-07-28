"use client";

// =============================================
// 对象检查器 — 右侧上下文栏 "详情" 模式 (ADR 0031)
// 渐进披露:列表选中 → 此处显示摘要、关键属性与快捷操作;
// 复杂编辑通过"打开全屏"进入完整页面。
// =============================================

import { useEffect, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  ArrowUpRight,
  Briefcase,
  Calendar,
  ClipboardList,
  MousePointerClick,
  Send,
  UserRound,
} from "lucide-react";
import { useWorkbench, type WorkbenchSelection } from "@/lib/workbench";

const KIND_META: Record<
  WorkbenchSelection["kind"],
  { label: string; icon: typeof Briefcase; fullscreenHref?: (selection: WorkbenchSelection) => string }
> = {
  job: {
    label: "岗位",
    icon: Briefcase,
    fullscreenHref: (selection) => `/jobs/${selection.id}`,
  },
  application: {
    label: "投递",
    icon: Send,
  },
  event: {
    label: "日程",
    icon: Calendar,
    fullscreenHref: () => "/calendar",
  },
  task: {
    label: "求职任务",
    icon: ClipboardList,
  },
  "profile-fact": {
    label: "个人事实",
    icon: UserRound,
  },
};

/** 检查器里的一行属性 */
export interface InspectorField {
  label: string;
  value: string;
  emphasis?: boolean;
  placeholder?: string;
  inputType?: "text" | "email" | "tel" | "url";
  onCommit?: (value: string) => void | Promise<void>;
}

/** 检查器快捷操作(由选中方页面注入,保持操作语义在领域侧) */
export interface InspectorAction {
  label: string;
  onAction: () => void | Promise<void>;
  tone?: "default" | "primary" | "danger";
}

function readFields(selection: WorkbenchSelection): InspectorField[] {
  const fields = selection.data?.fields;
  return Array.isArray(fields) ? (fields as InspectorField[]) : [];
}

function readActions(selection: WorkbenchSelection): InspectorAction[] {
  const actions = selection.data?.actions;
  return Array.isArray(actions) ? (actions as InspectorAction[]) : [];
}

function readTimeline(selection: WorkbenchSelection): Array<{ time: string; text: string }> {
  const timeline = selection.data?.timeline;
  return Array.isArray(timeline) ? (timeline as Array<{ time: string; text: string }>) : [];
}

function readFullscreenHref(selection: WorkbenchSelection): string | null {
  if (typeof selection.data?.fullscreenHref === "string") return selection.data.fullscreenHref;
  const meta = KIND_META[selection.kind];
  return meta.fullscreenHref ? meta.fullscreenHref(selection) : null;
}

function InspectorFieldRow({ field }: { field: InspectorField }) {
  const [draft, setDraft] = useState(field.value || "");
  const [committedValue, setCommittedValue] = useState(field.value || "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(field.value || "");
    setCommittedValue(field.value || "");
  }, [field.value]);

  const commit = async () => {
    if (!field.onCommit || draft === committedValue) return;
    setSaving(true);
    try {
      await field.onCommit(draft);
      setCommittedValue(draft);
    } catch {
      setDraft(committedValue);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid grid-cols-[5.5rem_1fr] items-center gap-2">
      <dt className="truncate text-[12px] text-[var(--foreground-muted)]">{field.label}</dt>
      <dd className="min-w-0">
        {field.onCommit ? (
          <input
            aria-label={`编辑${field.label}`}
            type={field.inputType || "text"}
            value={draft}
            placeholder={field.placeholder}
            disabled={saving}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              }
              if (event.key === "Escape") {
                setDraft(field.value || "");
                event.currentTarget.blur();
              }
            }}
            className="h-8 w-full rounded-md border border-transparent bg-transparent px-2 text-[12.5px] text-[var(--foreground)] outline-none transition-colors duration-[var(--dur-quick)] placeholder:text-[var(--foreground-faint)] hover:border-[var(--border)] hover:bg-[var(--surface-muted)] focus:border-[var(--border-strong)] focus:bg-[var(--surface)]"
          />
        ) : (
          <span
            className={`block min-w-0 break-words text-[12.5px] ${
              field.emphasis
                ? "font-semibold text-[var(--foreground)]"
                : "text-[var(--foreground-soft)]"
            }`}
          >
            {field.value || "-"}
          </span>
        )}
      </dd>
    </div>
  );
}

export function InspectorPanel() {
  const { selection } = useWorkbench();

  if (!selection) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-[var(--surface-muted)] text-[var(--foreground-muted)]">
          <MousePointerClick size={18} strokeWidth={1.75} />
        </div>
        <div>
          <p className="text-[13px] font-medium text-[var(--foreground)]">未选中对象</p>
          <p className="mt-1 text-[12px] leading-5 text-[var(--foreground-muted)]">
            在列表中点击岗位、投递、日程、任务或个人事实，这里会显示摘要与快捷操作。
          </p>
        </div>
      </div>
    );
  }

  const meta = KIND_META[selection.kind];
  const Icon = meta.icon;
  const fields = readFields(selection);
  const actions = readActions(selection);
  const timeline = readTimeline(selection);
  const fullscreenHref = readFullscreenHref(selection);

  return (
    <motion.div
      key={`${selection.kind}-${selection.id}`}
      initial={{ opacity: 0, x: 12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ type: "spring", stiffness: 360, damping: 36, mass: 0.8 }}
      className="custom-scrollbar flex h-full flex-col overflow-y-auto"
    >
      {/* 对象头 */}
      <div className="border-b border-[var(--border)] px-4 py-3">
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--foreground-muted)]">
          <Icon size={12} strokeWidth={1.75} />
          {meta.label}
        </div>
        <h3 className="mt-1.5 text-[15px] font-semibold leading-snug text-[var(--foreground)]">
          {selection.title}
        </h3>
        {selection.subtitle && (
          <p className="mt-0.5 text-[12.5px] text-[var(--foreground-soft)]">{selection.subtitle}</p>
        )}
      </div>

      {/* 关键属性 */}
      {fields.length > 0 && (
        <dl className="space-y-2 border-b border-[var(--border)] px-4 py-3">
          {fields.map((field) => (
            <InspectorFieldRow
              key={field.label}
              field={field}
            />
          ))}
        </dl>
      )}

      {/* 时间线(按需展开) */}
      {timeline.length > 0 && (
        <details open className="border-b border-[var(--border)] px-4 py-3">
          <summary className="cursor-pointer text-[12px] font-medium text-[var(--foreground-soft)]">
            时间线
          </summary>
          <ol className="mt-2 space-y-1.5 border-l border-[var(--border-strong)] pl-3">
            {timeline.map((entry, index) => (
              <li key={`${entry.time}-${index}`} className="text-[12px] leading-5">
                <span className="text-[var(--foreground-muted)]">{entry.time}</span>
                <span className="ml-2 text-[var(--foreground)]">{entry.text}</span>
              </li>
            ))}
          </ol>
        </details>
      )}

      {/* 快捷操作 */}
      <div className="mt-auto space-y-1.5 px-4 py-3">
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            onClick={action.onAction}
            className={`bauhaus-button w-full !justify-center !text-[12.5px] ${
              action.tone === "primary"
                ? "bauhaus-button-blue bauhaus-button-outline"
                : action.tone === "danger"
                  ? "bauhaus-button-red"
                  : "bauhaus-button-outline"
            }`}
          >
            {action.label}
          </button>
        ))}
        {fullscreenHref && (
          <Link
            href={fullscreenHref}
            className="bauhaus-button bauhaus-button-outline w-full !justify-center !text-[12.5px]"
          >
            打开全屏
            <ArrowUpRight size={13} />
          </Link>
        )}
      </div>
    </motion.div>
  );
}
