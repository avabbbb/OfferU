// =============================================
// Selector 语法与安全检查
// 约束：无 XPath、无文本执行器、无 :contains()、无任意函数表达式
// =============================================

/**
 * 检查单个 CSS selector 是否合法。返回错误信息，合法返回 null。
 * - 有 DOM（jsdom/浏览器）时用 querySelector 做真实解析验证；
 * - 无 DOM（node 构建期）时做字符级检查。
 * 错误消息不包含 selector 原文（防止疑似 secret 回显）。
 */
export function checkSelectorSyntax(css: string): string | null {
  if (css.length === 0) return "empty selector";
  if (css.length > 300) return "selector too long";
  if (/:contains\s*\(/i.test(css)) return "forbidden pseudo :contains()";
  if (css.includes("::xpath") || /^xpath\s*[:=]/.test(css)) return "xpath is forbidden";
  if (!isBalanced(css, "(", ")") || !isBalanced(css, "[", "]")) return "unbalanced brackets";

  if (typeof document !== "undefined") {
    try {
      document.createDocumentFragment().querySelector(css);
    } catch {
      return "invalid selector syntax";
    }
  } else {
    if (/[;{}]/.test(css)) return "invalid selector syntax";
    if (/^[>+~]/.test(css)) return "selector must not start with combinator";
  }
  return null;
}

function isBalanced(text: string, open: string, close: string): boolean {
  let depth = 0;
  let inString: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) depth--;
    if (depth < 0) return false;
  }
  return depth === 0 && inString === null;
}
