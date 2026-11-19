import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import type { AgentModelService } from "@/lib/api";
import { AgentComposerControls, modeMenuItems, modelMenuItems, resolveComposerChoice, type ComposerOptions } from "./AgentComposerControls";

const SERVICES: AgentModelService[] = [
  {
    config_id: "ds", service_name: "DeepSeek", provider_id: "deepseek", active: true, default_model: "deepseek-v4-flash",
    models: [
      { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", efforts: [] },
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", efforts: [{ id: "low", label: "低", hint: "更快" }, { id: "high", label: "高", hint: "想得更深" }] },
    ],
  },
  { config_id: "oa", service_name: "OpenAI", provider_id: "openai", active: false, default_model: "o4-mini", models: [{ id: "o4-mini", name: "o4-mini", efforts: [{ id: "minimal", label: "极简", hint: "最快" }] }] },
];

const OPTIONS: ComposerOptions = { llmConfigId: "", model: "", reasoningEffort: "", approvalMode: "auto" };

afterEach(cleanup);

describe("resolveComposerChoice", () => {
  it("falls back to the active service's model and drops an effort the model does not offer", () => {
    expect(resolveComposerChoice(SERVICES, OPTIONS)).toMatchObject({ modelId: "deepseek-v4-flash", reasoningEffort: "" });
    expect(resolveComposerChoice(SERVICES, { ...OPTIONS, llmConfigId: "ds", model: "deepseek-v4-flash", reasoningEffort: "high" }).reasoningEffort).toBe("");
    expect(resolveComposerChoice(SERVICES, { ...OPTIONS, llmConfigId: "ds", model: "deepseek-v4-pro", reasoningEffort: "high" })).toMatchObject({ modelId: "deepseek-v4-pro", reasoningEffort: "high" });
  });
});

describe("modelMenuItems", () => {
  it("builds service › model › effort; effort-less models are leaves", () => {
    const onChange = vi.fn();
    const items = modelMenuItems(SERVICES, OPTIONS, onChange, vi.fn());
    const deepseek = items[1] as { items: unknown[]; checked: boolean };
    expect(deepseek.checked).toBe(true);
    const [, flash, pro] = deepseek.items as Array<Record<string, any>>;
    expect(flash).toHaveProperty("onSelect");
    expect(pro.items.map((item: { label?: string }) => item.label).filter(Boolean)).toEqual(["默认", "低 · 更快", "高 · 想得更深"]);
    pro.items[3].onSelect();
    expect(onChange).toHaveBeenCalledWith({ llmConfigId: "ds", model: "deepseek-v4-pro", reasoningEffort: "high" });
  });
});

describe("AgentComposerControls", () => {
  it("opens the cascade with the keyboard and picks an effort", async () => {
    const onChange = vi.fn();
    render(<AgentComposerControls options={{ ...OPTIONS, llmConfigId: "ds", model: "deepseek-v4-pro", reasoningEffort: "low" }} onChange={onChange}
      services={SERVICES} modelOpen onModelOpenChange={vi.fn()} />);
    expect(screen.getByTestId("agent-model-trigger").textContent).toContain("DeepSeek V4 Pro");
    expect(screen.getByTestId("agent-model-trigger").textContent).toContain("低");
    const service = await screen.findByTestId("agent-model-service-ds");
    service.focus();
    fireEvent.keyDown(service, { key: "ArrowRight" });
    const model = await screen.findByTestId("agent-model-deepseek-v4-pro");
    model.focus();
    fireEvent.keyDown(model, { key: "ArrowRight" });
    const high = await screen.findByText("高 · 想得更深");
    fireEvent.click(high);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ llmConfigId: "ds", model: "deepseek-v4-pro", reasoningEffort: "high" }));
  });
});

describe("modeMenuItems (approval + sandbox)", () => {
  it("offers 询问 / 自动 and 可写 / 只读, checking the current ones", () => {
    const onChange = vi.fn();
    const items = modeMenuItems({ ...OPTIONS, sandbox: "read_only" }, onChange) as Array<any>;
    const actions = items.filter((item) => item && typeof item === "object" && "label" in item);
    expect(actions.map((item) => item.label)).toEqual(["询问", "自动", "可写", "只读"]);
    expect(actions.filter((item) => item.checked).map((item) => item.label)).toEqual(["自动", "只读"]);
    actions[2].onSelect();
    expect(onChange).toHaveBeenCalledWith({ sandbox: "workspace_write" });
    // 没设沙箱时默认可写
    const defaults = (modeMenuItems(OPTIONS, onChange) as Array<any>).filter((item) => item?.checked).map((item) => item.label);
    expect(defaults).toEqual(["自动", "可写"]);
  });
});
