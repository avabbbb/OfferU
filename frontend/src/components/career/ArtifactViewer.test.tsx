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

  it("hides persisted content when its source has gone stale", async () => {
    mockGetCareerArtifact.mockResolvedValue({
      id: "artifact-stale",
      artifact_type: "interview_prep",
      title: "旧面试计划",
      content_markdown: "不要再使用这份旧材料",
      delivery: { state: "stale", reason: "岗位要求已经更新" },
    });
    render(<ArtifactViewer artifactId="artifact-stale" onClose={vi.fn()} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("这份内容已过期");
    expect(screen.getByRole("alert")).toHaveTextContent("岗位要求已经更新");
    expect(screen.queryByText("不要再使用这份旧材料")).not.toBeInTheDocument();
    expect(screen.queryByTestId("prepared-artifact-viewer")?.querySelector(".prose-chat")).toBeNull();
  });
});
