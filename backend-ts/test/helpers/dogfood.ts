// Desensitized DOGFOOD records shared by the evidence-ledger tests and the regression bench.

import { saveRecord } from "@offeru/core";

import type { SqliteCoreStore } from "../../src/store";

export const at = (day: string) => ({ actor: "你", now: `2026-11-${day}T08:00:00+00:00`, today: `2026-11-${day}` });

export const BEFORE = [
  "# 林同学",
  "## 项目经历",
  "### 校园活动 | 负责人 | 2025",
  "- 项目牵头协作：牵头 3 个部门协作，按期上线",
  "- 企业家讲座：组织 2 场企业家讲座，覆盖 300 人",
].join("\n");

export async function seedDogfood1109(store: SqliteCoreStore) {
  const lead = await saveRecord(store, { type: "memory", data: { kind: "project", title: "项目牵头协作", body: "牵头 3 个部门协作，按期上线" } }, at("08"));
  const talk = await saveRecord(store, { type: "memory", data: { kind: "project", title: "企业家讲座", body: "组织 2 场企业家讲座，覆盖 300 人" } }, at("08"));
  const score = await saveRecord(store, { type: "memory", data: { kind: "note", title: "评估综合分", body: "综合分 5.8→6.4" } }, { ...at("08"), actor: "助手" });
  const job = await saveRecord(store, { type: "job", data: { company: "某电商", title: "运营管培生", url: "https://talent.example.com/26", jd: "要求跨部门协作；英语流利。" } }, at("08"));
  const jobId = job.record.id;
  await saveRecord(store, { type: "doc", data: { kind: "evaluation", job_id: jobId, title: "评估", body: "# 结论\n可以投 [inference]\n## 逐条匹配\n摘要 [inference]\n- 跨部门协作 → 强：项目牵头协作 [inference S2]\n- 英语流利 → 无：档案里没有 [gap]\n## 岗位摘要\n- x" } }, at("08"));
  await saveRecord(store, { type: "doc", data: { kind: "resume", job_id: jobId, title: "定制简历", body: BEFORE } }, at("08"));
  return { jobId, leadId: lead.record.id, talkId: talk.record.id, scoreId: score.record.id };
}

