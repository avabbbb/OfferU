import type { DocKind, EventKind, JobStatus, MemoryKind, PlainRecord, RecordType, StoredRecord } from "./types";

export const JOB_STATUS: Record<JobStatus, string> = {
  saved: "想投",
  applied: "已投递",
  test: "笔试 / 测评",
  interview: "面试中",
  offer: "offer",
  rejected: "未通过",
  closed: "不投了",
};

export const EVENT_KIND: Record<EventKind, string> = {
  todo: "待办",
  deadline: "截止",
  test: "笔试 / 测评",
  interview: "面试",
};

export const DOC_KIND: Record<DocKind, string> = {
  resume: "简历",
  apply_chat: "官网投递对话",
  email: "投递邮件",
  review: "面试复盘",
  research: "调研",
  evaluation: "岗位评估",
  note: "笔记",
};

export const MEMORY_KIND: Record<MemoryKind, string> = {
  experience: "实习 / 工作",
  project: "项目",
  education: "教育",
  skill: "技能",
  award: "奖项 / 证书",
  preference: "偏好",
  note: "其他",
};

export const TYPE_LABEL: Record<RecordType, string> = {
  profile: "档案",
  memory: "记忆",
  job: "岗位",
  event: "事项",
  doc: "文档",
};

export const JOB_ORDER: JobStatus[] = ["saved", "applied", "test", "interview", "offer"];
export const JOB_FROZEN: JobStatus[] = ["offer", "rejected", "closed"];

export function isRecordType(value: unknown): value is RecordType {
  return value === "profile" || value === "memory" || value === "job" || value === "event" || value === "doc";
}

export function label(record: Pick<StoredRecord, "id" | "type"> & Record<string, unknown>): string {
  const kind = record.type;
  if (kind === "job") {
    const name = [record.company, record.title].filter((value) => typeof value === "string" && value.trim()).join(" · ");
    return name || `岗位 #${record.id}`;
  }
  if (kind === "profile") return typeof record.name === "string" && record.name ? record.name : "我的档案";
  if (kind === "doc") {
    return typeof record.title === "string" && record.title
      ? record.title
      : DOC_KIND[record.kind as DocKind] ?? "文档";
  }
  const title = typeof record.title === "string" ? record.title : "";
  const body = typeof record.body === "string" ? record.body : "";
  return title || body.slice(0, 30) || `${TYPE_LABEL[kind]} #${record.id}`;
}

export function plain(record: StoredRecord | null): PlainRecord | null {
  if (!record) return null;
  const { id: _id, type: _type, created_at: _created, updated_at: _updated, ...rest } = record;
  return rest;
}

export function withoutMeta(record: StoredRecord | null): PlainRecord | null {
  if (!record) return null;
  const { id: _id, type: _type, job_id: _job, created_at: _created, updated_at: _updated, ...data } = record;
  return data;
}

export function brief(record: StoredRecord): StoredRecord & { label: string } {
  // Python _brief: resume and messages never go into list/brief views; jd/body are cut to 160.
  const { resume: _resume, messages: _messages, ...rest } = record;
  const out = { ...rest, label: label(record) } as StoredRecord & { label: string };
  for (const key of ["jd", "body"] as const) {
    const value = record[key];
    if (typeof value === "string" && value) {
      out[key] = value.slice(0, 160) + (value.length > 160 ? "…" : "");
    }
  }
  return out;
}

export function todayIso(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function dayOf(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  return value.slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T12:00:00`);
  date.setDate(date.getDate() + days);
  return todayIso(date);
}

export function nowIso(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`;
}
