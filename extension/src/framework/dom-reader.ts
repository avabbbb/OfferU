// =============================================
// DOM 读取器：按 SiteRulePack ReadRule 从页面提取岗位字段
// 只读；不修改 DOM、不点击、不展开。
// =============================================

import type { JobCandidate } from "./workflow.js";
import type {
  ReadRuleV1,
  ResolvedSiteAdapter,
  SelectorScope,
  SelectorSetV1,
} from "../rule-packs/contracts.js";
import { applyNormalizers } from "../rule-packs/normalizers.js";

export interface ReadOutcome {
  job: JobCandidate | null;
  /** 缺失的必填字段（title/company/description/root） */
  missing: string[];
}

/**
 * 按 candidate 顺序选择第一组符合 maxMatches 的 selector。
 * 超过 maxMatches 视为不稳定，不默默截断，尝试下一个 candidate。
 * 全部失败返回 null。
 */
export function resolveSelectorSet(base: ParentNode, set: SelectorSetV1): Element[] | null {
  const queryBase = scopeBase(base, set.scope);
  for (const candidate of set.candidates) {
    let nodes: NodeListOf<Element>;
    try {
      nodes = queryBase.querySelectorAll(candidate.css);
    } catch {
      // selector 语法错误由 validator 拒绝；运行时结构异常按零匹配处理
      continue;
    }
    if (nodes.length === 0) continue;
    if (nodes.length > set.maxMatches) continue;
    return Array.from(nodes);
  }
  return null;
}

function scopeBase(root: ParentNode, scope: SelectorScope): ParentNode {
  if (scope === "document") return (root as Element).ownerDocument ?? root;
  return root;
}

function textOf(element: Element): string {
  return (element.textContent ?? "").replace(/\s+/g, " ").trim();
}

function readValue(elements: Element[], rule: ReadRuleV1, pageUrl: string): string {
  switch (rule.mode) {
    case "text":
    case "datetime":
      return applyNormalizers(textOf(elements[0]), rule.normalize, pageUrl);
    case "texts":
      return applyNormalizers(
        elements.map((el) => textOf(el)).filter(Boolean).join("\n"),
        rule.normalize,
        pageUrl,
      );
    case "href":
      return applyNormalizers(elements[0].getAttribute("href") ?? "", rule.normalize, pageUrl);
    case "attribute":
      return applyNormalizers(
        elements[0].getAttribute(rule.attribute ?? "") ?? "",
        rule.normalize,
        pageUrl,
      );
  }
}

function readField(root: ParentNode, rule: ReadRuleV1, pageUrl: string): string | null {
  const elements = resolveSelectorSet(root, rule.selectors);
  if (!elements || elements.length === 0) return null;
  const value = readValue(elements, rule, pageUrl);
  return value.length > 0 ? value : null;
}

function splitTexts(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** 从 job-detail adapter 读取岗位；title/company/description 是入库预览的最低字段门 */
export function readJobDetail(
  adapter: ResolvedSiteAdapter,
  doc: Document,
  pageUrl: string,
): ReadOutcome {
  const jobDetail = adapter.pageRule.jobDetail;
  if (!jobDetail) {
    return { job: null, missing: ["jobDetail"] };
  }

  let root: ParentNode = doc;
  if (jobDetail.root) {
    const rootElements = resolveSelectorSet(doc, jobDetail.root);
    if (!rootElements) {
      return { job: null, missing: ["root"] };
    }
    root = rootElements[0];
  }

  const fields = jobDetail.fields;
  const missing: string[] = [];

  const title = readField(root, fields.title, pageUrl);
  const company = readField(root, fields.company, pageUrl);
  const description = readField(root, fields.description, pageUrl);
  if (!title) missing.push("title");
  if (!company) missing.push("company");
  if (!description) missing.push("description");

  const readOptional = (rule: ReadRuleV1 | undefined): string | null =>
    rule ? readField(root, rule, pageUrl) : null;

  const location = readOptional(fields.location);
  const salary = readOptional(fields.salary);
  const applyUrl = readOptional(fields.applyUrl);
  const postedAt = readOptional(fields.postedAt);
  const tagsRaw = readOptional(fields.tags);
  const companyTagsRaw = readOptional(fields.companyTags);
  const sourceId = readOptional(fields.sourceId);

  const job: JobCandidate = {
    title: title ?? "",
    company: company ?? "",
    description: description ?? "",
    ...(location ? { location } : {}),
    ...(salary ? { salary } : {}),
    ...(applyUrl ? { applyUrl } : {}),
    ...(postedAt ? { postedAt } : {}),
    ...(tagsRaw ? { tags: splitTexts(tagsRaw) } : {}),
    ...(companyTagsRaw ? { companyTags: splitTexts(companyTagsRaw) } : {}),
    ...(sourceId ? { sourceId } : {}),
    sourceUrl: pageUrl,
  };

  return { job, missing };
}
