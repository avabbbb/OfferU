import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetCareerArtifact } = vi.hoisted(() => ({ mockGetCareerArtifact: vi.fn() }));

vi.mock("@/lib/api", () => ({ getCareerArtifact: mockGetCareerArtifact }));

import { ArtifactViewer } from "./ArtifactViewer";

describe("ArtifactViewer", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders saved Markdown while escaping raw HTML and exposing no external-action controls", async () => {
    mockGetCareerArtifact.mockResolvedValue({
      id: "artifact-20",
      artifact_type: "follow_up_draft",
      title: "招聘方跟进草稿",
      content_markdown: "## 可审核草稿\n\n只供你检查。\n\n<img src=x onerror=alert(1)>",
    });
    render(<ArtifactViewer artifactId="artifact-20" onClose={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "招聘方跟进草稿" })).toBeInTheDocument();
    expect(screen.getByText("只供你检查。")).toBeInTheDocument();
    const content = screen.getByTestId("prepared-artifact-viewer").querySelector(".prose-chat");
    expect(content?.querySelector("img")).toBeNull();
    expect(content?.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(screen.getByText(/不会自动发送/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /发送|联系|提交/ })).not.toBeInTheDocument();
    expect(mockGetCareerArtifact).toHaveBeenCalledWith("artifact-20");
  });
});
