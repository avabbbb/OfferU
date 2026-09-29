import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: mocks.isTauri,
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: mocks.openUrl,
}));

import { ExternalUrlLink } from "./ExternalUrlLink";

describe("ExternalUrlLink", () => {
  beforeEach(() => {
    mocks.isTauri.mockReset();
    mocks.openUrl.mockReset();
  });

  it("keeps normal browser link behavior on the Web Showcase", () => {
    mocks.isTauri.mockReturnValue(false);
    render(<ExternalUrlLink href="https://example.com/job">打开岗位</ExternalUrlLink>);

    const link = screen.getByRole("link", { name: "打开岗位" });
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    const notCancelled = link.dispatchEvent(event);

    expect(notCancelled).toBe(true);
    expect(mocks.openUrl).not.toHaveBeenCalled();
  });

  it("uses the native opener inside Tauri instead of WebView target-blank behavior", async () => {
    mocks.isTauri.mockReturnValue(true);
    mocks.openUrl.mockResolvedValue(undefined);
    render(<ExternalUrlLink href="https://example.com/job">打开岗位</ExternalUrlLink>);

    fireEvent.click(screen.getByRole("link", { name: "打开岗位" }));

    expect(mocks.openUrl).toHaveBeenCalledWith("https://example.com/job");
  });

  it("rejects non-web protocols before they reach the native opener", async () => {
    mocks.isTauri.mockReturnValue(true);
    render(<ExternalUrlLink href="javascript:alert(1)">危险链接</ExternalUrlLink>);

    fireEvent.click(screen.getByRole("link", { name: "危险链接" }));
    await Promise.resolve();

    expect(mocks.openUrl).not.toHaveBeenCalled();
  });
});
