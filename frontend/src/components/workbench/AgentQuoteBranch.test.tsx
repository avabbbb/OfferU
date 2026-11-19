import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AgentQuoteBranchActions, AgentQuoteChip } from "./AgentMessageActions";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
async function render(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
  return host;
}
afterEach(async () => {
  window.getSelection()?.removeAllRanges();
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("AgentQuoteChip", () => {
  it("shows a one-line preview and clears with ×", async () => {
    const onClear = vi.fn();
    const el = await render(<AgentQuoteChip quote={"第一行\n\n第二行"} onClear={onClear} />);
    const chip = el.querySelector('[data-testid="agent-quote-chip"]')!;
    expect(chip.querySelector(".agent-quote-chip__text")?.textContent).toBe("第一行 第二行");
    await act(async () => chip.querySelector<HTMLButtonElement>('button[aria-label^="取消引用"]')!.click());
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});

describe("AgentQuoteBranchActions", () => {
  function Row(props: { onQuote?: (text: string) => void; onBranch?: () => void; branchDisabled?: boolean }) {
    const rowRef = createRef<HTMLDivElement>();
    return (
      <div ref={rowRef}>
        <p id="body">整条消息 的 全文</p>
        <AgentQuoteBranchActions rowRef={rowRef} fallbackText="整条消息 的 全文" {...props} />
      </div>
    );
  }

  it("quotes the whole message when nothing is selected", async () => {
    const onQuote = vi.fn();
    const el = await render(<Row onQuote={onQuote} />);
    await act(async () => el.querySelector<HTMLButtonElement>('[data-testid="agent-quote"]')!.click());
    expect(onQuote).toHaveBeenCalledWith("整条消息 的 全文");
  });

  it("quotes only the selection inside the row (captured before the click)", async () => {
    const onQuote = vi.fn();
    const el = await render(<Row onQuote={onQuote} />);
    const text = el.querySelector("#body")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 4);
    window.getSelection()!.addRange(range);
    const button = el.querySelector<HTMLButtonElement>('[data-testid="agent-quote"]')!;
    await act(async () => { button.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
    window.getSelection()!.removeAllRanges(); // 浏览器点击时清掉选区
    await act(async () => button.click());
    expect(onQuote).toHaveBeenCalledWith("整条消息");
  });

  it("renders the branch button only when allowed, and respects disabled", async () => {
    const onBranch = vi.fn();
    let el = await render(<Row onQuote={() => {}} />);
    expect(el.querySelector('[data-testid="agent-branch"]')).toBeNull();
    await act(async () => root!.unmount());
    host!.remove();
    el = await render(<Row onBranch={onBranch} />);
    expect(el.querySelector('[data-testid="agent-quote"]')).toBeNull();
    await act(async () => el.querySelector<HTMLButtonElement>('[data-testid="agent-branch"]')!.click());
    expect(onBranch).toHaveBeenCalledTimes(1);
    await act(async () => root!.render(<Row onBranch={onBranch} branchDisabled />));
    expect(el.querySelector<HTMLButtonElement>('[data-testid="agent-branch"]')!.disabled).toBe(true);
  });
});
