import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";

import type { AgentConversationSummary } from "@/lib/api";
import { AgentHistoryList } from "./AgentHistoryList";
import { AgentSlashMenu, useAgentSlash, type SlashAction } from "./AgentSlashMenu";

afterEach(cleanup);

function Harness({ commands }: { commands: SlashAction[] }) {
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const slash = useAgentSlash({ input, setInput, inputRef, commands });
  return (
    <div ref={anchorRef} data-ou-listbox-anchor="">
      <textarea aria-label="输入" ref={inputRef} value={input}
        onChange={(event) => { setInput(event.target.value); }}
        onSelect={slash.syncCaret} onInput={slash.syncCaret}
        onKeyDown={(event) => { slash.onKeyDown(event); }} />
      <AgentSlashMenu slash={slash} anchorRef={anchorRef} />
    </div>
  );
}

function typeInto(element: HTMLTextAreaElement, value: string) {
  fireEvent.change(element, { target: { value } });
  element.setSelectionRange(value.length, value.length);
  fireEvent.select(element);
}

describe("slash menu", () => {
  it("opens on /, filters, moves with ↓ and runs with Enter, removing the /token", () => {
    const runNew = vi.fn();
    const runModel = vi.fn();
    const commands: SlashAction[] = [
      { id: "new", label: "新对话", group: "对话", hint: "/new", run: runNew },
      { id: "model", label: "切换模型", group: "输入", hint: "/model", run: runModel },
      { id: "mode", label: "切换模式", group: "输入", hint: "/mode", run: vi.fn() },
    ];
    render(<Harness commands={commands} />);
    const box = screen.getByLabelText("输入") as HTMLTextAreaElement;
    typeInto(box, "帮我 /");
    expect(screen.getByTestId("agent-slash-menu")).toBeTruthy();
    expect(screen.getAllByRole("option")).toHaveLength(3);
    typeInto(box, "帮我 /mo");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([expect.stringContaining("切换模型"), expect.stringContaining("切换模式")]);
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "ArrowUp" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(runModel).toHaveBeenCalledTimes(1);
    expect(box.value).toBe("帮我 ");
    expect(screen.queryByTestId("agent-slash-menu")).toBeNull();
  });

  it("Esc closes without clearing the text; no match leaves Enter to the composer", () => {
    render(<Harness commands={[{ id: "new", label: "新对话", group: "对话", hint: "/new", run: vi.fn() }]} />);
    const box = screen.getByLabelText("输入") as HTMLTextAreaElement;
    typeInto(box, "/n");
    expect(screen.getByTestId("agent-slash-menu")).toBeTruthy();
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByTestId("agent-slash-menu")).toBeNull();
    expect(box.value).toBe("/n");
  });
});

describe("history list", () => {
  const conversations: AgentConversationSummary[] = [
    { id: "a", title: "改简历", created_at: "", updated_at: "", message_count: 2, last_message: "量化实习" },
    { id: "b", title: "面试邀约", created_at: "", updated_at: "", message_count: 4, last_message: "周三笔试" },
  ] as AgentConversationSummary[];

  it("is fully keyboard driven: search, ↓, Enter, Delete, Esc", () => {
    const onOpen = vi.fn();
    const onDelete = vi.fn();
    const onClose = vi.fn();
    render(<AgentHistoryList conversations={conversations} currentId="a" onOpen={onOpen} onDelete={onDelete} onNew={vi.fn()} onClose={onClose} />);
    const search = screen.getByLabelText("搜索历史对话");
    expect(document.activeElement).toBe(search);
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith("b");
    fireEvent.keyDown(search, { key: "Delete" });
    expect(onDelete).toHaveBeenCalledWith("b");
    fireEvent.change(search, { target: { value: "笔试" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(search, { key: "Escape" });
    expect((search as HTMLInputElement).value).toBe("");
    fireEvent.keyDown(search, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
