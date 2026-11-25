"use client";

// 按岗位改写：简历没绑岗位时先选一个有 JD 的岗位。Agent 先起草（边写边报字数），再由独立的审稿调用给出修改，
// 按原文精确替换，审一轮；随时可取消。整个流程跑完才存成一条「Agent」改动（最近改动里可撤销）；取消、超时、出错简历都不动。
// 审稿因为找不到出处而改掉的内容逐条列出：确实是真的就存进档案，下次改写就有出处了。
// 追问成果：审稿挑出只写了动作、没写结果的句子（最多 3 句），先出一版之后才问；每句可以先不答。
// 回答由模型整理成记忆草稿，一次给你看完，点一次「存进档案」全部写入；再用新成果只跑审稿改一下（不重新起草）。
import { useEffect, useRef, useState } from "react";

import { tool, type Job } from "@/lib/core";
import { Sparkles } from "lucide-react";

import { Button, Select } from "@/components/ui";
import { captureImpact, tailorNotes, tailorResume, type ImpactDraft, type ImpactDropped, type TailorAsk, type TailorChecks, type TailorEdit } from "@/lib/tailor";

type Props = {
  docId: number; jobId: number | null; jobs: Job[]; disabled: boolean; onDone: (docId: number) => Promise<unknown>;
  // 改写开始 / 结束时告诉上层，让左侧表单只读：否则写完那一刻你这边的自动保存会盖掉改写结果。
  onRunning?: (running: boolean) => void;
};

// 主简历改写完会跳到定制简历：Editor 按 doc id 重挂，TailorBar 跟着重挂，组件状态会丢。
// 结果按写入的 doc id 暂存在模块里，新挂载的 TailorBar 取回。
type Result = { message: string; grounding: TailorEdit[]; asks: TailorAsk[]; job: number | null; checks?: TailorChecks | null };
const results = new Map<number, Result>();

export function TailorBar({ docId, jobId, jobs, disabled, onDone, onRunning }: Props) {
  const withJd = jobs.filter((job) => job.jd?.trim());
  const saved = results.get(docId);
  const [picked, setPicked] = useState<number | null>(withJd[0]?.id ?? null);
  const [running, setRunning] = useState(false);
  const [chars, setChars] = useState(0);
  const [phase, setPhase] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(() => saved?.message ?? null);
  const [grounding, setGrounding] = useState<TailorEdit[]>(() => saved?.grounding ?? []);
  const [checks, setChecks] = useState<TailorChecks | null>(() => saved?.checks ?? null);
  const [kept, setKept] = useState<Set<number>>(new Set());
  // 追问：asks → 你回答 → drafts（给你看）→ 存进档案 → 可以再改一下
  const [asks, setAsks] = useState<TailorAsk[]>(() => saved?.asks ?? []);
  const [answers, setAnswers] = useState<string[]>(() => (saved?.asks ?? []).map(() => ""));
  const [drafts, setDrafts] = useState<ImpactDraft[] | null>(null);
  const [dropped, setDropped] = useState<ImpactDropped[]>([]);
  const [busy, setBusy] = useState(false);
  const [stored, setStored] = useState(false);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  // 岗位列表晚于本组件到达时 picked 还是 null：退回第一个有 JD 的岗位（修「下拉是空的」）。
  const target = jobId ?? saved?.job ?? picked ?? withJd[0]?.id ?? null;

  const resetAsks = (next: TailorAsk[]) => {
    setAsks(next);
    setAnswers(next.map(() => ""));
    setDrafts(null);
    setDropped([]);
    setStored(false);
  };

  // 问完（存了或先不答）就清掉简历上挂着的 pending_asks，下次打开不再问。
  const clearPending = (id: number) => tool("save", { type: "doc", id, data: { pending_asks: null } }).catch(() => undefined);

  const start = async (reviewOnly = false) => {
    if (!target) return;
    const controller = new AbortController();
    abort.current = controller;
    setRunning(true);
    onRunning?.(true);
    setChars(0);
    setPhase(reviewOnly ? "用新成果再审一遍…" : null);
    setMessage(null);
    setGrounding([]);
    setChecks(null);
    setKept(new Set());
    resetAsks([]);
    results.delete(docId);
    let outcome = null as string | null; // 在回调里赋值，别让 TS 收窄成 null
    let written = null as number | null;
    let edits: TailorEdit[] = [];
    let verified = null as TailorChecks | null;
    let questions: TailorAsk[] = [];
    try {
      await tailorResume(docId, target, controller.signal, (event) => {
        if (event.type === "delta") setChars((n) => n + event.text.length);
        else if (event.type === "review") {
          setPhase("审稿第 " + event.round + " 轮" + (event.pages ? "（预计 " + event.pages.toFixed(1) + " 页）" : "") + "…");
        } else if (event.type === "error") outcome = event.message;
        else if (event.type === "done") {
          written = event.doc_id;
          const head = event.doc_id === docId ? "已按岗位改好，可在最近改动里撤销" : "已存成这个岗位的定制简历，主简历没动";
          outcome = [head, ...tailorNotes(event)].join("\n");
          edits = event.grounding ?? [];
          questions = reviewOnly ? [] : (event.asks ?? []).slice(0, 3);
          setGrounding(edits);
          verified = event.checks ?? null;
          setChecks(verified);
          resetAsks(questions);
        }
      }, { reviewOnly });
      if (written != null) {
        results.set(written, { message: outcome ?? "", grounding: edits, asks: questions, job: target, checks: verified });
        await onDone(written);
      }
      setMessage(outcome ?? "连接断了，简历没动");
    } catch (error) {
      setMessage(controller.signal.aborted ? "已取消，简历没动" : error instanceof Error ? error.message : "改写失败，简历没动");
    } finally {
      abort.current = null;
      setRunning(false);
      setPhase(null);
      onRunning?.(false);
    }
  };

  const keep = async (index: number, edit: TailorEdit) => {
    try {
      await tool("save", { type: "memory", data: { kind: "note", title: "改写审稿时确认的事实", body: edit.old } });
      setKept((prev) => new Set(prev).add(index));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "没存进档案");
    }
  };

  const forget = () => {
    results.set(docId, { ...(results.get(docId) ?? { message: message ?? "", grounding, job: target }), asks: [] });
    resetAsks([]);
    void clearPending(docId);
  };

  const organize = async () => {
    const given = asks.map((ask, i) => ({ old: ask.old, question: ask.question, answer: answers[i].trim() })).filter((a) => a.answer);
    if (!given.length) return;
    setBusy(true);
    try {
      const out = await captureImpact(given, target);
      setDrafts(out.drafts);
      setDropped(out.dropped);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "整理失败，档案没动");
    } finally {
      setBusy(false);
    }
  };

  // 一次确认，全部草稿写进档案（每条一条可撤销的改动）。
  const storeAll = async () => {
    if (!drafts?.length) return;
    setBusy(true);
    try {
      for (const draft of drafts) {
        await tool("save", draft.memory_id ? { type: "memory", id: draft.memory_id, data: draft.data } : { type: "memory", data: draft.data });
      }
      setStored(true);
      setAsks([]);
      results.set(docId, { ...(results.get(docId) ?? { message: message ?? "", grounding, job: target }), asks: [] });
      void clearPending(docId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "没存进档案");
    } finally {
      setBusy(false);
    }
  };

  const answered = answers.some((a) => a.trim());
  const pickedValue = picked ?? withJd[0]?.id ?? null;

  return (
    <div className="tb" data-running={running || undefined}>
      <div className="tb-run">
        {jobId == null && (withJd.length ? (
          <Select aria-label="按哪个岗位改" className="tb-select" disabled={running}
            value={pickedValue != null ? String(pickedValue) : undefined} onValueChange={(v) => setPicked(Number(v))}
            options={withJd.map((job) => ({ value: String(job.id), label: job.label ?? [job.company, job.title].filter(Boolean).join(" · ") }))} />
        ) : <span className="tb-muted">先在岗位页贴上 JD，才能按岗位改</span>)}
        {running ? (
          <>
            <span className="tb-progress ou-shimmer" role="status">{phase ?? "Agent 在写… " + chars + " 字"}</span>
            <Button variant="ghost" className="tb-action" onClick={() => abort.current?.abort()}>取消</Button>
          </>
        ) : (
          <Button variant="secondary" className="tb-action tb-go" disabled={disabled || !target}
            title={disabled ? "等当前修改存好再改写" : undefined} onClick={() => void start()}>
            <Sparkles size={15} aria-hidden />按岗位改写
          </Button>
        )}
      </div>
      {message && <p className="tb-message" role="status">{message}</p>}
      {grounding.length > 0 && (
        <ul className="tb-list">
          {grounding.map((edit, index) => (
            <li key={index} className="tb-line">
              <span>审稿找不到出处，改掉了「{edit.old}」{edit.reason ? "：" + edit.reason : ""}</span>
              {kept.has(index) ? <span className="tb-done">已存进档案，再改写一次就能用上</span> : (
                <button type="button" className="tb-link" onClick={() => void keep(index, edit)}>是真的，存进档案</button>
              )}
            </li>
          ))}
        </ul>
      )}
      {checks && (checks.block.length > 0 || checks.warn.length > 0 || checks.unchecked || (checks.dropped?.length ?? 0) > 0) && (
        <ul className="tb-list tb-checks" aria-label="改写结果核对">
          <li className="tb-lead">程序把改好的简历逐行对了一遍档案和原简历，只提醒，简历没动：</li>
          {checks.unchecked && <li>{checks.unchecked}</li>}
          {checks.block.map((check, i) => (
            <li key={"b" + i} className="tb-flag" data-tone="block">「{check.line}」{check.detail}，投之前请改掉或补进档案</li>
          ))}
          {checks.warn.map((check, i) => (
            <li key={"w" + i} className="tb-flag" data-tone="warn">留意：「{check.line}」{check.detail}</li>
          ))}
          {(checks.dropped ?? []).map((item) => (
            <li key={"d" + item.memory_id} className="tb-flag" data-tone="warn">「{item.title}」留在简历里，但档案里的 {item.missing.join("、")} 没写进去，确认是有意删的再投</li>
          ))}
        </ul>
      )}
      {!running && asks.length > 0 && !drafts && (
        <div className="tb-asks" aria-label="追问成果">
          <p className="tb-lead">这几句只写了做了什么，补一句结果会更有说服力。记不清数字就写「大概……」或「没有数据，但结果是……」，不想答就空着。</p>
          {asks.map((ask, i) => (
            <label key={i} className="tb-ask">
              <span className="tb-quote">「{ask.old.replace(/^[-\u002a·•]\s{0,3}/, "")}」</span>
              <span className="tb-question">{ask.question}</span>
              <textarea aria-label={ask.question} rows={2} value={answers[i]} disabled={busy}
                onChange={(e) => setAnswers((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))}
                className="tb-answer" />
            </label>
          ))}
          <div className="tb-foot">
            <Button variant="secondary" className="tb-action" disabled={busy || !answered} onClick={() => void organize()}>
              {busy ? "整理中…" : "整理一下"}
            </Button>
            <Button variant="ghost" className="tb-action" disabled={busy} onClick={forget}>先不答</Button>
          </div>
        </div>
      )}
      {!running && drafts && !stored && (
        <div className="tb-asks" aria-label="记忆草稿">
          {drafts.length > 0 && <p className="tb-lead">我会这样记进档案（带上你的原话和今天的日期），标了「留意」的请看一眼再存：</p>}
          {drafts.map((draft, i) => (
            <div key={i} className="tb-draft">
              <span className="tb-question">{draft.title}{draft.memory_id ? "（补到已有经历）" : "（新建一条）"}</span>
              {draft.answers.map((a, j) => (
                <span key={j} className="tb-add">+ {a.add}
                  {a.flags?.length ? <span className="tb-flag" data-tone="warn">（留意：{a.flags.join("；")}）</span> : null}
                </span>
              ))}
            </div>
          ))}
          {dropped.map((d, i) => (
            <span key={i} className="tb-add tb-muted">没记：「{d.quote}」，{d.why}</span>
          ))}
          <div className="tb-foot">
            {drafts.length > 0 && (
              <Button variant="secondary" className="tb-action" disabled={busy} onClick={() => void storeAll()}>
                {busy ? "存入中…" : "存进档案"}
              </Button>
            )}
            <Button variant="ghost" className="tb-action" disabled={busy} onClick={() => { setDrafts(null); setDropped([]); }}>改一下</Button>
          </div>
        </div>
      )}
      {!running && stored && (
        <div className="tb-foot tb-stored">
          <span>已存进档案，可在最近改动里撤销。</span>
          <Button variant="ghost" className="tb-action" disabled={disabled || !target} onClick={() => void start(true)}>用新成果再改一下</Button>
        </div>
      )}
    </div>
  );
}

/** 这份简历有没有刚跑完、还没看完的改写结果（换到定制简历后重挂时用来默认展开）。 */
export const hasTailorResult = (docId: number) => results.has(docId);
