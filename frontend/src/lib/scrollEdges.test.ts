import { describe, expect, it } from "vitest";
import { scrollEdges } from "./scrollEdges";

describe("scrollEdges", () => {
  it("no fade when content fits", () => {
    expect(scrollEdges(0, 0)).toEqual({ start: false, end: false });
  });
  it("fades the end until scrolled to the bottom", () => {
    expect(scrollEdges(0, 120)).toEqual({ start: false, end: true });
    expect(scrollEdges(60, 120)).toEqual({ start: true, end: true });
    expect(scrollEdges(119.5, 120)).toEqual({ start: true, end: false });
  });
});
