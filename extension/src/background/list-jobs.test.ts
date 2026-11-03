// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readListCards, saveListJobs, type ListCard } from "./list-jobs.js";

const SERVER = ["http:", "", "127.0.0.1:8766"].join("/");
const site = (...labels: string[]): string => ["https:", "", labels.join(".")].join("/");
const BOSS = site("www", "zhipin", "com");
const XHS = site("www", "xiaohongshu", "com");

const LIST_HTML = [
  "<ul>",
  '<li class="job-card-box"><a href="/job_detail/111.html" class="job-name">前端工程师</a><span class="salary">20-30K</span><span class="boss-name">Example Co</span></li>',
  '<li class="job-card-box"><a href="/job_detail/111.html" class="job-name">前端工程师</a></li>',
  '<li class="job-card-box"><span class="job-name">没有链接</span></li>',
  "</ul>",
  '<section class="note-item"><a href="/explore/abc?xsec_token=t">x</a><div class="title">字节 AI 产品实习 内推</div><div class="author"><span class="name">某某</span></div></section>',
].join("");

describe("readListCards", () => {
  it("reads BOSS and xhs cards, dedupes by url", () => {
    document.body.innerHTML = LIST_HTML;
    const cards = readListCards();
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({ title: "前端工程师", company: "Example Co", source: "boss" });
    expect(new URL(cards[0].url).pathname).toBe("/job_detail/111.html");
    expect(cards[0].text).toContain("20-30K");
    expect(cards[1]).toMatchObject({ title: "字节 AI 产品实习 内推", company: "某某", source: "xhs" });
  });
});

describe("saveListJobs", () => {
  afterEach(() => vi.unstubAllGlobals());

  const cards: ListCard[] = [
    { url: BOSS + "/job_detail/1.html", title: "A", company: "C", text: "a", source: "boss" },
    { url: XHS + "/explore/2", title: "B", company: "", text: "b", source: "xhs" },
    { url: site("evil", "example", "com") + "/x", title: "X", company: "", text: "x", source: "boss" },
  ];

  it("saves nothing without consent", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ agreed: false }) });
    vi.stubGlobal("fetch", fetchMock);
    const result = await saveListJobs(SERVER, cards);
    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(SERVER + "/api/consent/platform-collect");
  });

  it("saves allowed cards after consent and skips other hosts", async () => {
    let id = 0;
    const fetchMock = vi.fn().mockImplementation(async (url: string) =>
      url.endsWith("/platform-collect")
        ? { ok: true, json: async () => ({ agreed: true }) }
        : { ok: true, json: async () => ({ record: { id: ++id } }) },
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await saveListJobs(SERVER, cards);
    expect(result.ok).toBe(true);
    expect(result.ids).toEqual([1, 2]);
    expect(result.message).toContain("跳过 1 个");
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body).toMatchObject({ type: "job", data: { title: "A", company: "C", source: "boss" } });
    expect(body.data.notes).toContain("列表页");
  });
});
