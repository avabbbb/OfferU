"use client";

import { Card, CardBody } from "@nextui-org/react";
import type { ArchiveCompletenessMetrics } from "@/lib/personalArchive";

interface ArchiveCompletenessBarProps {
  metrics: ArchiveCompletenessMetrics;
  onJump: (target: "resume" | "application" | "missing" | "syncable") => void;
}

function MetricCard(props: {
  title: string;
  value: string;
  hint?: string;
  colorClass?: string;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onPress}
      className={`bauhaus-panel-sm flex h-full w-full flex-col bg-[var(--surface)] p-4 text-left transition hover:-translate-y-[1px] ${props.colorClass || ""}`}
    >
      <div className="bauhaus-label text-[var(--foreground-muted)]">{props.title}</div>
      <div className="mt-2 text-2xl font-bold text-[var(--foreground)]">{props.value}</div>
      <div className="mt-2 min-h-[2.5rem] text-xs text-[var(--foreground-muted)]">{props.hint || ""}</div>
    </button>
  );
}

export default function ArchiveCompletenessBar(props: ArchiveCompletenessBarProps) {
  const { metrics } = props;
  const cardToneBlue = "bg-[color:color-mix(in_srgb,var(--auxiliary-blue)_14%,#ffffff_86%)]";
  const cardToneGreen = "bg-[color:color-mix(in_srgb,var(--auxiliary-green)_16%,#ffffff_84%)]";

  return (
    <Card className="bauhaus-panel overflow-hidden bg-[var(--surface)]">
      <CardBody className="grid grid-cols-1 gap-3 p-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          title="简历档案完整度"
          value={`${metrics.resumeCompleteness}%`}
          hint={metrics.missingResumeSections.length > 0 ? `待补：${metrics.missingResumeSections.join("、")}` : "已满足基础字段"}
          colorClass={cardToneBlue}
          onPress={() => props.onJump("resume")}
        />
        <MetricCard
          title="投递档案完整度"
          value={`${metrics.applicationCompleteness}%`}
          hint={metrics.missingApplicationSections.length > 0 ? `待补：${metrics.missingApplicationSections.join("、")}` : "已满足基础字段"}
          colorClass={cardToneGreen}
          onPress={() => props.onJump("application")}
        />
        <MetricCard
          title="待补字段"
          value={`${metrics.missingFieldCount} 项`}
          hint="点击跳到第一个待补区域"
          colorClass={cardToneBlue}
          onPress={() => props.onJump("missing")}
        />
        <MetricCard
          title="可同步字段"
          value={`${metrics.syncableFieldCount} 项`}
          hint="点击打开同步设置"
          colorClass={cardToneGreen}
          onPress={() => props.onJump("syncable")}
        />
      </CardBody>
    </Card>
  );
}
