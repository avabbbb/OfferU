import { describe, expect, it } from "vitest";

import type { Job } from "@/lib/core";
import {
  type Condition, activeCounts, applyView, defaultState, defaultView, groupJobs, loadViews, PRIMARY, saveViews, sortJobs, STORAGE_KEY,
} from "@/lib/jobView";

const job = (id: number, over: Partial<Job> = {}): Job => ({
  id, type: "job", job_id: null, created_at: "2026-11-0" + id + "T10:00:00", updated_at: "", status: "saved", ...over,
});

const JOBS: Job[] = [
  job(1, { company: "字节跳动", city: "北京", status: "applied", tags: ["大厂", "AI"], score: 80, applied_at: "2026-11-03" }),
  job(2, { company: "腾讯", city: "深圳", status: "interview", tags: ["大厂"], score: 90 }),
  job(3, { company: "小公司", city: "北京", status: "saved" }),
  job(4, { company: "外企", city: "上海", status: "closed", tags: ["外企"], score: 60, posting: { hire_type: "实习" } }),
];
const ids = (list: Job[]) => list.map((j) => j.id);
const run = (conditions: Condition[], mode: "and" | "or" = "and", search = "") =>
  ids(applyView(JOBS, { filter: { mode, conditions }, sort: [] }, search));

describe("筛选", () => {
  const beijing: Condition = { field: "city", op: "is", value: ["北京"] };
  const bigTech: Condition = { field: "tags", op: "contains", value: ["大厂"] };
  it("所有 / 任一", () => {
    expect(run([beijing, bigTech])).toEqual([1]);
    expect(run([beijing, bigTech], "or")).toEqual([1, 2, 3]);
  });
  it("各类型运算符", () => {
    expect(run([{ field: "status", op: "isNot", value: ["closed"] }])).toEqual([1, 2, 3]);
    expect(run([{ field: "status", op: "is", value: ["applied", "interview"] }])).toEqual([1, 2]);
    expect(run([{ field: "tags", op: "empty", value: [] }])).toEqual([3]);
    expect(run([{ field: "tags", op: "notContains", value: ["大厂"] }])).toEqual([3, 4]);
    expect(run([{ field: "score", op: "notEmpty", value: [] }])).toEqual([1, 2, 4]);
    expect(run([{ field: "score", op: "gt", value: ["70"] }])).toEqual([1, 2]);
    expect(run([{ field: "company", op: "contains", value: ["字节"] }])).toEqual([1]);
    expect(run([{ field: "created_at", op: "gt", value: ["2026-11-02"] }])).toEqual([3, 4]);
    expect(run([{ field: "applied_at", op: "is", value: ["2026-11-03"] }])).toEqual([1]);
    expect(run([{ field: "hire_type", op: "is", value: ["实习"] }])).toEqual([4]);
  });
  it("没填值的条件不生效", () => {
    expect(run([{ field: "city", op: "is", value: [] }, { field: "score", op: "gt", value: [" "] }])).toEqual([1, 2, 3, 4]);
  });
  it("搜索不分大小写，查标签和城市", () => {
    expect(run([], "and", "ai")).toEqual([1]);
    expect(run([], "and", " 上海 ")).toEqual([4]);
    expect(run([beijing], "and", "小")).toEqual([3]);
  });
});

describe("排序", () => {
  it("空值不论升降都在最后", () => {
    expect(ids(sortJobs(JOBS, [{ field: "score", desc: true }]))).toEqual([2, 1, 4, 3]);
    expect(ids(sortJobs(JOBS, [{ field: "score", desc: false }]))).toEqual([4, 1, 2, 3]);
  });
  it("状态按流程顺序，多级排序", () => {
    expect(ids(sortJobs(JOBS, [{ field: "status", desc: false }]))).toEqual([3, 1, 2, 4]);
    const more = [...JOBS, job(5, { status: "applied", score: 95 })];
    expect(ids(sortJobs(more, [{ field: "status", desc: false }, { field: "score", desc: true }]))).toEqual([3, 5, 1, 2, 4]);
  });
  it("不改原数组", () => {
    sortJobs(JOBS, [{ field: "score", desc: true }]);
    expect(ids(JOBS)).toEqual([1, 2, 3, 4]);
  });
});

describe("分组", () => {
  it("按状态：流程顺序，组名用中文", () => {
    const groups = groupJobs(JOBS, ["status"]);
    expect(groups.map((g) => [g.label, ids(g.jobs)])).toEqual([["想投", [3]], ["已投递", [1]], ["面试中", [2]], ["不投了", [4]]]);
  });
  it("按标签：一个岗位进它的每个标签组，空值组最后", () => {
    const groups = groupJobs(JOBS, ["tags"]);
    const byLabel = Object.fromEntries(groups.map((g) => [g.label, ids(g.jobs)]));
    expect(byLabel).toEqual({ 大厂: [1, 2], AI: [1], 外企: [4], "（空）": [3] });
    expect(groups.at(-1)!.value).toBeNull();
  });
  it("两层分组，key 唯一", () => {
    const groups = groupJobs(JOBS, ["city", "status"]);
    const beijing = groups.find((g) => g.value === "北京")!;
    expect(beijing.children.map((g) => [g.label, ids(g.jobs)])).toEqual([["想投", [3]], ["已投递", [1]]]);
    const keys = groups.flatMap((g) => [g.key, ...g.children.map((c) => c.key)]);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("视图配置存取", () => {
  const memory = () => {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  };
  it("存了能原样读回", () => {
    const store = memory();
    const state = defaultState();
    state.active = "gantt";
    state.views.table = { ...defaultView("table"), group: ["status"], widths: { company: 240 }, rowHeight: "medium",
      filter: { mode: "or", conditions: [{ field: "tags", op: "contains", value: ["大厂"] }] } };
    saveViews(state, store);
    expect(loadViews(store)).toEqual(state);
  });
  it("坏数据退回默认", () => {
    const store = memory();
    store.setItem(STORAGE_KEY, "{not json");
    expect(loadViews(store)).toEqual(defaultState());
    expect(loadViews(undefined)).toEqual(defaultState());
  });
  it("逐项校验：未知字段丢掉、分组最多两层、主字段第一且不能隐藏、列宽夹在范围内", () => {
    const store = memory();
    store.setItem(STORAGE_KEY, JSON.stringify({ active: "nope", views: { table: {
      group: ["status", "city", "tags"], hidden: ["company", "bogus", "score"], order: ["score", "bogus", "company"],
      widths: { company: 9999, title: 10, bogus: 100 }, sort: [{ field: "score", desc: true }, { field: "score" }, { field: "x" }],
      filter: { mode: "xor", conditions: [{ field: "status", op: "gt", value: ["1"] }, { field: "city", op: "is", value: ["北京", 3] }] },
    } } }));
    const { active, views } = loadViews(store);
    const t = views.table;
    expect(active).toBe("table");
    expect(t.group).toEqual(["status", "city"]);
    expect(t.hidden).toEqual(["score"]);
    expect(t.order[0]).toBe(PRIMARY);
    expect(t.order.slice(0, 2)).toEqual(["company", "score"]);
    expect(new Set(t.order).size).toBe(t.order.length);
    expect(t.order).toHaveLength(9);
    expect(t.widths).toEqual({ company: 600, title: 60 });
    expect(t.sort).toEqual([{ field: "score", desc: true }]);
    expect(t.filter).toEqual({ mode: "and", conditions: [{ field: "city", op: "is", value: ["北京"] }] });
    expect(views.board).toEqual(defaultView("board"));
  });
  it("工具栏计数只算生效的条件", () => {
    const v = { ...defaultView("table"), group: ["status" as const],
      filter: { mode: "and" as const, conditions: [{ field: "city" as const, op: "is" as const, value: [] }, { field: "tags" as const, op: "empty" as const, value: [] }] } };
    expect(activeCounts(v)).toEqual({ filter: 1, group: 1, sort: 1, hidden: 1 });
  });
});

import { tagPatch } from "./jobView";

describe("tagPatch", () => {
  it("删掉的自动标签进 tags_muted，手动加回的拿出来", () => {
    const j = { ...job(1), tags: ["a", "b", "c"], auto_tags: ["a", "b"], tags_muted: ["c", "z"] };
    expect(tagPatch(j, ["b", "c"])).toEqual({ tags: ["b", "c"], auto_tags: ["b"], tags_muted: ["z", "a"] });
    expect(tagPatch(j, [])).toEqual({ tags: null, auto_tags: null, tags_muted: ["c", "z", "a", "b"] });
  });
});
