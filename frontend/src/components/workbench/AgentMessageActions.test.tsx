import { describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { AgentImageViewer, openAgentImage } from "./AgentMessageActions";
import { imageCollageLayout } from "./AgentAttachmentTray";

describe("image collage + viewer", () => {
  it("lays images out by count", () => {
    expect(imageCollageLayout(0)).toBeUndefined();
    expect(imageCollageLayout(1)).toBe("1");
    expect(imageCollageLayout(2)).toBe("2");
    expect(imageCollageLayout(5)).toBe("many");
  });

  it("opens on request and steps with ←/→ (wrapping)", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(<AgentImageViewer />));
    expect(document.querySelector('[data-testid="agent-image-viewer"]')).toBeNull();
    await act(async () => openAgentImage({ images: [{ src: "https://a/1.png", name: "一" }, { src: "https://a/2.png", name: "二" }], index: 0 }));
    const viewer = () => document.querySelector<HTMLElement>('[data-testid="agent-image-viewer"]')!;
    expect(viewer().querySelector("img")?.getAttribute("src")).toBe("https://a/1.png");
    await act(async () => { viewer().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
    expect(viewer().querySelector("img")?.getAttribute("src")).toBe("https://a/2.png");
    await act(async () => { viewer().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
    expect(viewer().querySelector("img")?.getAttribute("src")).toBe("https://a/1.png");
    expect(viewer().textContent).toContain("1 / 2");
    await act(async () => root.unmount());
    host.remove();
  });
});
