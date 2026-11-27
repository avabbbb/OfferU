import type { AgentToolCall } from "@/lib/api";
import type { ToolExecutionState, ToolExecutionStatus } from "@/lib/embeddedAgentStream";
import { safeClientErrorMessage } from "@/lib/safe-error";

function record(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : null;
}

/** Unwrap ToolResultView `{ content: [{ type: "text", text: "<json>" }] }` or plain objects. */
export function parseToolPayload(value: unknown): Record<string, any> | null {
  const obj = record(value);
  if (!obj) {
    if (typeof value === "string" && value.trim().startsWith("{")) {
      try {
        return record(JSON.parse(value));
      } catch {
        return null;
      }
    }
    return null;
  }
  if (Array.isArray(obj.content)) {
    const firstText = obj.content.find((part: unknown) => record(part)?.type === "text" && typeof record(part)?.text === "string");
    if (firstText) {
      try {
        return record(JSON.parse(String(firstText.text)));
      } catch {
        return obj;
      }
    }
  }
  return obj;
}

const RECORD_TYPE_LABEL: Record<string, string> = {
  profile: "职业档案",
  memory: "职业记忆",
  job: "岗位",
  event: "日程事项",
  doc: "文档",
};

const TOOL_VERBS: Record<string, { running: string; done: string }> = {
  overview: { running: "正在查看今日全貌", done: "已读取今日全貌" },
  search: { running: "正在检索档案与记录", done: "已检索档案与记录" },
  list: { running: "正在列出记录", done: "已读取记录列表" },
  get: { running: "正在读取详情", done: "已读取详情" },
  save: { running: "正在保存记录", done: "已保存记录" },
  delete: { running: "正在删除记录", done: "已删除记录" },
  undo: { running: "正在撤销改动", done: "已撤销改动" },
  changes: { running: "正在查看最近改动", done: "已读取最近改动" },
  read_file: { running: "正在读取本机文件", done: "已读取本机文件" },
  find_files: { running: "正在查找本机文件", done: "已查找本机文件" },
  web_search: { running: "正在联网搜索", done: "已完成联网搜索" },
  fetch_page: { running: "正在抓取网页正文", done: "已获取网页正文" },
  add_job: { running: "正在解析并收藏岗位", done: "已收藏岗位" },
  evaluate_jobs: { running: "正在评估岗位匹配度", done: "已完成岗位评估" },
  tailor_resume: { running: "正在按 JD 定制简历", done: "已完成简历定制" },
  split_resume: { running: "正在拆分旧简历入档", done: "已拆分旧简历入档" },
  export_resume_pdf: { running: "正在导出简历 PDF", done: "已导出简历 PDF" },
  apply_answer: { running: "正在生成网申回答", done: "已生成网申回答" },
  draft_email: { running: "正在起草投递邮件", done: "已生成邮件草稿" },
  reconcile_memory: { running: "正在核对记忆一致性", done: "已完成记忆核对" },
  delegate_research: { running: "正在并行调研核查", done: "已完成并行调研" },
  request_user_input: { running: "等待你的确认", done: "已发起确认提问" },
  tool_manual: { running: "正在查阅工具说明", done: "已查阅工具说明" },
  skill_read: { running: "正在加载专业技能", done: "已加载专业技能" },
};

function short(value: unknown, max = 28): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export interface FormattedToolStep {
  title: string;
  detail?: string;
}

/** Human-readable Chinese step title and factual result summary for live execution transparency. */
export function formatToolStep(
  toolName: string,
  args?: unknown,
  status: ToolExecutionStatus = "done",
  result?: unknown,
): FormattedToolStep {
  const input = record(args) ?? {};
  const payload = parseToolPayload(result);
  const verb = TOOL_VERBS[toolName];
  const base = verb ? (status === "running" ? verb.running : verb.done) : toolName;

  if (toolName === "search" && input.query) {
    const count = Array.isArray(payload?.items) ? payload.items.length : null;
    return {
      title: `${base}：${short(input.query, 24)}`,
      detail: count !== null ? `命中 ${count} 条` : undefined,
    };
  }
  if (toolName === "list" && input.type) {
    const typeLabel = RECORD_TYPE_LABEL[String(input.type)] ?? String(input.type);
    const count = Array.isArray(payload?.items) ? payload.items.length : null;
    return {
      title: `${status === "running" ? "正在查看" : "已读取"}${typeLabel}`,
      detail: count !== null ? `共 ${count} 条` : undefined,
    };
  }
  if (toolName === "get" && input.type) {
    const typeLabel = RECORD_TYPE_LABEL[String(input.type)] ?? String(input.type);
    const idNote = input.id ? ` #${input.id}` : "";
    return { title: `${status === "running" ? "正在读取" : "已读取"}${typeLabel}${idNote}` };
  }
  if (toolName === "save") {
    const typeLabel = RECORD_TYPE_LABEL[String(input.type ?? "")] ?? "记录";
    const data = record(input.data);
    const name = short(data?.title || [data?.company, data?.title].filter(Boolean).join(" ") || data?.name || payload?.record?.title || payload?.record?.name, 24);
    const changeId = typeof payload?.change_id === "number" ? payload.change_id : null;
    return {
      title: `${status === "running" ? "正在保存" : "已保存"}${typeLabel}${name ? `：${name}` : ""}`,
      detail: changeId ? `改动 #${changeId} · 可撤销` : undefined,
    };
  }
  if (toolName === "add_job") {
    const job = record(payload?.job ?? payload?.record);
    const name = short([job?.company, job?.title].filter(Boolean).join(" · ") || input.text, 26);
    return {
      title: `${base}${name ? `：${name}` : ""}`,
      detail: job?.id ? `岗位 #${job.id}` : undefined,
    };
  }
  if (toolName === "evaluate_jobs") {
    const count = Array.isArray(payload?.evaluated) ? payload.evaluated.length : Array.isArray(payload?.results) ? payload.results.length : null;
    return {
      title: base,
      detail: count !== null ? `完成 ${count} 个岗位` : undefined,
    };
  }
  if (toolName === "web_search" && input.query) {
    const count = Array.isArray(payload?.results) ? payload.results.length : null;
    return {
      title: `${base}：${short(input.query, 24)}`,
      detail: count !== null ? `${count} 条结果` : undefined,
    };
  }
  if (toolName === "fetch_page" && input.url) {
    return { title: `${base}：${short(input.url, 32)}` };
  }
  if (toolName === "tailor_resume") {
    const docId = payload?.doc_id ?? payload?.resume_id ?? payload?.record?.id;
    return {
      title: base,
      detail: docId ? `定制简历 #${docId}` : undefined,
    };
  }
  if (toolName === "draft_email") {
    return {
      title: base,
      detail: payload?.ready ? "草稿与附件就绪" : undefined,
    };
  }
  if (toolName === "undo" && (input.change_id || payload?.undone)) {
    return { title: `${base} #${payload?.undone ?? input.change_id}` };
  }
  return { title: base };
}

export interface AgentJobPanelItem {
  id: number;
  company: string;
  title: string;
  status?: string;
  score?: number;
  reason?: string;
}

export interface AgentEventPanelItem {
  id: number;
  title: string;
  kind?: string;
  at?: string;
  url?: string;
  done?: boolean;
  jobId?: number | null;
}

export interface AgentDocPanelItem {
  id: number;
  title: string;
  kind: string;
  jobId?: number | null;
}

export interface AgentMemoryPanelItem {
  id: number;
  title: string;
  kind?: string;
  confirmed?: boolean;
}

export interface AgentChangePanelItem {
  changeId: number;
  summary: string;
}

export interface AgentOutputPanelsModel {
  jobs: AgentJobPanelItem[];
  events: AgentEventPanelItem[];
  docs: AgentDocPanelItem[];
  pendingMemories: AgentMemoryPanelItem[];
  changes: AgentChangePanelItem[];
}

/** Extract interactive Hark-style mini-panels from completed tool executions. */
export function extractOutputPanels(executions: readonly ToolExecutionState[]): AgentOutputPanelsModel {
  const jobs = new Map<number, AgentJobPanelItem>();
  const events = new Map<number, AgentEventPanelItem>();
  const docs = new Map<number, AgentDocPanelItem>();
  const pendingMemories = new Map<number, AgentMemoryPanelItem>();
  const changes = new Map<number, AgentChangePanelItem>();

  for (const tool of executions) {
    if (tool.status !== "done" || tool.isError) continue;
    const payload = parseToolPayload(tool.result);
    if (!payload) continue;

    const changeId = typeof payload.change_id === "number" ? payload.change_id : null;
    const rec = record(payload.record);
    if (rec && typeof rec.id === "number") {
      if (rec.type === "job") {
        jobs.set(rec.id, {
          id: rec.id,
          company: String(rec.company || ""),
          title: String(rec.title || "未命名岗位"),
          status: typeof rec.status === "string" ? rec.status : undefined,
          score: typeof rec.score === "number" ? rec.score : undefined,
          reason: Array.isArray(rec.reasons) && rec.reasons[0] ? String(rec.reasons[0]) : undefined,
        });
      } else if (rec.type === "event") {
        events.set(rec.id, {
          id: rec.id,
          title: String(rec.title || "未命名事项"),
          kind: typeof rec.kind === "string" ? rec.kind : undefined,
          at: typeof rec.at === "string" ? rec.at : undefined,
          url: typeof rec.url === "string" ? rec.url : undefined,
          done: Boolean(rec.done),
          jobId: typeof rec.job_id === "number" ? rec.job_id : null,
        });
      } else if (rec.type === "doc") {
        docs.set(rec.id, {
          id: rec.id,
          title: String(rec.title || "未命名文档"),
          kind: String(rec.kind || "note"),
          jobId: typeof rec.job_id === "number" ? rec.job_id : null,
        });
      } else if (rec.type === "memory" && rec.confirmed === false) {
        pendingMemories.set(rec.id, {
          id: rec.id,
          title: String(rec.title || "未命名记忆"),
          kind: typeof rec.kind === "string" ? rec.kind : undefined,
          confirmed: false,
        });
      }
      if (changeId) {
        const label = String(rec.title || [rec.company, rec.title].filter(Boolean).join(" · ") || rec.name || `#${rec.id}`);
        changes.set(changeId, { changeId, summary: `${RECORD_TYPE_LABEL[String(rec.type)] ?? "记录"}「${short(label, 20)}」` });
      }
    }

    if (tool.toolName === "add_job") {
      const job = record(payload.job);
      if (job && typeof job.id === "number") {
        jobs.set(job.id, {
          id: job.id,
          company: String(job.company || ""),
          title: String(job.title || "未命名岗位"),
          status: typeof job.status === "string" ? job.status : "saved",
          score: typeof job.score === "number" ? job.score : undefined,
        });
      }
    }

    if (tool.toolName === "evaluate_jobs") {
      const items = Array.isArray(payload.results) ? payload.results : Array.isArray(payload.evaluated) ? payload.evaluated : [];
      for (const raw of items) {
        const item = record(raw);
        const id = Number(item?.job_id ?? item?.id);
        if (!Number.isInteger(id) || id <= 0) continue;
        jobs.set(id, {
          id,
          company: String(item?.company || ""),
          title: String(item?.title || item?.label || `岗位 #${id}`),
          status: typeof item?.status === "string" ? item.status : undefined,
          score: typeof item?.score === "number" ? item.score : undefined,
          reason: Array.isArray(item?.reasons) && item.reasons[0] ? String(item.reasons[0]) : undefined,
        });
      }
    }

    if (tool.toolName === "tailor_resume") {
      const id = Number(payload.doc_id ?? payload.resume_id);
      if (Number.isInteger(id) && id > 0) {
        docs.set(id, {
          id,
          title: String(payload.title || `定制简历 #${id}`),
          kind: "resume",
          jobId: typeof payload.job_id === "number" ? payload.job_id : null,
        });
      }
    }

    if (tool.toolName === "draft_email") {
      const id = Number(payload.doc_id ?? payload.id);
      if (Number.isInteger(id) && id > 0) {
        docs.set(id, {
          id,
          title: String(payload.subject || payload.title || `邮件草稿 #${id}`),
          kind: "email",
          jobId: typeof payload.job_id === "number" ? payload.job_id : null,
        });
      }
    }
  }

  return {
    jobs: [...jobs.values()],
    events: [...events.values()],
    docs: [...docs.values()],
    pendingMemories: [...pendingMemories.values()],
    changes: [...changes.values()],
  };
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
  const result = parseToolPayload(call.result);
  if (!result) return null;

  if (call.tool === "start_batch_job_evaluation" || call.tool === "resume_batch_job_evaluation") {
    const state = result.accepted ? "已进入后台队列" : safeClientErrorMessage(result.message, "未启动");
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
  const formatted = formatToolStep(call.tool, undefined, "done", result);
  return formatted.detail ? `${formatted.title}（${formatted.detail}）` : formatted.title;
}
