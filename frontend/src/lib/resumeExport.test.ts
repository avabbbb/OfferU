import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/core", () => ({
  apiUrl: (path: string) => "http://api" + path,
  tool: vi.fn(async () => ({ record: { id: 7, kind: "resume", title: "主简历", body: "# 张三\n", template: "photo", style: { accent: "#123456" } } })),
}));

import { tool } from "@/lib/core";
import { dispositionName, exportResume } from "@/lib/resumeExport";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  URL.createObjectURL = vi.fn(() => "blob:x");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => vi.unstubAllGlobals());

describe("resumeExport", () => {
  it("reads the UTF-8 file name from Content-Disposition", () => {
    expect(dispositionName(`attachment; filename="resume.pdf"; filename*=UTF-8''${encodeURIComponent("张三-主简历.pdf")}`, "x")).toBe("张三-主简历.pdf");
    expect(dispositionName('attachment; filename="resume.png"', "x")).toBe("resume.png");
    expect(dispositionName(null, "x")).toBe("x");
  });

  it("downloads what the companion printed", async () => {
    fetchMock.mockResolvedValueOnce(new Response("%PDF", {
      status: 200, headers: { "Content-Disposition": `attachment; filename="resume.pdf"; filename*=UTF-8''${encodeURIComponent("张三.pdf")}` },
    }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    expect(await exportResume(7, "pdf")).toBe("downloaded");
    expect(fetchMock.mock.calls[0][0]).toBe("http://api/api/resume/7/pdf");
    expect(click).toHaveBeenCalled();
    click.mockRestore();
  });

  it("web page without a printer (501): PDF prints the rendered page with window.print", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "no printer", code: "unsupported" }), { status: 501 }))
      .mockResolvedValueOnce(new Response("<!doctype html><title>简历</title>", { status: 200 }));
    const print = vi.fn();
    const append = document.body.appendChild.bind(document.body);
    const spy = vi.spyOn(document.body, "appendChild").mockImplementation((node) => {
      const out = append(node);
      if (node instanceof HTMLIFrameElement) {
        Object.defineProperty(node, "contentWindow", {
          value: { document: { title: "" }, addEventListener: vi.fn(), focus: vi.fn(), print },
        });
      }
      return out;
    });
    expect(await exportResume(7, "pdf")).toBe("printed");
    expect(tool).toHaveBeenCalledWith("get", { type: "doc", id: 7 });
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe("http://api/api/resume/render");
    const body = JSON.parse(init.body);
    expect(body.body).toBe("# 张三\n");
    expect(body.style).toMatchObject({ template: "clear", photo: true, accent: "#123456" });
    expect(print).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it("PNG on the web says to use PDF; other errors carry the detail", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 501 }));
    await expect(exportResume(7, "png")).rejects.toThrow("网页版导不了 PNG");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ detail: "简历不存在" }), { status: 404 }));
    await expect(exportResume(7, "pdf")).rejects.toThrow("简历不存在");
  });
});
