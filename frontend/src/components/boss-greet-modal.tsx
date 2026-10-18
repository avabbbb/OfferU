"use client";

// 海投：搜一页岗位 → 按简历打分、高分默认勾选 → 逐个打招呼，成功的记进总表。
import { useEffect, useState } from "react";
import { Modal, ModalBody, ModalContent, ModalHeader } from "@heroui/react";
import { getBossGreet, searchBossJobs, startBossGreet, type BossGreet, type BossJob, type BossSearch } from "@/lib/bossGreet";
import { safeClientErrorMessage } from "@/lib/safe-error";

const STATUS = { waiting: "等待", sending: "发送中…", done: "已打招呼", failed: "没发出去", skipped: "已停止" } as const;

export function BossGreetModal({ open, onClose, onGreeted }: { open: boolean; onClose: () => void; onGreeted: () => void }) {
  const [keyword, setKeyword] = useState("");
  const [city, setCity] = useState("全国");
  const [result, setResult] = useState<BossSearch | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [run, setRun] = useState<BossGreet | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setError("");
    getBossGreet().then((g) => setRun(g.items.length ? g : null)).catch(() => undefined);
  }, [open]);

  useEffect(() => {
    if (!open || !run?.running) return;
    const timer = window.setInterval(async () => {
      const next = await getBossGreet().catch(() => null);
      if (!next) return;
      setRun(next);
      if (!next.running) onGreeted();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [open, run?.running, onGreeted]);

  const search = async () => {
    setBusy(true);
    setError("");
    try {
      const data = await searchBossJobs(keyword.trim(), city.trim() || "全国");
      setResult(data);
      setPicked(new Set(data.items.filter((i) => i.picked).slice(0, data.left).map((i) => i.encrypt_job_id)));
      setRun(null);
    } catch (cause) {
      setError(safeClientErrorMessage(cause, "搜索失败"));
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (!result) return;
    setBusy(true);
    setError("");
    try {
      setRun(await startBossGreet(result.items.filter((i) => picked.has(i.encrypt_job_id))));
    } catch (cause) {
      setError(safeClientErrorMessage(cause, "没能开始"));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (job: BossJob) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(job.encrypt_job_id)) next.delete(job.encrypt_job_id);
      else next.add(job.encrypt_job_id);
      return next;
    });

  const left = run?.left ?? result?.left ?? 0;
  const over = picked.size > left;
  const btn = "rounded-md px-3 py-1.5 text-[13px] font-medium disabled:opacity-40";
  const field = "h-8 rounded-md border border-[var(--border)] bg-transparent px-2.5 text-[13.5px] outline-none focus:border-[var(--border-strong)]";

  return (
    <Modal isOpen={open} onClose={onClose} size="2xl" scrollBehavior="inside">
      <ModalContent className="rounded-xl bg-[var(--surface)]">
        <ModalHeader className="text-[16px] font-semibold">BOSS 海投</ModalHeader>
        <ModalBody className="pb-6 text-[13.5px] leading-relaxed text-[var(--foreground)]" data-testid="boss-greet-modal">
          {run ? (
            <>
              <p className="text-[var(--foreground-muted)]">
                {run.running ? "每两个之间随机等 20–60 秒。可以关掉这个窗口，OfferU 会在后台发完。" : `这一批发完了，打过招呼的已记进投递总表。今天还能打 ${run.left} 个招呼。`}
              </p>
              <ul className="divide-y divide-[var(--border)]" data-testid="boss-greet-progress">
                {run.items.map((item) => (
                  <li key={item.encrypt_job_id} className="flex items-baseline justify-between gap-3 py-2">
                    <span className="min-w-0 truncate">
                      {item.title} <span className="text-[var(--foreground-muted)]">· {item.company}</span>
                    </span>
                    <span className={`shrink-0 text-[12.5px] ${item.status === "failed" ? "text-[var(--danger,#b42318)]" : "text-[var(--foreground-muted)]"}`} title={item.message}>
                      {STATUS[item.status]}
                    </span>
                  </li>
                ))}
              </ul>
              {!run.running && (
                <div className="flex justify-end">
                  <button type="button" onClick={() => setRun(null)} className={`${btn} border border-[var(--border-strong)] hover:bg-[var(--surface-muted)]`}>
                    再搜一批
                  </button>
                </div>
              )}
            </>
          ) : (
            <>
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (keyword.trim()) void search();
                }}
              >
                <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="岗位关键词，例如 数据分析实习" className={`${field} min-w-0 flex-1`} data-testid="boss-greet-keyword" />
                <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="城市" className={`${field} w-24`} />
                <button type="submit" disabled={busy || !keyword.trim()} className={`${btn} border border-[var(--border-strong)] hover:bg-[var(--surface-muted)]`} data-testid="boss-greet-search">
                  {busy && !result ? "搜索中…" : "搜索"}
                </button>
              </form>
              {result && (
                <>
                  <p className="text-[12.5px] text-[var(--foreground-muted)]">
                    {result.resume_title ? `按「${result.resume_title}」里提到的技能打分，60 分以上默认勾选` : "还没有简历，没法打分，请自己勾选"} · 今天还能打 {result.left} 个招呼
                  </p>
                  <ul className="divide-y divide-[var(--border)]" data-testid="boss-greet-list">
                    {result.items.map((job) => (
                      <li key={job.encrypt_job_id}>
                        <label className={`flex gap-3 py-2.5 ${job.greeted ? "opacity-50" : "cursor-pointer"}`}>
                          <input type="checkbox" className="mt-1" disabled={job.greeted} checked={picked.has(job.encrypt_job_id)} onChange={() => toggle(job)} />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-baseline justify-between gap-3">
                              <span className="truncate font-medium">
                                {job.title} <span className="font-normal text-[var(--foreground-muted)]">· {job.company}</span>
                              </span>
                              <span className="shrink-0 tabular-nums text-[12.5px] text-[var(--foreground-muted)]">{job.greeted ? "已打过招呼" : `${job.score} 分`}</span>
                            </span>
                            <span className="block truncate text-[12.5px] text-[var(--foreground-muted)]">
                              {[job.salary, job.city].filter(Boolean).join(" · ")}
                              {job.hits.length > 0 && ` · 简历里有 ${job.hits.join("、")}`}
                              {job.misses.length > 0 && ` · 没提到 ${job.misses.join("、")}`}
                            </span>
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                  <div className="rounded-lg border border-[var(--border)] px-3 py-2.5 text-[var(--foreground-muted)]">
                    打招呼会用你的 BOSS 账号给 HR 发默认招呼语，发出去就撤不回。boss-cli 不是 BOSS 官方工具，发得多账号可能被限制。
                    <label className="mt-1.5 flex items-center gap-2 text-[var(--foreground)]">
                      <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} data-testid="boss-greet-agree" />
                      我了解风险，账号问题由我自己承担
                    </label>
                  </div>
                  <div className="flex items-center justify-end gap-3">
                    {over && <span className="text-[12.5px] text-[var(--danger,#b42318)]">超出今天剩余的 {left} 个</span>}
                    <button type="button" disabled={!agreed || busy || picked.size === 0 || over} onClick={start} className={`${btn} bg-[var(--foreground)] text-[var(--surface)]`} data-testid="boss-greet-start">
                      给 {picked.size} 个岗位打招呼
                    </button>
                  </div>
                </>
              )}
            </>
          )}
          {error && <p className="text-[12.5px] text-[var(--danger,#b42318)]">{error}</p>}
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}
