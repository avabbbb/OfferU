import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AgentThinkingBlock } from "./AgentThinkingBlock";
import { AgentMarkdown } from "./AgentMarkdown";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const head = () => host.querySelector<HTMLButtonElement>(".agent-thinking__head")!;
const body = () => host.querySelector('[data-testid="agent-thinking-body"]');

describe("AgentThinkingBlock", () => {
  it("is open and ticking while thinking, then collapses when the answer starts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    await act(async () => root.render(<AgentThinkingBlock text="先看岗位" startedAt={10_000} endedAt={null} />));
    expect(head().getAttribute("aria-expanded")).toBe("true");
    expect(body()?.textContent).toBe("先看岗位");
    expect(host.querySelector('[data-testid="agent-thinking"]')?.getAttribute("data-state")).toBe("active");
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(head().textContent).toContain("思考中 · 3 秒");

    await act(async () => root.render(<AgentThinkingBlock text="先看岗位，再对简历" startedAt={10_000} endedAt={14_000} />));
    expect(head().getAttribute("aria-expanded")).toBe("false");
    expect(body()).toBeNull();
    expect(head().textContent).toContain("已思考 4 秒");
    await act(async () => head().click());
    expect(body()?.textContent).toBe("先看岗位，再对简历");
  });

  it("does not auto-collapse once the user toggled it", async () => {
    await act(async () => root.render(<AgentThinkingBlock text="想" startedAt={0} endedAt={null} />));
    await act(async () => head().click()); // 收起
    await act(async () => head().click()); // 再展开
    await act(async () => root.render(<AgentThinkingBlock text="想完了" startedAt={0} endedAt={2000} />));
    expect(head().getAttribute("aria-expanded")).toBe("true");
  });

  it("finished blocks (saved on the message) start collapsed", async () => {
    await act(async () => root.render(<AgentThinkingBlock text="想" startedAt={0} endedAt={5000} />));
    expect(head().getAttribute("aria-expanded")).toBe("false");
    expect(head().textContent).toContain("已思考 5 秒");
  });
});

describe("AgentMarkdown streaming", () => {
  it("closes an unfinished code fence and marks the caret while streaming", async () => {
    await act(async () => root.render(<AgentMarkdown text={"看代码：\n```js\nconst a = 1;\n\n后面还在写"} streaming />));
    const md = host.querySelector(".agent-md")!;
    expect(md.getAttribute("data-streaming")).toBe("true");
    expect(md.querySelector("pre code")?.textContent).toContain("后面还在写");
    expect(md.textContent).not.toContain("```");
  });
  it("renders final text as-is without the caret", async () => {
    await act(async () => root.render(<AgentMarkdown text={"完成"} />));
    expect(host.querySelector(".agent-md")!.hasAttribute("data-streaming")).toBe(false);
  });
});
