// Job Evidence Ledger (packages/core/src/research/evidence-ledger.ts) on the desensitized
// DOGFOOD 2026-11-09 case: a re-tailor dropped two confirmed points and wrote the evaluator's own
// composite score as the user's achievement.

import { afterEach, describe, expect, it } from "vitest";

import { buildJobEvidenceLedger, saveRecord, validateTailoredResume } from "@offeru/core";

import { SqliteCoreStore } from "../src/store";
import { at, BEFORE, seedDogfood1109 } from "./helpers/dogfood";

let stores: SqliteCoreStore[] = [];
afterEach(() => {
  for (const store of stores) store.close();
  stores = [];
});

describe("job evidence ledger", () => {
  it("maps requirements to evidence, gaps to questions, and resume claims to confirmed memories", async () => {
    const store = new SqliteCoreStore(":memory:");
    stores.push(store);
    const ids = await seedDogfood1109(store);
    const ledger = await buildJobEvidenceLedger(store, ids.jobId);
    expect(ledger).toMatchObject({
      jobId: ids.jobId,
      evaluationStale: false,
      requirements: [
        { requirementId: "r1", text: "跨部门协作", sourceType: "evaluation", sourceUrl: "https://talent.example.com/26", evidenceIds: [ids.leadId] },
        { requirementId: "r2", text: "英语流利", evidenceIds: [], gap: "无" },
      ],
      resumeClaims: [
        { claim: "项目牵头协作：牵头 3 个部门协作，按期上线", evidenceIds: [ids.leadId], confirmed: true },
        { claim: "企业家讲座：组织 2 场企业家讲座，覆盖 300 人", evidenceIds: [ids.talkId], confirmed: true },
      ],
    });
    expect(ledger?.pendingQuestions.join("\n")).toContain("英语流利");
  });

  it("flags the 11-09 re-tailor: dropped confirmed point, self-score as achievement, unsourced new number", async () => {
    const store = new SqliteCoreStore(":memory:");
    stores.push(store);
    const ids = await seedDogfood1109(store);
    const ledger = (await buildJobEvidenceLedger(store, ids.jobId))!;
    const after = [
      "# 林同学",
      "## 项目经历",
      "### 校园活动 | 负责人 | 2025",
      "- 项目牵头协作：牵头 3 个部门协作，按期上线",
      "- 综合分从 5.8 提升到 6.4",
      "- 带动社群活跃度提升 45%",
    ].join("\n");
    const issues = await validateTailoredResume({ ledger, job: (await store.get("job", ids.jobId))!, before: BEFORE, after, memories: await store.all("memory") });
    expect(issues.map((issue) => issue.code).sort()).toEqual(["confirmed_dropped", "self_score_as_achievement", "unconfirmed_claim"]);
    expect(issues.find((issue) => issue.code === "confirmed_dropped")).toMatchObject({ memoryId: ids.talkId });
    expect(issues.find((issue) => issue.code === "unconfirmed_claim")?.line).toBe("带动社群活跃度提升 45%");

    // the untouched resume is clean
    expect(await validateTailoredResume({ ledger, job: (await store.get("job", ids.jobId))!, before: BEFORE, after: BEFORE, memories: await store.all("memory") })).toEqual([]);
  });

  it("notices a JD edited after the evaluation (from the change log; nothing new stored)", async () => {
    const store = new SqliteCoreStore(":memory:");
    stores.push(store);
    const ids = await seedDogfood1109(store);
    await saveRecord(store, { type: "job", id: ids.jobId, data: { jd: "要求跨部门协作；英语流利；会 SQL。" } }, at("10"));
    const ledger = (await buildJobEvidenceLedger(store, ids.jobId))!;
    expect(ledger.evaluationStale).toBe(true);
    expect(ledger.pendingQuestions[0]).toMatch(/重新 evaluate_jobs/);
    const issues = await validateTailoredResume({ ledger, job: (await store.get("job", ids.jobId))!, before: BEFORE, after: BEFORE, memories: await store.all("memory") });
    expect(issues).toMatchObject([{ code: "jd_changed" }]);
  });
});
