import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EMPTY_SYNC_FORM, encodeLinkCode } from "@/lib/syncWizard";

const test = vi.fn();
const configure = vi.fn();
vi.mock("@/lib/syncClient", () => ({
  syncApi: () => ({ test, configure }),
  syncRunsInBrowser: () => true,
}));

import { SyncWizard } from "./SyncWizard";

const ACCOUNT = "0123456789abcdef0123456789abcdef";

afterEach(cleanup);

describe("SyncWizard", () => {
  it("walks R2 setup, shows the CORS rule when the browser is blocked, then saves", async () => {
    const onDone = vi.fn();
    render(<SyncWizard saved={null} onDone={onDone} />);
    expect(screen.getByRole("radio", { name: /Cloudflare R2/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));

    fireEvent.change(screen.getByLabelText("Cloudflare 账户 ID"), { target: { value: `https://${ACCOUNT}.r2.cloudflarestorage.com/jobs` } });
    expect(screen.getByLabelText("Endpoint")).toHaveValue(`https://${ACCOUNT}.r2.cloudflarestorage.com`);
    expect(screen.getByLabelText("存储桶")).toHaveValue("jobs");
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));

    fireEvent.change(screen.getByLabelText("Access Key ID"), { target: { value: "AKID" } });
    fireEvent.change(screen.getByLabelText("Secret Access Key"), { target: { value: "SECRET" } });
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));

    test.mockResolvedValueOnce({ ok: false, repo: "unknown", passphrase: "unchecked", skewMs: null, checks: [
      { id: "network", status: "ok", detail: "能连上存储服务。" },
      { id: "cors", status: "fail", detail: "浏览器拦下了请求", code: "cors_blocked" },
    ] });
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    expect(await screen.findByLabelText("CORS 规则")).toHaveTextContent("ExposeHeaders");
    expect(screen.getByRole("button", { name: "下一步" })).toBeDisabled();
    expect(test).toHaveBeenCalledWith(expect.objectContaining({ provider: "r2", bucket: "jobs", region: "auto", secretAccessKey: "SECRET" }));

    test.mockResolvedValueOnce({ ok: true, repo: "empty", passphrase: "unchecked", skewMs: 0, checks: [{ id: "network", status: "ok", detail: "ok" }] });
    fireEvent.click(screen.getByRole("button", { name: "重新测试" }));
    await screen.findByText("通过");
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));

    fireEvent.change(screen.getByLabelText("同步口令"), { target: { value: "a long passphrase" } });
    fireEvent.change(screen.getByLabelText("再输一次"), { target: { value: "a long passphrase" } });
    configure.mockResolvedValueOnce({ configured: true });
    fireEvent.click(screen.getByRole("button", { name: "保存并连接" }));
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledWith({ configured: true }));
    expect(configure).toHaveBeenCalledWith(expect.objectContaining({ passphrase: "a long passphrase", remember: true }));
  });

  it("a pasted connection code fills the bucket and jumps to keys", () => {
    render(<SyncWizard saved={null} onDone={vi.fn()} />);
    const code = encodeLinkCode({ ...EMPTY_SYNC_FORM, provider: "minio", endpoint: "http://nas:9000", bucket: "家里", region: "us-east-1" });
    fireEvent.change(screen.getByLabelText("已经在另一台设备上设置过？"), { target: { value: code } });
    fireEvent.click(screen.getByRole("button", { name: "使用连接码" }));
    expect(screen.getByLabelText("Access Key ID")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "2. 存储桶" }));
    expect(screen.getByLabelText("存储桶")).toHaveValue("家里");
    expect(screen.getByLabelText("Endpoint")).toHaveValue("http://nas:9000");
  });
});
