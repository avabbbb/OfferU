"use client";

// 按岗位改写：简历没绑岗位时先选一个有 JD 的岗位；Agent 边写边报字数，随时可取消。
// 只有写完才存成一条「Agent」改动（最近改动里可撤销）；取消、超时、出错简历都不动。
import { useEffect, useRef, useState } from "react";

import type { Job } from "@/lib/core";
import { tailorResume } from "@/lib/tailor";

type Props = { docId: number; jobId: number | null; jobs: Job[]; disabled: boolean; onDone: () => Promise<unknown> };

const muted = "text-[var(--foreground-muted)]";
const action = "text-[12.5px] font-medium text-[var(--foreground)] disabled:text-[var(--foreground-muted)]";

export function TailorBar({ docId, jobId, jobs, disabled, onDone }: Props) {
  const withJd = jobs.filter((job) => job.jd?.trim());
  const [picked, setPicked] = useState<number | null>(withJd[0]?.id ?? null);
  const [running, setRunning] = useState(false);
  const [chars, setChars] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const target = jobId ?? picked;

  const start = async () => {
    if (!target) return;
    const controller = new AbortController();
    abort.current = controller;
    setRunning(true);
    setChars(0);
    setMessage(null);
    let outcome = null as string | null; // 在回调里赋值，别让 TS 收窄成 null
    try {
      await tailorResume(docId, target, controller.signal, (event) => {
        if (event.type === "delta") setChars((n) => n + event.text.length);
        else if (event.type === "error") outcome = event.message;
        else if (event.type === "done") outcome = "已按岗位改好，可在最近改动里撤销";
      });
      if (outcome === "已按岗位改好，可在最近改动里撤销") await onDone();
      setMessage(outcome ?? "连接断了，简历没动");
    } catch (error) {
      setMessage(controller.signal.aborted ? "已取消，简历没动" : error instanceof Error ? error.message : "改写失败，简历没动");
    } finally {
      abort.current = null;
      setRunning(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--border)] px-4 py-2 text-[12px]" style={{ fontSize: 12 }}>
      {jobId == null && (withJd.length ? (
        <select aria-label="按哪个岗位改" value={picked ?? ""} disabled={running} onChange={(e) => setPicked(Number(e.target.value))}
          className="max-w-[220px] truncate bg-transparent text-[12px] text-[var(--foreground)] outline-none">
          {withJd.map((job) => <option key={job.id} value={job.id}>{job.label ?? [job.company, job.title].filter(Boolean).join(" · ")}</option>)}
        </select>
      ) : <span className={muted}>先在岗位页贴上 JD，才能按岗位改</span>)}
      {running ? (
        <>
          <span className={muted}>Agent 在写… {chars} 字</span>
          <button type="button" className={action} style={{ fontSize: 12.5 }} onClick={() => abort.current?.abort()}>取消</button>
        </>
      ) : (
        <button type="button" className={action} style={{ fontSize: 12.5 }} disabled={disabled || !target}
          title={disabled ? "等当前修改存好再改写" : undefined} onClick={() => void start()}>按岗位改写</button>
      )}
      {message && <span className={muted}>{message}</span>}
    </div>
  );
}
