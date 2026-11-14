// 岗位文本的入库闸门（port of backend/app/core/posting_guard.py）：
// 去掉隐藏内容和不可见字符，把像「给 AI 的指令」的行找出来。只提醒不拦截；入库只存计数。

const EXCERPT = 120;

const ZERO_WIDTH = "\u200b\u200c\u200d\u2060\u2061\u2062\u2063\u2064";
const BIDI = "\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069";
const BIDI_TAMPER = "\u202d\u202e\u2066\u2067\u2068\u2069";
const FORMAT = "\u00ad\u2028\u2029";
const BOM = "\ufeff";
const isTagChar = (cp: number) => cp >= 0xe0000 && cp <= 0xe007f;
const INVISIBLE = new Set([...ZERO_WIDTH + BIDI + FORMAT + BOM].map((c) => c.codePointAt(0)!));
const isInvisible = (cp: number) => INVISIBLE.has(cp) || isTagChar(cp);

const HIDDEN_STYLE = new RegExp(
  "display\\s*:\\s*none|visibility\\s*:\\s*hidden|opacity\\s*:\\s*0(?![.\\d]*[1-9])"
  + "|font-size\\s*:\\s*0(?:\\.0+)?(?:px|pt|em|rem|%)?(?![\\d.])|color\\s*:\\s*transparent"
  + "|clip\\s*:\\s*rect\\(\\s*0|clip-path\\s*:\\s*inset\\(\\s*100%|(?:left|top|text-indent)\\s*:\\s*-\\d{4,}px",
  "i",
);
const CSS_COMMENT = /\/\*[\s\S]*?\*\//g;
const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
const DROP_BLOCKS = /<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi;
const TAG = /<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTR = /([^\s=/"'>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;
const VOID = new Set(["br", "img", "input", "meta", "link", "hr", "wbr", "source", "area", "base", "col", "embed", "param", "track"]);
const BLOCK = new Set(["p", "div", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "br", "section", "article",
  "header", "footer", "table", "blockquote", "pre", "dd", "dt", "dl", "nav", "main", "aside", "td", "th", "hr"]);
const IMPLIED_END = new Set(["p", "li", "dd", "dt", "tr", "td", "th", "option"]);
const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

// Python \b is Unicode-aware; these patterns only use \b next to ASCII words, so JS \b is equivalent.
const INSTRUCTION = [
  /\bignore (all|any|the|previous|prior|above|earlier)\b/i,
  /\b(disregard|forget)( all| any| the| your)? (previous|prior|above|earlier|system) (instructions?|prompts?)\b/i,
  /\byou are (?:an?|the) (?:ai(?![\p{L}\p{N}_-])|assistant|llm|language model)\b/iu,
  /\bsystem prompt\b/i,
  /\b(do not|don['\u2019]?t|never) (tell|inform) the user\b(?!['\u2019]s)/i,
  /^\s*(assistant|system|user)\s*:/i, /<\|/i, /\[INST\]/i, /###\s*(system|instruction)/i,
  /\btool_use\b|\bfunction_call\b/i,
  /(忽略|无视|忘记|不要理会)(掉)?(以上|上面|之前|前面|先前|所有|全部|系统)(的)?(所有)?(指令|指示|提示|规则|要求|内容)/i,
  /(你是|你现在是|扮演)(一个|一名)?\s*(AI|人工智能|大模型|语言模型|助手|智能体)/i,
  /系统提示(词)?|system\s*prompt/i,
  /(不要|别|切勿|不得)(告诉|告知|透露给|提醒)用户/i,
  /(给|对)\s*(AI|模型|大模型|智能体|助手)\s*的(指令|说明|提示)/i,
  /(把|将)(用户|候选人)的?(简历|档案|手机号|电话|邮箱|身份证|个人信息).{0,12}(发送|发到|上传|提交|转发)/i,
  /(评分|打分|匹配度).{0,8}(给|打|设为|定为)\s*(满分|100\s*分?)/i,
];

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: "\u00a0", ensp: "\u2002", emsp: "\u2003", thinsp: "\u2009",
  zwnj: "\u200c", zwj: "\u200d", lrm: "\u200e", rlm: "\u200f", shy: "\u00ad", copy: "©", reg: "®", trade: "™",
  hellip: "…", mdash: "—", ndash: "–", middot: "·", bull: "•", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  laquo: "«", raquo: "»", yen: "¥", times: "×", divide: "÷", deg: "°", plusmn: "±", sect: "§", para: "¶",
};

/**
 * html.unescape subset: numeric references and the common named entities.
 * Python knows all HTML5 names; rarer ones stay as written here.
 */
export function unescapeHtml(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);?/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "\ufffd";
      return code === 0 ? "\ufffd" : String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
    return named !== undefined && (whole.endsWith(";") || body in NAMED_ENTITIES) ? named : whole;
  });
}

function fold(text: string): string {
  return text
    .replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    .replace(/[ \t\u00a0\f\v\u3000]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

const isAlnum = (ch: string) => /^[\p{L}\p{N}]$/u.test(ch);

export type CleanInfo = { invisible: number; tampered: number; invisible_text: string[] };

/** 删不可见字符。返回 [text, {invisible, tampered, invisible_text}]。 */
export function cleanText(text: string): [string, CleanInfo] {
  const chars = [...text];
  let invisible = 0;
  let tampered = 0;
  chars.forEach((ch, index) => {
    const cp = ch.codePointAt(0)!;
    if (isInvisible(cp)) invisible += 1;
    if (BIDI_TAMPER.includes(ch) || isTagChar(cp)) tampered += 1;
    else if (ZERO_WIDTH.includes(ch) || ch === BOM) {
      const before = index ? chars[index - 1] : "";
      const after = index + 1 < chars.length ? chars[index + 1] : "";
      if (before && after && isAlnum(before) && isAlnum(after)) tampered += 1;
    }
  });
  const spelled: string[] = [];
  let run: number[] = [];
  const flush = () => {
    if (!run.length) return;
    const decoded = run.map((cp) => cp - 0xe0000).filter((c) => c >= 0x20 && c < 0x7f).map((c) => String.fromCharCode(c)).join("").trim();
    if (decoded) spelled.push(decoded.slice(0, 200));
    run = [];
  };
  for (const ch of chars) {
    const cp = ch.codePointAt(0)!;
    if (isTagChar(cp)) run.push(cp);
    else flush();
  }
  flush();
  const kept = chars.filter((ch) => !isInvisible(ch.codePointAt(0)!)).join("");
  return [fold(kept), { invisible, tampered, invisible_text: spelled }];
}

function isHidden(rawAttrs: string): boolean {
  const attrs: Record<string, string> = {};
  for (const match of rawAttrs.matchAll(ATTR)) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  if ("hidden" in attrs || (attrs["aria-hidden"] ?? "").trim().toLowerCase() === "true") return true;
  return HIDDEN_STYLE.test(unescapeHtml(attrs.style ?? "").replace(CSS_COMMENT, ""));
}

/** 可见正文、隐藏块摘录、全部被删内容（供扫描）。 */
export function cleanHtml(input: string): [string, string[], string] {
  const removed: string[] = [];
  const blocks: string[] = [];
  const collect = (whole: string) => {
    removed.push(unescapeHtml(whole.replace(/<!--|-->/g, " ").replace(/<[^>]+>/g, " ")));
    return " ";
  };
  const markup = input.replace(COMMENT, collect).replace(DROP_BLOCKS, collect);
  const visible: string[] = [];
  const hiddenBuf: string[] = [];
  const stack: string[] = [];
  let hiddenAt: number | null = null;
  let pos = 0;

  const emit = (text: string) => (hiddenAt === null ? visible : hiddenBuf).push(text);
  const popTo = (index: number) => {
    stack.splice(index);
    if (hiddenAt !== null && hiddenAt >= stack.length) {
      const block = fold(unescapeHtml(hiddenBuf.join("")));
      hiddenBuf.length = 0;
      hiddenAt = null;
      if (block) {
        blocks.push([...cleanText(block)[0]].slice(0, EXCERPT).join(""));
        removed.push(block);
      }
    }
  };

  for (const match of markup.matchAll(TAG)) {
    emit(markup.slice(pos, match.index));
    pos = match.index! + match[0].length;
    const closing = match[1];
    const name = match[2].toLowerCase();
    const rawAttrs = match[3];
    if (BLOCK.has(name)) emit("\n");
    if (closing) {
      const index = stack.lastIndexOf(name);
      if (index >= 0) popTo(index);
      continue;
    }
    if (hiddenAt !== null) {
      const hrefs = unescapeHtml(rawAttrs).match(URL_RE);
      if (hrefs?.length) hiddenBuf.push(` ${hrefs.join(" ")} `);
    }
    if (VOID.has(name)) continue;
    if (IMPLIED_END.has(name) && stack.length && stack[stack.length - 1] === name) popTo(stack.length - 1);
    stack.push(name);
    if (hiddenAt === null && isHidden(rawAttrs)) hiddenAt = stack.length - 1;
  }
  emit(markup.slice(pos));
  if (hiddenAt !== null) popTo(hiddenAt);
  return [unescapeHtml(visible.join("")), blocks, removed.join("\n")];
}

function instructionLines(text: string): string[] {
  const seen: string[] = [];
  for (const raw of text.split(/\r\n|\r|\n|\u2028|\u2029|\v|\f|\x1c|\x1d|\x1e|\x85/)) {
    const line = raw.trim();
    if (line && !seen.includes(line) && INSTRUCTION.some((pattern) => pattern.test(line))) seen.push(line);
  }
  return seen.map((line) => ([...line].length <= 200 ? line : `${[...line].slice(0, 200).join("")}…`));
}

export type GuardFindings = {
  instruction_like: string[];
  hidden_blocks: string[];
  hidden_urls: string[];
  invisible: number;
  tampered: number;
  invisible_text: string[];
  alarm: boolean;
};

/** 跑整道闸门。返回 [干净正文, findings]。 */
export function guard(raw: string, isHtml: boolean): [string, GuardFindings] {
  let [text, blocks, hidden] = isHtml ? cleanHtml(raw) : [raw, [] as string[], ""];
  const [cleanBody, tf] = cleanText(text);
  text = cleanBody;
  const [cleanHidden, hf] = cleanText(hidden);
  hidden = cleanHidden;
  const spelled = [...tf.invisible_text, ...hf.invisible_text];
  const hiddenAll = [hidden, ...spelled].join("\n");
  const findings: GuardFindings = {
    instruction_like: instructionLines(`${text}\n${hiddenAll}`),
    hidden_blocks: blocks,
    hidden_urls: [...new Set((hiddenAll.match(URL_RE) ?? []).filter((url) => !text.includes(url)))],
    invisible: tf.invisible + hf.invisible,
    tampered: tf.tampered + hf.tampered,
    invisible_text: spelled,
    alarm: false,
  };
  findings.alarm = Boolean(findings.instruction_like.length || findings.tampered || spelled.length);
  return [text, findings];
}

export type GuardCounts = { alarm: boolean; instruction_like: number; hidden_blocks: number; hidden_urls: number; invisible: number; tampered: number };

/** 入库/日志只存计数，不存第三方文本的摘录。 */
export function guardCounts(findings: GuardFindings): GuardCounts {
  return {
    alarm: findings.alarm,
    instruction_like: findings.instruction_like.length,
    hidden_blocks: findings.hidden_blocks.length,
    hidden_urls: findings.hidden_urls.length,
    invisible: findings.invisible,
    tampered: findings.tampered,
  };
}

/** 有可疑信号时给用户的一句话；干净就返回 null。 */
export function guardWarning(findings: GuardFindings): string | null {
  if (!findings.alarm) return null;
  const parts: string[] = [];
  if (findings.instruction_like.length) parts.push(`${findings.instruction_like.length} 行像是写给 AI 的指令`);
  if (findings.tampered || findings.invisible_text.length) parts.push(`${findings.tampered} 个夹在字里的不可见字符`);
  return `岗位文本里有${parts.join("、")}，已当普通文字处理，没有照做。建议核对岗位来源。`;
}
