// =============================================
// PageSnapshot：受限页面快照
// 只承载检测所需的最小信息；不保存页面正文、完整 HTML、表单值。
// =============================================

export interface SnapshotBudget {
  /** css-exists 查询总预算 */
  maxQueries: number;
}

export interface PageSnapshot {
  url: string;
  host: string;
  pathname: string;
  title: string;
  /** meta name/property（小写）→ content，受限数量 */
  meta: Readonly<Record<string, string>>;
  /** <script src> 的 hostname 集合，受限数量 */
  scriptHosts: readonly string[];
  /** 预算内查询；超出预算返回 false 并永久置位 budgetExceeded */
  cssExists(css: string): boolean;
  budgetExceeded(): boolean;
}

export const DEFAULT_SNAPSHOT_BUDGET: SnapshotBudget = { maxQueries: 200 };
const META_MAX = 40;
const SCRIPT_HOST_MAX = 20;

export class PageSnapshotImpl implements PageSnapshot {
  readonly url: string;
  readonly host: string;
  readonly pathname: string;
  readonly title: string;
  readonly meta: Readonly<Record<string, string>>;
  readonly scriptHosts: readonly string[];

  private queryCount = 0;
  private exceeded = false;

  constructor(
    url: string,
    title: string,
    meta: Record<string, string>,
    scriptHosts: string[],
    private readonly budget: SnapshotBudget,
    private readonly query: (css: string) => boolean,
  ) {
    this.url = url;
    this.title = title;
    this.meta = Object.freeze({ ...meta });
    this.scriptHosts = Object.freeze([...scriptHosts]);
    try {
      const parsed = new URL(url);
      this.host = parsed.hostname;
      this.pathname = parsed.pathname;
    } catch {
      this.host = "";
      this.pathname = "";
    }
  }

  cssExists(css: string): boolean {
    if (this.exceeded) return false;
    if (this.queryCount >= this.budget.maxQueries) {
      this.exceeded = true;
      return false;
    }
    this.queryCount++;
    try {
      return this.query(css);
    } catch {
      this.exceeded = true;
      throw new Error("selector-query-failed");
    }
  }

  budgetExceeded(): boolean {
    return this.exceeded;
  }
}

/** 从受限 HTML 片段构建快照（fixture harness / page agent 使用） */
export function createSnapshotFromDom(
  url: string,
  documentLike: {
    title: string;
    querySelectorAll(selector: string): Iterable<{
      getAttribute(name: string): string | null;
    }>;
  },
  budget: SnapshotBudget = DEFAULT_SNAPSHOT_BUDGET,
): PageSnapshot {
  const meta: Record<string, string> = {};
  let metaCount = 0;
  for (const el of documentLike.querySelectorAll("meta")) {
    if (metaCount >= META_MAX) break;
    const name = (el.getAttribute("name") ?? el.getAttribute("property") ?? "").toLowerCase();
    const content = el.getAttribute("content");
    if (name && content) {
      meta[name] = content;
      metaCount++;
    }
  }
  const scriptHosts: string[] = [];
  for (const el of documentLike.querySelectorAll("script[src]")) {
    if (scriptHosts.length >= SCRIPT_HOST_MAX) break;
    const src = el.getAttribute("src");
    if (!src) continue;
    try {
      const host = new URL(src, url).hostname;
      if (host && !scriptHosts.includes(host)) scriptHosts.push(host);
    } catch {
      // 忽略无法解析的 src
    }
  }
  const doc = documentLike as unknown as { querySelector(css: string): unknown };
  return new PageSnapshotImpl(url, documentLike.title, meta, scriptHosts, budget, (css) => {
    if (typeof doc.querySelector !== "function") return false;
    return doc.querySelector(css) !== null;
  });
}
