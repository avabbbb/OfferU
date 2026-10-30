import { Schema, type Node as PMNode } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import { describe, expect, it } from "vitest";

import { blockRange, moveRange } from "./BlockHandle";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    text: {},
    paragraph: { group: "block", content: "text*" },
    heading: { group: "block", content: "text*", attrs: { level: { default: 2 } } },
  },
});
const h = (level: number, t: string) => schema.node("heading", { level }, schema.text(t));
const p = (t: string) => schema.node("paragraph", null, schema.text(t));
// 名字(0-4) 教育(4-8) a(8-11) 实习(11-15) b(15-18) c(18-21)
const doc = schema.node("doc", null, [h(1, "名字"), h(2, "教育"), p("a"), h(2, "实习"), p("b"), p("c")]);
const texts = (d: PMNode) => { const out: string[] = []; d.forEach((n) => { out.push(n.textContent); }); return out; };

describe("blockRange", () => {
  it("分节标题带上整节，其他块只取自己", () => {
    expect(blockRange(doc, 1)).toEqual({ from: 4, to: 11 });
    expect(blockRange(doc, 3)).toEqual({ from: 11, to: 21 });
    expect(blockRange(doc, 2)).toEqual({ from: 8, to: 11 });
    expect(blockRange(doc, 0)).toEqual({ from: 0, to: 4 });
  });
});

describe("moveRange", () => {
  it("整节上移、下移", () => {
    const up = moveRange(doc, 11, 21, 4)!;
    expect(texts(new Transform(doc).delete(11, 21).insert(up.insertAt, up.content).doc)).toEqual(["名字", "实习", "b", "c", "教育", "a"]);
    const down = moveRange(doc, 4, 11, 21)!;
    expect(texts(new Transform(doc).delete(4, 11).insert(down.insertAt, down.content).doc)).toEqual(["名字", "实习", "b", "c", "教育", "a"]);
  });
  it("落在自己范围内不动", () => {
    expect(moveRange(doc, 4, 11, 8)).toBeNull();
    expect(moveRange(doc, 4, 11, 4)).toBeNull();
    expect(moveRange(doc, 4, 11, 11)).toBeNull();
  });
});
