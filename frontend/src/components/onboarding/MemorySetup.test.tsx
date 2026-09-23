import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemorySetup } from "./MemorySetup";

const memoryApi = vi.hoisted(() => ({
  localSources: vi.fn(), previewLocalSource: vi.fn(), inbox: vi.fn(), importCandidates: vi.fn(), reviewProposal: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ memoryApi }));

describe("memory setup consent", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    memoryApi.localSources.mockResolvedValue({ items: [{ id: "codex-memory-summary", name: "Codex 摘要", bytes: 100, can_preview: true }] });
    memoryApi.inbox.mockResolvedValue({ items: [] });
    memoryApi.previewLocalSource.mockResolvedValue({ source_name: "Codex 摘要", text: "- 希望从事产品工作" });
    memoryApi.importCandidates.mockResolvedValue({ items: [{ id: 1, title: "职业目标", after: { statement: "希望从事产品工作" }, status: "pending", evidence: [] }] });
    memoryApi.reviewProposal.mockResolvedValue({ status: "accepted" });
  });

  it("requires separate user actions to read, save, and accept a memory excerpt", async () => {
    const user = userEvent.setup();
    render(<MemorySetup onDone={vi.fn()} onBusy={vi.fn()} />);
    const preview = await screen.findByRole("button", { name: "允许读取并预览" });
    expect(memoryApi.previewLocalSource).not.toHaveBeenCalled();
    expect(memoryApi.importCandidates).not.toHaveBeenCalled();
    await user.click(preview);
    await waitFor(() => expect(screen.getByLabelText("要导入的职业线索")).toHaveValue("- 希望从事产品工作"));
    expect(screen.getByRole("button", { name: "整理所选记忆" })).toBeDisabled();
    expect(memoryApi.importCandidates).not.toHaveBeenCalled();
    await user.click(screen.getByRole("checkbox", { name: /允许 OfferU 保存/ }));
    await user.click(screen.getByRole("button", { name: "整理所选记忆" }));
    const accept = await screen.findByRole("button", { name: "保留为线索" });
    expect(memoryApi.importCandidates).toHaveBeenCalledWith("Codex 摘要", ["希望从事产品工作"]);
    expect(memoryApi.reviewProposal).not.toHaveBeenCalled();
    await user.click(accept);
    await screen.findByText("已保留为线索");
    expect(memoryApi.reviewProposal).toHaveBeenCalledWith(1, "accept", expect.any(String));
  });
});
