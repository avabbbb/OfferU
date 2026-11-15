import { describe, expect, it } from "vitest";

import type { Event, Job } from "@/lib/core";
import { clampIndex, framePose, galleryWheelDelta, galleryGroups, galleryJobs, nextDeadline, topMatch } from "@/lib/jobGallery";
import { VIEW_KINDS, VIEW_NAME, defaultState, loadViews } from "@/lib/jobView";

const job = (id: number, over: Partial<Job> = {}): Job => ({ id, type: "job", job_id: null, created_at: "", updated_at: "", status: "saved", ...over });
const JOBS = [job(1, { status: "interview", score: 70 }), job(2, { status: "applied", score: 88 }), job(3, { status: "interview" })];

describe("画廊视图", () => {
  it("登记成第五个视图，旧存档也能读出它的配置", () => {
    expect(VIEW_KINDS).toContain("gallery");
    expect(VIEW_NAME.gallery).toBe("画廊");
    expect(defaultState().views.gallery.sort).toEqual([{ field: "score", desc: true }]);
    const old = { getItem: () => JSON.stringify({ active: "gallery", views: {} }), setItem: () => {} };
    expect(loadViews(old).active).toBe("gallery");
    expect(loadViews(old).views.gallery.filter.conditions).toEqual([]);
  });

  it("底部分组：全部 + 有岗位的状态，按流程顺序", () => {
    expect(galleryGroups(JOBS).map((g) => [g.label, g.count])).toEqual([["全部", 3], ["已投递", 1], ["面试中", 2]]);
    expect(galleryGroups([])).toEqual([{ key: "all", label: "全部", count: 0 }]);
    expect(galleryJobs(JOBS, "interview").map((j) => j.id)).toEqual([1, 3]);
    expect(galleryJobs(JOBS, "all")).toBe(JOBS);
  });

  it("最匹配、最近截止、下标收拢", () => {
    expect(topMatch(JOBS)).toBe(2);
    expect(topMatch([job(9)])).toBeNull();
    const ev = (id: number, at: string, over: Partial<Event> = {}): Event =>
      ({ id, type: "event", job_id: 1, created_at: "", updated_at: "", title: "网申截止", kind: "deadline", at, ...over });
    const events = [ev(1, "2026-12-01"), ev(2, "2026-11-20"), ev(3, "2026-11-18", { done: true }), ev(4, "2026-11-10", { job_id: 2 })];
    expect(nextDeadline(JOBS[0], events)?.id).toBe(2);
    expect(clampIndex(7, 3)).toBe(2);
    expect(clampIndex(-1, 3)).toBe(0);
    expect(clampIndex(4, 0)).toBe(0);
  });

  it("普通滚轮放给页面，Shift+滚轮和横向轻扫才切帧", () => {
    expect(galleryWheelDelta({ deltaX: 0, deltaY: 100, shiftKey: false })).toBe(0);
    expect(galleryWheelDelta({ deltaX: 0, deltaY: -100, shiftKey: true })).toBe(-100);
    expect(galleryWheelDelta({ deltaX: 100, deltaY: 0, shiftKey: true })).toBe(100);
    expect(galleryWheelDelta({ deltaX: -30, deltaY: 5, shiftKey: false })).toBe(-30);
  });

  it("焦点正对、两侧朝里转；减少动态时不转不糊", () => {
    expect(framePose(0, false, false)).toMatchObject({ x: 0, rotate: 0, opacity: 1 });
    const right = framePose(2, false, false);
    expect(right.x).toBeGreaterThan(0);
    expect(right.rotate).toBeLessThan(0);
    expect(framePose(-2, false, false).rotate).toBe(-right.rotate);
    expect(right.blur).toBeGreaterThan(0);
    expect(framePose(3, false, true)).toMatchObject({ rotate: 0, z: 0, blur: 0 });
    expect(framePose(3, true, false).opacity).toBe(0);
  });
});
