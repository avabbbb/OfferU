// add_job source_url + 小红书 share-link normalization (DOGFOOD 2026-11-06). Same cases as
// backend/app/core/tools.py _share_url / _source_of_url.

import { afterEach, describe, expect, it } from "vitest";

import { normalizeShareUrl, sourceFact, sourceOfUrl } from "@offeru/core";

import { createApp } from "../src/app";
import { SqliteCoreStore } from "../src/store";

const IOS_SHARE = "【数据分析实习】看看 https://www.xiaohongshu.com/discovery/item/66a1b2c3d4e5f6a7b8c9d0e1?source=webshare&xhsshare=pc_web&xsec_token=ABx_y-z=&xsec_source=pc_share 复制后打开";

let store: SqliteCoreStore | null = null;
afterEach(() => {
  store?.close();
  store = null;
});

describe("share links", () => {
  it("keeps only the note id and xsec_token; short links lose their query; other links are cut out of the text", () => {
    expect(normalizeShareUrl(IOS_SHARE)).toBe("https://www.xiaohongshu.com/explore/66a1b2c3d4e5f6a7b8c9d0e1?xsec_token=ABx_y-z=");
    expect(normalizeShareUrl("http://xhslink.com/a/AbCdEf?foo=1，复制本条信息")).toBe("http://xhslink.com/a/AbCdEf");
    expect(normalizeShareUrl("见 https://jobs.feishu.cn/campus/position/7。")).toBe("https://jobs.feishu.cn/campus/position/7");
    expect(normalizeShareUrl("没有链接")).toBe("");
    expect([sourceOfUrl("https://www.xiaohongshu.com/explore/1"), sourceOfUrl("https://www.zhipin.com/job_detail/x"), sourceOfUrl("https://jobs.feishu.cn/x")])
      .toEqual(["xhs", "boss", "jobs.feishu.cn"]);
  });

  it("add_job(text, source_url) records the normalized link without fetching it; the evaluation names the platform", async () => {
    store = new SqliteCoreStore(":memory:");
    let fetched = 0;
    const app = createApp({ store, runtime: "node", storage: "sqlite", fetch: async () => { fetched += 1; throw new Error("no fetch"); } });
    const jd = "示例科技 数据分析实习生\n岗位职责：负责业务指标周报与 A/B 实验分析。\n任职要求：熟练 SQL，会 Python。\n工作地点：上海";
    const response = await app.request("/api/tools/add_job", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: jd, source_url: IOS_SHARE }),
    });
    expect(response.status).toBe(200);
    const { record } = await response.json() as any;
    expect(record).toMatchObject({ url: "https://www.xiaohongshu.com/explore/66a1b2c3d4e5f6a7b8c9d0e1?xsec_token=ABx_y-z=", source: "xhs" });
    expect(fetched).toBe(0);
    expect(sourceFact(record)).toEqual(["community", "第三方平台（小红书），没在招聘官网核实"]);
  });
});
