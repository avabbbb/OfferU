import { describe, expect, it, vi } from "vitest";
import { closeOpenFences, createFrameBatcher, partialReplyFrom, thinkingLabel } from "./agentStreaming";

describe("closeOpenFences", () => {
  it("leaves closed / fence-free text alone", () => {
    expect(closeOpenFences("普通文字")).toBe("普通文字");
    const closed = "看：\n```js\nconst a = 1;\n```\n结束";
    expect(closeOpenFences(closed)).toBe(closed);
  });
  it("closes an open backtick or tilde fence with the same marker", () => {
    expect(closeOpenFences("```ts\nconst a")).toBe("```ts\nconst a\n```");
    expect(closeOpenFences("````\nx\n")).toBe("````\nx\n````");
    expect(closeOpenFences("~~~\ncode")).toBe("~~~\ncode\n~~~");
  });
  it("only a matching, long-enough fence closes the block", () => {
    // ~~~ 在 ``` 块里只是内容
    expect(closeOpenFences("```\n~~~\nstill code")).toBe("```\n~~~\nstill code\n```");
    // 更短的围栏不算关
    expect(closeOpenFences("````\n```\nx")).toBe("````\n```\nx\n````");
    // 第二个块开了没关
    expect(closeOpenFences("```\na\n```\n\n```py\nb")).toBe("```\na\n```\n\n```py\nb\n```");
  });
  it("ignores inline backticks", () => {
    expect(closeOpenFences("用 ``` 包起来")).toBe("用 ``` 包起来");
  });
});

describe("createFrameBatcher", () => {
  it("delivers everything pushed within one frame in a single flush", () => {
    const frames: Array<() => void> = [];
    const onFlush = vi.fn();
    const batcher = createFrameBatcher<string>(onFlush, (cb) => frames.push(cb), () => {});
    batcher.push("a"); batcher.push("b"); batcher.push("c");
    expect(frames).toHaveLength(1);
    expect(onFlush).not.toHaveBeenCalled();
    frames[0]();
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith(["a", "b", "c"]);
    batcher.push("d");
    expect(frames).toHaveLength(2);
  });
  it("flush() delivers now and cancels the scheduled frame; cancel() drops", () => {
    const cancelled: number[] = [];
    const onFlush = vi.fn();
    const batcher = createFrameBatcher<string>(onFlush, () => 7, (handle) => cancelled.push(handle));
    batcher.push("x");
    batcher.flush();
    expect(onFlush).toHaveBeenCalledWith(["x"]);
    expect(cancelled).toEqual([7]);
    batcher.flush();
    expect(onFlush).toHaveBeenCalledTimes(1);
    batcher.push("y");
    batcher.cancel();
    batcher.flush();
    expect(onFlush).toHaveBeenCalledTimes(1);
  });
});

describe("thinkingLabel", () => {
  it("counts while thinking, then reports the total", () => {
    expect(thinkingLabel(1000, null, 1200)).toBe("思考中");
    expect(thinkingLabel(1000, null, 4000)).toBe("思考中 · 3 秒");
    expect(thinkingLabel(1000, 6000, 99999)).toBe("已思考 5 秒");
    expect(thinkingLabel(0, 125000, 0)).toBe("已思考 2 分 5 秒");
    expect(thinkingLabel(0, 120000, 0)).toBe("已思考 2 分");
    expect(thinkingLabel(0, 200, 0)).toBe("已思考");
  });
});

describe("partialReplyFrom", () => {
  it("keeps streamed text and labels how the run ended", () => {
    expect(partialReplyFrom("  半截回答 ", new Error("Run 已取消"))).toEqual({ content: "半截回答", partial: "cancelled" });
    expect(partialReplyFrom("半截", new Error("Run interrupted"))).toEqual({ content: "半截", partial: "cancelled" });
    expect(partialReplyFrom("半截", new Error("LLM 超时"))).toEqual({ content: "半截", partial: "failed" });
    expect(partialReplyFrom("半截", "boom")).toEqual({ content: "半截", partial: "failed" });
  });
  it("keeps nothing when nothing was streamed", () => {
    expect(partialReplyFrom("", new Error("x"))).toBeNull();
    expect(partialReplyFrom("  \n ", new Error("x"))).toBeNull();
  });
});
