// Resume rules for saving a doc (Python tools._check doc branch + tools._with_resume).
// Called from operations.saveRecord so every writer (workbench, agent tools, tailor) gets them.

import type { CoreStore, Json } from "../types";
import { CoreError } from "../types";
import { normalizeResume, resumeFromMarkdown, resumeToMarkdown } from "./model";
import { pyStr } from "./py";
import { checkStyle, LEGACY_TEMPLATE } from "./style";

const ASK_FIELDS = ["old", "why", "question"];

/** doc.pending_asks（改写时追问成果、还没回答的句子）：最多 3 项，每项 {old, why, question} 都是字符串。 */
export function checkAsks(asks: unknown): void {
  if (!Array.isArray(asks) || asks.length > 3) throw new CoreError("doc.pending_asks 要是数组，最多 3 项");
  asks.forEach((item, index) => {
    const ok = typeof item === "object" && item !== null && !Array.isArray(item)
      && Object.keys(item).every((k) => ASK_FIELDS.includes(k))
      && Object.values(item).every((v) => typeof v === "string");
    if (!ok) throw new CoreError(`doc.pending_asks[${index}] 只能有 ${ASK_FIELDS.join(", ")}，值是字符串`);
  });
}

/** doc.template (legacy), doc.style, doc.pending_asks. */
export function checkResumeDocFields(data: Json): void {
  if (data.template !== undefined && data.template !== null && !(typeof data.template === "string" && data.template in LEGACY_TEMPLATE)) {
    throw new CoreError(`doc.template 只能是 ${Object.keys(LEGACY_TEMPLATE).join(", ")}`);
  }
  if (data.style !== undefined && data.style !== null) checkStyle(data.style);
  if (data.pending_asks !== undefined && data.pending_asks !== null) checkAsks(data.pending_asks);
}

/**
 * 简历以 doc.resume 为准，body 从它派生；只给 body（agent / 旧代码）的简历就解析成 resume（Python tools._with_resume）。
 * existingKind: kind of the record being updated, when data does not carry one. Same shape as core-tools'
 * ResumeDocNormalizer hook, so it can be registered with setResumeDocNormalizer after the merge.
 */
export function normalizeResumeDoc(data: Json, existingKind: string | undefined): Json {
  let resume;
  if (data.resume !== undefined && data.resume !== null) {
    resume = normalizeResume(data.resume);
  } else {
    const kind = data.kind || existingKind;
    if (data.body === undefined || data.body === null || kind !== "resume") return data;
    resume = resumeFromMarkdown(pyStr(data.body));
  }
  return { ...data, resume, body: resumeToMarkdown(resume) };
}

export async function withResume(store: CoreStore, data: Json, id: number | undefined): Promise<Json> {
  const needKind = (data.resume === undefined || data.resume === null) && !data.kind && id !== undefined;
  const existing = needKind ? (await store.get("doc", id))?.kind : undefined;
  return normalizeResumeDoc(data, typeof existing === "string" ? existing : undefined);
}
