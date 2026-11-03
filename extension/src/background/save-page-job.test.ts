import { afterEach, describe, expect, it, vi } from "vitest";
import { savePageAsJob, type PageSnapshot } from "./save-page-job.js";

const SERVER = "http" + "://127.0.0.1:8766";
const snapshot: PageSnapshot = {
  url: "https" + "://jobs.example.com/position/1",
  title: "测试岗位",
  selection: "",
  text: "岗位描述",
  meta: {},
  ldjson: [],
  images: [],
};

function stubSaveResponse() {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ record: { id: 7, title: "测试岗位" } }),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("savePageAsJob", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses a content-script snapshot without injecting into the tab", async () => {
    const executeScript = vi.fn();
    vi.stubGlobal("chrome", { scripting: { executeScript } });
    const fetchMock = stubSaveResponse();

    const result = await savePageAsJob(undefined, SERVER, snapshot);

    expect(executeScript).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, message: "已存为岗位：测试岗位", id: 7 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(SERVER + "/api/tools/save");
    expect(init.headers["x-offeru-actor"]).toBe(encodeURIComponent("插件"));
    expect(JSON.parse(init.body).type).toBe("job");
  });

  it("injects into the tab when no snapshot is given", async () => {
    const executeScript = vi.fn().mockResolvedValue([{ result: snapshot }]);
    vi.stubGlobal("chrome", { scripting: { executeScript } });
    stubSaveResponse();

    const result = await savePageAsJob(3, SERVER);

    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(executeScript.mock.calls[0][0].target).toEqual({ tabId: 3 });
    expect(result.ok).toBe(true);
  });

  it("fails cleanly with neither a snapshot nor a tab", async () => {
    const executeScript = vi.fn();
    vi.stubGlobal("chrome", { scripting: { executeScript } });

    const result = await savePageAsJob(undefined, SERVER);

    expect(executeScript).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });
});
