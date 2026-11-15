// The 求职 journey trace on the TS Agent runtime, in mock mode (scripted model,
// no key, no network): seed → turns over the real /api/agent routes → code
// checks C1–C15. Covers the full journey and the s6 abort + retry. The model's
// judgment is not under test here (mode "real" in scripts/journey/run.ts is).

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { saveRecord } from "@offeru/core";

import { openStore } from "../src/store";
import { gradeRun, type Grade } from "../scripts/journey/grade";
import { runJourney } from "../scripts/journey/harness";

const out = mkdtempSync(join(tmpdir(), "offeru-journey-test-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

const quiet = () => undefined;
const results = (grade: Grade) => Object.fromEntries(grade.checks.map((check) => [check.id, check.result]));

describe("journey trace on the TS Agent runtime (mock model)", () => {
  it("full: 补经历 → 比较 → 投递包 → 拒绝编造 → 模拟面试 → 复盘 → 新会话用新证据 → 撤销, all code checks pass", async () => {
    const { root, meta, transcript } = await runJourney({ scenario: "full", mode: "mock", out, log: quiet });
    expect(meta.mock_problems).toEqual([]);
    expect(transcript).toHaveLength(12);
    const grade = await gradeRun(root, { print: quiet });
    expect(grade.summary.fail, JSON.stringify(grade.checks.filter((check) => check.result === "fail"), null, 1)).toBe(0);
    expect(results(grade)).toMatchObject({
      C1: "pass", C2: "pass", C3: "pass", C4: "pass", C5: "pass", C6: "pass", C7: "pass", C8: "pass", C8b: "pass",
      C9: "pass", C10: "pass", C11: "pass", C11b: "pass", C11c: "pass", C11d: "pass", C12: "pass", C13: "pass", C14: "pass", C15: "pass",
    });

    // The trace of the pack turn: versions, model, every tool with args / result / latency / change ids, sub-model calls, stop reason.
    const pack = transcript.find((entry) => entry.label === "投递包")!;
    const trace = JSON.parse(readFileSync(pack.trace, "utf8"));
    expect(trace).toMatchObject({ schema: "offeru.trace.v1", run_id: pack.run_id, journey_id: meta.journey_id, model: "journey-script", provider: "mock", terminal_state: "completed", stop_reason: "stop", step_budget: 14 });
    expect(trace.prompt_version).toMatch(/^[0-9a-f]{12}$/);
    expect(typeof trace.code_version).toBe("string");
    expect(trace.tool_calls.map((call: { tool: string }) => call.tool)).toEqual(["list", "tailor_resume", "save", "save", "draft_email"]);
    for (const call of trace.tool_calls) expect(call).toMatchObject({ ok: true, seconds: expect.any(Number) });
    expect(trace.tool_calls[1].args).toEqual({ id: meta.seed_ids.main_resume, job_id: meta.seed_ids.jobs.j1.id });
    expect(trace.tool_calls[1].change_ids).toHaveLength(1);
    expect(trace.llm_calls.map((call: { purpose: string }) => call.purpose)).toEqual(["chat", "chat_json"]); // tailor draft + review
    expect(trace.artifacts.map((item: { kind: string }) => item.kind)).toEqual(["resume", "apply_chat", "apply_chat", "email"]);
    expect(trace.job_ids).toContain(meta.seed_ids.jobs.j1.id);
  });

  it("s6: aborting mid-pack ends cancelled with a trace; the retry finishes the pack without duplicate writes", async () => {
    const { root, transcript } = await runJourney({ scenario: "s6_interrupt", mode: "mock", out, log: quiet });
    const [aborted, retry] = transcript;
    expect(aborted).toMatchObject({ aborted_by_harness: true, http_status: 200, terminal_state: "cancelled", stop_reason: "aborted" });
    expect(JSON.parse(readFileSync(aborted.trace, "utf8"))).toMatchObject({ terminal_state: "cancelled", stop_reason: "aborted" });
    expect(retry).toMatchObject({ terminal_state: "completed", stop_reason: "stop" });
    // The retry read what the aborted run had saved (the tailored resume) and did not tailor again.
    const retryTools = JSON.parse(readFileSync(retry.trace, "utf8")).tool_calls.map((call: { tool: string }) => call.tool);
    expect(retryTools).toEqual(["list", "save", "save", "draft_email"]);

    const grade = await gradeRun(root, { print: quiet });
    expect(grade.summary.fail, JSON.stringify(grade.checks.filter((check) => check.result === "fail"), null, 1)).toBe(0);
    expect(results(grade)).toMatchObject({ C1: "pass", C6: "pass", C7: "pass", C8: "pass", C10: "pass", C13: "pass", C15: "pass" });

    // The grader really catches a duplicate: add a second BOSS greeting and re-grade.
    const store = openStore(join(root, "data", "offeru.db"));
    const meta = JSON.parse(readFileSync(join(root, "meta.json"), "utf8"));
    await saveRecord(store, { type: "doc", data: { kind: "apply_chat", job_id: meta.seed_ids.jobs.j1.id, title: "BOSS 直聘打招呼语（重复）", body: "重复" } }, { actor: "助手", now: new Date().toISOString(), today: "2026-11-15" });
    store.close();
    const regraded = await gradeRun(root, { print: quiet, write: false });
    expect(results(regraded).C10).toBe("fail");
  });
});
