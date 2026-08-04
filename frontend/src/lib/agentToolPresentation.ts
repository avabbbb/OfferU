import type { AgentToolCall } from "@/lib/api";

function record(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : null;
}

function countsText(value: unknown) {
  const counts = record(value);
  if (!counts) return "";
  return Object.entries(counts)
    .filter(([, count]) => Number(count) > 0)
    .map(([status, count]) => `${status} ${count}`)
    .join(" · ");
}

export function presentAgentToolCall(call: AgentToolCall): string | null {
  const result = record(call.result);
  if (!result) return null;

  if (call.tool === "start_batch_job_evaluation" || call.tool === "resume_batch_job_evaluation") {
    const state = result.accepted ? "已进入后台队列" : result.message || "未启动";
    return `${state} · ${result.runtime_id || "coding-agent"} · ${result.job_count || 0} 个岗位 · ${result.id || ""}`;
  }
  if (call.tool === "get_batch_job_evaluation") {
    const jobs = Array.isArray(result.jobs) ? result.jobs : [];
    const counts = jobs.reduce<Record<string, number>>((acc, item) => {
      const status = String(item?.status || "unknown");
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {});
    return `批处理 ${result.status || "unknown"} · ${countsText(counts) || `${jobs.length} 个岗位`}`;
  }
  if (call.tool === "list_batch_job_evaluations") {
    return `共 ${result.total || 0} 个持久批处理，可按 batch ID 继续查看或恢复。`;
  }
  if (call.tool === "list_coding_agents") {
    const available = Array.isArray(result.available_supported) ? result.available_supported.join("、") : "";
    return available ? `可用隔离 worker：${available}` : "没有检测到可用的隔离 coding-agent worker。";
  }
  if (call.tool === "save_career_artifact") {
    return `材料已原子保存：${result.title || result.id || "未命名材料"}`;
  }
  if (call.tool === "export_resume_pdf") {
    const kb = result.bytes ? Math.max(1, Math.round(Number(result.bytes) / 1024)) : 0;
    return `PDF 已保存：${result.filename || "resume.pdf"}${kb ? ` · ${kb} KB` : ""}`;
  }
  if (call.tool === "list_follow_up_cadence") {
    const metadata = record(result.metadata);
    if (!metadata) return null;
    return `可跟进 ${metadata.actionable_count || 0} · 紧急 ${metadata.urgent || 0} · 逾期 ${metadata.overdue || 0} · 冷却 ${metadata.cold || 0}`;
  }
  if (call.tool === "record_follow_up") {
    return `已记录实际发送：${result.sent_at || "今天"} · ${result.channel || "other"}`;
  }
  if (call.tool === "list_application_events") {
    return `已读取 ${result.total || 0} 条追加式投递事件。`;
  }
  if (call.tool === "analyze_application_patterns") {
    const metadata = record(result.metadata);
    const rates = record(result.conversion_rates);
    const coverage = metadata ? Math.round(Number(metadata.timeline_coverage_rate || 0) * 100) : 0;
    const interviewRate = rates?.applied_to_interview == null ? "暂无" : `${Math.round(Number(rates.applied_to_interview) * 100)}%`;
    return `时间线覆盖 ${coverage}% · 投递→面试 ${interviewRate}`;
  }
  if (call.tool === "add_profile_evidence") {
    return result.duplicate
      ? "这条职业证据已存在，没有重复写入。"
      : `职业证据已写入：${result.title || result.id || "新条目"}`;
  }
  if (call.tool === "create_application") {
    return `投递工作区记录${result.created ? "已创建" : "已存在"} · ${result.status || "待投递"}`;
  }
  return null;
}
