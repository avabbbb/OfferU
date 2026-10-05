import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import BuildIdentityPanel from "./BuildIdentityPanel";

const mocks = vi.hoisted(() => ({ isTauri: vi.fn(), invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri, invoke: mocks.invoke }));

describe("BuildIdentityPanel", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        runtime_instance_id: "4cb704f3-df88-4fbf-9e8c-1a10ef96ea7d",
        version: "0.4.0",
        commit: null,
        build_timestamp: null,
        dirty: null,
        source_fingerprint: null,
        data_root: "H:/tmp/offeru/desktop-data",
        runtime_type: "local",
        build_source: "source",
        approval_token: "do-not-render-this-token",
      }),
    }));
  });

  it("clearly shows a source run and leaves missing build metadata unknown", async () => {
    render(<BuildIdentityPanel />);

    expect(await screen.findByText("本地源码运行（未打包）")).toBeTruthy();
    expect(screen.getByText("0.4.0")).toBeTruthy();
    expect(screen.getByText("H:/tmp/offeru/desktop-data")).toBeTruthy();
    expect(screen.getAllByText("未知").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("do-not-render-this-token")).toBeNull();
  });
});
