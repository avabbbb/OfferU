import { describe, expect, it } from "vitest";

import type { Job } from "@/lib/core";
import {
  boardColumns, boardGroupField, canWriteGroup, cardFields, formatDay, groupPatch, groupTone, hiddenCardFields, moveField, toggleCardField, toggleCollapsed,
} from "@/lib/jobBoard";
import { defaultView, loadViews, sanitizeView } from "@/lib/jobView";

const job = (id: number, over: Partial<Job> = {}): Job => ({
  id, type: "job", job_id: null, created_at: "2026-11-0" + id + "T10:00:00", updated_at: "", status: "saved", ...over,
});

const JOBS: Job[] = [
  job(1, { city: "北京", status: "applied", posting: { hire_type: "实习" } }),
  job(2, { city: "深圳", status: "interview" }),
  job(3, { city: "北京", status: "applied" }),
  job(4, { status: "closed" }),
];

describe("分组依据", () => {
  it("默认按状态；只接受单值字段", () => {
    expect(boardGroupField(defaultView("board"))).toBe("status");
    expect(boardGroupField({ group: ["city"] })).toBe("city");
    expect(boardGroupField({ group: ["tags"] })).toBe("status");
  });

  it("按状态：七列都在（空列也在），列内保持传入顺序，颜色和表格一致", () => {
    const cols = boardColumns(JOBS, "status");
    expect(cols.map((c) => c.value)).toEqual(["saved", "applied", "test", "interview", "offer", "rejected", "closed"]);
    expect(cols[1].jobs.map((j) => j.id)).toEqual([1, 3]);
    expect(cols[1]).toMatchObject({ key: "status=applied", label: "已投递", tone: "blue" });
    expect(cols.some((c) => c.value === null)).toBe(false);
  });

  it("按其他字段：出现过的值 + 最后一列「未分组」", () => {
    const cols = boardColumns(JOBS, "city");
    expect(cols.map((c) => c.label)).toEqual(["北京", "深圳", "未分组"]);
    expect(cols[2]).toMatchObject({ key: "city=", value: null, tone: "gray" });
    expect(cols[2].jobs.map((j) => j.id)).toEqual([4]);
    expect(boardColumns(JOBS, "hire_type").map((c) => [c.label, c.jobs.length])).toEqual([["实习", 1], ["未分组", 3]]);
  });

  it("同一个值永远同一个颜色", () => {
    expect(groupTone("city", "北京")).toBe(groupTone("city", "北京"));
    expect(groupTone("status", "offer")).toBe("green");
  });

  it("拖到某列 / 在某列新建要写的字段", () => {
    expect(groupPatch("status", "test")).toEqual({ status: "test" });
    expect(groupPatch("city", "上海")).toEqual({ city: "上海" });
    expect(groupPatch("city", null)).toEqual({ city: null });
    expect(groupPatch("hire_type", "实习")).toBeNull();
    expect(canWriteGroup("status")).toBe(true);
    expect(canWriteGroup("hire_type")).toBe(false);
  });
});

describe("卡片管理", () => {
  const view = defaultView("board");
  it("默认显示状态、标签、评分、投递日；公司和岗位在标题里，不算卡片字段", () => {
    expect(cardFields(view)).toEqual(["status", "tags", "score", "applied_at"]);
    expect(hiddenCardFields(view)).toEqual(["city", "hire_type", "created_at"]);
  });

  it("切换显示、拖动排序", () => {
    const shown = { ...view, ...toggleCardField(view, "city") };
    expect(cardFields(shown)).toContain("city");
    expect(cardFields({ ...shown, ...toggleCardField(shown, "city") })).not.toContain("city");
    const moved = { ...view, ...moveField(view, "applied_at", "status") };
    expect(cardFields(moved)).toEqual(["applied_at", "status", "tags", "score"]);
    const down = { ...view, ...moveField(view, "status", "score") };
    expect(cardFields(down)).toEqual(["tags", "score", "status", "applied_at"]);
  });

  it("折叠列可切换；默认折叠两个已结束的状态", () => {
    expect(view.collapsed).toEqual(["status=rejected", "status=closed"]);
    expect(toggleCollapsed(view, "status=closed").collapsed).toEqual(["status=rejected"]);
    expect(toggleCollapsed({ collapsed: [] }, "city=").collapsed).toEqual(["city="]);
  });

  it("配置存取：坏值退回默认，showNames / collapsed 原样读回", () => {
    expect(sanitizeView({ collapsed: "x", showNames: 1 }, "board")).toMatchObject({ collapsed: view.collapsed, showNames: true });
    expect(sanitizeView({ collapsed: ["city=北京", 3, "city=北京"], showNames: false }, "board")).toMatchObject({ collapsed: ["city=北京"], showNames: false });
    const store = { getItem: () => JSON.stringify({ active: "board", views: { board: { group: ["city"], showNames: false } } }), setItem: () => {} };
    expect(loadViews(store).views.board).toMatchObject({ group: ["city"], showNames: false });
  });
});

describe("日期", () => {
  it("2026/11/17 星期二", () => {
    expect(formatDay("2026-11-17")).toBe("2026/11/17 星期二");
    expect(formatDay("2026-11-15T09:00:00")).toBe("2026/11/15 星期日");
    expect(formatDay("坏")).toBe("坏");
  });
});
