import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ request }));
import { ModelPicker } from "./ModelPicker";

describe("ModelPicker", () => {
  beforeEach(() => request.mockReset());
  it("automatically fetches models and lets the user select one", async () => {
    request.mockResolvedValue({ success: true, models: [{ id: "fixture-model", name: "Fixture model" }] });
    const onChange = vi.fn();
    render(<ModelPicker baseUrl="https://provider.test/v1" apiKey="fixture-key" apiFormat="openai" configId="" value="" onChange={onChange} />);
    expect(await screen.findByRole("option", { name: "Fixture model · fixture-model" }, { timeout: 2500 })).toBeInTheDocument();
    await userEvent.setup().selectOptions(screen.getByLabelText("选择模型"), "fixture-model");
    expect(onChange).toHaveBeenCalledWith("fixture-model");
    expect(JSON.parse(request.mock.calls[0][1].body)).toMatchObject({ api_format: "openai", base_url: "https://provider.test/v1" });
  });
  it("keeps the existing selection when discovery fails and offers retry/manual input", async () => {
    request.mockResolvedValue({ success: false, models: [], message: "服务不支持模型列表" });
    render(<ModelPicker baseUrl="https://provider.test/v1" apiKey="***" apiFormat="anthropic" configId="stored" value="saved-model" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("服务不支持模型列表"), { timeout: 2500 });
    expect(screen.getByLabelText("选择模型")).toHaveValue("saved-model");
    await userEvent.setup().click(screen.getByRole("button", { name: "手动填写模型 ID" }));
    expect(screen.getByRole("textbox", { name: "选择模型" })).toHaveValue("saved-model");
  });
  it("ignores a stale response after the endpoint changes", async () => {
    let resolveOld: (value: unknown) => void = () => {};
    request.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; })).mockResolvedValue({ success: true, models: [{ id: "new", name: "New" }] });
    const view = render(<ModelPicker baseUrl="https://old.test/v1" apiKey="fixture" apiFormat="openai" configId="" value="" onChange={vi.fn()} />);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1), { timeout: 2500 });
    view.rerender(<ModelPicker baseUrl="https://new.test/v1" apiKey="fixture" apiFormat="openai" configId="" value="" onChange={vi.fn()} />);
    resolveOld({ success: true, models: [{ id: "old", name: "Old" }] });
    expect(await screen.findByRole("option", { name: "New · new" }, { timeout: 2500 })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Old · old" })).not.toBeInTheDocument();
  });
});
