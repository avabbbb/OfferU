// =============================================
// HttpOfferUControl 测试：probe、两阶段导入、逐条确认、错误保留
// =============================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpOfferUControl, toIngestPayloadItem } from "./offeru-control-http.js";
import type { SyncJobCandidate } from "../framework/workflow.js";

function candidate(overrides: Partial<SyncJobCandidate> = {}): SyncJobCandidate {
  return {
    title: "前端工程师",
    company: "Example Co",
    description: "岗位职责：测试。",
    salary: "25-40K",
    salaryMin: 25000,
    salaryMax: 40000,
    sourceUrl: "https://www.zhipin.com/job_detail/1.html",
    hashKey: "offeru-boss-abc123",
    ...overrides,
  };
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("HttpOfferUControl", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("probe reports ok on healthy backend", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        status: "ok",
        service: "OfferU",
        runtime: "python",
        version: "0.4.0",
        build_mode: "local-development",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const control = new HttpOfferUControl("http://127.0.0.1:8765");
    const state = await control.probe();
    expect(state.ok).toBe(true);
    expect(state.backendUrl).toBe("http://127.0.0.1:8765");
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:8765/api/health");
  });

  it("normalizes a legacy local endpoint before making requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        status: "ok",
        service: "OfferU",
        runtime: "python",
        version: "0.4.0",
        build_mode: "local-development",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const control = new HttpOfferUControl("http://127.0.0.1:8080");
    const state = await control.probe();

    expect(state.ok).toBe(true);
    expect(state.backendUrl).toBe("http://127.0.0.1:8765");
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:8765/api/health");
  });

  it("rejects a wrong health identity instead of reporting a ready backend", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ status: "ok", service: "other-service", runtime: "python" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const control = new HttpOfferUControl("http://127.0.0.1:8765");

    const state = await control.probe();

    expect(state.ok).toBe(false);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "error" });
  });

  it("rejects a partial health payload without release identity", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ status: "ok", service: "OfferU", runtime: "python" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const state = await new HttpOfferUControl().probe();

    expect(state.ok).toBe(false);
  });

  it("probe reports failure when backend unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const control = new HttpOfferUControl("http://127.0.0.1:8765");
    const state = await control.probe();
    expect(state.ok).toBe(false);
    expect(state.error).toContain("fetch failed");
  });

  it("confirmJobImport posts the prepared plan and maps per-item outcomes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        created: 1,
        skipped: 1,
        batch_id: "offeru-ext-1",
        created_hash_keys: ["offeru-boss-abc123"],
        skipped_hash_keys: ["offeru-boss-def456"],
        accepted_hash_keys: ["offeru-boss-abc123", "offeru-boss-def456"],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const control = new HttpOfferUControl("http://127.0.0.1:8765");
    const plan = await control.prepareJobImport([candidate(), candidate({ hashKey: "offeru-boss-def456" })]);
    const result = await control.confirmJobImport(plan.planId);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8765/api/jobs/ingest");
    const body = JSON.parse(init.body as string);
    expect(body.batch_id).toMatch(/^offeru-ext-/);
    expect(body.source).toBe("offeru-extension");
    expect(body.jobs).toHaveLength(2);
    expect(body.jobs[0].hash_key).toBe("offeru-boss-abc123");
    expect(body.jobs[0].salary_min).toBe(25000);

    expect(result.createdCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(result.perItem[0].status).toBe("created");
    expect(result.perItem[1].status).toBe("skipped");
  });

  it("throws when backend gives no per-item confirmation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ created: 1, skipped: 0, accepted_hash_keys: [] })),
    );
    const control = new HttpOfferUControl("http://127.0.0.1:8765");
    const plan = await control.prepareJobImport([candidate()]);
    await expect(control.confirmJobImport(plan.planId)).rejects.toThrow("逐条同步确认");
  });

  it("throws on non-ok http status", async () => {
    const response = jsonResponse({ detail: "OFFERU_RELEASE_CANARY_SECRET_SHOULD_NOT_LEAK" }, false, 500);
    response.headers.set("X-OfferU-Error-Id", "err-123");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const control = new HttpOfferUControl("http://127.0.0.1:8765");
    const plan = await control.prepareJobImport([candidate()]);
    const error = await control.confirmJobImport(plan.planId).catch((value: unknown) => value as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("HTTP 500");
    expect(error.message).toContain("err-123");
    expect(error.message).not.toContain("OFFERU_RELEASE_CANARY_SECRET_SHOULD_NOT_LEAK");
  });

  it("returns empty result for unknown plan id", async () => {
    const control = new HttpOfferUControl("http://127.0.0.1:8765");
    const result = await control.confirmJobImport("import-unknown");
    expect(result.perItem).toEqual([]);
    expect(result.createdCount).toBe(0);
  });

  it("keeps the plan for retry after failure", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValueOnce(
        jsonResponse({ created: 1, skipped: 0, created_hash_keys: ["offeru-boss-abc123"], accepted_hash_keys: ["offeru-boss-abc123"] }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const control = new HttpOfferUControl("http://127.0.0.1:8765");
    const plan = await control.prepareJobImport([candidate()]);
    await expect(control.confirmJobImport(plan.planId)).rejects.toThrow("network down");
    const retry = await control.confirmJobImport(plan.planId);
    expect(retry.createdCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("toIngestPayloadItem", () => {
  it("maps sync candidate fields without losing salary data", () => {
    const item = toIngestPayloadItem(candidate());
    expect(item.salary_min).toBe(25000);
    expect(item.salary_max).toBe(40000);
    expect(item.salary_text).toBe("25-40K");
    expect(item.hash_key).toBe("offeru-boss-abc123");
    expect(item.url).toBe("https://www.zhipin.com/job_detail/1.html");
  });
});
