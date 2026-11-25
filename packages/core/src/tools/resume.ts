// tailor_resume / export_resume_pdf: the same tailoring pipeline the resume page runs
// (draft → review → grounding checks, one undoable change) and the runtime's PDF export,
// as registry tools so the Agent and CLI reach them too.

import { runTailor, type TailorEvent } from "../resume/tailor";
import { CoreError, type Json, type StoredRecord } from "../types";
import type { ToolDeps } from "./deps";

type Args = Record<string, unknown>;
type Done = Extract<TailorEvent, { type: "done" }>;

const NO_PDF = "这个运行环境不能导出 PDF：在本机 OfferU（桌面伴侣）里导出，或在简历页用浏览器打印成 PDF";

/** The base resume to tailor: the given id, else this job's tailored resume, else the newest master resume. */
async function baseResume(deps: ToolDeps, id: unknown, jobId: number | null): Promise<StoredRecord> {
  if (typeof id === "number") {
    const doc = await deps.store.get("doc", id);
    if (!doc || doc.kind !== "resume") throw new CoreError(`简历 #${id} 不存在`, "not_found");
    return doc;
  }
  const resumes = (await deps.store.all("doc")).filter((doc) => doc.kind === "resume").sort((a, b) => b.id - a.id);
  const picked = (jobId ? resumes.find((doc) => doc.job_id === jobId) : undefined) ?? resumes.find((doc) => !doc.job_id);
  if (!picked) throw new CoreError("还没有简历：先导入或新建一份主简历（doc kind=resume）", "not_found");
  return picked;
}

/** Drain runTailor to its done event; an error event becomes a CoreError. Returns a summary, not the whole body. */
export async function tailorResume(deps: ToolDeps, args: Args): Promise<Json> {
  if (!deps.llm) throw new CoreError("没配模型：按岗位改写简历要调模型，先在设置里填模型服务", "unsupported");
  const jobId = typeof args.job_id === "number" ? args.job_id : null;
  const doc = await baseResume(deps, args.id, jobId);
  let done: Done | null = null;
  for await (const event of runTailor({
    store: deps.store,
    llm: deps.llm,
    files: deps.files ?? null,
    measure: deps.measure ?? null,
    actor: deps.ctx.actor,
    signal: deps.signal,
    context: () => deps.ctx,
  }, doc.id, jobId, { reviewOnly: args.review_only === true })) {
    if (event.type === "error" && event.blocked?.length) {
      throw new CoreError(`${event.message.replace(/。草稿在 draft 里$/u, "")}。简历没动；按这些问题调整（保留已确认的经历、不写评估分）后再调一次 tailor_resume，或把问题告诉用户`, "invalid");
    }
    if (event.type === "error" && event.conflict) throw new CoreError(`${event.message.split("；")[0]}；按最新内容再调一次 tailor_resume`, "conflict");
    if (event.type === "error") throw new CoreError(event.message, event.message.includes("正在改写") ? "conflict" : "invalid");
    if (event.type === "done") done = event;
  }
  if (!done) throw new CoreError(deps.signal?.aborted ? "已中止，简历没动" : "改写没有完成，简历没动");
  const saved = await deps.store.get("doc", done.doc_id);
  return {
    doc_id: done.doc_id,
    job_id: saved?.job_id ?? jobId ?? doc.job_id ?? null,
    base_id: doc.id,
    change_id: done.change_id,
    pages: done.pages,
    asks: done.asks,
    notes: done.notes,
    checks: { block: done.checks.block, warn: done.checks.warn, dropped: done.checks.dropped, omitted: done.checks.omitted, ledger: done.checks.ledger ?? [] },
    rounds: done.rounds.map((round) => ({ round: round.round, applied: round.applied.length, skipped: round.skipped.length, error: round.error ?? null })),
    chars: done.body.length,
    next: done.checks.block.length
      ? "checks.block 里有和档案对不上的句子，先给用户看再导出"
      : "export_resume_pdf(id=doc_id) 导出，或 draft_email(job_id, resume_id=doc_id) 直接带附件写投递邮件；全文用 get(type=doc, id=doc_id)",
  };
}

export async function exportResumePdfTool(deps: ToolDeps, args: Args): Promise<Json> {
  const id = Number(args.id);
  const doc = await deps.store.get("doc", id);
  if (!doc || doc.kind !== "resume") throw new CoreError(`简历 #${id} 不存在`, "not_found");
  if (!deps.exportResumePdf) throw new CoreError(NO_PDF, "unsupported");
  const { path } = await deps.exportResumePdf(id, "");
  return { doc_id: id, job_id: doc.job_id ?? null, path };
}
