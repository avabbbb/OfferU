// 「存为岗位」：用户点击时读当前标签页已经渲染好的内容，直接写进本机 OfferU（POST /api/tools/save）。
// 只在点击时注入、不常驻，不发任何额外请求：读的就是用户已经看到的页面，等同复制粘贴。
// 任何网站都能用（飞书 / Moka / 北森 / BOSS / 小红书……），不按站点适配。

export interface PageSnapshot {
  url: string;
  title: string;
  selection: string;
  text: string;
  meta: Record<string, string>;
  ldjson: unknown[];
  images: string[];
}

export interface SavePageResult {
  ok: boolean;
  message: string;
  id?: number;
}

export const ACTOR = "插件";

// 在页面里执行：会被序列化注入，所以必须自包含，不能引用外面的变量。
export function snapshotPage(): PageSnapshot {
  const meta: Record<string, string> = {};
  document.querySelectorAll("meta[property], meta[name]").forEach((el) => {
    const key = el.getAttribute("property") || el.getAttribute("name") || "";
    const value = el.getAttribute("content") || "";
    if (value && /^(og:|description$|keywords$)/.test(key)) meta[key] = value;
  });
  const ldjson: unknown[] = [];
  document.querySelectorAll('script[type="application/ld+json"]').forEach((el) => {
    try {
      ldjson.push(JSON.parse(el.textContent || ""));
    } catch {
      // 站点自己写坏的 ld+json 直接跳过
    }
  });
  // 小红书笔记是弹层 .note-container；其他站先找主区域，太短就退回整页。
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(".note-container, main, article, [role=main]"));
  const root = candidates.find((el) => el.innerText.trim().length > 200) || document.body;
  const images = Array.from(root.querySelectorAll("img"))
    .filter((img) => img.naturalWidth >= 300 && img.src.startsWith("http"))
    .map((img) => img.src);
  return {
    url: location.href,
    title: document.title,
    selection: String(getSelection() || "").trim(),
    text: root.innerText.trim().slice(0, 20000),
    meta,
    ldjson,
    images: Array.from(new Set(images)).slice(0, 9),
  };
}

const SOURCES: [RegExp, string][] = [
  [/xiaohongshu\.com|xhslink\.com/, "xhs"],
  [/zhipin\.com/, "boss"],
  [/feishu\.cn|jobs\.bytedance\.com/, "feishu"],
  [/mokahr\.com/, "moka"],
  [/zhiye\.com|beisen/, "beisen"],
];

type Posting = Record<string, any>;

function findPosting(ldjson: unknown[]): Posting | null {
  const stack: unknown[] = [...ldjson];
  while (stack.length) {
    const item = stack.pop();
    if (Array.isArray(item)) {
      stack.push(...item);
    } else if (item && typeof item === "object") {
      const obj = item as Posting;
      if (obj["@type"] === "JobPosting") return obj;
      if (obj["@graph"]) stack.push(obj["@graph"]);
    }
  }
  return null;
}

function htmlToText(html: string): string {
  return html
    .replace(/<br\s?\/?>|<\/p>|<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// 页面快照 → job 的 data。优先 ld+json JobPosting，其次 og meta，最后是正文；用户选中的文字最优先当 JD。
// 公司、投递方式（邮箱、标题格式）这些结构化字段留给 Agent 从 jd 里拆。
export function toJobData(page: PageSnapshot): Record<string, unknown> {
  const posting = findPosting(page.ldjson);
  const host = new URL(page.url).hostname;
  const postingText = posting?.description ? htmlToText(String(posting.description)) : "";
  const data: Record<string, unknown> = {
    title: String(posting?.title || page.meta["og:title"] || page.title || host).trim().slice(0, 120),
    company: posting?.hiringOrganization?.name || null,
    url: page.url,
    jd: page.selection || postingText || page.text || page.meta["description"] || null,
    source: SOURCES.find(([re]) => re.test(host))?.[1] || host,
    images: page.images.length ? page.images : null,
  };
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== null && value !== ""));
}

// snapshot 由 content script 直接读好传进来时（悬浮 dock 抽屉里点「存为岗位」是页内点击，拿不到 activeTab）就不再注入；
// 只有没带快照时才用 executeScript 读 tabId 对应的页面。
export async function savePageAsJob(
  tabId: number | undefined,
  serverUrl: string,
  snapshot?: PageSnapshot,
): Promise<SavePageResult> {
  let page: PageSnapshot | undefined = snapshot;
  if (!page) {
    if (tabId === undefined) return { ok: false, message: "未找到当前标签页" };
    try {
      const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func: snapshotPage });
      page = injection?.result as PageSnapshot | undefined;
    } catch (error) {
      return { ok: false, message: "这个页面读不了：" + (error instanceof Error ? error.message : String(error)) };
    }
  }
  if (!page) return { ok: false, message: "这个页面读不了" };
  const headers = { "content-type": "application/json", "x-offeru-actor": encodeURIComponent(ACTOR) };
  let resp: Response;
  try {
    resp = await fetch(serverUrl + "/api/tools/save", {
      method: "POST",
      headers,
      body: JSON.stringify({ type: "job", data: toJobData(page) }),
    });
  } catch {
    return { ok: false, message: "连不上 OfferU（" + serverUrl + "），后端启动了吗？" };
  }
  const body = await resp.json();
  if (!resp.ok) return { ok: false, message: "没存上：" + (body.detail ?? resp.status) };
  // 截止日期按设计存成 event（kind=deadline），挂在刚建的岗位下；没存上不影响岗位本身。
  const deadline = findPosting(page.ldjson)?.validThrough;
  if (deadline) {
    await fetch(serverUrl + "/api/tools/save", {
      method: "POST",
      headers,
      body: JSON.stringify({ type: "event", data: { title: "截止：" + body.record.title, kind: "deadline", at: String(deadline).slice(0, 10), job_id: body.record.id } }),
    }).catch(() => undefined);
  }
  return { ok: true, message: "已存为岗位：" + body.record.title, id: body.record.id };
}

// 在页面右下角提示一下结果（右键菜单触发时没有 popup 可以显示）。同样要自包含。
export function showToast(text: string): void {
  const el = document.createElement("div");
  el.textContent = "OfferU · " + text;
  el.style.cssText =
    "position:fixed;right:1.5rem;bottom:1.5rem;z-index:2147483647;max-width:24rem;padding:0.6rem 0.9rem;" +
    "border-radius:0.5rem;background:#111;color:#fff;font:13px/1.5 system-ui,sans-serif;" +
    "box-shadow:0 0.25rem 1rem rgba(0,0,0,.2)";
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}
