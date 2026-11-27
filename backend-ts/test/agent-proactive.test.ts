import { describe, expect, it } from "vitest";

import {
  AgentConversations,
  MemoryAgentRunStore,
  agentSystemPrompt,
  buildProactiveActions,
  jobIdFromConversationId,
  projectConversationId,
  saveRecord,
} from "@offeru/core";

import { createApp } from "../src/app";
import { SqliteCoreStore } from "../src/store";

const CTX = { actor: "你", now: "2026-11-27T09:00:00", today: "2026-11-27" };
const AGENT_CTX = { actor: "助手", now: "2026-11-27T09:00:00", today: "2026-11-27" };

describe("proactive action engine (Hark-style action buttons)", () => {
  it("guides onboarding on an empty store and surfaces 1-tap memory confirmation", async () => {
    const store = new SqliteCoreStore(":memory:");
    try {
      const empty = await buildProactiveActions(store, CTX);
      expect(empty.actions.map((item) => item.kind)).toEqual(["missing_profile"]);

      await saveRecord(store, { type: "profile", data: { name: "李凯风", school: "华南师范大学" } }, CTX);
      await saveRecord(store, { type: "memory", data: { kind: "project", title: "AgentOS 研发" } }, AGENT_CTX);
      await saveRecord(store, { type: "memory", data: { kind: "skill", title: "评测体系" } }, AGENT_CTX);

      const snapshot = await buildProactiveActions(store, CTX);
      expect(snapshot.counts.unconfirmed_memories).toBe(2);
      const confirm = snapshot.actions.find((item) => item.kind === "unconfirmed_memories");
      expect(confirm).toMatchObject({
        priority: "high",
        button_label: "全部确认",
        direct_action: "confirm_memories",
        record_ids: [2, 3],
      });
      expect(snapshot.actions.some((item) => item.kind === "missing_resume")).toBe(true);
    } finally {
      store.close();
    }
  });

  it("prioritizes urgent events, unevaluated jobs, top job tailoring, stale follow-up, and review", async () => {
    const store = new SqliteCoreStore(":memory:");
    try {
      await saveRecord(store, { type: "profile", data: { name: "李凯风" } }, CTX);
      await saveRecord(store, { type: "doc", data: { kind: "resume", title: "主简历", body: "# 李凯风" } }, CTX);
      const savedJob = await saveRecord(store, { type: "job", data: { company: "字节跳动", title: "AI 产品", status: "saved" } }, CTX);
      const scoredJob = await saveRecord(store, { type: "job", data: { company: "飞书", title: "Agent 产品", status: "saved", score: 88 } }, CTX);
      const interviewJob = await saveRecord(store, { type: "job", data: { company: "小红书", title: "AI 技术产品", status: "interview" } }, CTX);
      await saveRecord(store, { type: "event", data: { title: "飞书笔试", kind: "test", at: "2026-11-28T14:00", job_id: scoredJob.record.id } }, CTX);
      await saveRecord(store, { type: "event", data: { title: "旧待办", kind: "todo", at: "2026-11-25" } }, CTX);
      await saveRecord(store, { type: "event", data: { title: "小红书一面", kind: "interview", at: "2026-11-26T10:00", done: true, job_id: interviewJob.record.id } }, CTX);

      const snapshot = await buildProactiveActions(store, CTX);
      expect(snapshot.actions[0].kind).toBe("overdue_event");
      expect(snapshot.actions[0].priority).toBe("urgent");
      expect(snapshot.actions[1].kind).toBe("upcoming_interview");
      expect(snapshot.actions[1].job_id).toBe(scoredJob.record.id);
      expect(snapshot.actions.some((item) => item.kind === "unevaluated_jobs" && item.record_ids?.includes(savedJob.record.id))).toBe(true);
      expect(snapshot.actions.some((item) => item.kind === "tailor_top_job" && item.job_id === scoredJob.record.id)).toBe(true);
      expect(snapshot.actions.some((item) => item.kind === "interview_review" && item.job_id === interviewJob.record.id)).toBe(true);

      // Serves cleanly over HTTP /api/agent/proactive.
      const app = createApp({ store, runtime: "node", storage: "sqlite" });
      const res = await app.request("/api/agent/proactive");
      expect(res.status).toBe(200);
      const body = await res.json() as { actions: Array<{ kind: string }>; counts: { overdue_events: number } };
      expect(body.counts.overdue_events).toBe(1);
      expect(body.actions.length).toBeGreaterThanOrEqual(4);
    } finally {
      store.close();
    }
  });
});

describe("job project conversations (Hark-style Projects)", () => {
  it("encodes and preserves job_id across save, list, branch, and injects project context into system prompt", async () => {
    const store = new SqliteCoreStore(":memory:");
    const runStore = new MemoryAgentRunStore();
    const conversations = new AgentConversations(runStore);
    try {
      const job = await saveRecord(store, { type: "job", data: { company: "月之暗面", title: "AI 产品经理", status: "saved", score: 91, city: "北京" } }, CTX);
      await saveRecord(store, { type: "doc", data: { kind: "research", title: "Kimi 调研", body: "...", job_id: job.record.id } }, CTX);

      const convId = projectConversationId(job.record.id);
      expect(jobIdFromConversationId(convId)).toBe(job.record.id);
      expect(jobIdFromConversationId("conv_plain123456")).toBeNull();

      await conversations.append(convId, { role: "user", content: "帮我拆解这个岗位的 JD" });
      const listed = await conversations.list();
      expect(listed[0].job_id).toBe(job.record.id);

      const branched = await conversations.branch(convId, 1);
      expect(branched.job_id).toBe(job.record.id);
      expect(jobIdFromConversationId(branched.id)).toBe(job.record.id);

      const prompt = await agentSystemPrompt(store, AGENT_CTX, { activeJobId: job.record.id });
      expect(prompt).toContain("当前项目空间");
      expect(prompt).toContain("月之暗面");
      expect(prompt).toContain("Kimi 调研");
      expect(prompt).toContain("匹配分 91");
    } finally {
      store.close();
    }
  });
});
