import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AgentQueueTray } from "./AgentQueueTray";
import { enqueue, loadQueue, saveQueue } from "@/lib/agentSteerQueue";

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
});

describe("AgentQueueTray", () => {
  it("renders nothing when empty", async () => {
    await act(async () => root.render(<AgentQueueTray items={[]} busy onSend={() => {}} onEdit={() => {}} onRemove={() => {}} />));
    expect(host.querySelector('[data-testid="agent-queue-tray"]')).toBeNull();
  });

  it("lists queued messages and wires send (steer while busy) / edit / remove", async () => {
    const items = enqueue(enqueue([], "先改简历", "c1", 1), "再投上海的岗位", "c1", 2);
    const onSend = vi.fn();
    const onEdit = vi.fn();
    const onRemove = vi.fn();
    await act(async () => root.render(<AgentQueueTray items={items} busy onSend={onSend} onEdit={onEdit} onRemove={onRemove} />));
    const rows = host.querySelectorAll('[data-testid="agent-queue-item"]');
    expect([...rows].map((row) => row.textContent)).toEqual(["先改简历", "再投上海的岗位"]);
    expect(host.textContent).toContain("排队 · 2");
    expect(host.textContent).toContain("这一轮结束后依次发送");
    const send = rows[1].querySelector<HTMLButtonElement>('[data-testid="agent-queue-send"]')!;
    expect(send.getAttribute("aria-label")).toBe("现在插话");
    await act(async () => send.click());
    await act(async () => rows[0].querySelector<HTMLButtonElement>('[data-testid="agent-queue-edit"]')!.click());
    await act(async () => rows[0].querySelector<HTMLButtonElement>('[data-testid="agent-queue-remove"]')!.click());
    expect(onSend).toHaveBeenCalledWith(items[1].id);
    expect(onEdit).toHaveBeenCalledWith(items[0].id);
    expect(onRemove).toHaveBeenCalledWith(items[0].id);
  });

  it("explains restored (not armed) and paused queues when idle", async () => {
    const storage = window.localStorage;
    saveQueue(storage, enqueue([], "上次没发的", null, 1));
    const restored = loadQueue(storage);
    storage.clear();
    await act(async () => root.render(<AgentQueueTray items={restored} busy={false} onSend={() => {}} onEdit={() => {}} onRemove={() => {}} />));
    expect(host.textContent).toContain("上次留下的，点发送才会发");
    expect(host.querySelector('[data-testid="agent-queue-send"]')!.getAttribute("aria-label")).toBe("现在发送");
    expect(host.querySelector('[data-testid="agent-queue-item"]')!.hasAttribute("data-armed")).toBe(false);
    await act(async () => root.render(<AgentQueueTray items={enqueue([], "x", null)} busy={false} paused onSend={() => {}} onEdit={() => {}} onRemove={() => {}} />));
    expect(host.textContent).toContain("已暂停，点发送继续");
  });
});
