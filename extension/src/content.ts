// =============================================
// OfferU Extension — Content Script (五平台)
// =============================================
// 列表页：仅提示“请进入详情页后再添加”
// 详情页：手动加入并补全 JD（可同步态）
// =============================================

/// <reference types="chrome" />

import type { ExtractedJob, JobSource, MergeResponse, Message, StatusResponse } from "./types.js";
import { buildHashKey, canonicalUrl, cleanText, parseSalary } from "./lib/collect-utils.js";
import { PLATFORM_CONFIGS } from "./content/platforms/index.js";
import type { PlatformConfig } from "./content/platforms/types.js";
import { scanFieldsSync } from "./content/smartfill-v2/scan/scanner.js";
import {
  applyCriticalSmartFillPlan,
  prepareCriticalSmartFillPlan,
} from "./content/smartfill-v2/pipeline.js";
import { PendingFieldHighlighter } from "./content/smartfill-v2/ui/highlighter.js";
import { setDebugEnabled, logDebug as logSmartFillDebug } from "./content/smartfill-v2/shared/logger.js";
import type { CriticalSmartFillPlan, ScannedField } from "./content/smartfill-v2/core/types.js";
import { safeExtensionError } from "./lib/safe-error.js";

const PLATFORMS: PlatformConfig[] = PLATFORM_CONFIGS;

const OFFERU_TOAST_ID = "offeru-ext-toast";
const DETAIL_BUTTON_ID = "offeru-ext-detail-button";
const LIST_BUTTON_FLAG = "data-offeru-list-btn";
const FLOATING_DOCK_ID = "offeru-ext-floating-dock";
const FLOATING_DOCK_STORAGE_KEY = "offeru-ext-floating-dock-state-v1";
const POPUP_TRIGGER_COLLECT_MESSAGE = "OFFERU_TRIGGER_COLLECT";
const PAGE_DRAWER_HOST_ID = "offeru-ext-page-drawer";
const POPUP_UI_SETTINGS_KEY = "popupUiSettings";
const SHORTCUT_SETTINGS_KEY = "shortcutSettingsV1";
const DRAWER_CLOSE_REASON_BUTTON = "close-button";
const LIST_CONTEXT_HINT = "当前列表未识别到岗位，请先点击目标岗位卡片后重试";
const LIST_BUTTON_HOST_FLAG = "data-offeru-list-btn-host";

type DockSide = "left" | "right" | "top" | "bottom";
type DrawerTab = "cart" | "resumes" | "settings";

interface DrawerController {
  open: (tab: DrawerTab) => void;
  close: () => void;
  toggle: (tab?: DrawerTab) => void;
  isOpen: () => boolean;
}

interface FloatingDockState {
  side: DockSide;
  top: number;
  expanded: boolean;
  edgeDocked: boolean;
  left?: number;
}

type UiTheme = "light" | "dark" | "system";

interface PopupUiSettings {
  theme?: UiTheme;
}

interface ShortcutSettings {
  collect: string;
  sync: string;
  settings: string;
}

const DEFAULT_SHORTCUT_SETTINGS: ShortcutSettings = {
  collect: "Alt+J",
  sync: "Alt+S",
  settings: "Alt+O",
};

const DOCK_COMPACT_WIDTH = 200;
const DOCK_COMPACT_HEIGHT = 44;
const DOCK_EXPANDED_WIDTH = 260;
const DOCK_EXPANDED_HEIGHT = 50;
const DOCK_PANEL_WIDTH = 260;
const DOCK_PANEL_HEIGHT = 208;
const EDGE_DOCK_LENGTH_REDUCTION = 30;
const EDGE_DOCK_SIDE_WIDTH = Math.max(60, Math.round(DOCK_COMPACT_WIDTH / 2) - EDGE_DOCK_LENGTH_REDUCTION);
const EDGE_DOCK_SIDE_HEIGHT = DOCK_COMPACT_HEIGHT;
const EDGE_DOCK_TOP_BOTTOM_WIDTH = Math.max(60, Math.round(DOCK_COMPACT_WIDTH / 2) - EDGE_DOCK_LENGTH_REDUCTION);
const EDGE_DOCK_TOP_BOTTOM_HEIGHT = DOCK_COMPACT_HEIGHT;
const EDGE_DOCK_TOP_BOTTOM_RADIUS = 16;
const DOCK_EDGE_SNAP_DISTANCE = 56;
const DOCK_RIGHT_GAP = 16;
const SCRIPT_CONTENT_MAX_LENGTH = 8_000_000;

interface CollectFromPageResponse {
  ok: boolean;
  message: string;
  added: number;
  upgraded: number;
  skipped: number;
}

function textOf(el: Element | null): string {
  return cleanText(el?.textContent || "");
}

function pickEl(root: ParentNode, selectors: string[]): Element | null {
  for (const selector of selectors) {
    const found = root.querySelector(selector);
    if (found) return found;
  }
  return null;
}

function pickText(root: ParentNode, selectors: string[]): string {
  for (const selector of selectors) {
    const nodes = root.querySelectorAll(selector);
    for (const node of Array.from(nodes)) {
      const value = textOf(node);
      if (value) return value;
    }
  }
  return "";
}

function pickAllText(root: ParentNode, selectors: string[]): string[] {
  const values: string[] = [];
  for (const selector of selectors) {
    const nodes = root.querySelectorAll(selector);
    nodes.forEach((node) => {
      const value = textOf(node);
      if (value) values.push(value);
    });
    if (values.length > 0) break;
  }
  return values;
}

function pickLink(root: ParentNode, selectors: string[]): string {
  for (const selector of selectors) {
    const node = root.querySelector(selector) as HTMLAnchorElement | null;
    if (!node) continue;
    const href = node.href || node.getAttribute("href") || "";
    if (!href) continue;
    try {
      return canonicalUrl(new URL(href, window.location.href).href, window.location.href);
    } catch {
      return href;
    }
  }
  return "";
}

function pickTag(tags: string[], rule: RegExp): string {
  return tags.find((tag) => rule.test(tag)) || "";
}

const LOCATION_NOISE_PATTERN =
  /(?:\d+\s*[-~]\s*\d+\s*[kK万]|面议|经验|应届|实习|本科|硕士|博士|大专|学历|招聘|发布|更新|招\d+人)/i;
const DESCRIPTION_HINT_PATTERN =
  /(岗位职责|职位描述|工作内容|任职要求|职位要求|职责|你将负责|我们希望|Job Description|Responsibilities|Requirements|Qualifications|About the job|What you'll do)/i;
const DESCRIPTION_WEAK_PATTERN =
  /(登录|扫码|分享|举报|收藏|投诉|隐私政策|免责声明|版权所有|推荐企业|公司简介|公司信息|官方微信|立即登录|企业服务热线)/i;
const BOSS_SALARY_PATTERN = /(\d+(?:\.\d+)?\s*(?:-|~|至)\s*\d+(?:\.\d+)?\s*(?:k|K|千|万)(?:[·•]\d+\s*薪)?|面议)/i;
const BOSS_JD_SECTION_START_PATTERN =
  /(职位描述|岗位职责|工作职责|职位职责|工作内容|你将负责|任职要求|职位要求|任职资格|岗位要求|Job Description|Responsibilities|Requirements|Qualifications)/i;
const BOSS_JD_SECTION_END_PATTERN =
  /(竞争力分析|公司介绍|公司简介|工商信息|工作地址|职位发布者|去APP|下载APP|立即沟通|举报|分享|收藏|微信扫码|BOSS直聘安全提示|BOSS\s*安全提示|个人综合排名|请立即举报|违法和不良信息举报邮箱)/i;
const BOSS_JD_NOISE_LINE_PATTERN =
  /(刚刚活跃|今日活跃|本周活跃|半年前活跃|近\d+(?:天|周|月)活跃|去APP与BOSS随时沟通|下载APP|前往APP|立即沟通|分享|举报|收藏|扫码登录|BOSS\s*安全提示|竞争力分析|对搜索结果是否满意|热门职位|热门城市|热门企业|附近城市|企业服务热线|老年人直连热线|工作日\s*8:00\s*-\s*22:00|休息日\s*8:00\s*-\s*22:00|没有更多职位|尝试登录查看全部职位|立即登录|协议与规则|隐私政策|防骗指南|使用帮助|朝阳网警|电子营业执照|京ICP备|算法备案信息|个人综合排名|在人中排名第|加载中|·HR|请立即举报|违法和不良信息举报邮箱|^(?:一般|良好|优秀|极好)$|^[\u4e00-\u9fa5]{1,4}(?:先生|女士)$)/i;
const BOSS_JD_NOISE_FRAGMENT_PATTERN =
  /(去APP与BOSS随时沟通|前往APP查看|下载APP|立即沟通|分享|举报|收藏|刚刚活跃|今日活跃|本周活跃|微信扫码登录|竞争力分析|对搜索结果是否满意|热门职位|热门城市|热门企业|附近城市|没有更多职位|尝试登录查看全部职位|立即登录|企业服务热线|老年人直连热线|协议与规则|隐私政策|防骗指南|使用帮助|朝阳网警|电子营业执照|京ICP备|算法备案信息|BOSS\s*安全提示|个人综合排名|在人中排名第|加载中|请立即举报|违法和不良信息举报邮箱)/gi;
const BOSS_LIST_PATH_HINT = /\/web\/geek\/jobs/i;
const GENERIC_DETAIL_DESCRIPTION_SELECTORS = [
  ".job-intro-container [data-selector='job-intro-content']",
  "[data-selector='job-intro-content']",
  ".job-description",
  ".job-detail",
  ".job-detail-section",
  ".describtion",
  ".describtion-card__detail-content",
  ".describtion__detail-content",
  ".job-content",
  ".content-word",
  ".jobs-description-content__text",
  ".jobs-description__content",
  ".show-more-less-html__markup",
  ".pos-ul",
  ".intern_position_detail",
  ".job_part .job_detail .intern-from-api",
  ".intern_position_detail",
  ".job_detail",
  "[class*='job-detail']",
  "[class*='job_description']",
  "[class*='description']",
] as const;
const CHINA_CITY_KEYWORDS = [
  "北京",
  "上海",
  "广州",
  "深圳",
  "杭州",
  "成都",
  "武汉",
  "南京",
  "天津",
  "重庆",
  "西安",
  "苏州",
  "宁波",
  "长沙",
  "郑州",
  "青岛",
  "沈阳",
  "大连",
  "济南",
  "合肥",
  "福州",
  "厦门",
  "珠海",
  "东莞",
  "佛山",
  "无锡",
  "常州",
  "南通",
  "昆明",
  "贵阳",
  "南昌",
  "太原",
  "石家庄",
  "长春",
  "哈尔滨",
  "兰州",
  "乌鲁木齐",
  "呼和浩特",
  "海口",
  "三亚",
  "温州",
  "嘉兴",
  "绍兴",
  "金华",
  "台州",
  "湖州",
  "烟台",
  "潍坊",
  "临沂",
  "徐州",
  "扬州",
  "镇江",
  "芜湖",
  "惠州",
  "中山",
  "南宁",
  "泉州",
  "洛阳",
  "唐山",
  "保定",
  "赣州",
  "银川",
  "拉萨",
  "珠三角",
  "长三角",
] as const;
const SORTED_CITY_KEYWORDS = [...CHINA_CITY_KEYWORDS].sort((a, b) => b.length - a.length);

let drawerController: DrawerController | null = null;

function normalizeLocationCandidate(value: string): string {
  if (!value) return "";
  return cleanText(value)
    .replace(/[|｜]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/(?:^工作地点[:：]?|^职位地址[:：]?|^工作地址[:：]?)/, "")
    .trim();
}

function extractCityFromText(value: string): string {
  if (!value) return "";
  const text = normalizeLocationCandidate(value);
  for (const city of SORTED_CITY_KEYWORDS) {
    if (text.includes(city)) {
      return city;
    }
  }

  const token = text.split(/[\-·\/｜|,，\s]/).find((part) => /[\u4e00-\u9fa5]{2,8}/.test(part));
  return token || "";
}

function scoreLocationCandidate(value: string): number {
  if (!value) return -999;
  const text = normalizeLocationCandidate(value);
  let score = 0;

  if (!text) return -999;
  if (/([\u4e00-\u9fa5]{2,})/.test(text)) score += 2;
  if (text.length >= 2 && text.length <= 26) score += 1;
  if (text.includes("-") || text.includes("·")) score += 1;
  if (LOCATION_NOISE_PATTERN.test(text)) score -= 7;
  if (text.length > 42) score -= 2;

  const city = extractCityFromText(text);
  if (city) score += 6;

  return score;
}

function dedupeTextList(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeLocationCandidate(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function pickLocationByLabel(root: ParentNode): string {
  const labelPattern = /^(工作地点|职位地址|工作地址|地址)[:：]?/;
  const nodes = root.querySelectorAll("dt,dd,div,span,p,strong,label");

  for (const node of Array.from(nodes)) {
    const text = normalizeLocationCandidate(node.textContent || "");
    if (!text || !labelPattern.test(text)) continue;

    const inline = text.replace(labelPattern, "").trim();
    if (inline) return inline;

    const sibling = node.nextElementSibling;
    const siblingText = normalizeLocationCandidate(sibling?.textContent || "");
    if (siblingText) return siblingText;
  }

  return "";
}

function appendLdJsonLocation(raw: unknown, output: string[]): void {
  if (!raw) return;

  if (Array.isArray(raw)) {
    raw.forEach((item) => appendLdJsonLocation(item, output));
    return;
  }

  if (typeof raw !== "object") return;
  const obj = raw as Record<string, unknown>;
  const type = String(obj["@type"] || "").toLowerCase();

  if (type === "jobposting") {
    const jobLocation = obj.jobLocation;
    if (jobLocation) {
      appendLdJsonLocation(jobLocation, output);
    }
  }

  const addressLocality = obj.addressLocality;
  if (typeof addressLocality === "string") output.push(addressLocality);

  const addressRegion = obj.addressRegion;
  if (typeof addressRegion === "string") output.push(addressRegion);

  const streetAddress = obj.streetAddress;
  if (typeof streetAddress === "string") output.push(streetAddress);

  const address = obj.address;
  if (address) appendLdJsonLocation(address, output);

  const graph = obj["@graph"];
  if (graph) appendLdJsonLocation(graph, output);
}

function readLdJsonLocationCandidates(root: ParentNode): string[] {
  const scripts = Array.from(root.querySelectorAll("script[type='application/ld+json']"));
  if (scripts.length === 0) return [];

  const values: string[] = [];
  for (const script of scripts) {
    const content = script.textContent?.trim();
    if (!content) continue;
    try {
      const parsed = JSON.parse(content) as unknown;
      appendLdJsonLocation(parsed, values);
    } catch {
      continue;
    }
  }

  return dedupeTextList(values);
}

function resolveLiepinLocation(pageType: "list" | "detail", primary: string, fallback: string): string {
  const candidates: string[] = [primary, fallback];

  if (pageType === "detail") {
    candidates.push(
      pickText(document, [
        "section.job-apply-container div.job-properties > span:first-child",
        ".job-apply-container .job-properties span:first-child",
        ".job-dq-box .ellipsis-1",
      ]),
    );
    candidates.push(pickLocationByLabel(document));
  } else {
    candidates.push(
      pickText(document, [
        ".job-dq-box .ellipsis-1",
        ".job-card-pc-container .job-dq",
        "section.job-apply-container div.job-properties > span:first-child",
      ]),
    );
  }

  candidates.push(...readLdJsonLocationCandidates(document));

  const titleCity = extractCityFromText(document.title || "");
  if (titleCity) {
    candidates.push(titleCity);
  }

  const merged = dedupeTextList(candidates);
  if (merged.length === 0) return "";

  let best = merged[0];
  let bestScore = scoreLocationCandidate(best);
  for (let i = 1; i < merged.length; i += 1) {
    const candidate = merged[i];
    const score = scoreLocationCandidate(candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  const bestCity = extractCityFromText(best);
  if (bestCity) return bestCity;

  const firstValid = merged.find((item) => scoreLocationCandidate(item) >= 0);
  if (firstValid) return firstValid;

  return best;
}

function resolveLocation(platform: PlatformConfig, pageType: "list" | "detail", primary: string, fallback = ""): string {
  if (platform.source === "liepin") {
    return resolveLiepinLocation(pageType, primary, fallback);
  }

  if (platform.source === "boss") {
    const candidates = dedupeTextList([
      primary,
      fallback,
      pickText(document, [
        ".location-address",
        ".job-location .location-address",
        ".job-location",
        ".job-location-text",
        ".job-area",
        ".job-area-wrapper",
        ".job-card-footer .job-area",
      ]),
      ...readLdJsonLocationCandidates(document),
      extractCityFromText(document.title || ""),
    ]);

    if (candidates.length === 0) return "";

    let best = candidates[0];
    let bestScore = scoreLocationCandidate(best);
    for (let i = 1; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      const score = scoreLocationCandidate(candidate);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }

    const bestCity = extractCityFromText(best);
    if (bestCity) return bestCity;

    const fallbackCity = candidates
      .map((candidate) => extractCityFromText(candidate))
      .find(Boolean);
    if (fallbackCity) return fallbackCity;

    return normalizeLocationCandidate(best);
  }

  const normalizedPrimary = normalizeLocationCandidate(primary);
  if (normalizedPrimary) return normalizedPrimary;

  const normalizedFallback = normalizeLocationCandidate(fallback);
  return normalizedFallback;
}

function normalizeDescriptionCandidate(value: string): string {
  if (!value) return "";

  const withLineBreak = value
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ");

  const textarea = document.createElement("textarea");
  textarea.innerHTML = withLineBreak;
  const decoded = textarea.value || withLineBreak;

  return decoded
    .split(/\n+/)
    .map((line) => cleanText(line))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function scoreDescriptionCandidate(value: string): number {
  const text = normalizeDescriptionCandidate(value);
  if (!text) return -999;

  let score = 0;
  const length = text.length;
  const lineCount = text.split(/\n+/).filter(Boolean).length;

  if (length >= 100) score += 3;
  if (length >= 220) score += 4;
  if (length >= 500) score += 3;
  if (length < 70) score -= 7;
  if (length > 12000) score -= 5;

  if (lineCount >= 4) score += 2;
  if (DESCRIPTION_HINT_PATTERN.test(text)) score += 7;
  if (DESCRIPTION_WEAK_PATTERN.test(text) && length < 260) score -= 5;

  return score;
}

function dedupeDescriptionCandidates(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = normalizeDescriptionCandidate(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function appendDescriptionFromStructuredData(raw: unknown, output: string[], depth = 0): void {
  if (!raw || output.length > 80) return;
  if (depth > 8) return;

  if (Array.isArray(raw)) {
    for (const item of raw) {
      appendDescriptionFromStructuredData(item, output, depth + 1);
      if (output.length > 80) return;
    }
    return;
  }

  if (typeof raw !== "object") return;
  const obj = raw as Record<string, unknown>;

  const valueKeys = [
    "description",
    "descriptionText",
    "postDescription",
    "jobDescription",
    "jobContent",
    "responsibility",
    "requirement",
    "Responsibilities",
    "Requirement",
  ] as const;

  for (const key of valueKeys) {
    const value = obj[key];
    if (typeof value === "string") {
      output.push(value);
      if (output.length > 80) return;
    }
  }

  for (const value of Object.values(obj)) {
    if (!value || typeof value !== "object") continue;
    appendDescriptionFromStructuredData(value, output, depth + 1);
    if (output.length > 80) return;
  }
}

function readScriptDescriptionCandidates(root: ParentNode): string[] {
  const scripts = Array.from(
    root.querySelectorAll(
      "script[type='application/ld+json'], script[type='application/json'], script#__NEXT_DATA__, script#__NUXT_DATA__",
    ),
  );
  if (scripts.length === 0) return [];

  const values: string[] = [];
  for (const script of scripts) {
    const content = script.textContent?.trim();
    if (!content) continue;
    if (content.length > SCRIPT_CONTENT_MAX_LENGTH) continue;

    try {
      const parsed = JSON.parse(content) as unknown;
      appendDescriptionFromStructuredData(parsed, values);
    } catch {
      continue;
    }
  }

  return dedupeDescriptionCandidates(values);
}

function readMetaDescriptionCandidates(root: ParentNode): string[] {
  const nodes = Array.from(
    root.querySelectorAll(
      "meta[name='description'], meta[property='og:description'], meta[name='twitter:description']",
    ),
  );

  return dedupeDescriptionCandidates(
    nodes
      .map((node) => (node as HTMLMetaElement).content || "")
      .filter(Boolean),
  );
}

function decodeEscapedScriptString(value: string): string {
  if (!value) return "";

  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
}

function readInlineScriptDescriptionCandidates(root: ParentNode): string[] {
  const scripts = Array.from(root.querySelectorAll("script:not([src])"));
  if (scripts.length === 0) return [];

  const values: string[] = [];
  const keyDrivenPatterns: RegExp[] = [
    /"(?:postDescription|descriptionText|jobDescription|jobContent|responsibility|requirement|Responsibilities|Requirement)"\s*:\s*"((?:\\.|[^"\\]){40,50000})"/g,
    /"description"\s*:\s*"((?:\\.|[^"\\]){120,50000})"/g,
  ];

  for (const script of scripts) {
    const content = script.textContent?.trim() || "";
    if (!content) continue;
    if (content.length > SCRIPT_CONTENT_MAX_LENGTH) continue;
    if (!/(postDescription|descriptionText|jobDescription|jobContent|responsibilit|requirement|description)/i.test(content)) {
      continue;
    }

    for (const pattern of keyDrivenPatterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        const decoded = decodeEscapedScriptString(match[1] || "");
        if (decoded) values.push(decoded);
        if (values.length > 80) break;
      }
      pattern.lastIndex = 0;
      if (values.length > 80) break;
    }
    if (values.length > 80) break;
  }

  return dedupeDescriptionCandidates(values);
}

function readSelectorDescriptionCandidates(root: ParentNode, selectors: readonly string[]): string[] {
  const values: string[] = [];

  for (const selector of selectors) {
    const nodes = root.querySelectorAll(selector);
    nodes.forEach((node) => {
      const htmlNode = node as HTMLElement;
      const candidate = normalizeDescriptionCandidate(htmlNode.innerText || node.textContent || "");
      if (candidate) values.push(candidate);
    });
  }

  return dedupeDescriptionCandidates(values);
}

function pickBestDescriptionCandidate(values: string[]): { text: string; score: number } | null {
  const merged = dedupeDescriptionCandidates(values);
  if (merged.length === 0) return null;

  let best = merged[0];
  let bestScore = scoreDescriptionCandidate(best);

  for (let i = 1; i < merged.length; i += 1) {
    const candidate = merged[i];
    const score = scoreDescriptionCandidate(candidate);
    if (score > bestScore || (score === bestScore && candidate.length > best.length)) {
      best = candidate;
      bestScore = score;
    }
  }

  return { text: best, score: bestScore };
}

function resolveDescriptionFromRoot(root: ParentNode, platform: PlatformConfig): string {
  const platformCandidates = readSelectorDescriptionCandidates(root, platform.detailDescription);
  const platformBest = pickBestDescriptionCandidate(platformCandidates);
  if (platformBest && platformBest.score >= 0) {
    return platformBest.text;
  }

  const candidates: string[] = [];
  candidates.push(...platformCandidates);
  candidates.push(...readSelectorDescriptionCandidates(root, GENERIC_DETAIL_DESCRIPTION_SELECTORS));
  candidates.push(...readScriptDescriptionCandidates(root));
  candidates.push(...readInlineScriptDescriptionCandidates(root));
  candidates.push(...readMetaDescriptionCandidates(root));

  const best = pickBestDescriptionCandidate(candidates);
  if (!best) return "";

  if (best.score < 0) {
    const longest = [...dedupeDescriptionCandidates(candidates)].sort((a, b) => b.length - a.length)[0];
    return longest || "";
  }

  return best.text;
}

function resolveDescription(platform: PlatformConfig): string {
  return resolveDescriptionFromRoot(document, platform);
}

function normalizeBossSalaryCandidate(value: string): string {
  if (!value) return "";

  const compact = cleanText(value)
    .replace(/[，,]/g, "")
    .replace(/[：:]/g, "")
    .replace(/\s+/g, "");

  if (!compact) return "";
  if (/面议/.test(compact)) return "面议";

  const extendedPattern = /(\d+(?:\.\d+)?\s*(?:-|~|至)\s*\d+(?:\.\d+)?\s*(?:k|K|千|万|元\/天|元\/月|元\/小时|元\/时)(?:[·•]\d+\s*薪)?|面议)/i;
  const match = compact.match(extendedPattern) || compact.match(BOSS_SALARY_PATTERN);
  if (!match) {
    const fallbackRange = compact.match(/(\d+(?:\.\d+)?(?:-|~|至)\d+(?:\.\d+)?[^\s，。,；;]{0,8})/i);
    if (!fallbackRange) return "";
    return (fallbackRange[1] || "").replace(/至/g, "-").trim();
  }

  return (match[1] || "")
    .replace(/至/g, "-")
    .replace(/\s+/g, "")
    .trim();
}

function resolveBossSalaryText(primary: string, root: ParentNode): string {
  const candidates: string[] = [primary];
  candidates.push(
    ...pickAllText(root, [
      ".info-primary .salary",
      ".job-salary",
      ".salary",
      ".job-card-left .salary",
      ".job-card-body .salary",
      ".job-banner .salary",
      "[class*='salary']",
    ]),
  );

  for (const candidate of candidates) {
    const normalized = normalizeBossSalaryCandidate(candidate);
    if (normalized) return normalized;
  }

  if (root instanceof Element || root instanceof Document) {
    const rawText = cleanText((root as Element).textContent || "");
    const fromText = normalizeBossSalaryCandidate(rawText);
    if (fromText) return fromText;
  }

  return cleanText(primary);
}

function sanitizeBossDescription(raw: string): string {
  const normalized = normalizeDescriptionCandidate(raw);
  if (!normalized) return "";

  let text = normalized
    .replace(BOSS_JD_NOISE_FRAGMENT_PATTERN, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const start = text.search(BOSS_JD_SECTION_START_PATTERN);
  if (start > 0 && text.length - start > 120) {
    text = text.slice(start);
  }

  const end = text.search(BOSS_JD_SECTION_END_PATTERN);
  if (end > 120) {
    text = text.slice(0, end);
  }

  const cleaned = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !BOSS_JD_NOISE_LINE_PATTERN.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const candidate = cleaned || text;
  const hasSectionHint = BOSS_JD_SECTION_START_PATTERN.test(candidate) || DESCRIPTION_HINT_PATTERN.test(candidate);
  const weakNoiseCount =
    candidate.match(/(对搜索结果是否满意|热门职位|热门城市|热门企业|附近城市|企业服务热线|没有更多职位|立即登录|协议与规则|隐私政策|朝阳网警|京ICP备)/g)?.length ||
    0;

  if (hasSectionHint && cleaned.length >= 60) return cleaned;
  if (hasSectionHint && candidate.length >= 80) return candidate;
  if (weakNoiseCount === 0 && candidate.length >= 260) return candidate;

  return "";
}

const POSTED_AT_HINT_PATTERN =
  /(datePosted|pubDate|publishedAt|publishTime|publishDate|postedAt|upDate|updateTime|updatedAt|发布时间|更新时间|发布于|更新于|更新|发布)/i;
const POSTED_AT_KEY_HINT_PATTERN =
  /(datePosted|pubDate|publishedAt|publishTime|publishDate|postedAt|upDate|updateTime|updatedAt)/i;
const POSTED_AT_WEAK_PATTERN =
  /(登录|扫码|分享|举报|收藏|投诉|隐私政策|免责声明|公司介绍|公司简介|职位描述|岗位职责|任职要求|招聘信息)/i;

function normalizePostedAtCandidate(value: string): string {
  if (!value) return "";

  return cleanText(value)
    .replace(/(?:^发布时间[:：]?|^更新时间[:：]?|^发布于[:：]?|^更新于[:：]?)/i, "")
    .replace(/^(?:发布|更新)[:：\s]+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupePostedAtCandidates(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = normalizePostedAtCandidate(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function coercePostedAtValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const abs = Math.abs(value);
    const timestampMs = abs > 1_000_000_000_000 ? value : abs > 1_000_000_000 ? value * 1000 : NaN;
    if (Number.isFinite(timestampMs)) {
      const date = new Date(timestampMs);
      if (!Number.isNaN(date.getTime())) {
        return date.toISOString();
      }
    }
    return String(value);
  }

  return "";
}

function appendPostedAtFromStructuredData(raw: unknown, output: string[], depth = 0): void {
  if (!raw || output.length > 60) return;
  if (depth > 8) return;

  if (Array.isArray(raw)) {
    for (const item of raw) {
      appendPostedAtFromStructuredData(item, output, depth + 1);
      if (output.length > 60) return;
    }
    return;
  }

  if (typeof raw !== "object") return;
  const obj = raw as Record<string, unknown>;

  const keys = [
    "datePosted",
    "pubDate",
    "publishedAt",
    "publishTime",
    "publishDate",
    "postedAt",
    "upDate",
    "updateTime",
    "updatedAt",
  ] as const;

  for (const key of keys) {
    const value = coercePostedAtValue(obj[key]);
    if (value) {
      output.push(value);
      if (output.length > 60) return;
    }
  }

  for (const value of Object.values(obj)) {
    if (!value || typeof value !== "object") continue;
    appendPostedAtFromStructuredData(value, output, depth + 1);
    if (output.length > 60) return;
  }
}

function readScriptPostedAtCandidates(root: ParentNode): string[] {
  const scripts = Array.from(
    root.querySelectorAll("script[type='application/ld+json']"),
  );
  if (scripts.length === 0) return [];

  const values: string[] = [];
  for (const script of scripts) {
    const content = script.textContent?.trim();
    if (!content) continue;
    if (content.length > SCRIPT_CONTENT_MAX_LENGTH) continue;
    if (!POSTED_AT_KEY_HINT_PATTERN.test(content)) continue;

    try {
      const parsed = JSON.parse(content) as unknown;
      appendPostedAtFromStructuredData(parsed, values);
      if (values.length > 60) break;
    } catch {
      continue;
    }
  }

  return dedupePostedAtCandidates(values);
}

function readInlineScriptPostedAtCandidates(root: ParentNode): string[] {
  const scripts = Array.from(root.querySelectorAll("script:not([src])"));
  if (scripts.length === 0) return [];

  const values: string[] = [];
  const stringPattern =
    /"(?:datePosted|pubDate|publishedAt|publishTime|publishDate|postedAt|upDate|updateTime|updatedAt)"\s*:\s*"((?:\\.|[^"\\]){4,120})"/g;
  const numberPattern =
    /"(?:datePosted|pubDate|publishedAt|publishTime|publishDate|postedAt|upDate|updateTime|updatedAt)"\s*:\s*(\d{10,13})/g;

  for (const script of scripts) {
    const content = script.textContent?.trim() || "";
    if (!content) continue;
    if (content.length > 1_200_000) continue;
    if (!POSTED_AT_KEY_HINT_PATTERN.test(content)) continue;

    let stringMatch: RegExpExecArray | null;
    while ((stringMatch = stringPattern.exec(content)) !== null) {
      const decoded = decodeEscapedScriptString(stringMatch[1] || "");
      if (decoded) values.push(decoded);
      if (values.length > 60) break;
    }
    stringPattern.lastIndex = 0;
    if (values.length > 60) break;

    let numberMatch: RegExpExecArray | null;
    while ((numberMatch = numberPattern.exec(content)) !== null) {
      const converted = coercePostedAtValue(Number(numberMatch[1] || ""));
      if (converted) values.push(converted);
      if (values.length > 60) break;
    }
    numberPattern.lastIndex = 0;
    if (values.length > 60) break;
  }

  return dedupePostedAtCandidates(values);
}

function readMetaPostedAtCandidates(root: ParentNode): string[] {
  const nodes = Array.from(
    root.querySelectorAll(
      "meta[property='article:published_time'], meta[property='article:modified_time'], meta[name='publishdate'], meta[name='pubdate'], meta[name='date'], meta[itemprop='datePosted']",
    ),
  );

  const values = nodes
    .map((node) => (node as HTMLMetaElement).content || "")
    .filter(Boolean);

  return dedupePostedAtCandidates(values);
}

function scorePostedAtCandidate(value: string): number {
  const text = normalizePostedAtCandidate(value);
  if (!text) return -999;

  let score = 0;
  if (/20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?/.test(text)) score += 8;
  if (/20\d{2}-\d{1,2}-\d{1,2}T\d{1,2}/.test(text)) score += 9;
  if (/\d{1,2}月\d{1,2}日/.test(text)) score += 5;
  if (/发布时间|发布于|更新时间|更新于|更新|发布/.test(text)) score += 2;
  if (text.length >= 6 && text.length <= 40) score += 1;
  if (text.length > 48) score -= 6;
  if (POSTED_AT_WEAK_PATTERN.test(text)) score -= 5;

  return score;
}

function pickBestPostedAtCandidate(values: string[]): { text: string; score: number } | null {
  const deduped = dedupePostedAtCandidates(values);
  if (deduped.length === 0) return null;

  let best = deduped[0];
  let bestScore = scorePostedAtCandidate(best);

  for (let i = 1; i < deduped.length; i += 1) {
    const candidate = deduped[i];
    const score = scorePostedAtCandidate(candidate);
    if (score > bestScore || (score === bestScore && candidate.length < best.length)) {
      best = candidate;
      bestScore = score;
    }
  }

  return { text: best, score: bestScore };
}

function resolvePostedAtFromRoot(platform: PlatformConfig, root: ParentNode): string {
  const selectorCandidates = pickAllText(root, platform.detailPostedAt);
  const selectorBest = pickBestPostedAtCandidate(selectorCandidates);
  if (selectorBest && selectorBest.score >= 5) {
    return selectorBest.text;
  }

  const structuredCandidates = [
    ...selectorCandidates,
    ...readMetaPostedAtCandidates(root),
    ...readScriptPostedAtCandidates(root),
  ];
  const structuredBest = pickBestPostedAtCandidate(structuredCandidates);
  if (structuredBest && structuredBest.score >= 3) {
    return structuredBest.text;
  }

  const fallbackCandidates = [...structuredCandidates, ...readInlineScriptPostedAtCandidates(root)];
  const fallbackBest = pickBestPostedAtCandidate(fallbackCandidates);
  if (!fallbackBest || fallbackBest.score < 0) return "";

  return fallbackBest.text;
}

function resolvePostedAt(platform: PlatformConfig): string {
  return resolvePostedAtFromRoot(platform, document);
}

function buildMeta(pageType: "list" | "detail", source: JobSource): string {
  return JSON.stringify({
    pageType,
    source,
    hostname: window.location.hostname,
    path: window.location.pathname,
    capturedAt: new Date().toISOString(),
  });
}

function normalizeExtractedTitle(value: string): string {
  return cleanText(value)
    .replace(/\s*-\s*智联招聘.*$/i, "")
    .replace(/\s*招聘\s*$/i, "")
    .replace(/^【\s*([^】]+)\s*】\s*/u, "$1 ")
    .trim();
}

function parseCompanyFromRecruitText(value: string): string {
  const text = cleanText(value);
  if (!text) return "";
  const match = text.match(/^(.{2,42}?)招聘/u);
  if (!match) return "";
  return cleanText(match[1]);
}

function resolveZhaopinTitleCompanyFallback(): { title: string; company: string } {
  let title = "";
  let company = "";

  const pageTitle = cleanText(document.title || "");
  if (pageTitle) {
    const underscore = pageTitle.split("_");
    if (underscore.length >= 2) {
      title = normalizeExtractedTitle(underscore[0] || "");
      company = cleanText((underscore[1] || "").replace(/\s*招聘\s*-\s*智联招聘.*$/i, "").replace(/\s*招聘\s*$/i, ""));
    } else {
      title = normalizeExtractedTitle(pageTitle);
    }
  }

  const scripts = Array.from(document.querySelectorAll("script[type='application/ld+json']"));
  for (const script of scripts) {
    const content = script.textContent || "";
    if (!content) continue;

    if (!title) {
      const titleMatch = content.match(/"title"\s*:\s*"((?:\\.|[^"\\]){2,220})"/);
      if (titleMatch) {
        const decoded = decodeEscapedScriptString(titleMatch[1] || "");
        title = normalizeExtractedTitle(decoded);
      }
    }

    if (!company) {
      const descMatch = content.match(/"description"\s*:\s*"((?:\\.|[^"\\]){8,800})"/);
      if (descMatch) {
        const decoded = decodeEscapedScriptString(descMatch[1] || "");
        company = parseCompanyFromRecruitText(decoded);
      }
    }

    if (title && company) break;
  }

  return { title, company };
}

function resolveCurrentPlatform(): PlatformConfig | null {
  const host = window.location.hostname;
  return PLATFORMS.find((platform) => platform.hostPattern.test(host)) || null;
}

function isDetailPage(platform: PlatformConfig): boolean {
  if (platform.detailPathHint && platform.detailPathHint.test(window.location.pathname)) {
    return true;
  }
  const hasDescription = Boolean(pickText(document, platform.detailDescription));
  const hasTitle = Boolean(pickText(document, platform.detailTitle));
  return hasDescription && hasTitle;
}

function isListPage(platform: PlatformConfig): boolean {
  return document.querySelectorAll(platform.listCard).length > 0;
}

function extractFromListCard(card: Element, platform: PlatformConfig): ExtractedJob | null {
  const title = pickText(card, platform.listTitle);
  const company = pickText(card, platform.listCompany);
  if (!title || !company) return null;

  const baseSalary = pickText(card, platform.listSalary);
  const salaryText = platform.source === "boss" ? resolveBossSalaryText(baseSalary, card) : baseSalary;
  const { min, max } = parseSalary(salaryText);
  const location = resolveLocation(platform, "list", pickText(card, platform.listLocation));
  const url = canonicalUrl(pickLink(card, platform.listLink), window.location.href);
  const tags = pickAllText(card, platform.listTags);
  const companyTags = pickAllText(card, platform.listCompanyTags);

  return {
    title,
    company,
    location,
    salary_text: salaryText,
    salary_min: min,
    salary_max: max,
    raw_description: "",
    url,
    apply_url: url,
    source: platform.source,
    source_page_meta: buildMeta("list", platform.source),
    education: pickTag(tags, /本科|硕士|博士|大专|学历|degree/i),
    experience: pickTag(tags, /经验|应届|实习|年|experience/i),
    job_type: pickTag(tags, /全职|实习|校招|兼职|full|intern/i),
    company_size: pickTag(companyTags, /人|employees|employee/i),
    company_industry: companyTags.find((item) => !/人|employees|employee/i.test(item)) || "",
    hash_key: buildHashKey(platform.source, title, company, url),
    status: "draft_pending_jd",
    created_at: new Date().toISOString(),
  };
}

function extractFromDetailPage(platform: PlatformConfig): ExtractedJob | null {
  let title = pickText(document, platform.detailTitle) || pickText(document, platform.listTitle);
  let company = pickText(document, platform.detailCompany) || pickText(document, platform.listCompany);
  const isBossListPath = platform.source === "boss" && BOSS_LIST_PATH_HINT.test(window.location.pathname);
  let listFallbackJob: ExtractedJob | null = null;

  if (isBossListPath) {
    const activeCard = pickBossActiveListCard(platform) || pickFirstVisibleListCard(platform);
    listFallbackJob = activeCard ? extractFromListCard(activeCard, platform) : null;
    if (listFallbackJob) {
      title = listFallbackJob.title || title;
      company = listFallbackJob.company || company;
    }
  }

  if (platform.source === "zhaopin" && (!title || !company)) {
    const fallback = resolveZhaopinTitleCompanyFallback();
    title = title || fallback.title;
    company = company || fallback.company;
  }

  if (platform.source === "boss" && (!title || !company)) {
    const activeCard = pickBossActiveListCard(platform) || pickFirstVisibleListCard(platform);
    const cardJob = activeCard ? extractFromListCard(activeCard, platform) : null;
    title = title || cardJob?.title || "";
    company = company || cardJob?.company || "";
  }

  if (!title || !company) return null;

  const baseSalary =
    pickText(document, platform.detailSalary) ||
    listFallbackJob?.salary_text ||
    pickText(document, platform.listSalary);
  const salaryRoot =
    (pickEl(document, [
      ".job-detail-box",
      ".job-card-body",
      ".job-detail",
      ".job-detail-section",
    ]) as ParentNode | null) || document;
  const salaryText = platform.source === "boss" ? resolveBossSalaryText(baseSalary, salaryRoot) : baseSalary;
  const { min, max } = parseSalary(salaryText);
  const detailLocation = pickText(document, platform.detailLocation);
  const listLocation = listFallbackJob?.location || pickText(document, platform.listLocation);
  const location = resolveLocation(platform, "detail", detailLocation, listLocation);
  const rawDescription = resolveDescription(platform);
  const description = platform.source === "boss" ? sanitizeBossDescription(rawDescription) : rawDescription;
  const tags = pickAllText(document, platform.detailTags);
  const companyTags = pickAllText(document, platform.detailCompanyTags);
  const postedAt = resolvePostedAt(platform);
  const currentUrl = listFallbackJob?.url || canonicalUrl(window.location.href, window.location.href);
  const applyUrl = canonicalUrl(pickLink(document, platform.detailApplyLink) || listFallbackJob?.apply_url || currentUrl, window.location.href);

  return {
    title,
    company,
    location,
    salary_text: salaryText,
    salary_min: min,
    salary_max: max,
    raw_description: description,
    posted_at: postedAt || null,
    url: currentUrl,
    apply_url: applyUrl,
    source: platform.source,
    source_page_meta: buildMeta("detail", platform.source),
    education: pickTag(tags, /本科|硕士|博士|大专|学历|degree/i),
    experience: pickTag(tags, /经验|应届|实习|年|experience/i),
    job_type: pickTag(tags, /全职|实习|校招|兼职|full|intern/i),
    company_size: pickTag(companyTags, /人|employees|employee/i),
    company_industry: companyTags.find((item) => !/人|employees|employee/i.test(item)) || "",
    hash_key: buildHashKey(platform.source, title, company, currentUrl),
    status: description ? "ready_to_sync" : "draft_pending_jd",
    created_at: new Date().toISOString(),
  };
}

function normalizeListCardRoot(platform: PlatformConfig, candidate: Element): Element {
  if (platform.source !== "boss") return candidate;
  const listRoot = candidate.closest("li.job-card-box, li.job-card-wrap, .job-list li, .rec-job-list li");
  if (listRoot) return listRoot;

  const wrapped = candidate.closest(".job-card-box, .job-card-wrap");
  if (!wrapped) return candidate;

  const parentLi = wrapped.closest("li");
  return parentLi || wrapped;
}

function getUniqueListCards(platform: PlatformConfig): Element[] {
  const cards = Array.from(document.querySelectorAll(platform.listCard));
  const result: Element[] = [];
  const seen = new Set<Element>();

  for (const candidate of cards) {
    const root = normalizeListCardRoot(platform, candidate);
    if (seen.has(root)) continue;
    seen.add(root);
    result.push(root);
  }

  return result;
}

function pickFirstVisibleListCard(platform: PlatformConfig): Element | null {
  const cards = getUniqueListCards(platform);
  if (cards.length === 0) return null;

  const visible = cards.find((card) => {
    const rect = (card as HTMLElement).getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.top <= window.innerHeight;
  });

  return visible || cards[0] || null;
}

function pickBossActiveListCard(platform: PlatformConfig): Element | null {
  if (platform.source !== "boss") return null;

  const active =
    document.querySelector(".rec-job-list .job-card-wrap.active") ||
    document.querySelector(".job-card-wrap.active") ||
    document.querySelector("li.job-card-box.active") ||
    document.querySelector(".job-card-box.active");

  if (!active) return null;
  return active.closest(platform.listCard) || active;
}

function resolveCollectJob(platform: PlatformConfig): ExtractedJob | null {
  if (platform.source === "boss") {
    const bossDetailJob = extractFromDetailPage(platform);
    if (bossDetailJob?.raw_description?.trim()) {
      return bossDetailJob;
    }
  }

  if (isDetailPage(platform)) {
    const detailJob = extractFromDetailPage(platform);
    if (detailJob) return detailJob;
  }

  const listCard = pickBossActiveListCard(platform) || pickFirstVisibleListCard(platform);
  if (!listCard) return null;

  return extractFromListCard(listCard, platform);
}

async function enrichBossDraftJob(job: ExtractedJob, platform: PlatformConfig): Promise<ExtractedJob> {
  if (platform.source !== "boss") return job;
  if (job.status !== "draft_pending_jd") return job;

  const detailUrl = canonicalUrl(job.apply_url || job.url, window.location.href);
  if (!detailUrl || !/job_detail/i.test(detailUrl)) return job;

  try {
    const response = await fetch(detailUrl, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      redirect: "error",
    });

    if (!response.ok) return job;

    const html = await response.text();
    if (!html || html.length < 200) return job;

    const parsed = new DOMParser().parseFromString(html, "text/html");
    const rawDescription = resolveDescriptionFromRoot(parsed, platform);
    const description = sanitizeBossDescription(rawDescription);
    if (!description) return job;

    const salaryBase = pickText(parsed, platform.detailSalary) || pickText(parsed, platform.listSalary);
    const salaryText = resolveBossSalaryText(salaryBase, parsed);
    const { min, max } = parseSalary(salaryText || job.salary_text);
    const postedAt = resolvePostedAtFromRoot(platform, parsed);

    return {
      ...job,
      salary_text: salaryText || job.salary_text,
      salary_min: min,
      salary_max: max,
      raw_description: description,
      posted_at: postedAt || job.posted_at || null,
      status: "ready_to_sync",
    };
  } catch {
    return job;
  }
}

async function enrichCollectedJob(job: ExtractedJob, platform: PlatformConfig): Promise<ExtractedJob> {
  const enriched = await enrichBossDraftJob(job, platform);
  return enriched;
}

function collectFromCurrentContext(
  platform: PlatformConfig | null,
  onDone: (response: CollectFromPageResponse) => void,
): void {
  if (!platform) {
    onDone({
      ok: false,
      message: "当前页面暂不支持采集，请前往招聘站页面",
      added: 0,
      upgraded: 0,
      skipped: 0,
    });
    return;
  }

  const job = resolveCollectJob(platform);
  if (!job) {
    const listHint = isListPage(platform)
      ? LIST_CONTEXT_HINT
      : "未识别到可加入岗位，请在岗位详情页或岗位列表卡片上操作";
    onDone({
      ok: false,
      message: listHint,
      added: 0,
      upgraded: 0,
      skipped: 0,
    });
    return;
  }

  void (async () => {
    const finalJob = await enrichCollectedJob(job, platform);

    collectJobs([finalJob], (resp) => {
      if (!resp) {
        onDone({
          ok: false,
          message: "加入失败，请稍后重试",
          added: 0,
          upgraded: 0,
          skipped: 0,
        });
        return;
      }

      const message =
        resp.added > 0
          ? `已加入：${finalJob.title}`
          : resp.upgraded > 0
            ? `已补全JD：${finalJob.title}`
            : "岗位已在购物车";

      onDone({
        ok: true,
        message,
        added: resp.added,
        upgraded: resp.upgraded,
        skipped: resp.skipped,
      });
    });
  })();
}

function showToast(message: string, isError = false): void {
  const existing = document.getElementById(OFFERU_TOAST_ID);
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = OFFERU_TOAST_ID;
  toast.textContent = message;
  toast.style.position = "fixed";
  toast.style.top = "16px";
  toast.style.right = "16px";
  toast.style.zIndex = "2147483647";
  toast.style.padding = "10px 14px";
  toast.style.borderRadius = "8px";
  toast.style.background = isError ? "#b91c1c" : "#0f172a";
  toast.style.color = "#f8fafc";
  toast.style.fontSize = "13px";
  toast.style.boxShadow = "0 8px 20px rgba(0,0,0,0.25)";
  toast.style.maxWidth = "340px";
  document.body.appendChild(toast);

  window.setTimeout(() => toast.remove(), 2000);
}

function buildDrawerUrl(tab: DrawerTab): string {
  const query = new URLSearchParams({ tab, embed: "drawer" });
  return chrome.runtime.getURL(`popup.html?${query.toString()}`);
}

function ensurePageDrawer(): DrawerController {
  if (drawerController) return drawerController;

  const stale = document.getElementById(PAGE_DRAWER_HOST_ID);
  if (stale) {
    stale.remove();
  }

  const host = document.createElement("div");
  host.id = PAGE_DRAWER_HOST_ID;
  host.style.setProperty("position", "fixed", "important");
  host.style.setProperty("inset", "0", "important");
  host.style.setProperty("z-index", "2147483647", "important");
  host.style.setProperty("pointer-events", "none", "important");
  host.style.setProperty("display", "block", "important");
  host.style.setProperty("visibility", "visible", "important");
  host.style.setProperty("opacity", "1", "important");
  host.style.setProperty("isolation", "isolate", "important");

  const root = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `
    .drawer-shell {
      position: fixed;
      inset: 0;
      pointer-events: none;
    }
    .drawer-panel {
      position: absolute;
      width: min(392px, calc(100vw - 12px));
      height: min(566px, calc(100vh - 12px));
      background: #f7f8fc;
      box-shadow: 0 18px 38px rgba(2, 6, 23, 0.28);
      --drawer-x: 0px;
      --drawer-y: 0px;
      --drawer-scale: 0.97;
      transform: translate3d(var(--drawer-x), var(--drawer-y), 0) scale(var(--drawer-scale));
      transform-origin: top left;
      transition: transform 0.18s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.18s ease;
      border-radius: 12px;
      display: none;
      grid-template-rows: minmax(0, 1fr);
      overflow: hidden;
      opacity: 0;
      pointer-events: none;
    }
    .drawer-shell.is-visible .drawer-panel {
      display: grid;
      pointer-events: auto;
    }
    .drawer-frame {
      width: 100%;
      height: 100%;
      border: 0;
      background: #f4f6fb;
      pointer-events: auto;
    }
    .drawer-shell.is-open .drawer-panel {
      opacity: 1;
      --drawer-scale: 1;
    }
    .drawer-shell.is-dragging .drawer-panel {
      transition: opacity 0.18s ease;
    }
  `;

  const shell = document.createElement("div");
  shell.className = "drawer-shell";
  shell.innerHTML = `
    <aside class="drawer-panel" role="dialog" aria-label="OfferU 功能弹窗" aria-modal="false">
      <iframe class="drawer-frame" title="OfferU Drawer" loading="eager" allow="clipboard-write"></iframe>
    </aside>
  `;

  const iframe = shell.querySelector("iframe") as HTMLIFrameElement;
  const panel = shell.querySelector(".drawer-panel") as HTMLElement;
  const PANEL_MARGIN = 10;
  let isOpen = false;
  let panelX = 0;
  let panelY = 0;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragOriginX = 0;
  let dragOriginY = 0;
  let pendingDragX = 0;
  let pendingDragY = 0;
  let dragRAF = 0;
  let dragging = false;
  let closeTimer = 0;

  function getPanelSize(): { width: number; height: number } {
    return {
      width: Math.max(280, Math.min(392, window.innerWidth - 12)),
      height: Math.max(360, Math.min(566, window.innerHeight - 12)),
    };
  }

  function clampPanelPosition(left: number, top: number): { left: number; top: number } {
    const size = getPanelSize();
    const maxLeft = Math.max(PANEL_MARGIN, window.innerWidth - size.width - PANEL_MARGIN);
    const maxTop = Math.max(PANEL_MARGIN, window.innerHeight - size.height - PANEL_MARGIN);
    return {
      left: Math.max(PANEL_MARGIN, Math.min(left, maxLeft)),
      top: Math.max(PANEL_MARGIN, Math.min(top, maxTop)),
    };
  }

  function applyPanelPosition(left = panelX, top = panelY): void {
    const next = clampPanelPosition(left, top);
    panelX = next.left;
    panelY = next.top;
    panel.style.setProperty("--drawer-x", `${panelX}px`);
    panel.style.setProperty("--drawer-y", `${panelY}px`);
  }

  function placePanelAtDefaultRight(): void {
    const size = getPanelSize();
    const defaultLeft = window.innerWidth - size.width - PANEL_MARGIN;
    const defaultTop = Math.round((window.innerHeight - size.height) / 2);
    applyPanelPosition(defaultLeft, defaultTop);
  }

  function ensurePanelVisible(): void {
    const rect = panel.getBoundingClientRect();
    const tooSmall = rect.width < 120 || rect.height < 120;
    const fullyOutside =
      rect.right < PANEL_MARGIN ||
      rect.left > window.innerWidth - PANEL_MARGIN ||
      rect.bottom < PANEL_MARGIN ||
      rect.top > window.innerHeight - PANEL_MARGIN;

    if (tooSmall || fullyOutside) {
      placePanelAtDefaultRight();
    }
  }

  function stopDragState(): void {
    if (dragRAF) {
      window.cancelAnimationFrame(dragRAF);
      dragRAF = 0;
    }
    dragging = false;
    shell.classList.remove("is-dragging");
  }

  function applyDragFrame(): void {
    dragRAF = 0;
    applyPanelPosition(pendingDragX, pendingDragY);
  }

  function startDrag(clientX: number, clientY: number): void {
    if (!isOpen) return;
    dragging = true;
    dragStartX = clientX;
    dragStartY = clientY;
    dragOriginX = panelX;
    dragOriginY = panelY;
    pendingDragX = panelX;
    pendingDragY = panelY;
    shell.classList.add("is-dragging");
  }

  function moveDrag(clientX: number, clientY: number): void {
    if (!dragging) return;
    pendingDragX = dragOriginX + (clientX - dragStartX);
    pendingDragY = dragOriginY + (clientY - dragStartY);

    if (!dragRAF) {
      dragRAF = window.requestAnimationFrame(applyDragFrame);
    }
  }

  function endDrag(clientX?: number, clientY?: number): void {
    if (!dragging) return;

    if (typeof clientX === "number" && typeof clientY === "number") {
      pendingDragX = dragOriginX + (clientX - dragStartX);
      pendingDragY = dragOriginY + (clientY - dragStartY);
      if (dragRAF) {
        window.cancelAnimationFrame(dragRAF);
        dragRAF = 0;
      }
      applyPanelPosition(pendingDragX, pendingDragY);
    }

    stopDragState();
  }

  const close = (): void => {
    if (!isOpen && !shell.classList.contains("is-visible")) return;

    isOpen = false;
    endDrag();
    shell.classList.remove("is-open");

    if (closeTimer) {
      window.clearTimeout(closeTimer);
      closeTimer = 0;
    }

    closeTimer = window.setTimeout(() => {
      if (isOpen) return;
      shell.classList.remove("is-visible");
    }, 190);
  };

  const open = (tab: DrawerTab): void => {
    const nextUrl = buildDrawerUrl(tab);
    if (iframe.getAttribute("src") !== nextUrl) {
      iframe.setAttribute("src", nextUrl);
    }

    if (closeTimer) {
      window.clearTimeout(closeTimer);
      closeTimer = 0;
    }

    shell.classList.add("is-visible");

    if (!isOpen) {
      placePanelAtDefaultRight();
    } else {
      applyPanelPosition(panelX, panelY);
    }

    isOpen = true;
    window.requestAnimationFrame(() => {
      if (!isOpen) return;
      shell.classList.add("is-open");
      ensurePanelVisible();
    });
  };

  const toggle = (tab: DrawerTab = "cart"): void => {
    if (isOpen) {
      close();
      return;
    }
    open(tab);
  };

  const isDrawerOpen = (): boolean => isOpen;

  window.addEventListener("message", (event) => {
    if (!isOpen) return;
    if (event.source !== iframe.contentWindow) return;
    const data = event.data as {
      type?: string;
      clientX?: number;
      clientY?: number;
      screenX?: number;
      screenY?: number;
      reason?: string;
      requestId?: string;
    } | null;
    const dragX = typeof data?.screenX === "number" ? data.screenX : data?.clientX;
    const dragY = typeof data?.screenY === "number" ? data.screenY : data?.clientY;

    if (data?.type === "offeru:drawer-focus-request") {
      try {
        window.focus();
      } catch {
        // ignore focus failures and continue with best-effort iframe focus
      }

      try {
        iframe.focus();
      } catch {
        // ignore iframe focus failures
      }

      iframe.contentWindow?.postMessage(
        {
          type: "offeru:drawer-focus-ack",
          requestId: data.requestId,
        },
        "*",
      );
      return;
    }

    if (data?.type === "offeru:drawer-close") {
      if (data.reason === DRAWER_CLOSE_REASON_BUTTON) {
        close();
      }
      return;
    }

    if (data?.type === "offeru:drawer-drag-start") {
      if (typeof dragX === "number" && typeof dragY === "number") {
        startDrag(dragX, dragY);
      }
      return;
    }

    if (data?.type === "offeru:drawer-drag-move") {
      if (typeof dragX === "number" && typeof dragY === "number") {
        moveDrag(dragX, dragY);
      }
      return;
    }

    if (data?.type === "offeru:drawer-drag-end") {
      endDrag(dragX, dragY);
    }
  });

  window.addEventListener("resize", () => {
    if (!isOpen) return;
    applyPanelPosition(panelX, panelY);
  });

  document.addEventListener(
    "keydown",
    (event) => {
      if (!isOpen) return;
      if (event.key === "Escape") {
        close();
      }
    },
    true,
  );

  root.appendChild(style);
  root.appendChild(shell);
  (document.body || document.documentElement).appendChild(host);

  drawerController = { open, close, toggle, isOpen: isDrawerOpen };
  return drawerController;
}

function openDrawer(tab: DrawerTab): void {
  try {
    ensurePageDrawer().open(tab);
  } catch {
    chrome.runtime.sendMessage({ type: "OPEN_DRAWER", tab }, (resp: { ok?: boolean }) => {
      if (chrome.runtime.lastError || !resp?.ok) {
        showToast("打开抽屉失败，请重试", true);
      }
    });
  }
}

function toggleDrawer(tab: DrawerTab = "cart"): void {
  try {
    ensurePageDrawer().toggle(tab);
  } catch {
    openDrawer(tab);
  }
}

function openSettingsPage(): void {
  openDrawer("settings");
}

function triggerSyncToServer(onDone?: () => void): void {
  chrome.runtime.sendMessage(
    { type: "SYNC_TO_SERVER" },
    (resp: { ok: boolean; synced: number; skippedDraft: number; error?: string }) => {
      if (chrome.runtime.lastError) {
        showToast("同步失败，请稍后重试", true);
        onDone?.();
        return;
      }

      if (resp?.ok) {
        showToast(`已同步 ${resp.synced} 条岗位`);
      } else {
        showToast(resp?.error || "同步失败", true);
      }
      onDone?.();
    },
  );
}

function normalizeShortcutKey(key: string): string {
  const lowered = key.trim().toLowerCase();
  if (lowered === " ") return "Space";
  if (lowered === "escape") return "Esc";
  if (lowered === "arrowup") return "Up";
  if (lowered === "arrowdown") return "Down";
  if (lowered === "arrowleft") return "Left";
  if (lowered === "arrowright") return "Right";
  if (lowered.length === 1) return lowered.toUpperCase();
  if (/^f\d{1,2}$/.test(lowered)) return lowered.toUpperCase();
  return key.trim();
}

function normalizeShortcutString(raw: string): string {
  if (!raw) return "";
  const parts = raw
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);

  const modifierSet = new Set<string>();
  let keyPart = "";

  for (const part of parts) {
    const lowered = part.toLowerCase();
    if (lowered === "ctrl" || lowered === "control") {
      modifierSet.add("Ctrl");
      continue;
    }
    if (lowered === "alt" || lowered === "option") {
      modifierSet.add("Alt");
      continue;
    }
    if (lowered === "shift") {
      modifierSet.add("Shift");
      continue;
    }
    if (lowered === "meta" || lowered === "cmd" || lowered === "command") {
      modifierSet.add("Meta");
      continue;
    }
    keyPart = normalizeShortcutKey(part);
  }

  if (!keyPart) return "";

  const ordered: string[] = [];
  if (modifierSet.has("Ctrl")) ordered.push("Ctrl");
  if (modifierSet.has("Alt")) ordered.push("Alt");
  if (modifierSet.has("Shift")) ordered.push("Shift");
  if (modifierSet.has("Meta")) ordered.push("Meta");
  ordered.push(keyPart);
  return ordered.join("+");
}

function eventToShortcut(event: KeyboardEvent): string {
  const modifierOnlyKeys = ["Control", "Shift", "Alt", "Meta"];
  if (modifierOnlyKeys.includes(event.key)) return "";

  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Meta");

  parts.push(normalizeShortcutKey(event.key));
  return normalizeShortcutString(parts.join("+"));
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function createFloatingDock(platform: PlatformConfig | null): void {
  if (document.getElementById(FLOATING_DOCK_ID)) return;

  const host = document.createElement("div");
  host.id = FLOATING_DOCK_ID;
  host.style.position = "fixed";
  host.style.zIndex = "2147483645";
  host.style.top = `${Math.round(window.innerHeight * 0.38)}px`;
  host.style.right = "0px";
  host.style.left = "auto";
  const motionCurve = "cubic-bezier(0.22, 1, 0.36, 1)";
  const hostTransition = `transform 0.22s ${motionCurve}, top 0.18s ${motionCurve}, left 0.18s ${motionCurve}, right 0.18s ${motionCurve}`;
  host.style.transition = hostTransition;
  host.style.willChange = "transform";

  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    .dock {
      font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif;
      user-select: none;
      -webkit-user-select: none;
      touch-action: none;
      position: relative;
      width: fit-content;
      --motion: cubic-bezier(0.22, 1, 0.36, 1);
    }
    .compact {
      all: initial;
      font-family: inherit;
      border: 1px solid #dbe2ea;
      border-radius: 999px;
      background: #fffffff2;
      color: #111827;
      width: ${DOCK_COMPACT_WIDTH}px;
      height: ${DOCK_COMPACT_HEIGHT}px;
      padding: 0 12px;
      box-shadow: 0 8px 18px rgba(15, 23, 42, 0.18);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: width 0.22s var(--motion), height 0.22s var(--motion), padding 0.22s var(--motion), border-radius 0.22s var(--motion), box-shadow 0.22s var(--motion), background 0.22s var(--motion), backdrop-filter 0.22s var(--motion), opacity 0.18s var(--motion);
    }
    .dock.is-muted .compact {
      filter: grayscale(0.92);
      opacity: 0.64;
    }
    .compact:focus-visible {
      outline: 2px solid #2563eb;
      outline-offset: 2px;
    }
    .compact-inner {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .compact-main {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .brand {
      font-size: 16px;
      font-weight: 700;
      color: #0057be;
      line-height: 1;
    }
    .badge {
      min-width: 17px;
      height: 17px;
      border-radius: 999px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: #e53935;
      color: #fff;
      font-size: 10px;
      font-weight: 700;
      padding: 0 4px;
      line-height: 1;
    }
    .compact-actions {
      margin-left: auto;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .mini-btn {
      all: initial;
      width: 28px;
      height: 28px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      background: transparent;
      border: none;
    }
    .mini-btn:hover {
      opacity: 0.72;
    }
    .mini-icon {
      font-size: 10px;
      line-height: 1;
      color: #1b1b1e;
    }
    .mini-icon-arrow {
      width: 22px;
      height: 22px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2.2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .mini-icon-chevron {
      width: 22px;
      height: 22px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2.2;
      stroke-linecap: round;
      stroke-linejoin: round;
      transition: transform 0.18s var(--motion);
    }
    .mini-icon-chevron.is-open {
      transform: rotate(180deg);
    }
    .panel {
      position: absolute;
      top: calc(100% + 6px);
      width: ${DOCK_PANEL_WIDTH}px;
      min-height: ${DOCK_PANEL_HEIGHT}px;
      border: 1px solid #ffffff;
      border-radius: 20px;
      background: #ffffffe6;
      backdrop-filter: blur(10px);
      box-shadow: 0 12px 28px rgba(2, 6, 23, 0.14);
      padding: 10px;
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      transform: translateY(-10px) scale(0.94);
      transition: opacity 0.22s var(--motion), transform 0.22s var(--motion), visibility 0.22s linear;
    }
    .panel.show {
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
      transform: translateY(0) scale(1);
    }
    .actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .action-btn {
      all: initial;
      font-family: inherit;
      border-radius: 16px;
      height: 44px;
      padding: 0 10px;
      font-size: 12px;
      font-weight: 700;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      border: 1px solid transparent;
      background: #f2eff4;
      color: #374151;
      line-height: 1;
    }
    .action-btn.primary {
      background: linear-gradient(135deg, #0f66e9, #1f88ff);
      border-color: #0f66e9;
      color: #ffffff;
    }
    .smart-fill-card {
      margin-top: 8px;
      display: grid;
      gap: 6px;
    }
    .smart-fill-btn {
      all: initial;
      font-family: inherit;
      border-radius: 14px;
      min-height: 44px;
      box-sizing: border-box;
      padding: 8px 10px;
      font-size: 12px;
      font-weight: 700;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      border: 1px solid #1f88ff;
      background: linear-gradient(135deg, #0f66e9, #1f88ff);
      color: #ffffff;
      line-height: 1.2;
      text-align: center;
      transition: transform 0.18s var(--motion), opacity 0.18s var(--motion);
    }
    .smart-fill-btn[disabled] {
      opacity: 0.7;
      cursor: default;
    }
    .smart-fill-btn.is-busy {
      animation: offeruSmartFillBreath 1.15s ease-in-out infinite;
    }
    .smart-fill-link {
      all: initial;
      font-family: inherit;
      cursor: pointer;
      color: #0f66e9;
      font-size: 11px;
      font-weight: 600;
      text-align: center;
      line-height: 1.2;
    }
    .smart-fill-nav {
      margin-top: 2px;
      display: grid;
      grid-template-columns: auto 1fr auto auto auto;
      gap: 6px;
      align-items: center;
      font-size: 11px;
      color: #4b5563;
    }
    .smart-fill-nav.hidden,
    .smart-fill-link.hidden {
      display: none;
    }
    .smart-fill-nav button {
      all: initial;
      font-family: inherit;
      cursor: pointer;
      border-radius: 8px;
      border: 1px solid #d1d5db;
      padding: 2px 6px;
      font-size: 11px;
      color: #374151;
      background: #fff;
      text-align: center;
      min-width: 20px;
    }
    .smart-fill-nav button.exit {
      min-width: auto;
      padding: 2px 8px;
    }
    .smart-fill-checklist {
      margin-top: 6px;
      border: 1px solid #e5e7eb;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.72);
      max-height: 132px;
      overflow: auto;
      padding: 4px;
      display: grid;
      gap: 4px;
    }
    .smart-fill-checklist.hidden {
      display: none;
    }
    .smart-fill-checklist-item {
      all: initial;
      font-family: inherit;
      cursor: pointer;
      display: block;
      border: 1px solid #fecaca;
      border-radius: 8px;
      background: #fff5f5;
      color: #991b1b;
      padding: 5px 7px;
      font-size: 11px;
      line-height: 1.25;
    }
    .smart-fill-checklist-item[data-resolved="false"] {
      border-color: #fca5a5;
      background: #fef2f2;
      color: #b91c1c;
    }
    .smart-fill-checklist-item .tag {
      font-size: 10px;
      margin-left: 4px;
      color: #dc2626;
    }
    @keyframes offeruSmartFillBreath {
      0% { opacity: 0.72; transform: scale(0.995); }
      50% { opacity: 1; transform: scale(1); }
      100% { opacity: 0.72; transform: scale(0.995); }
    }
    .meta {
      margin-top: 8px;
      font-size: 11px;
      color: #6b7280;
      text-align: left;
      line-height: 1.3;
    }
    .meta.meta-secondary {
      margin-top: 4px;
      color: #4b5563;
    }
    .meta.meta-secondary.ok {
      color: #15803d;
    }
    .meta.meta-secondary.warn {
      color: #b45309;
    }
    .dock.theme-dark .compact {
      border-color: #3f3f46;
      background: #27272a;
      color: #f9fafb;
      box-shadow: 0 6px 14px rgba(0, 0, 0, 0.4);
    }
    .dock.theme-dark .brand {
      color: #006fee;
    }
    .dock.theme-dark .mini-btn {
      background: transparent;
      border: none;
    }
    .dock.theme-dark .mini-btn:hover {
      opacity: 0.72;
    }
    .dock.theme-dark .mini-icon {
      color: #a1a1aa;
    }
    .dock.theme-dark .panel {
      border-color: #3f3f46;
      background: #27272a;
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.42);
    }
    .dock.theme-dark .action-btn {
      border-color: transparent;
      background: #3f3f46;
      color: #e5e7eb;
    }
    .dock.theme-dark .action-btn.primary {
      background: linear-gradient(135deg, #1d4ed8, #2563eb);
      border-color: #2563eb;
      color: #ffffff;
    }
    .dock.theme-dark .smart-fill-btn {
      border-color: #2563eb;
      background: linear-gradient(135deg, #1d4ed8, #2563eb);
      color: #ffffff;
    }
    .dock.theme-dark .smart-fill-link {
      color: #93c5fd;
    }
    .dock.theme-dark .smart-fill-nav {
      color: #9ca3af;
    }
    .dock.theme-dark .smart-fill-nav button {
      border-color: #52525b;
      background: #3f3f46;
      color: #e5e7eb;
    }
    .dock.theme-dark .smart-fill-checklist {
      border-color: #52525b;
      background: rgba(39, 39, 42, 0.65);
    }
    .dock.theme-dark .smart-fill-checklist-item {
      border-color: #7f1d1d;
      background: #450a0a;
      color: #fecaca;
    }
    .dock.theme-dark .smart-fill-checklist-item[data-resolved="false"] {
      border-color: #b91c1c;
      background: #3f0a0a;
      color: #fca5a5;
    }
    .dock.theme-dark .meta {
      color: #9ca3af;
    }
    .dock.theme-dark .meta.meta-secondary {
      color: #9ca3af;
    }
    .dock.theme-dark .meta.meta-secondary.ok {
      color: #4ade80;
    }
    .dock.theme-dark .meta.meta-secondary.warn {
      color: #fbbf24;
    }
    .dock.mode-edge .compact {
      padding: 0 10px;
      background: #ffffff;
      border-color: #ffffff;
      box-shadow: 0 6px 14px rgba(2, 6, 23, 0.14);
      opacity: 1;
    }
    .dock.mode-edge.side-left .compact,
    .dock.mode-edge.side-right .compact {
      width: ${EDGE_DOCK_SIDE_WIDTH}px;
      min-width: ${EDGE_DOCK_SIDE_WIDTH}px;
      max-width: ${EDGE_DOCK_SIDE_WIDTH}px;
      height: ${EDGE_DOCK_SIDE_HEIGHT}px;
      min-height: ${EDGE_DOCK_SIDE_HEIGHT}px;
      max-height: ${EDGE_DOCK_SIDE_HEIGHT}px;
    }
    .dock.mode-edge.side-top .compact,
    .dock.mode-edge.side-bottom .compact {
      width: ${EDGE_DOCK_TOP_BOTTOM_WIDTH}px;
      min-width: ${EDGE_DOCK_TOP_BOTTOM_WIDTH}px;
      max-width: ${EDGE_DOCK_TOP_BOTTOM_WIDTH}px;
      height: ${EDGE_DOCK_TOP_BOTTOM_HEIGHT}px;
      min-height: ${EDGE_DOCK_TOP_BOTTOM_HEIGHT}px;
      max-height: ${EDGE_DOCK_TOP_BOTTOM_HEIGHT}px;
    }
    .dock.mode-edge.side-right .compact {
      border-radius: 999px 0 0 999px;
      border-right: 0;
    }
    .dock.mode-edge.side-left .compact {
      border-radius: 0 999px 999px 0;
      border-left: 0;
    }
    .dock.mode-edge.side-top .compact {
      border-radius: 0 0 ${EDGE_DOCK_TOP_BOTTOM_RADIUS}px ${EDGE_DOCK_TOP_BOTTOM_RADIUS}px;
      border-top: 0;
    }
    .dock.mode-edge.side-bottom .compact {
      border-radius: ${EDGE_DOCK_TOP_BOTTOM_RADIUS}px ${EDGE_DOCK_TOP_BOTTOM_RADIUS}px 0 0;
      border-bottom: 0;
    }
    .dock.mode-edge .compact-main {
      width: 100%;
      justify-content: center;
    }
    .dock.mode-edge .badge,
    .dock.mode-edge .compact-actions {
      display: none;
    }
    .dock.mode-edge .brand {
      font-size: 16px;
      color: #0057be;
    }
    .dock.mode-edge:hover .compact,
    .dock.mode-edge.mode-dragging .compact {
      opacity: 1;
    }
    .dock.theme-dark.mode-edge .compact {
      background: #1f1f23;
      border-color: #3f3f46;
      box-shadow: 0 6px 14px rgba(0, 0, 0, 0.42);
    }
    .dock.theme-dark.mode-edge .brand {
      color: #006fee;
    }
    .dock.mode-edge.side-left .compact-inner,
    .dock.mode-edge.side-right .compact-inner,
    .dock.mode-edge.side-top .compact-inner,
    .dock.mode-edge.side-bottom .compact-inner {
      flex-direction: row;
    }
    .dock.side-left .compact-inner {
      flex-direction: row-reverse;
    }
    .dock.side-left .compact-actions {
      margin-left: 0;
      margin-right: auto;
    }
    .dock.side-right .compact-inner {
      flex-direction: row;
    }
    .dock.side-right .compact-actions {
      margin-left: auto;
      margin-right: 0;
    }
    .dock.mode-expanded .compact {
      width: ${DOCK_EXPANDED_WIDTH}px;
      height: ${DOCK_EXPANDED_HEIGHT}px;
      border-radius: 999px;
      box-shadow: 0 10px 22px rgba(15, 23, 42, 0.24);
    }
    .dock.mode-dragging .compact {
      cursor: grabbing;
      box-shadow: 0 12px 30px rgba(15, 23, 42, 0.26);
    }
    .dock.side-left .panel {
      left: 0;
      right: auto;
      transform-origin: left top;
    }
    .dock.side-right .panel {
      right: 0;
      left: auto;
      transform-origin: right top;
    }
    .dock.side-top .panel,
    .dock.side-bottom .panel {
      left: 0;
      right: auto;
      transform-origin: left top;
    }
    .dock.side-bottom .panel {
      top: auto;
      bottom: calc(100% + 16px);
      transform-origin: left bottom;
      transform: translateY(10px) scale(0.94);
    }
  `;

  const wrap = document.createElement("div");
  wrap.className = "dock side-right";

  const compactBtn = document.createElement("div");
  compactBtn.className = "compact";
  compactBtn.setAttribute("role", "button");
  compactBtn.setAttribute("tabindex", "0");
  compactBtn.setAttribute("aria-label", "OfferU 悬浮入口");
  compactBtn.setAttribute("aria-expanded", "false");
  compactBtn.innerHTML = `
    <span class="compact-inner">
      <span class="compact-main">
        <span class="brand">OfferU</span>
        <span class="badge" id="offeruFloatingBadge">0</span>
      </span>
      <span class="compact-actions">
        <button class="mini-btn" type="button" data-action="open-drawer" aria-label="打开功能弹窗">
          <svg class="mini-icon mini-icon-arrow" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 16L16 8" />
            <path d="M10 8H16V14" />
          </svg>
        </button>
        <button class="mini-btn" type="button" data-action="toggle-panel" aria-label="展开面板">
          <svg class="mini-icon mini-icon-chevron" id="offeruFloatingToggleGlyph" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 9L12 15L18 9" />
          </svg>
        </button>
      </span>
    </span>
  `;

  wrap.appendChild(compactBtn);
  root.appendChild(style);
  root.appendChild(wrap);

  const badgeEl = root.querySelector("#offeruFloatingBadge") as HTMLSpanElement | null;
  const toggleGlyphEl = root.querySelector("#offeruFloatingToggleGlyph") as HTMLElement | null;
  const pendingHighlighter = new PendingFieldHighlighter();

  let panel: HTMLDivElement | null = null;
  let panelController: AbortController | null = null;
  let metaEl: HTMLDivElement | null = null;
  let collectabilityEl: HTMLDivElement | null = null;
  let smartFillBtnEl: HTMLButtonElement | null = null;
  let smartFillLinkEl: HTMLButtonElement | null = null;
  let smartFillNavEl: HTMLDivElement | null = null;
  let smartFillNavIndexEl: HTMLSpanElement | null = null;
  let smartFillChecklistEl: HTMLDivElement | null = null;
  let latestMetaText = "草稿 0 条 | 可同步 0 条";
  let latestCollectabilityText = "当前页面：检测中";
  let latestCollectabilityTone: "ok" | "warn" = "warn";
  let smartFillBusy = false;
  let smartFillFilledCount = 0;
  let smartFillPendingCount = 0;
  let smartFillStatus: "idle" | "running" | "preview" | "success" | "partial" | "failed" = "idle";
  let smartFillStatusText = "一键智填";
  let smartFillSubText = "";
  let smartFillResetTimer: number | null = null;
  let smartFillLastRunAt = 0;
  let smartFillRunToken = 0;
  let smartFillRunActive = false;
  let smartFillAbortController: AbortController | null = null;
  let smartFillPlan: CriticalSmartFillPlan | null = null;
  let smartFillPreviewMode = false;
  let smartFillChecklistData: Array<{ fieldId: string; title: string; resolved: boolean; reason: string }> = [];

  let expanded = false;
  let edgeDocked = false;
  let side: DockSide = "right";
  let hovering = false;
  let themePreference: UiTheme = "system";
  let shortcutSettings: ShortcutSettings = { ...DEFAULT_SHORTCUT_SETTINGS };

  const darkMedia = window.matchMedia("(prefers-color-scheme: dark)");

  let pointerActive = false;
  let activePointerId: number | null = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragOriginX = 0;
  let dragOriginY = 0;
  let pendingDx = 0;
  let pendingDy = 0;
  let dragRAF = 0;
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  let dragDistance = 0;
  let dragging = false;
  let pendingUndockFromEdge = false;
  let saveTimer: number | null = null;

  function clampTop(top: number): number {
    const rect = host.getBoundingClientRect();
    const edgeHeight = (side === "left" || side === "right")
      ? EDGE_DOCK_SIDE_HEIGHT
      : EDGE_DOCK_TOP_BOTTOM_HEIGHT;
    const baseHeight = edgeDocked ? edgeHeight : DOCK_EXPANDED_HEIGHT;
    const dockHeight = Math.max(baseHeight, rect.height || baseHeight);
    const maxTop = Math.max(6, window.innerHeight - dockHeight - 6);
    return Math.max(6, Math.min(top, maxTop));
  }

  function clampLeft(left: number): number {
    const rect = host.getBoundingClientRect();
    const edgeWidth = (side === "left" || side === "right")
      ? EDGE_DOCK_SIDE_WIDTH
      : EDGE_DOCK_TOP_BOTTOM_WIDTH;
    const baseWidth = edgeDocked ? edgeWidth : DOCK_EXPANDED_WIDTH;
    const dockWidth = Math.max(baseWidth, rect.width || baseWidth);
    const maxLeft = Math.max(0, window.innerWidth - dockWidth);
    return Math.max(0, Math.min(left, maxLeft));
  }

  function readCurrentTop(): number {
    const parsed = Number.parseFloat(host.style.top || "0");
    return Number.isFinite(parsed) ? parsed : 8;
  }

  function readCurrentLeft(): number {
    const parsed = Number.parseFloat(host.style.left || "");
    if (Number.isFinite(parsed)) {
      return parsed;
    }
    return host.getBoundingClientRect().left;
  }

  function getDefaultUndockedLeft(): number {
    return window.innerWidth - (DOCK_EXPANDED_WIDTH + DOCK_RIGHT_GAP);
  }

  function resolveThemeValue(preference: UiTheme): "light" | "dark" {
    if (preference === "system") {
      return darkMedia.matches ? "dark" : "light";
    }
    return preference;
  }

  function applyDockTheme(): void {
    const resolved = resolveThemeValue(themePreference);
    wrap.classList.toggle("theme-dark", resolved === "dark");
  }

  function resolvePageCollectability(currentPlatform: PlatformConfig | null): {
    text: string;
    tone: "ok" | "warn";
  } {
    if (!currentPlatform) {
      return {
        text: "当前页面：暂不支持采集",
        tone: "warn",
      };
    }

    const currentJob = resolveCollectJob(currentPlatform);
    if (currentJob) {
      if (currentJob.status === "ready_to_sync" || Boolean(currentJob.raw_description?.trim())) {
        return {
          text: "当前页面：可添加岗位（可同步）",
          tone: "ok",
        };
      }

      return {
        text: "当前页面：可添加岗位（需补全JD）",
        tone: "ok",
      };
    }

    if (isListPage(currentPlatform) || isDetailPage(currentPlatform)) {
      return {
        text: "当前页面：未识别到可添加岗位",
        tone: "warn",
      };
    }

    return {
      text: "当前页面：非岗位页",
      tone: "warn",
    };
  }

  function resolveSmartFillCollectability(currentPlatform: PlatformConfig | null): {
    text: string;
    tone: "ok" | "warn";
  } {
    const fieldCount = scanFieldsSync(document).length;
    if (fieldCount > 0) {
      return {
        text: "当前页面：支持智填",
        tone: "ok",
      };
    }

    if (!currentPlatform) {
      return {
        text: "当前页面：未检测到可填写表单",
        tone: "warn",
      };
    }

    const collectability = resolvePageCollectability(currentPlatform);
    if (collectability.tone === "ok") {
      return {
        text: "当前页面：可采集但未检测到可填写表单",
        tone: "warn",
      };
    }
    return collectability;
  }

  function syncPanelSummaryText(): void {
    if (metaEl) {
      metaEl.textContent = latestMetaText;
    }

    if (collectabilityEl) {
      collectabilityEl.textContent = latestCollectabilityText;
      collectabilityEl.classList.toggle("ok", latestCollectabilityTone === "ok");
      collectabilityEl.classList.toggle("warn", latestCollectabilityTone === "warn");
    }
  }

  function clearSmartFillResetTimer(): void {
    if (smartFillResetTimer !== null) {
      window.clearTimeout(smartFillResetTimer);
      smartFillResetTimer = null;
    }
  }

  function syncSmartFillNavigationText(): void {
    if (!smartFillNavIndexEl) return;
    if (smartFillPendingCount <= 0) {
      smartFillNavIndexEl.textContent = "0/0";
      return;
    }
    smartFillNavIndexEl.textContent = `${pendingHighlighter.currentIndex()}/${smartFillPendingCount}`;
  }

  function buildChecklistTitle(field: ScannedField): string {
    const label = (field.semanticLabel || field.label || "未命名字段").trim();
    const moduleName = (field.moduleName || "").trim();
    if (!moduleName) return label;
    return `${moduleName} / ${label}`;
  }

  function resolveChecklistReason(field: ScannedField): string {
    const reason = field.runtime?.failureReason || "no_match";
    // Distinguish: AI/rule match failure vs write success failure
    switch (reason) {
      case "no_match": return "档案中无匹配数据";
      case "write_failed": return "已匹配但写入失败";
      case "write_blocked": return "控件不可写或只读";
      case "existing_value": return "已保护网页中的现有值";
      case "verify_failed": return "写入后未通过校验";
      case "control_not_supported": return "复杂控件待手动补充";
      case "validation_error": return "页面校验未通过";
      case "aborted": return "操作已中止";
      case "not_found": return "控件已从页面移除";
      default: return "待手动确认";
    }
  }

  function buildChecklistDataFromHighlighter(): Array<{ fieldId: string; title: string; resolved: boolean; reason: string }> {
    return pendingHighlighter
      .checklist()
      .map(({ field, resolved }) => ({
        fieldId: field.fieldId,
        title: buildChecklistTitle(field),
        resolved,
        reason: resolveChecklistReason(field),
      }));
  }

  function renderSmartFillChecklist(): void {
    if (!smartFillChecklistEl) return;
    const show = smartFillChecklistData.length > 0 && (smartFillPendingCount > 0 || smartFillPreviewMode);
    smartFillChecklistEl.classList.toggle("hidden", !show);
    if (!show) {
      smartFillChecklistEl.innerHTML = "";
      return;
    }

    smartFillChecklistEl.innerHTML = smartFillChecklistData
      .map((item, index) => {
        const safeTitle = item.title
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        const safeReason = item.reason
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        const unresolvedTag = item.resolved ? "" : `<span class="tag">待定位</span>`;
        return `<button class="smart-fill-checklist-item" data-action="smart-fill-focus-item" data-field-id="${item.fieldId}" data-resolved="${item.resolved ? "true" : "false"}">#${index + 1} ${safeTitle}${unresolvedTag}<br/>${safeReason}</button>`;
      })
      .join("");
  }

  function updateSmartFillUi(): void {
    if (!smartFillBtnEl) return;

    smartFillBtnEl.disabled = smartFillBusy;
    smartFillBtnEl.classList.toggle("is-busy", smartFillBusy);
    smartFillBtnEl.textContent = smartFillBusy
      ? `⏸ ${smartFillStatusText}`
      : smartFillStatusText;

    if (smartFillLinkEl) {
      const showLink = (smartFillPreviewMode && !smartFillBusy) || smartFillPendingCount > 0;
      smartFillLinkEl.classList.toggle("hidden", !showLink);
      smartFillLinkEl.dataset.action = smartFillPreviewMode
        ? "smart-fill-cancel-preview"
        : "smart-fill-focus";
      smartFillLinkEl.textContent = smartFillPreviewMode
        ? "取消本次填写"
        : (smartFillSubText || "查看待补字段 ›");
    }

    if (smartFillNavEl) {
      const showNav = !smartFillPreviewMode && smartFillPendingCount > 0;
      smartFillNavEl.classList.toggle("hidden", !showNav);
      syncSmartFillNavigationText();
    }
    renderSmartFillChecklist();
  }

  function resetSmartFillState(): void {
    clearSmartFillResetTimer();
    smartFillBusy = false;
    smartFillFilledCount = 0;
    smartFillPendingCount = 0;
    smartFillStatus = "idle";
    smartFillStatusText = "一键智填";
    smartFillSubText = "";
    smartFillPlan = null;
    smartFillPreviewMode = false;
    smartFillChecklistData = [];
    pendingHighlighter.clear();
    updateSmartFillUi();
  }

  async function runSmartFillFlow(): Promise<void> {
    if (smartFillBusy && smartFillAbortController) {
      smartFillAbortController.abort();
      smartFillAbortController = null;
      smartFillBusy = false;
      smartFillRunActive = false;
      smartFillStatus = "idle";
      smartFillStatusText = "已暂停";
      smartFillSubText = "";
      updateSmartFillUi();
      return;
    }

    const now = Date.now();
    if (smartFillBusy || smartFillRunActive) return;
    if (now - smartFillLastRunAt < 800) return;
    smartFillRunToken += 1;
    const runToken = smartFillRunToken;
    smartFillRunActive = true;
    smartFillLastRunAt = now;
    clearSmartFillResetTimer();

    smartFillBusy = true;
    smartFillFilledCount = 0;
    smartFillPendingCount = 0;
    smartFillChecklistData = [];
    pendingHighlighter.clear();
    smartFillStatus = "running";
    smartFillStatusText = "正在识别页面";
    smartFillSubText = "";
    updateSmartFillUi();

    const slowHintTimer = window.setTimeout(() => {
      if (!smartFillBusy) return;
      smartFillStatusText = "AI 正在分析页面，请稍候…";
      updateSmartFillUi();
    }, 18000);

    smartFillAbortController = new AbortController();

    try {
      const progressHandler = (progress: { detail: string }) => {
        if (runToken !== smartFillRunToken) return;
        smartFillStatusText = progress.detail;
        updateSmartFillUi();
      };

      if (!smartFillPlan) {
        const plan = await prepareCriticalSmartFillPlan({
          signal: smartFillAbortController.signal,
          onProgress: progressHandler,
        });
        if (runToken !== smartFillRunToken) return;
        if (plan.items.length === 0) {
          smartFillStatus = "failed";
          smartFillStatusText = "没有可安全填写的关键字段";
          const existingCount = plan.skipped.filter((item) => item.reason === "existing_value").length;
          smartFillSubText = existingCount > 0
            ? `已保护 ${existingCount} 个网页现有值`
            : "敏感、低置信或非关键字段已跳过";
          smartFillChecklistData = [];
          smartFillPreviewMode = false;
          return;
        }
        smartFillPlan = plan;
        smartFillPreviewMode = true;
        smartFillStatus = "preview";
        smartFillStatusText = `确认填写 ${plan.items.length} 项`;
        const protectedCount = plan.skipped.filter((item) => (
          item.reason === "existing_value" || item.reason === "sensitive"
        )).length;
        smartFillSubText = protectedCount > 0 ? `已保护或跳过 ${protectedCount} 项` : "不会自动提交";
        smartFillChecklistData = plan.items.map((item) => ({
          fieldId: item.field.fieldId,
          title: buildChecklistTitle(item.field),
          resolved: true,
          reason: `将填写：${item.valuePreview}`,
        }));
        return;
      }

      const planToApply = smartFillPlan;
      const result = await applyCriticalSmartFillPlan(planToApply, {
        signal: smartFillAbortController.signal,
        onProgress: progressHandler,
      });
      smartFillPlan = null;
      smartFillPreviewMode = false;

      if (runToken !== smartFillRunToken) return;
      const { outcome } = result;

      smartFillFilledCount = outcome.filledCount;
      smartFillPendingCount = outcome.pendingCount;

      if (result.fields.length === 0) {
        smartFillStatus = "failed";
        smartFillStatusText = "未检测到表单";
        smartFillSubText = "当前页面暂无可填写内容";
        smartFillChecklistData = [];
        pendingHighlighter.clear();
        return;
      }

      if (outcome.pendingCount <= 0) {
        smartFillStatus = "success";
        smartFillStatusText = outcome.skippedCount > 0
          ? `已填写 ${outcome.filledCount} 项｜跳过 ${outcome.skippedCount} 项`
          : `已填写 ${outcome.filledCount} 项`;
        smartFillSubText = outcome.protectedCount > 0
          ? `已保护 ${outcome.protectedCount} 项，页面不会自动提交`
          : "已完成本页智填，不会自动提交";
        smartFillChecklistData = [];
        pendingHighlighter.clear();
        smartFillResetTimer = window.setTimeout(() => {
          resetSmartFillState();
        }, 2000);
        return;
      }

      smartFillStatus = "partial";
      smartFillStatusText = outcome.aiUsed
        ? `已填 ${outcome.filledCount} 项｜待补 ${outcome.pendingCount} 项`
        : `已用规则智填｜待补 ${outcome.pendingCount} 项`;
      smartFillSubText = "查看待补字段 ›";
      pendingHighlighter.setPending(outcome.pendingFields);
      smartFillChecklistData = buildChecklistDataFromHighlighter();
      const unresolvedCount = pendingHighlighter.unresolvedCount();
      const highlightedCount = pendingHighlighter.size();
      smartFillPendingCount = outcome.pendingCount;
      if (smartFillPendingCount <= 0 && highlightedCount > 0) {
        smartFillPendingCount = highlightedCount;
      }
      if (smartFillPendingCount <= 0) {
        smartFillStatus = "success";
        smartFillStatusText = `已填写 ${outcome.filledCount} 项`;
        smartFillSubText = "已完成本页智填";
        smartFillChecklistData = [];
        pendingHighlighter.clear();
        smartFillResetTimer = window.setTimeout(() => {
          resetSmartFillState();
        }, 2000);
        return;
      }
      const suffix = unresolvedCount > 0 ? `（其中 ${unresolvedCount} 项待定位）` : "";
      smartFillStatusText = outcome.aiUsed
        ? `已填 ${outcome.filledCount} 项｜待补 ${smartFillPendingCount} 项${suffix}`
        : `已用规则智填｜待补 ${smartFillPendingCount} 项${suffix}`;
      if (highlightedCount > 0) {
        pendingHighlighter.focusFirst();
      }
    } catch (error: unknown) {
      if (runToken !== smartFillRunToken) return;
      smartFillStatus = "failed";
      const text = safeExtensionError(error, "请求失败");
      if (smartFillPendingCount > 0) {
        smartFillSubText = "查看待补字段 ›";
      } else {
        pendingHighlighter.clear();
        smartFillPendingCount = 0;
        smartFillChecklistData = [];
      }
      if (/档案|profile/i.test(text)) {
        smartFillStatusText = "未读取到档案";
        smartFillSubText = "请检查 OfferU 后端连接";
      } else if (/超时/i.test(text)) {
        smartFillStatusText = "智填超时，请重试";
        smartFillSubText = "";
      } else if (/fetch|网络|连接失败|Failed to fetch/i.test(text)) {
        smartFillStatusText = "AI 服务调用失败";
        smartFillSubText = "请检查网络或 AI 配置";
      } else if (/页面已变化|计划已过期/i.test(text)) {
        smartFillPlan = null;
        smartFillPreviewMode = false;
        smartFillStatusText = "页面已变化，请重新扫描";
        smartFillSubText = "";
      } else if (/Failed to set|Permission denied|read.only/i.test(text)) {
        smartFillStatusText = "部分字段写入失败";
        smartFillSubText = smartFillPendingCount > 0 ? "查看待补字段 ›" : "";
      } else {
        smartFillStatusText = "部分字段未写入";
        smartFillSubText = smartFillPendingCount > 0 ? "查看待补字段 ›" : "";
      }
    } finally {
      smartFillAbortController = null;
      if (runToken === smartFillRunToken) {
        smartFillRunActive = false;
      }
      smartFillBusy = false;
      window.clearTimeout(slowHintTimer);
      updateSmartFillUi();
      void refreshFloatingStatus();
    }
  }

  function handlePanelAction(action: string, trigger?: HTMLElement | null): void {
    if (action === "collect") {
      const currentPlatform = resolveCurrentPlatform() || platform;
      collectFromCurrentContext(currentPlatform, (resp) => {
        showToast(resp.message, !resp.ok);
        void refreshFloatingStatus();
      });
      return;
    }

    if (action === "sync") {
      triggerSyncToServer(() => {
        void refreshFloatingStatus();
      });
      return;
    }

    if (action === "smart-fill") {
      void runSmartFillFlow();
      return;
    }

    if (action === "smart-fill-cancel-preview") {
      resetSmartFillState();
      return;
    }

    if (action === "smart-fill-focus") {
      pendingHighlighter.focusFirst();
      syncSmartFillNavigationText();
      return;
    }

    if (action === "smart-fill-focus-item") {
      const node = trigger?.closest<HTMLElement>("[data-field-id]") || null;
      const fieldId = node?.dataset.fieldId || "";
      if (smartFillPreviewMode && smartFillPlan) {
        const planned = smartFillPlan.items.find((item) => item.field.fieldId === fieldId);
        if (planned) {
          try {
            planned.field.element.scrollIntoView({ block: "center", behavior: "smooth" });
            planned.field.element.focus({ preventScroll: true });
          } catch { /* detached or non-focusable control */ }
        }
        return;
      }
      const focused = pendingHighlighter.focusByFieldId(fieldId);
      if (!focused) {
        pendingHighlighter.focusFirst();
      }
      syncSmartFillNavigationText();
      return;
    }

    if (action === "smart-fill-prev") {
      pendingHighlighter.focusPrev();
      syncSmartFillNavigationText();
      return;
    }

    if (action === "smart-fill-next") {
      pendingHighlighter.focusNext();
      syncSmartFillNavigationText();
      return;
    }

    if (action === "smart-fill-exit") {
      resetSmartFillState();
      latestCollectabilityText = "当前页面：支持智填";
      latestCollectabilityTone = "ok";
      syncPanelSummaryText();
    }
  }

  function mountPanel(): HTMLDivElement {
    if (panel) {
      syncPanelSummaryText();
      return panel;
    }

    const nextPanel = document.createElement("div");
    nextPanel.className = "panel";
    nextPanel.innerHTML = `
      <div class="actions">
        <button class="action-btn" data-action="collect" type="button">+ 加入</button>
        <button class="action-btn primary" data-action="sync" type="button">去同步</button>
      </div>
      <div class="smart-fill-card">
        <button class="smart-fill-btn" data-action="smart-fill" type="button">一键智填</button>
        <button class="smart-fill-link hidden" data-action="smart-fill-focus" type="button">查看待补字段 ›</button>
        <div class="meta meta-secondary">先预览再确认 · 不覆盖已填值 · 不自动提交</div>
      </div>
      <div class="smart-fill-nav hidden" id="offeruSmartFillNav">
        <span>待补导航</span>
        <span id="offeruSmartFillNavIndex">0/0</span>
        <button type="button" data-action="smart-fill-prev">←</button>
        <button type="button" data-action="smart-fill-next">→</button>
        <button type="button" class="exit" data-action="smart-fill-exit">退出高亮</button>
      </div>
      <div class="smart-fill-checklist hidden" id="offeruSmartFillChecklist"></div>
      <div class="meta" id="offeruFloatingMeta">${latestMetaText}</div>
      <div class="meta meta-secondary" id="offeruFloatingCollectability">${latestCollectabilityText}</div>
    `;

    panelController = new AbortController();
    nextPanel.addEventListener(
      "click",
      (event) => {
        const target = event.target as HTMLElement;
        if (target.closest("[data-action='smart-fill-focus-item']")) {
          const node = target.closest<HTMLElement>("[data-action='smart-fill-focus-item']");
          handlePanelAction("smart-fill-focus-item", node);
          return;
        }
        const action = target.closest<HTMLButtonElement>("button[data-action]")?.dataset.action;
        if (!action) return;
        handlePanelAction(action, target);
      },
      { signal: panelController.signal },
    );

    wrap.appendChild(nextPanel);

    panel = nextPanel;
    metaEl = panel.querySelector("#offeruFloatingMeta") as HTMLDivElement | null;
    collectabilityEl = panel.querySelector("#offeruFloatingCollectability") as HTMLDivElement | null;
    smartFillBtnEl = panel.querySelector(".smart-fill-btn") as HTMLButtonElement | null;
    smartFillLinkEl = panel.querySelector(".smart-fill-link") as HTMLButtonElement | null;
    smartFillNavEl = panel.querySelector("#offeruSmartFillNav") as HTMLDivElement | null;
    smartFillNavIndexEl = panel.querySelector("#offeruSmartFillNavIndex") as HTMLSpanElement | null;
    smartFillChecklistEl = panel.querySelector("#offeruSmartFillChecklist") as HTMLDivElement | null;
    syncPanelSummaryText();
    updateSmartFillUi();
    return nextPanel;
  }

  function unmountPanel(): void {
    if (!panel) return;

    panelController?.abort();
    panelController = null;

    panel.remove();
    panel = null;
    metaEl = null;
    collectabilityEl = null;
    smartFillBtnEl = null;
    smartFillLinkEl = null;
    smartFillNavEl = null;
    smartFillNavIndexEl = null;
    smartFillChecklistEl = null;
  }

  function currentPeekTransform(): string {
    return "translate3d(0, 0, 0)";
  }

  function renderHostTransform(): void {
    const baseTransform = currentPeekTransform();
    if (dragOffsetX === 0 && dragOffsetY === 0) {
      host.style.transform = baseTransform;
      return;
    }

    host.style.transform = `${baseTransform} translate3d(${dragOffsetX}px, ${dragOffsetY}px, 0)`;
  }

  function updatePeek(): void {
    const edgeOnly = edgeDocked && !expanded && !hovering && !dragging;
    const muted = !hovering && !expanded && !dragging;

    wrap.classList.toggle("mode-edge", edgeOnly);
    wrap.classList.toggle("is-muted", muted);
    compactBtn.setAttribute("aria-label", edgeOnly ? "OfferU 贴边入口" : "OfferU 悬浮入口");
    renderHostTransform();
  }

  function setSide(next: DockSide): void {
    side = next;
    wrap.classList.toggle("side-left", side === "left");
    wrap.classList.toggle("side-right", side === "right");
    wrap.classList.toggle("side-top", side === "top");
    wrap.classList.toggle("side-bottom", side === "bottom");
  }

  function setExpanded(next: boolean, persist = true): void {
    expanded = next;
    wrap.classList.toggle("mode-expanded", expanded);

    if (expanded) {
      const nextPanel = mountPanel();
      nextPanel.classList.add("show");
      void refreshFloatingStatus();
    } else {
      panel?.classList.remove("show");
      unmountPanel();
    }

    compactBtn.setAttribute("aria-expanded", expanded ? "true" : "false");
    if (toggleGlyphEl) {
      toggleGlyphEl.classList.toggle("is-open", expanded);
    }
    updatePeek();
    if (persist) {
      scheduleDockStateSave();
    }
  }

  function getRect(): { x: number; y: number } {
    const rect = host.getBoundingClientRect();
    return { x: rect.left, y: rect.top };
  }

  function moveTo(x: number, y: number): void {
    const safeX = clampLeft(x);
    const safeY = clampTop(y);
    host.style.top = `${safeY}px`;
    host.style.left = `${safeX}px`;
    host.style.right = "auto";
  }

  function dockToEdge(nextSide: DockSide, left: number, top: number): void {
    edgeDocked = true;
    setSide(nextSide);
    if (expanded) {
      setExpanded(false, false);
    }

    if (nextSide === "left" || nextSide === "right") {
      host.style.top = `${clampTop(top)}px`;
      host.style.left = nextSide === "left" ? "0px" : "auto";
      host.style.right = nextSide === "right" ? "0px" : "auto";
      updatePeek();
      return;
    }

    host.style.left = `${clampLeft(left)}px`;
    host.style.right = "auto";
    const edgeHeight = nextSide === "top" || nextSide === "bottom"
      ? EDGE_DOCK_TOP_BOTTOM_HEIGHT
      : EDGE_DOCK_SIDE_HEIGHT;
    host.style.top = nextSide === "top" ? "0px" : `${Math.max(0, window.innerHeight - edgeHeight)}px`;
    updatePeek();
  }

  function undockTo(left: number, top: number): void {
    edgeDocked = false;
    host.style.top = `${clampTop(top)}px`;
    host.style.left = `${clampLeft(left)}px`;
    host.style.right = "auto";
    updatePeek();
  }

  function settleAfterDrag(): void {
    const rect = host.getBoundingClientRect();

    const candidates: Array<{ side: DockSide; gap: number }> = [
      { side: "left", gap: rect.left },
      { side: "right", gap: window.innerWidth - (rect.left + rect.width) },
      { side: "top", gap: rect.top },
      { side: "bottom", gap: window.innerHeight - (rect.top + rect.height) },
    ];
    candidates.sort((a, b) => a.gap - b.gap);

    const nearest = candidates[0];
    if (nearest && nearest.gap <= DOCK_EDGE_SNAP_DISTANCE) {
      dockToEdge(nearest.side, rect.left, rect.top);
    } else {
      undockTo(rect.left, rect.top);
    }

    scheduleDockStateSave();
  }

  function applyDragFrame(): void {
    dragRAF = 0;
    dragOffsetX = pendingDx;
    dragOffsetY = pendingDy;
    renderHostTransform();
  }

  function scheduleDockStateSave(): void {
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer);
    }
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      const nextState: FloatingDockState = {
        side,
        top: readCurrentTop(),
        expanded: false,
        edgeDocked,
        left: readCurrentLeft(),
      };
      chrome.storage.local.set({ [FLOATING_DOCK_STORAGE_KEY]: nextState });
    }, 120);
  }

  async function restoreDockState(): Promise<void> {
    const stored = await new Promise<Partial<FloatingDockState> | null>((resolve) => {
      chrome.storage.local.get([FLOATING_DOCK_STORAGE_KEY], (result) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        const value = result[FLOATING_DOCK_STORAGE_KEY];
        if (!value || typeof value !== "object") {
          resolve(null);
          return;
        }
        resolve(value as Partial<FloatingDockState>);
      });
    });

    if (!stored) {
      const defaultLeft = getDefaultUndockedLeft();
      const defaultTop = Math.round(window.innerHeight * 0.38);
      undockTo(defaultLeft, defaultTop);
      return;
    }

    if (stored.side === "left" || stored.side === "right" || stored.side === "top" || stored.side === "bottom") {
      setSide(stored.side);
    }

    if (typeof stored.top === "number" && Number.isFinite(stored.top)) {
      host.style.top = `${clampTop(stored.top)}px`;
    }

    const top = typeof stored.top === "number" && Number.isFinite(stored.top)
      ? stored.top
      : Math.round(window.innerHeight * 0.38);
    const left = typeof stored.left === "number" && Number.isFinite(stored.left)
      ? stored.left
      : getDefaultUndockedLeft();

    if (stored.edgeDocked) {
      dockToEdge(side, left, top);
    } else {
      undockTo(left, top);
    }

    setExpanded(false, false);
  }

  function finishPointerInteraction(): void {
    if (!pointerActive) return;

    window.removeEventListener("pointermove", handleDragPointerMove, true);
    window.removeEventListener("pointerup", handleDragPointerFinish, true);
    window.removeEventListener("pointercancel", handleDragPointerFinish, true);

    const wasDragging = dragging;

    if (dragRAF) {
      window.cancelAnimationFrame(dragRAF);
      dragRAF = 0;
    }

    if (activePointerId !== null && compactBtn.hasPointerCapture(activePointerId)) {
      compactBtn.releasePointerCapture(activePointerId);
    }

    pointerActive = false;
    activePointerId = null;
    dragging = false;
    pendingUndockFromEdge = false;
    dragDistance = 0;
    host.style.transition = hostTransition;
    wrap.classList.remove("mode-dragging");

    if (wasDragging) {
      const finalLeft = dragOriginX + pendingDx;
      const finalTop = dragOriginY + pendingDy;
      dragOffsetX = 0;
      dragOffsetY = 0;
      renderHostTransform();
      moveTo(finalLeft, finalTop);
      settleAfterDrag();
      return;
    }

    dragOffsetX = 0;
    dragOffsetY = 0;
    updatePeek();
  }

  function handleDragPointerMove(event: PointerEvent): void {
    if (!pointerActive || event.pointerId !== activePointerId) return;

    const dx = event.clientX - dragStartX;
    const dy = event.clientY - dragStartY;
    pendingDx = dx;
    pendingDy = dy;
    dragDistance = Math.hypot(dx, dy);

    if (!dragging && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
      dragging = true;
      if (pendingUndockFromEdge) {
        edgeDocked = false;
        const current = getRect();
        host.style.left = `${clampLeft(current.x)}px`;
        host.style.right = "auto";
        pendingUndockFromEdge = false;
      }
      setExpanded(false);
    }

    if (!dragging) return;

    if (!dragRAF) {
      dragRAF = window.requestAnimationFrame(applyDragFrame);
    }
  }

  function handleDragPointerFinish(event: PointerEvent): void {
    if (event.pointerId !== activePointerId) return;
    finishPointerInteraction();
  }

  async function refreshFloatingStatus(): Promise<void> {
    const currentPlatform = resolveCurrentPlatform() || platform;
    const collectability = resolveSmartFillCollectability(currentPlatform);
    latestCollectabilityText = collectability.text;
    latestCollectabilityTone = collectability.tone;

    try {
      const response = await sendRuntimeMessage<StatusResponse>({ type: "GET_STATUS" });
      if (badgeEl) {
        badgeEl.textContent = String(Math.max(0, response.total));
      }
      latestMetaText = `草稿 ${Math.max(0, response.draft)} 条 | 可同步 ${Math.max(0, response.ready)} 条`;
    } catch {
      latestMetaText = "状态读取失败";
    }

    syncPanelSummaryText();
  }

  function loadThemePreference(): void {
    chrome.storage.local.get([POPUP_UI_SETTINGS_KEY], (result) => {
      const settings = (result[POPUP_UI_SETTINGS_KEY] || {}) as PopupUiSettings;
      const nextTheme = settings.theme;
      if (nextTheme === "light" || nextTheme === "dark" || nextTheme === "system") {
        themePreference = nextTheme;
      } else {
        themePreference = "system";
      }
      applyDockTheme();
    });
  }

  function loadShortcutPreference(): void {
    chrome.storage.local.get([SHORTCUT_SETTINGS_KEY], (result) => {
      const raw = (result[SHORTCUT_SETTINGS_KEY] || {}) as Partial<ShortcutSettings>;
      shortcutSettings = {
        collect: normalizeShortcutString(raw.collect || DEFAULT_SHORTCUT_SETTINGS.collect),
        sync: normalizeShortcutString(raw.sync || DEFAULT_SHORTCUT_SETTINGS.sync),
        settings: normalizeShortcutString(raw.settings || DEFAULT_SHORTCUT_SETTINGS.settings),
      };
    });
  }

  function handleShortcutAction(action: keyof ShortcutSettings): void {
    if (action === "collect") {
      const currentPlatform = resolveCurrentPlatform() || platform;
      collectFromCurrentContext(currentPlatform, (resp) => {
        showToast(resp.message, !resp.ok);
        void refreshFloatingStatus();
      });
      return;
    }

    if (action === "sync") {
      triggerSyncToServer(() => {
        void refreshFloatingStatus();
      });
      return;
    }

    if (action === "settings") {
      openSettingsPage();
    }
  }

  function handleShortcutKeydown(event: KeyboardEvent): void {
    if (isEditableTarget(event.target)) return;

    const pressed = eventToShortcut(event);
    if (!pressed) return;

    const collectShortcut = normalizeShortcutString(shortcutSettings.collect);
    const syncShortcut = normalizeShortcutString(shortcutSettings.sync);
    const settingsShortcut = normalizeShortcutString(shortcutSettings.settings);

    if (pressed === collectShortcut) {
      event.preventDefault();
      handleShortcutAction("collect");
      return;
    }

    if (pressed === syncShortcut) {
      event.preventDefault();
      handleShortcutAction("sync");
      return;
    }

    if (pressed === settingsShortcut) {
      event.preventDefault();
      handleShortcutAction("settings");
    }
  }

  darkMedia.addEventListener("change", () => {
    if (themePreference === "system") {
      applyDockTheme();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;

    if (changes[POPUP_UI_SETTINGS_KEY]) {
      const next = changes[POPUP_UI_SETTINGS_KEY].newValue as PopupUiSettings | undefined;
      const nextTheme = next?.theme;
      if (nextTheme === "light" || nextTheme === "dark" || nextTheme === "system") {
        themePreference = nextTheme;
      } else {
        themePreference = "system";
      }
      applyDockTheme();
    }

    if (changes[SHORTCUT_SETTINGS_KEY]) {
      loadShortcutPreference();
    }
  });

  compactBtn.addEventListener("pointerdown", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("button[data-action]")) return;
    if (event.button !== 0) return;
    event.preventDefault();

    pointerActive = true;
    activePointerId = event.pointerId;
    dragging = false;
    dragDistance = 0;
    dragStartX = event.clientX;
    dragStartY = event.clientY;
    const pos = getRect();
    dragOriginX = pos.x;
    dragOriginY = pos.y;
    pendingUndockFromEdge = edgeDocked;

    wrap.classList.add("mode-dragging");
    host.style.transition = "none";
    compactBtn.setPointerCapture(event.pointerId);
    window.addEventListener("pointermove", handleDragPointerMove, true);
    window.addEventListener("pointerup", handleDragPointerFinish, true);
    window.addEventListener("pointercancel", handleDragPointerFinish, true);
  });

  compactBtn.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const action = target.closest<HTMLButtonElement>("button[data-action]")?.dataset.action;
    if (!action) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    if (action === "open-drawer") {
      toggleDrawer("cart");
      return;
    }

    if (action === "toggle-panel") {
      setExpanded(!expanded);
    }
  });

  compactBtn.addEventListener("lostpointercapture", (event) => {
    if (event.pointerId !== activePointerId) return;
    finishPointerInteraction();
  });

  wrap.addEventListener("mouseenter", () => {
    hovering = true;
    updatePeek();
    void refreshFloatingStatus();
  });

  wrap.addEventListener("mouseleave", () => {
    hovering = false;
    updatePeek();
  });

  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!expanded) return;
      const eventPath = typeof event.composedPath === "function" ? event.composedPath() : [];
      if (eventPath.includes(host)) return;
      setExpanded(false);
    },
    true,
  );

  window.addEventListener("resize", () => {
    const currentTop = readCurrentTop();
    const currentLeft = readCurrentLeft();
    if (edgeDocked) {
      dockToEdge(side, currentLeft, currentTop);
      return;
    }

    undockTo(currentLeft, currentTop);
  });

  window.addEventListener("beforeunload", () => {
    pendingHighlighter.clear();
  });

  document.addEventListener("keydown", handleShortcutKeydown, true);

  document.body.appendChild(host);

  void restoreDockState();
  loadThemePreference();
  loadShortcutPreference();
  updatePeek();
  void refreshFloatingStatus();
}

function createShadowButton(label: string): {
  host: HTMLDivElement;
  button: HTMLButtonElement;
  setLabel: (text: string) => void;
  setBusy: (busy: boolean) => void;
} {
  const host = document.createElement("div");
  const root = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `
    .offeru-btn {
      all: initial;
      font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 6px 10px;
      border-radius: 8px;
      border: 0;
      background: linear-gradient(135deg, #2563eb, #1d4ed8);
      color: #ffffff;
      font-size: 12px;
      font-weight: 600;
      line-height: 1;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(37,99,235,0.24);
    }
    .offeru-btn[disabled] {
      opacity: 0.7;
      cursor: default;
      box-shadow: none;
    }
  `;

  const button = document.createElement("button");
  button.className = "offeru-btn";
  button.textContent = label;
  button.type = "button";

  root.appendChild(style);
  root.appendChild(button);

  return {
    host,
    button,
    setLabel(text: string) {
      button.textContent = text;
    },
    setBusy(busy: boolean) {
      button.disabled = busy;
    },
  };
}

function collectJobs(jobs: ExtractedJob[], onDone: (resp: MergeResponse | null) => void): void {
  chrome.runtime.sendMessage({ type: "JOBS_COLLECTED", jobs }, (resp: MergeResponse) => {
    if (chrome.runtime.lastError) {
      onDone(null);
      return;
    }
    onDone(resp || null);
  });
}

function sendRuntimeMessage<T>(message: Message): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    chrome.runtime.sendMessage(message, (resp: T) => {
      if (chrome.runtime.lastError) {
        reject(new Error(safeExtensionError(chrome.runtime.lastError.message, "扩展后台无响应")));
        return;
      }
      resolve(resp);
    });
  });
}

let popupCollectBridgeBound = false;

function bindPopupCollectBridge(): void {
  if (popupCollectBridgeBound) return;

  chrome.runtime.onMessage.addListener((incoming, _sender, sendResponse) => {
    const message = incoming as { type?: string };
    if (message?.type !== POPUP_TRIGGER_COLLECT_MESSAGE) {
      return;
    }

    const platform = resolveCurrentPlatform();
    collectFromCurrentContext(platform, (response) => {
      sendResponse(response);
    });
    return true;
  });

  popupCollectBridgeBound = true;
}

function decorateListPage(platform: PlatformConfig): void {
  const cards = getUniqueListCards(platform);
  cards.forEach((card) => {
    if ((card as HTMLElement).getAttribute(LIST_BUTTON_FLAG) === "1") return;

    const control = createShadowButton("加入简历购物车");
    control.host.setAttribute(LIST_BUTTON_HOST_FLAG, "1");
    control.host.style.display = "inline-block";
    control.host.style.marginTop = "8px";

    control.button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();

      const job = extractFromListCard(card, platform);
      if (!job) {
        showToast("当前卡片未识别到岗位信息，请刷新后重试", true);
        return;
      }

      control.setBusy(true);
      control.setLabel("加入中...");

      void (async () => {
        const finalJob = await enrichCollectedJob(job, platform);
        collectJobs([finalJob], (resp) => {
          control.setBusy(false);

          if (!resp) {
            control.setLabel("加入简历购物车");
            showToast("加入失败，请稍后重试", true);
            return;
          }

          if (resp.added > 0) {
            control.setLabel(finalJob.status === "ready_to_sync" ? "已加入可同步" : "已加入草稿");
            showToast(`已加入：${finalJob.title}`);
            return;
          }

          if (resp.upgraded > 0) {
            control.setLabel("已补全并更新");
            showToast(`已补全JD：${finalJob.title}`);
            return;
          }

          control.setLabel("已在购物车");
          showToast("岗位已存在购物车");
        });
      })();
    });

    const actionContainer =
      pickEl(card, platform.listActionTargets) ||
      card.querySelector(".job-info") ||
      card;

    actionContainer
      .querySelectorAll(`[${LIST_BUTTON_HOST_FLAG}='1']`)
      .forEach((node) => {
        node.remove();
      });

    Array.from(actionContainer.children).forEach((child) => {
      const element = child as HTMLElement;
      const maybeText = element.shadowRoot?.querySelector("button")?.textContent || "";
      if (/加入简历购物车/.test(maybeText)) {
        element.remove();
      }
    });

    actionContainer.appendChild(control.host);
    (card as HTMLElement).setAttribute(LIST_BUTTON_FLAG, "1");
  });
}

function decorateDetailPage(platform: PlatformConfig): void {
  if (document.getElementById(DETAIL_BUTTON_ID)) return;

  const control = createShadowButton("加入简历购物车（详情）");
  control.host.id = DETAIL_BUTTON_ID;
  control.host.style.position = "fixed";
  control.host.style.right = "20px";
  control.host.style.bottom = "90px";
  control.host.style.zIndex = "2147483646";

  control.button.addEventListener("click", () => {
    const job = extractFromDetailPage(platform);
    if (!job) {
      showToast("当前页面未识别到岗位详情信息", true);
      return;
    }

    control.setBusy(true);
    collectJobs([job], (resp) => {
      control.setBusy(false);
      if (!resp) {
        showToast("采集失败，请稍后重试", true);
        return;
      }

      if (resp.added > 0) {
        control.setLabel("已加入购物车");
        showToast(`已加入：${job.title}`);
        return;
      }

      if (resp.upgraded > 0) {
        control.setLabel("已补全并更新");
        showToast(`已补全JD：${job.title}`);
        return;
      }

      control.setLabel("已在购物车");
      showToast("岗位已存在购物车");
    });
  });

  document.body.appendChild(control.host);
}

function run(): void {
  const platform = resolveCurrentPlatform();
  createFloatingDock(platform);

  // SPA 导航离开详情页后移除残留的详情按钮：按钮只增不删时，
  // 列表页点击会经 extractFromDetailPage 误采集当前首卡内容。
  if (!platform || !isDetailPage(platform)) {
    document.getElementById(DETAIL_BUTTON_ID)?.remove();
  }

  if (!platform) return;

  if (isDetailPage(platform)) {
    decorateDetailPage(platform);
  }

  if (isListPage(platform)) {
    decorateListPage(platform);
  }
}

let refreshTimer: number | null = null;

function scheduleRun(): void {
  if (refreshTimer !== null) {
    window.clearTimeout(refreshTimer);
  }
  refreshTimer = window.setTimeout(() => {
    run();
    refreshTimer = null;
  }, 220);
}

function init(): void {
  bindPopupCollectBridge();
  run();

  const observer = new MutationObserver(() => {
    scheduleRun();
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
