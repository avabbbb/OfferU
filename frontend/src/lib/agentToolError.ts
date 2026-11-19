/**
 * 工具报错的展示：工具失败时后端给模型的是 {ok:false, error:{code, message, retryable, suggestedAction}}
 * （packages/core tools/preflight.ts）。事件里它可能直接是对象、包在 toolResult 的 details / content[0].text 里、
 * 或是一段 JSON 字符串。这里统一认出来，界面画成卡片，不再露 JSON 原文。
 */

export interface ToolErrorView {
  code: string;
  /** 给人看的错误码名字（「参数不对」等）；不认识的码原样。 */
  codeLabel: string;
  message: string;
  suggestedAction: string;
  retryable: boolean;
  /** 需要用户本人处理（橙色 = 紧急）：只读、权限、本机不支持。 */
  needsUser: boolean;
}

const CODE_LABELS: Record<string, string> = {
  invalid_args: "参数不对",
  invalid: "数据不合法",
  not_found: "找不到",
  conflict: "有冲突",
  forbidden: "要你本人操作",
  read_only: "只读模式",
  unsupported: "这里不支持",
  unknown_tool: "没有这个工具",
  upstream_unavailable: "外部服务暂时不可用",
  aborted: "已中止",
  internal: "内部错误",
};

const NEEDS_USER = new Set(["forbidden", "read_only", "unsupported"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function fromFailure(value: unknown): ToolErrorView | null {
  const record = asRecord(value);
  if (!record || record.ok !== false) return null;
  const error = asRecord(record.error);
  const message = String(error?.message ?? "").trim();
  if (!error || !message) return null;
  const code = String(error.code ?? "internal") || "internal";
  return {
    code,
    codeLabel: CODE_LABELS[code] ?? code,
    message,
    suggestedAction: String(error.suggestedAction ?? error.suggested_action ?? "").trim(),
    retryable: error.retryable === true,
    needsUser: NEEDS_USER.has(code),
  };
}

/** 从工具结果里认出结构化错误；不是错误（或认不出）返回 null。 */
export function parseToolError(result: unknown): ToolErrorView | null {
  if (typeof result === "string") return fromFailure(parseJson(result));
  const direct = fromFailure(result);
  if (direct) return direct;
  const record = asRecord(result);
  if (!record) return null;
  const fromDetails = fromFailure(record.details);
  if (fromDetails) return fromDetails;
  const content = Array.isArray(record.content) ? record.content : [];
  for (const part of content) {
    const text = asRecord(part)?.text;
    if (typeof text === "string") {
      const parsed = fromFailure(parseJson(text));
      if (parsed) return parsed;
    }
  }
  return null;
}

/** 工具失败了但没有结构化错误（旧格式 "ERROR: …"、或别的文本）时的一句话，不露 JSON。 */
export function plainToolErrorText(result: unknown): string {
  const record = asRecord(result);
  const content = record && Array.isArray(record.content) ? record.content : [];
  const text = typeof result === "string" ? result : content.map((part) => String(asRecord(part)?.text ?? "")).join("\n");
  const cleaned = text.replace(/^ERROR:\s*/i, "").trim();
  if (!cleaned || cleaned.startsWith("{") || cleaned.startsWith("[")) return "工具执行失败";
  return cleaned.length > 200 ? cleaned.slice(0, 199) + "…" : cleaned;
}

/** 结果看起来是失败（结构化错误、{ok:false}、isError 标记或 "ERROR:" 文本）——用于没有 status 的历史工具调用。 */
export function isToolFailure(result: unknown): boolean {
  if (parseToolError(result)) return true;
  if (typeof result === "string") return /^\s*ERROR:/i.test(result);
  const record = asRecord(result);
  if (!record) return false;
  if (record.ok === false || record.isError === true || record.is_error === true) return true;
  const content = Array.isArray(record.content) ? record.content : [];
  return content.some((part) => /^\s*ERROR:/i.test(String(asRecord(part)?.text ?? "")));
}
