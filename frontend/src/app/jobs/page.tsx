"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { JobsGantt } from "@/components/jobs/JobsGantt";
import { JobsTable } from "@/components/jobs/JobsTable";
import { RecordDrawer } from "@/components/jobs/RecordDrawer";
import { ViewBar } from "@/components/jobs/ViewBar";
import { JobBoard } from "@/components/today/JobBoard";
import { type Event, JOB_STATUS, type Job, refreshAll, useTool, write } from "@/lib/core";
import { evaluateJobs } from "@/lib/evaluate";
import { applyView, defaultState, defaultView, loadViews, saveViews, type ViewConfig, type ViewKind, type ViewState } from "@/lib/jobView";

const field = "rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-[13px] text-[var(--foreground)] outline-none focus:border-[var(--foreground-muted)]";

// 添加岗位：贴链接或 JD 让后端抓正文、拆字段（抓不到就报错，不存空壳）；也能手动填。
function AddJob() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [company, setCompany] = useState("");
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");

  const paste = async () => {
    setBusy(true); setError("");
    try {
      const { record, existed } = await write<{ record: Job; existed?: boolean }>("add_job", { text: text.trim() });
      setText("");
      // 存完接着评估，报告出在岗位页；评估失败只提示，不影响已存的岗位。
      if (existed) { setError("这个岗位之前存过，已合并到原记录，没有重复新建"); return; }
      void write("evaluate_jobs", { ids: [record.id] }).catch((e) => setError("岗位已存，评估没做完：" + (e instanceof Error ? e.message : String(e))));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    await write("save", { type: "job", data: { company: company.trim() || null, title: title.trim() || null, url: url.trim() || null } });
    setCompany(""); setTitle(""); setUrl("");
  };

  return (
    <div className="space-y-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
      <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void paste(); }}>
        <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={3} aria-label="岗位链接或 JD"
          placeholder="贴岗位链接、整段 JD，或只写「公司 岗位」（会去官网找）" style={{ fontSize: 13 }} className={field + " block w-full resize-y"}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && text.trim() && !busy) { e.preventDefault(); void paste(); } }} />
        <div className="flex items-center gap-3">
          <button type="submit" style={{ fontSize: 13 }} disabled={!text.trim() || busy} className="rounded-md bg-[var(--foreground)] px-3 py-1.5 text-[13px] font-medium text-[var(--background)] disabled:opacity-40">{busy ? "正在读…" : "添加"}</button>
          {error && <span role="alert" className="text-[12.5px] text-[var(--foreground)]">{error}</span>}
        </div>
      </form>
      <details className="text-[13px] text-[var(--foreground-muted)]">
        <summary className="cursor-pointer select-none">手动填</summary>
        <form className="mt-2 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="公司" aria-label="公司" style={{ fontSize: 13 }} className={field + " w-36"} />
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="岗位" aria-label="岗位" style={{ fontSize: 13 }} className={field + " w-48"} />
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="链接（可选）" aria-label="链接" style={{ fontSize: 13 }} className={field + " min-w-[180px] flex-1"} />
          <button type="submit" style={{ fontSize: 13 }} disabled={!company.trim() || !title.trim()} className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[13px] text-[var(--foreground)] disabled:opacity-40">添加</button>
        </form>
      </details>
    </div>
  );
}

// 岗位多维表：表格 / 看板 / 甘特三个视图，各自记住筛选、分组、排序、字段（存在本机浏览器）。
export default function JobsPage() {
  const { data } = useTool<{ items: Job[] }>("list", { type: "job", limit: 500 }, 5000);
  const jobs = useMemo(() => data?.items ?? [], [data]);
  // 甘特的节点：所有带日期的事项，含已完成（画淡）。
  const { data: eventData } = useTool<{ items: Event[] }>("list", { type: "event", limit: 500 }, 5000);
  const events = useMemo(() => eventData?.items ?? [], [eventData]);
  const [state, setState] = useState<ViewState>(defaultState);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [ranking, setRanking] = useState(false);
  const [rankProgress, setRankProgress] = useState("");
  const [error, setError] = useState("");

  useEffect(() => { setState(loadViews()); setLoaded(true); }, []);
  useEffect(() => { if (loaded) saveViews(state); }, [state, loaded]);

  const view = state.views[state.active];
  const patch = useCallback((p: Partial<ViewConfig>) => {
    setState((s) => ({ ...s, views: { ...s.views, [s.active]: { ...s.views[s.active], ...p } } }));
  }, []);
  const setActive = (active: ViewKind) => setState((s) => ({ ...s, active }));
  const reset = () => setState((s) => ({ ...s, views: { ...s.views, [s.active]: defaultView(s.active) } }));

  const shown = useMemo(() => applyView(jobs, view, search), [jobs, view, search]);
  const tagOptions = useMemo(() => [...new Set(jobs.flatMap((j) => j.tags ?? []))].sort((a, b) => a.localeCompare(b, "zh")), [jobs]);
  const unscored = jobs.filter((job) => job.score == null && job.status !== "rejected" && job.status !== "closed").length;
  const index = openId == null ? -1 : shown.findIndex((j) => j.id === openId);
  const open = openId == null ? undefined : index >= 0 ? shown[index] : jobs.find((j) => j.id === openId);
  const close = useCallback(() => setOpenId(null), []);

  // 给没评过的岗位逐个出评估报告（存在岗位下），分数写回岗位。
  const rank = async () => {
    setRanking(true); setError(""); setRankProgress("");
    try {
      await evaluateJobs(null, new AbortController().signal, (event) => {
        if (event.type === "start") setRankProgress(`0/${event.total}`);
        if (event.type === "job_start") setRankProgress(`${event.index}/${event.total}`);
        if (event.type === "done") void refreshAll();
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRanking(false); setRankProgress("");
    }
  };

  return (
    <div className="ou-page ou-page-wide space-y-4">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 className="text-[24px] font-semibold tracking-tight text-[var(--foreground)]">岗位</h1>
        {unscored > 0 && (
          <span className="flex items-center gap-2 text-[13px] text-[var(--foreground-muted)]">
            {unscored} 个岗位还没评估
            <button type="button" onClick={() => void rank()} disabled={ranking} className="ou-button ou-button-secondary ou-button-sm">{ranking ? (rankProgress ? `正在评估 ${rankProgress}…` : "正在评估…") : "评估未评估的"}</button>
          </span>
        )}
        {error && <span role="alert" className="text-[12.5px] text-[var(--foreground)]">{error}</span>}
      </div>

      <ViewBar state={state} jobs={jobs} search={search} adding={adding} setActive={setActive} setSearch={setSearch}
        patch={patch} reset={reset} onAdd={() => setAdding((a) => !a)} />
      {adding && <AddJob />}

      {state.active === "table" && (
        data && !jobs.length
          ? <p className="text-[13.5px] text-[var(--foreground-muted)]">还没有岗位。点右上角「添加岗位」贴一个链接或 JD。</p>
          : <JobsTable jobs={shown} view={view} patch={patch} openId={openId} onOpen={setOpenId} onAdd={() => setAdding(true)} />
      )}
      {state.active === "board" && <JobBoard embedded />}
      {state.active === "gantt" && <JobsGantt jobs={shown} events={events} view={view} openId={openId} onOpen={setOpenId} />}

      {open && (
        <RecordDrawer job={open} index={index} total={shown.length} tagOptions={tagOptions} onClose={close}
          onPrev={() => { if (index > 0) setOpenId(shown[index - 1].id); }}
          onNext={() => { if (index >= 0 && index < shown.length - 1) setOpenId(shown[index + 1].id); }} />
      )}
    </div>
  );
}
