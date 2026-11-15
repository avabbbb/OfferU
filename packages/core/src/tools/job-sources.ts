// 只给「公司 岗位」时从公司自己的招聘系统拿 JD（port of backend/app/core/job_sources.py）。
// 大厂走招聘官网公开接口，其余只认官方域名；镜像站、聚合站不采用。网络走注入的 fetch。

import { OFFICIAL_DOMAINS } from "../research/official-sources";
import { hostnameOf } from "../research/py";
import { CoreError } from "../types";
import type { HttpFetch } from "./net";

const ALIASES: Record<string, string> = {
  字节: "字节跳动", bytedance: "字节跳动", tencent: "腾讯", baidu: "百度", 阿里: "阿里巴巴",
  蚂蚁集团: "蚂蚁", b站: "哔哩哔哩", bilibili: "哔哩哔哩", meituan: "美团", kuaishou: "快手",
};
export const API_COMPANIES = ["腾讯", "百度", "字节跳动"];

const JCODE = /[（(]?\s?(J\d{4,})\s?[)）]?/i;
const PAREN = /[（(][^)）]+[)）]/g;
const CITIES = ["北京", "上海", "深圳", "广州", "杭州", "成都", "武汉", "南京", "西安", "苏州", "天津", "重庆",
  "长沙", "合肥", "厦门", "珠海", "大连", "新加坡"];
const SEP = " ·-|/，,：:";

const stripSep = (text: string) => {
  let start = 0;
  let end = text.length;
  while (start < end && SEP.includes(text[start])) start += 1;
  while (end > start && SEP.includes(text[end - 1])) end -= 1;
  return text.slice(start, end);
};

/** 「腾讯 大模型数据运营」→ [腾讯, 大模型数据运营]；认不出公司时公司为空。 */
export function splitName(name: string): [string, string] {
  const text = name.trim();
  const low = text.toLowerCase();
  const keys = [...Object.keys(OFFICIAL_DOMAINS), ...Object.keys(ALIASES)].sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (low.startsWith(key.toLowerCase())) return [ALIASES[key] ?? key, stripSep(text.slice(key.length).trim())];
  }
  return ["", text];
}

/** urlparse(url).hostname, lower-cased ("" when none). */
export const hostOf = hostnameOf;

/** 岗位名、城市、J 编号：「AI产品营销经理（J102408）北京」→ [AI产品营销经理, 北京, J102408]。 */
export function parseWant(rest: string): [string, string, string] {
  const found = JCODE.exec(rest);
  const jcode = found ? found[1].toUpperCase() : "";
  let title = rest.replace(new RegExp(JCODE.source, "gi"), "");
  const city = CITIES.find((c) => title.includes(c)) ?? "";
  if (city) title = title.split(city).join("");
  return [stripSep(title.trim()), city, jcode];
}

const norm = (value: unknown) => String(value ?? "").replace(/[\s（）()·\-—_/|，,、]+/g, "").toLowerCase();
const grams = (text: string) => {
  const chars = [...text];
  const out = new Set<string>();
  for (let i = 0; i < chars.length - 1; i += 1) out.add(chars[i] + chars[i + 1]);
  return out.size ? out : new Set([text]);
};

function score(title: string, city: string, name: unknown, location: unknown): number {
  const want = norm(title);
  const got = norm(String(name ?? "").replace(new RegExp(JCODE.source, "gi"), ""));
  if (!want || !got) return 0;
  const wanted = grams(want);
  const have = grams(got);
  let value = want === got ? 1 : [...wanted].filter((g) => have.has(g)).length / wanted.size;
  if (city && String(location ?? "").includes(city)) value += 0.1;
  return value;
}

function keywords(title: string, jcode = ""): string[] {
  const core = title.replace(PAREN, "").trim();
  const chars = [...core];
  return [...new Set([jcode, title, core, chars.length > 6 ? chars.slice(-4).join("") : ""].filter(Boolean))];
}

const labelOf = (name: unknown, location: unknown) => (location ? `${String(name)}（${String(location)}）` : String(name));

export type OfficialPosting = { url: string; title: string; text: string; truncated: false; source: string };
type Lookup = (fetcher: HttpFetch, title: string, city: string, jcode: string) => Promise<[OfficialPosting | null, string[]]>;

async function json(fetcher: HttpFetch, url: string, init: RequestInit = {}): Promise<any> {
  const response = await fetcher(url, { ...init, headers: { "User-Agent": "Mozilla/5.0 OfferU", ...(init.headers as Record<string, string> ?? {}) } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function render(parts: Array<[string, unknown]>, blocks: string[]): string {
  return parts
    .filter(([, value]) => value)
    .map(([key, value]) => (blocks.includes(key) ? `${key}：\n${String(value)}` : key ? `${key}：${String(value)}` : String(value)))
    .join("\n");
}

const tencent: Lookup = async (fetcher, title, city) => {
  const base = "https://careers.tencent.com";
  const posts = new Map<string, any>();
  for (const keyword of keywords(title)) {
    const query = new URLSearchParams({ timestamp: String(Date.now()), keyword, pageIndex: "1", pageSize: "20", language: "zh-cn", area: "cn" });
    const body = await json(fetcher, `${base}/tencentcareer/api/post/Query?${query}`);
    for (const post of body?.Data?.Posts ?? []) if (!posts.has(String(post.PostId))) posts.set(String(post.PostId), post);
  }
  const ranked = [...posts.values()].map((p) => [score(title, city, p.RecruitPostName, p.LocationName), p] as const).sort((a, b) => b[0] - a[0]);
  const similar = ranked.slice(0, 5).filter(([s]) => s > 0.3).map(([, p]) => labelOf(p.RecruitPostName, p.LocationName));
  if (!ranked.length || ranked[0][0] < 0.8) return [null, similar];
  const post = ranked[0][1];
  const postId = String(post.PostId);
  const detail = (await json(fetcher, `${base}/tencentcareer/api/post/ByPostId?${new URLSearchParams({ timestamp: String(Date.now()), postId, language: "zh-cn" })}`))?.Data ?? {};
  const name = detail.RecruitPostName || post.RecruitPostName;
  const text = render([
    ["", `腾讯 ${name}`], ["地点", detail.LocationName || post.LocationName], ["事业群", detail.BGName || post.BGName],
    ["产品", detail.ProductName], ["岗位职责", detail.Responsibility || post.Responsibility], ["岗位要求", detail.Requirement],
  ], ["岗位职责", "岗位要求"]);
  return [{ url: `${base}/jobdesc.html?postId=${postId}`, title: `腾讯 ${name}`, text, truncated: false, source: "careers.tencent.com 公开接口" }, similar];
};

const baidu: Lookup = async (fetcher, title, city, jcode) => {
  const base = "https://talent.baidu.com";
  const posts = new Map<string, [string, any]>();
  for (const keyword of keywords(title, jcode)) {
    for (const recruit of ["SOCIAL", "GRADUATE", "INTERN"]) {
      const body = await json(fetcher, `${base}/httservice/getPostListNew`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: `${base}/jobs/social-list` },
        body: new URLSearchParams({ recruitType: recruit, pageSize: "20", keyWord: keyword, curPage: "1", projectType: "" }).toString(),
      });
      for (const post of body?.data?.list ?? []) if (!posts.has(String(post.postId))) posts.set(String(post.postId), [recruit, post]);
    }
  }
  const byName = [...posts.values()].map(([r, p]) => [score(title, city, p.name, p.workPlace), r, p] as const).sort((a, b) => b[0] - a[0]);
  const similar = byName.slice(0, 5).filter(([s]) => s > 0.3).map(([, , p]) => labelOf(p.name, p.workPlace));
  const ranked = jcode
    ? [...posts.values()].filter(([, p]) => String(p.name ?? "").toUpperCase().includes(jcode)).map(([r, p]) => [2, r, p] as const)
    : byName;
  if (!ranked.length || ranked[0][0] < 0.8) return [null, similar];
  const [, recruit, post] = ranked[0];
  const text = render([
    ["", `百度 ${post.name}`], ["地点", post.workPlace], ["工作年限", post.workYears], ["学历", post.education],
    ["发布", post.publishDate], ["更新", post.updateDate], ["工作职责", post.workContent], ["职责要求", post.serviceCondition],
  ], ["工作职责", "职责要求"]);
  return [{ url: `${base}/jobs/detail/${recruit}/${post.postId}`, title: `百度 ${post.name}`, text, truncated: false, source: "talent.baidu.com 公开接口" }, similar];
};

const bytedance: Lookup = async (fetcher, title, city, jcode) => {
  const base = "https://jobs.bytedance.com";
  const posts = new Map<string, [string, any]>();
  for (const [site, page, portal] of [["society", "/experienced/position", 2], ["campus", "/campus/position", 3]] as const) {
    // atsx keys the CSRF token to a session cookie; carry it by hand (no cookie jar in fetch).
    const landing = await fetcher(base + page, { headers: { "User-Agent": "Mozilla/5.0 OfferU" }, redirect: "follow" });
    const cookies = (landing.headers.get("set-cookie") ?? "").split(/,(?=[^;]+=)/).map((c) => c.split(";")[0].trim()).filter(Boolean);
    const headers: Record<string, string> = {
      "Content-Type": "application/json", Referer: base + page, "Portal-Channel": "office", "Portal-Platform": "pc", "website-path": site,
      ...(cookies.length ? { Cookie: cookies.join("; ") } : {}),
    };
    const token = (await json(fetcher, `${base}/api/v1/csrf/token`, { method: "POST", headers, body: JSON.stringify({ portal_entrance: 1 }) }))?.data?.token;
    if (token) headers["x-csrf-token"] = token;
    for (const keyword of keywords(title, jcode)) {
      const body = await json(fetcher, `${base}/api/v1/search/job/posts`, {
        method: "POST", headers,
        body: JSON.stringify({
          keyword, limit: 20, offset: 0, job_category_id_list: [], location_code_list: [], subject_id_list: [],
          recruitment_id_list: [], portal_type: portal, job_function_id_list: [], portal_entrance: 1,
        }),
      });
      if (body?.code !== 0) throw new Error(`字节招聘接口返回：${String(body?.message)}`);
      for (const post of body?.data?.job_post_list ?? []) if (!posts.has(String(post.id))) posts.set(String(post.id), [page, post]);
    }
  }
  const where = (post: any) => String(post?.city_info?.name ?? "");
  const ranked = [...posts.values()].map(([page, p]) => [score(title, city, p.title, where(p)), page, p] as const).sort((a, b) => b[0] - a[0]);
  const similar = ranked.slice(0, 5).filter(([s]) => s > 0.3).map(([, , p]) => labelOf(p.title, where(p)));
  if (!ranked.length || ranked[0][0] < 0.8) return [null, similar];
  const [, page, post] = ranked[0];
  const recruit = post.recruit_type ?? {};
  const text = render([
    ["", `字节跳动 ${post.title}`], ["地点", where(post)], ["类别", post.job_category?.name],
    ["招聘类型", [recruit.parent?.name, recruit.name].filter(Boolean).join("·")], ["职位编号", post.code],
    ["职位描述", post.description], ["职位要求", post.requirement],
  ], ["职位描述", "职位要求"]);
  return [{ url: `${base}${page}/${post.id}/detail`, title: `字节跳动 ${post.title}`, text, truncated: false, source: "jobs.bytedance.com 公开接口" }, similar];
};

/** 查招聘官网接口：返回 [岗位页, 名字相近的官网岗位]。岗位页为 null 表示官网确实没有；网络错误照样抛出。 */
export async function findViaApi(fetcher: HttpFetch, company: string, rest: string): Promise<[OfficialPosting | null, string[]]> {
  const lookup: Record<string, Lookup> = { 腾讯: tencent, 百度: baidu, 字节跳动: bytedance };
  if (!lookup[company]) throw new CoreError(`${company} 还没接招聘官网接口`);
  const [title, city, jcode] = parseWant(rest);
  return lookup[company](fetcher, title, city, jcode);
}
