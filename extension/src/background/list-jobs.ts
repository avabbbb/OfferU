// 列表页多选存岗位：BOSS 直聘搜索结果、小红书搜索结果。
// 只读当前页已经渲染出来的卡片（用户已经看到的内容），不翻页、不点详情、不发额外请求。
// 登录态平台要先在 OfferU 设置里读完风险告知并同意（/api/consent/platform-collect），没同意一条都不存。

export interface ListCard {
  url: string;
  title: string;
  company: string;
  text: string;
  source: "boss" | "xhs";
}

export interface SaveListResult {
  ok: boolean;
  message: string;
  ids?: number[];
}

export const MAX_BATCH = 30;

const HOSTS: Record<ListCard["source"], RegExp> = {
  boss: /(^|\.)zhipin\.com$/,
  xhs: /(^|\.)xiaohongshu\.com$/,
};

// 在页面里执行：会被序列化注入，必须自包含，不能引用外面的变量。按卡片结构认平台，站点校验在保存时做。
export function readListCards(): ListCard[] {
  const clean = (value: string | null | undefined): string => (value || "").replace(/\s+/g, " ").trim();
  const textOf = (el: Element): string => clean((el as HTMLElement).innerText || el.textContent);
  const first = (root: Element, selectors: string): string => {
    const hit = root.querySelector(selectors);
    return hit ? textOf(hit) : "";
  };
  const linkTo = (root: Element, part: string): string => {
    const a = Array.from(root.querySelectorAll("a")).find((el) => (el.getAttribute("href") || "").includes(part));
    if (!a) return "";
    try {
      return new URL(a.getAttribute("href") || "", location.href).href;
    } catch {
      return "";
    }
  };
  const out: ListCard[] = [];
  const seen = new Set<string>();
  const push = (card: ListCard): void => {
    if (!card.url || !card.title || seen.has(card.url)) return;
    seen.add(card.url);
    out.push(card);
  };
  document.querySelectorAll(".job-card-box, .job-card-wrapper").forEach((el) => {
    push({
      url: linkTo(el, "/job_detail/"),
      title: first(el, ".job-name, .job-title"),
      company: first(el, ".boss-name, .company-name"),
      text: textOf(el).slice(0, 2000),
      source: "boss",
    });
  });
  document.querySelectorAll("section.note-item").forEach((el) => {
    push({
      url: linkTo(el, "/explore/") || linkTo(el, "/search_result/"),
      title: first(el, ".title"),
      company: first(el, ".author .name, .name"),
      text: textOf(el).slice(0, 2000),
      source: "xhs",
    });
  });
  return out;
}

// 卡片 → job 的 data。JD 只有卡片摘要，备注里写明，提醒打开详情补全。
export function cardToJob(card: ListCard): Record<string, unknown> {
  const data: Record<string, unknown> = {
    title: card.title.slice(0, 120),
    company: card.company,
    url: card.url,
    jd: card.text,
    source: card.source,
    notes: "从列表页卡片存入：JD 只有卡片上的摘要，打开详情页再存一次可补全",
  };
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== ""));
}

function allowed(card: ListCard): boolean {
  try {
    return HOSTS[card.source].test(new URL(card.url).hostname);
  } catch {
    return false;
  }
}

export async function saveListJobs(serverUrl: string, cards: ListCard[]): Promise<SaveListResult> {
  const picked = cards.filter(allowed).slice(0, MAX_BATCH);
  if (!picked.length) return { ok: false, message: "没有可存的岗位：只支持 BOSS 直聘和小红书的卡片" };
  let consent: { agreed?: boolean };
  try {
    const resp = await fetch(serverUrl + "/api/consent/platform-collect");
    consent = await resp.json();
  } catch {
    return { ok: false, message: "连不上 OfferU（" + serverUrl + "），后端启动了吗？" };
  }
  if (!consent.agreed) {
    return { ok: false, message: "登录态平台采集还没开启：先在 OfferU 设置里读完风险告知并同意" };
  }
  const headers = { "content-type": "application/json", "x-offeru-actor": encodeURIComponent("插件") };
  const ids: number[] = [];
  const failed: string[] = [];
  for (const card of picked) {
    try {
      const resp = await fetch(serverUrl + "/api/tools/save", {
        method: "POST",
        headers,
        body: JSON.stringify({ type: "job", data: cardToJob(card) }),
      });
      const body = await resp.json();
      if (resp.ok) ids.push(body.record.id);
      else failed.push(card.title);
    } catch {
      failed.push(card.title);
    }
  }
  const skipped = cards.length - picked.length;
  let message = "已存 " + ids.length + " 个岗位";
  if (failed.length) message += "，" + failed.length + " 个没存上：" + failed.slice(0, 3).join("、");
  if (skipped) message += "，跳过 " + skipped + " 个（不是 BOSS / 小红书卡片或超过一次 " + MAX_BATCH + " 个）";
  return { ok: ids.length > 0, message, ids };
}
