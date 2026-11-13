// 校徽库搜索（port of services/web_assets.search_school_logos）。Pure: the index ships with core, so the browser
// and the Worker can search too; only serving the PNG files needs the companion (or static hosting).

import { SCHOOL_LOGO_INDEX } from "./school-logo-index";

export const LOGO_URL_PREFIX = "/api/resume/assets/school-logos/";

// Common short names students type.
export const SCHOOL_ALIASES: Record<string, string> = {
  北大: "北京大学", 清华: "清华大学", 复旦: "复旦大学", 上交: "上海交通大学", 交大: "上海交通大学",
  浙大: "浙江大学", 南大: "南京大学", 中科大: "中国科学技术大学", 人大: "中国人民大学",
  北航: "北京航空航天大学", 北理: "北京理工大学", 北理工: "北京理工大学", 哈工大: "哈尔滨工业大学",
  西交: "西安交通大学", 华科: "华中科技大学", 武大: "武汉大学", 中大: "中山大学", 川大: "四川大学",
  电子科大: "电子科技大学", 成电: "电子科技大学", 北邮: "北京邮电大学", 西电: "西安电子科技大学",
  华南理工: "华南理工大学", 华工: "华南理工大学", 同济: "同济大学", 南开: "南开大学", 天大: "天津大学",
  厦大: "厦门大学", 山大: "山东大学", 东南: "东南大学", 北师大: "北京师范大学", 华东师大: "华东师范大学",
  上海交大: "上海交通大学", 西安交大: "西安交通大学", 北京交大: "北京交通大学", 北交: "北京交通大学",
  西南交大: "西南交通大学", 国科大: "中国科学院大学", 央财: "中央财经大学", 贸大: "对外经济贸易大学",
  上财: "上海财经大学", 深大: "深圳大学", 南科大: "南方科技大学", 西工大: "西北工业大学", 中南: "中南大学",
};

export type SchoolLogoHit = { school_name: string; file: string; url: string };

const normalizeSchool = (name: string): string =>
  (name || "").replace(/[（(][^）)]*[）)]/gu, "").replace(/\s+/gu, "").trim();

const length = (text: string): number => Array.from(text).length;

/** key 的每个字按顺序出现在 name 里：华师 -> 华南师范大学。 */
function inOrder(key: string, name: string): boolean {
  const chars = Array.from(name);
  let at = 0;
  for (const ch of key) {
    const found = chars.indexOf(ch, at);
    if (found < 0) return false;
    at = found + 1;
  }
  return true;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** 边打边联想：全名 / 简称、前缀、片段、跳字都算，最像的排前面。 */
export function searchSchoolLogos(query: string, limit = 20, index: Record<string, string> = SCHOOL_LOGO_INDEX): SchoolLogoHit[] {
  const q = (query || "").trim();
  if (!q) return [];
  const key = normalizeSchool(SCHOOL_ALIASES[q] ?? q);
  const scored: Array<[number, number, string, string]> = [];
  for (const [name, file] of Object.entries(index)) {
    const n = normalizeSchool(name);
    let rank: number;
    if (n === key) rank = 0;
    else if (n.startsWith(key)) rank = 1;
    else if (n.includes(key)) rank = 2;
    else if (length(n) >= 4 && key.includes(n)) rank = 3;
    else if (length(key) >= 2 && inOrder(key, n)) rank = 4;
    else continue;
    scored.push([rank, length(n), name, file]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1] - b[1] || cmp(a[2], b[2]) || cmp(a[3], b[3]));
  return scored.slice(0, limit).map(([, , name, file]) => ({ school_name: name, file, url: LOGO_URL_PREFIX + file }));
}

/** Only bundled emblem names (0001.png …) are valid; anything else is not ours to serve. */
export const isSchoolLogoFile = (name: string): boolean => /^\d{4}\.png$/.test(name || "");
