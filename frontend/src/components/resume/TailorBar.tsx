"use client";

// 按岗位改写：简历没绑岗位时先选一个有 JD 的岗位。Agent 先起草（边写边报字数），再由独立的审稿调用给出修改，
// 按原文精确替换，最多两轮；随时可取消。整个流程跑完才存成一条「Agent」改动（最近改动里可撤销）；取消、超时、出错简历都不动。
// 审稿因为找不到出处而改掉的内容逐条列出：确实是真的就存进档案，下次改写就有出处了。
import { useEffect, useRef, useState } from "react";

import { tool, type Job } from "@/lib/core";
import { tailorNotes, tailorResume, type TailorEdit } from "@/lib/tailor";

type Props = {
  docId: number; jobId: number | null; jobs: Job[]; disabled: boolean; onDone: (docId: number) => Promise<unknown>;
  // 改写开始 / 结束时告诉上层，让左侧表单只读：否则写完那一刻你这边的自动保存会盖掉改写结果。
  onRunning?: (running: boolean) => void;
};

const muted = "text-[var(--foreground-muted)]";
const action = "text-[12.5px] font-medium text-[var(--foreground)] disabled:text-[var(--foreground-muted)]";

export function TailorBar({ docId, jobId, jobs, disabled, onDone, onRunning }: Props) {
  const withJd = jobs.filter((job) => job.jd?.trim());
  const [picked, setPicked] = useState<number | null>(withJd[0]?.id ?? null);
  const [running, setRunning] = useState(false);
  const [chars, setChars] = useState(0);
  const [phase, setPhase] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [grounding, setGrounding] = useState<TailorEdit[]>([]);
  const [kept, setKept] = useState<Set<number>>(new Set());
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const target = jobId ?? picked;

  const start = async () => {
    if (!target) return;
    const controller = new AbortController();
    abort.current = controller;
    setRunning(true);
    onRunning?.(true);
    setChars(0);
    setPhase(null);
    setMessage(null);
    setGrounding([]);
    setKept(new Set());
    let outcome = null as string | null; // 在回调里赋值，别让 TS 收窄成 null
    let written = null as number | null;
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
          setGrounding(event.grounding ?? []);
        }
      });
      if (written != null) await onDone(written);
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

  return (
    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[12px]" style={{ fontSize: 12 }}>
      {jobId == null && (withJd.length ? (
        <select aria-label="按哪个岗位改" value={picked ?? ""} disabled={running} onChange={(e) => setPicked(Number(e.target.value))}
          className="max-w-[220px] truncate bg-transparent text-[12px] text-[var(--foreground)] outline-none">
          {withJd.map((job) => <option key={job.id} value={job.id}>{job.label ?? [job.company, job.title].filter(Boolean).join(" · ")}</option>)}
        </select>
      ) : <span className={muted}>先在岗位页贴上 JD，才能按岗位改</span>)}
      {running ? (
        <>
          <span className={muted}>{phase ?? "Agent 在写… " + chars + " 字"}</span>
          <button type="button" className={action} style={{ fontSize: 12.5 }} onClick={() => abort.current?.abort()}>取消</button>
        </>
      ) : (
        <button type="button" className={action} style={{ fontSize: 12.5 }} disabled={disabled || !target}
          title={disabled ? "等当前修改存好再改写" : undefined} onClick={() => void start()}>按岗位改写</button>
      )}
      {message && <span className={muted + " basis-full whitespace-pre-line text-left"}>{message}</span>}
      {grounding.length > 0 && (
        <ul className={muted + " basis-full text-left"}>
          {grounding.map((edit, index) => (
            <li key={index} className="flex flex-wrap items-baseline gap-x-2">
              <span>审稿找不到出处，改掉了「{edit.old}」{edit.reason ? "：" + edit.reason : ""}</span>
              {kept.has(index) ? <span>已存进档案，再改写一次就能用上</span> : (
                <button type="button" className={action} style={{ fontSize: 12.5 }} onClick={() => void keep(index, edit)}>是真的，存进档案</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
