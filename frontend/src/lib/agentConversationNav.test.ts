// Cases adapted from avabbbb/Flovart@28c79bf:tests/agentConversationNav.test.ts (MIT).
import { describe, expect, it } from "vitest";
import {
  activeTurnIndex,
  isAwayFromBottom,
  nextStickToBottom,
  plainPreview,
  splitConversationTurns,
  turnIndexByMessage,
} from "./agentConversationNav";

const msgs = [
  { id: "w", role: "assistant", text: "你好，我是 OfferU" },
  { id: "u1", role: "user", text: "> 上一条回答\n\n帮我**改**简历" },
  { id: "a1", role: "assistant", text: "## 好的\n\n- 第一步 [链接](https://x)" },
  { id: "u2", role: "user", text: "再投 3 家\n\n附件：a.pdf" },
  { id: "a2", role: "assistant", text: "已投递" },
];

describe("agentConversationNav", () => {
  it("splits turns at user messages and skips the greeting before the first one", () => {
    const turns = splitConversationTurns(msgs);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ index: 0, userMessageId: "u1", question: "帮我改简历", answer: "好的 第一步 链接" });
    expect(turns[1]).toMatchObject({ userMessageId: "u2", question: "再投 3 家", answer: "已投递" });
  });

  it("maps every message to its turn (-1 before the first user message)", () => {
    const map = turnIndexByMessage(msgs);
    expect(map.get("w")).toBe(-1);
    expect(map.get("a1")).toBe(0);
    expect(map.get("a2")).toBe(1);
  });

  it("strips markdown for previews", () => {
    expect(plainPreview("```js\nx\n```\n**粗** `码` ![图](a.png)")).toBe("粗 码");
  });

  it("picks the last turn whose top is above the upper third of the viewport", () => {
    expect(activeTurnIndex([], 0, 300)).toBe(-1);
    expect(activeTurnIndex([0, 400, 900], 0, 300)).toBe(0);
    expect(activeTurnIndex([0, 400, 900], 350, 300)).toBe(1);
    expect(activeTurnIndex([0, 400, 900], 2000, 300)).toBe(2);
  });

  it("shows back-to-latest only when more than a third of a screen above the bottom", () => {
    expect(isAwayFromBottom({ scrollTop: 0, scrollHeight: 1000, clientHeight: 300 })).toBe(true);
    expect(isAwayFromBottom({ scrollTop: 650, scrollHeight: 1000, clientHeight: 300 })).toBe(false);
    expect(isAwayFromBottom({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 })).toBe(false);
  });

  it("stops following when the user scrolls up and resumes at the bottom; growth keeps the state", () => {
    const at = (scrollTop: number, scrollHeight = 1000) => ({ scrollTop, scrollHeight, clientHeight: 300 });
    expect(nextStickToBottom(true, at(500), 700)).toBe(false);
    expect(nextStickToBottom(false, at(690), 500)).toBe(true);
    // streaming makes the content taller: scrollTop unchanged → state unchanged
    expect(nextStickToBottom(true, at(700, 1400), 700)).toBe(true);
    expect(nextStickToBottom(false, at(500, 1400), 500)).toBe(false);
  });
});
