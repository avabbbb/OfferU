// =============================================
// Agent Ask（结构化提问）类型与归一化
// =============================================

export interface AgentInputOption {
  option_id: string;
  label: string;
  description?: string;
  /** 推荐项会被预选 */
  recommended?: boolean;
}

export type AgentInputSelectionMode = "single" | "multiple";

export interface AgentInputRequestView {
  request_id: string;
  run_id: string;
  status: "pending" | "answered" | "cancelled" | "expired" | string;
  question: string;
  reason?: string;
  options: AgentInputOption[];
  allow_free_text: boolean;
  /** 互斥选项为 single（默认），可同时成立的选项为 multiple */
  selection_mode: AgentInputSelectionMode;
  min_selections: number;
  /** 0 表示不限；single 恒为 1 */
  max_selections: number;
  allow_skip: boolean;
  created_at?: string;
}

export interface AgentInputAnswerBody {
  answer_id: string;
  selected_option_ids: string[];
  free_text: string;
  skipped?: boolean;
}

export interface AgentInputAnswerResult {
  ok: boolean;
  duplicate?: boolean;
  request?: {
    request_id?: string;
    status?: string;
    answer?: { selected_option_ids?: string[]; free_text?: string };
    answered_at?: string;
  };
  run?: { id?: string; status?: string } & Record<string, unknown>;
  continuation?: { ok?: boolean; assistant_message?: string; errors?: string[] };
  errors?: string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : value == null ? fallback : String(value);
}

export function normalizeInputRequest(raw: unknown): AgentInputRequestView {
  const record = asRecord(raw);
  const options = Array.isArray(record.options ?? record.options_json)
    ? ((record.options ?? record.options_json) as unknown[])
    : [];
  return {
    request_id: asString(record.request_id ?? record.id),
    run_id: asString(record.run_id),
    status: asString(record.status, "pending"),
    question: asString(record.question),
    reason: asString(record.reason) || undefined,
    options: options.map((option, index) => {
      const item = asRecord(option);
      return {
        option_id: asString(item.option_id ?? item.id, `option_${index + 1}`),
        label: asString(item.label ?? item.title ?? item.option_id ?? item.id, `选项 ${index + 1}`),
        description: asString(item.description) || undefined,
        recommended: item.recommended === true || undefined,
      };
    }),
    allow_free_text: Boolean(record.allow_free_text),
    selection_mode: record.selection_mode === "multiple" ? "multiple" : "single",
    min_selections: Math.max(0, Number(record.min_selections) || 0),
    max_selections:
      record.selection_mode === "multiple" ? Math.max(0, Number(record.max_selections) || 0) : 1,
    allow_skip: record.allow_skip !== false,
    created_at: asString(record.created_at) || undefined,
  };
}
