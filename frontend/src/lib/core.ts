"use client";

// 工作台和 Agent 调的是同一套工具（backend/app/core/tools.py）：POST /api/tools/{name}。
import useSWR, { mutate as globalMutate } from "swr";

import { request } from "@/lib/api";
import { resolveApiBase } from "@/lib/apiBase";

export type JobStatus = "saved" | "applied" | "test" | "interview" | "offer" | "rejected" | "closed";
export type EventKind = "todo" | "deadline" | "test" | "interview";

export const JOB_STATUS: Record<JobStatus, string> = {
  saved: "想投", applied: "已投递", test: "笔试 / 测评", interview: "面试中", offer: "offer", rejected: "未通过", closed: "不投了",
};
export const EVENT_KIND: Record<EventKind, string> = { todo: "待办", deadline: "截止", test: "笔试 / 测评", interview: "面试" };

type Base = { id: number; type: string; job_id: number | null; created_at: string; updated_at: string; label?: string };
export type Job = Base & { company?: string; title?: string; status: JobStatus; url?: string; city?: string; jd?: string; notes?: string; applied_at?: string };
export type Event = Base & { title: string; kind?: EventKind; at?: string; done?: boolean; notes?: string; job_label?: string };
export type MemoryKind = "experience" | "project" | "education" | "skill" | "award" | "preference" | "note";
export const MEMORY_KIND: Record<MemoryKind, string> = {
  education: "教育", experience: "实习 / 工作", project: "项目", award: "奖项", skill: "技能", preference: "偏好", note: "其他",
};
export type Profile = Partial<Record<"name" | "school" | "major" | "degree" | "grad_year" | "phone" | "email" | "city" | "target" | "about" | "photo", string>> & { id?: number };
export type Memory = Base & { kind: MemoryKind; title?: string; body?: string; start?: string; end?: string };
export type Doc = Base & { kind: string; title?: string; body?: string; resume?: unknown; template?: string; style?: import("@/lib/resumeStyle").StyleInput };
export type Change = { id: number; at: string; actor: string; summary: string; undone_at: string | null };
export type Overview = {
  today: string;
  stage: string;
  next_step: { title: string; why: string; link: string };
  todos: Record<"overdue" | "today" | "week" | "later" | "undated", Event[]>;
  jobs: Record<JobStatus, number>;
  recent_changes: Change[];
};

export function tool<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  return request<T>(`/api/tools/${name}`, { method: "POST", body: JSON.stringify(args) });
}

export function useTool<T>(name: string, args: Record<string, unknown> = {}, refreshInterval = 0) {
  return useSWR<T>(["tool", name, JSON.stringify(args)], () => tool<T>(name, args), { refreshInterval });
}

/** 写完以后所有用到工具的地方一起刷新（Agent 的改动也靠轮询出现）。 */
export async function write<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
  const result = await tool<T>(name, args);
  await globalMutate((key) => Array.isArray(key) && key[0] === "tool");
  return result;
}

export function when(at?: string): string {
  if (!at) return "";
  const [day, time] = at.split("T");
  const [, m, d] = day.split("-");
  return `${Number(m)}月${Number(d)}日${time ? ` ${time.slice(0, 5)}` : ""}`;
}

export const apiUrl = (path: string) => `${resolveApiBase()}${path}`;

export async function upload(file: File): Promise<{ name: string; original: string }> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(apiUrl("/api/files"), { method: "POST", body: form });
  if (!res.ok) throw new Error("上传失败");
  return res.json();
}
