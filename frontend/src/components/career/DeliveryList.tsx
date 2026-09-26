"use client";

// =============================================
// 交付物列表 —— 渲染后端 resolve_deliveries 的真实状态。
// suggested/preparing 只呈现真实任务状态；blocked/failed/stale 展示原因。
// 在 Artifact read route 接入前，ready 只表示已保存；不导航到尚未实现的 ?artifact API。
// =============================================

import Link from "next/link";
import { AlertTriangle, ArrowRight, CheckCircle2, LoaderCircle } from "lucide-react";
import type { CareerDelivery } from "@/lib/api";
import {
  deliveryNeedsAttention,
  deliveryStateLabel,
  deliveryTypeLabel,
} from "@/components/career/deliveries";

function toneClasses(state: string | undefined): string {
  switch (state) {
    case "ready":
      return "bg-[var(--status-sage)] text-[var(--primary-green)]";
    case "preparing":
      return "bg-[var(--primary-blue)]/10 text-[var(--primary-blue)]";
    case "blocked":
    case "stale":
      return "bg-[var(--primary-yellow)]/15 text-[var(--primary-yellow)]";
    case "failed":
      return "bg-[var(--status-blush)] text-[var(--primary-red)]";
    default:
      return "bg-[var(--surface-muted)] text-[var(--foreground-muted)]";
  }
}

function DeliveryRow({
  delivery,
  onOpenArtifact,
}: {
  delivery: CareerDelivery;
  onOpenArtifact?: (artifactId: string) => void;
}) {
  const ready = delivery.state === "ready" && Boolean(delivery.artifact_id);
  const title = delivery.title || deliveryTypeLabel(delivery.artifact_type);
  const provenance = delivery.provenance;

  return (
    <li
      className="flex items-start gap-2.5 rounded-md px-2.5 py-2"
      data-testid="career-delivery"
      data-state={delivery.state}
      data-artifact-type={delivery.artifact_type}
    >
      <span className="mt-1 shrink-0">
        {delivery.state === "ready" ? (
          <CheckCircle2 size={13} className="text-[var(--primary-green)]" />
        ) : delivery.state === "preparing" ? (
          <LoaderCircle size={13} className="animate-spin text-[var(--primary-blue)]" />
        ) : deliveryNeedsAttention(delivery) ? (
          <AlertTriangle size={13} className="text-[var(--primary-yellow)]" />
        ) : (
          <span className="block h-1.5 w-1.5 rounded-full bg-[var(--border-strong)]" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-[12px] font-medium text-[var(--foreground)]">{title}</span>
          <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${toneClasses(delivery.state)}`}>
            {deliveryStateLabel(delivery.state)}
          </span>
          {delivery.artifact_type ? (
            <span className="text-[10px] text-[var(--foreground-faint)]">
              {deliveryTypeLabel(delivery.artifact_type)}
            </span>
          ) : null}
        </span>
        {deliveryNeedsAttention(delivery) && delivery.reason ? (
          <span className="mt-0.5 block text-[11px] leading-4 text-[var(--primary-yellow)]">
            {delivery.reason}
          </span>
        ) : null}
        {delivery.state === "preparing" && delivery.task_id ? (
          <span className="mt-0.5 block text-[11px] leading-4 text-[var(--foreground-muted)]">
            任务 {delivery.task_id} 正在执行
          </span>
        ) : null}
        {delivery.artifact_type === "interview_prep" && delivery.practice?.total ? (
          <span className="mt-0.5 block text-[11px] leading-4 text-[var(--foreground-muted)]">
            已练 {delivery.practice.answered}/{delivery.practice.total} 题
            {delivery.practice.completed ? " · 全部完成" : ""}
          </span>
        ) : null}
        {delivery.artifact_type === "follow_up_draft" && ready ? (
          <span className="mt-0.5 block text-[11px] leading-4 text-[var(--foreground-muted)]">
            草稿已保存，需你确认后才会使用——不会自动发送。
          </span>
        ) : null}
        {provenance?.last_seen_at ? (
          <span className="mt-0.5 block text-[10.5px] leading-4 text-[var(--foreground-faint)]">
            证据更新于 {provenance.last_seen_at}
          </span>
        ) : null}
      </span>
      {ready ? (
        delivery.artifact_id && onOpenArtifact ? (
          <button
            type="button"
            onClick={() => onOpenArtifact(String(delivery.artifact_id))}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-[11px] font-medium text-[var(--foreground)] hover:bg-[var(--surface-muted)]"
          >
            {delivery.artifact_type === "interview_prep" ? "打开练习" : "查看"}
            <ArrowRight size={11} />
          </button>
        ) : (
          <span className="flex shrink-0 flex-col items-end gap-1 text-right">
            <span className="text-[10.5px] text-[var(--foreground-faint)]">已保存，详情暂不可打开</span>
            {delivery.job_id ? (
              <Link
                href={`/jobs/${encodeURIComponent(String(delivery.job_id))}`}
                className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-[11px] font-medium text-[var(--foreground)] hover:bg-[var(--surface-muted)]"
              >
                打开岗位工作区
                <ArrowRight size={11} />
              </Link>
            ) : null}
          </span>
        )
      ) : null}
    </li>
  );
}

export function DeliveryList({
  deliveries,
  onOpenArtifact,
  heading,
}: {
  deliveries: CareerDelivery[];
  onOpenArtifact?: (artifactId: string) => void;
  heading?: string;
}) {
  if (!deliveries.length) return null;
  return (
    <div data-testid="career-delivery-list">
      {heading ? (
        <p className="mb-1 text-[11px] font-medium text-[var(--foreground-muted)]">{heading}</p>
      ) : null}
      <ul className="space-y-1">
        {deliveries.map((delivery, index) => (
          <DeliveryRow
            key={String(delivery.artifact_id || delivery.action_key || `${delivery.artifact_type}-${index}`)}
            delivery={delivery}
            onOpenArtifact={onOpenArtifact}
          />
        ))}
      </ul>
    </div>
  );
}

export default DeliveryList;
