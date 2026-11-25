"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import "@/styles/jobs.css";

import { JobsCalendar } from "@/components/jobs/JobsCalendar";
import { JobsGallery } from "@/components/jobs/JobsGallery";
import { JobsGantt } from "@/components/jobs/JobsGantt";
import { JobsTable } from "@/components/jobs/JobsTable";
import { RecordDrawer } from "@/components/jobs/RecordDrawer";
import { JobsList, ModeTrack } from "@/components/jobs/JobsList";
import { ViewBar } from "@/components/jobs/ViewBar";
import { DisclosurePanel } from "@/components/settings/SettingsLayout";
import { JobBoard, createJob } from "@/components/today/JobBoard";
import { Plus } from "lucide-react";
import { type Event, type Job, refreshAll, useTool, write } from "@/lib/core";
import { evaluateJobs } from "@/lib/evaluate";
import { boardColumns, boardGroupField, groupPatch, hiddenCardFields } from "@/lib/jobBoard";
import { VIEW_KINDS, VIEW_NAME, applyView, defaultState, defaultView, loadViews, saveViews, type ViewConfig, type ViewKind, type ViewState } from "@/lib/jobView";

// 添加岗位：贴链接或 JD 让后端抓正文、拆字段（抓不到就报错，不存空壳）；也能手动填（折叠在「手动填」里）。
// 打开时它的「添加」是这一屏唯一的墨黑按钮，页头的按钮退成文字「收起」。
function AddJob() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [manual, setManual] = useState(false);
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
    <div className="jb-add" data-testid="jobs-add">
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void paste(); }}>
        <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={3} aria-label="岗位链接或 JD"
          placeholder="贴岗位链接、整段 JD，或只写「公司 岗位」（会去官网找）" className="jb-textarea"
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && text.trim() && !busy) { e.preventDefault(); void paste(); } }} />
        <div className="jb-add-row">
          <button type="submit" disabled={!text.trim() || busy} className="jb-primary">{busy ? "正在读…" : "添加"}</button>
          <button type="button" className="jb-text" aria-expanded={manual} onClick={() => setManual((v) => !v)}>手动填</button>
          {error && <span role="alert" className="jb-alert">{error}</span>}
        </div>
      </form>
      <DisclosurePanel open={manual}>
        <form className="jb-add-manual" onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="公司" aria-label="公司" className="jb-field" />
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="岗位" aria-label="岗位" className="jb-field" />
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="链接（可选）" aria-label="链接" className="jb-field" />
          <button type="submit" disabled={!company.trim() || !title.trim()} className="jb-text">添加</button>
        </form>
      </DisclosurePanel>
    </div>
  );
}

type Mode = "list" | ViewKind;
const MODE_KEY = "offeru.jobs.mode.v1";
const MODES: Array<{ value: Mode; label: string }> = [{ value: "list", label: "列表" }, ...VIEW_KINDS.map((k) => ({ value: k as Mode, label: VIEW_NAME[k] }))];

// 岗位：默认是「列表」（搜索 + 阶段 chip + 排序，宽屏列表 + 详情双栏，窄屏推入详情）；
// 表格 / 看板 / 甘特 / 日历 / 画廊是多维表视图，各自记住筛选、分组、排序、字段（存在本机浏览器），收在同一条视图分段里。
export default function JobsPage() {
  const { data } = useTool<{ items: Job[] }>("list", { type: "job", limit: 500 }, 5000);
  const jobs = useMemo(() => data?.items ?? [], [data]);
  // 甘特的节点：所有带日期的事项，含已完成（画淡）。
  const { data: eventData } = useTool<{ items: Event[] }>("list", { type: "event", limit: 500 }, 5000);
  const events = useMemo(() => eventData?.items ?? [], [eventData]);
  const [state, setState] = useState<ViewState>(defaultState);
  const [mode, setMode] = useState<Mode>("list");
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [ranking, setRanking] = useState(false);
  const [rankProgress, setRankProgress] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const saved = loadViews();
    // #/jobs?view=calendar（以及旧的 #/calendar）直接打开对应视图。
    const want = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("view");
    let savedMode: string | null = null;
    try { savedMode = localStorage.getItem(MODE_KEY); } catch { /* 忽略 */ }
    if (VIEW_KINDS.includes(want as ViewKind)) {
      setState({ ...saved, active: want as ViewKind });
      setMode(want as ViewKind);
    } else {
      // 上次停在哪个视图就回到哪个；没记过（或记的是列表）就是列表。
      const kind = VIEW_KINDS.includes(savedMode as ViewKind) ? (savedMode as ViewKind) : null;
      setState(kind ? { ...saved, active: kind } : saved);
      setMode(kind ?? "list");
    }
    setLoaded(true);
  }, []);
  useEffect(() => { if (loaded) saveViews(state); }, [state, loaded]);
  useEffect(() => { if (loaded) { try { localStorage.setItem(MODE_KEY, mode); } catch { /* 忽略 */ } } }, [mode, loaded]);

  const view = state.views[state.active];
  const patch = useCallback((p: Partial<ViewConfig>) => {
    setState((s) => ({ ...s, views: { ...s.views, [s.active]: { ...s.views[s.active], ...p } } }));
  }, []);
  const setActive = (active: ViewKind) => setState((s) => ({ ...s, active }));
  const switchMode = (next: Mode) => {
    setMode(next);
    setOpenId(null);
    if (next !== "list") setActive(next);
  };
  const reset = () => setState((s) => ({ ...s, views: { ...s.views, [s.active]: defaultView(s.active) } }));

  const shown = useMemo(() => applyView(jobs, view, search), [jobs, view, search]);
  const tagOptions = useMemo(() => [...new Set(jobs.flatMap((j) => j.tags ?? []))].sort((a, b) => a.localeCompare(b, "zh")), [jobs]);
  const unscored = jobs.filter((job) => job.score == null && job.status !== "rejected" && job.status !== "closed").length;
  // 看板里 ↑↓ 按列从左到右、列内从上到下走（跳过折叠的列）；其他视图按当前表格顺序。
  const board = state.active === "board";
  const ordered = useMemo(() => (board
    ? boardColumns(shown, boardGroupField(view)).filter((c) => !view.collapsed.includes(c.key)).flatMap((c) => c.jobs)
    : shown), [board, shown, view]);
  const index = openId == null ? -1 : ordered.findIndex((j) => j.id === openId);
  const open = openId == null ? undefined : index >= 0 ? ordered[index] : jobs.find((j) => j.id === openId);
  const drawerHidden = board ? hiddenCardFields(view) : state.active === "table" ? view.hidden : [];
  // 看板「⊕ 添加记录」：在第一列（按状态分组就是「想投」）新建一条空记录，直接在右侧面板里填。
  const addRecord = async () => {
    setError("");
    try {
      const field = boardGroupField(view);
      const first = boardColumns(shown, field)[0];
      const record = await createJob(first ? groupPatch(field, first.value) ?? {} : {});
      setOpenId(record.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "没能新建记录");
    }
  };
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

  const active = jobs.filter((j) => j.status === "applied" || j.status === "test" || j.status === "interview").length;
  const header = ({ inkAdd }: { inkAdd: boolean }) => (
    <div className="flex flex-col gap-4">
      <header className="jb-head">
        <div className="min-w-0">
          <h1 className="jb-title">岗位</h1>
          <div className="jb-sub">
            <span>{data ? (jobs.length ? `${jobs.length} 个岗位 · ${active} 个进行中` : "还没有岗位") : "正在读取…"}</span>
            {unscored > 0 && (
              <button type="button" onClick={() => void rank()} disabled={ranking} className="jb-text" data-size="sm" data-testid="jobs-rank">
                {ranking ? (rankProgress ? `正在评估 ${rankProgress}…` : "正在评估…") : `评估 ${unscored} 个未评估的`}
              </button>
            )}
            {error && <span role="alert" className="jb-error">{error}</span>}
          </div>
        </div>
        <div className="jb-head-actions">
          {adding
            ? <button type="button" onClick={() => setAdding(false)} className="jb-text" data-testid="jobs-add-toggle">收起</button>
            : <button type="button" onClick={() => setAdding(true)} className={inkAdd ? "jb-primary" : "jb-secondary"} data-testid="jobs-add-toggle"><Plus size={16} aria-hidden="true" />添加岗位</button>}
        </div>
      </header>
      <DisclosurePanel open={adding}><AddJob /></DisclosurePanel>
      <div className="jb-bar">
        <div className="jb-modes"><ModeTrack label="视图" value={mode} options={MODES} onChange={switchMode} testId="jobs-mode" /></div>
      </div>
    </div>
  );

  if (mode === "list") {
    return (
      <div className="ou-page ou-page-wide">
        <JobsList header={header} jobs={jobs} loaded={Boolean(data)} search={search} setSearch={setSearch} />
      </div>
    );
  }

  return (
    <div className="ou-page ou-page-wide jb space-y-4">
      {header({ inkAdd: true })}

      <ViewBar state={state} jobs={jobs} search={search} adding={adding} setActive={setActive} setSearch={setSearch}
        patch={patch} reset={reset} onAdd={() => setAdding((a) => !a)} onAddRecord={() => void addRecord()} tabs={null} showAdd={false} />

      {state.active === "table" && (
        data && !jobs.length
          ? <p className="text-[length:var(--ou-type-body)] text-[var(--ou-text-secondary)]">还没有岗位。点右上角「添加岗位」贴一个链接或 JD。</p>
          : <JobsTable jobs={shown} view={view} patch={patch} openId={openId} onOpen={setOpenId} onAdd={() => setAdding(true)} />
      )}
      {state.active === "board" && data && <JobBoard embedded jobs={shown} view={view} patch={patch} openId={openId} onOpen={setOpenId} events={events} />}
      {state.active === "calendar" && <JobsCalendar events={events} />}
      {state.active === "gantt" && <JobsGantt jobs={shown} events={events} view={view} openId={openId} onOpen={setOpenId} />}
      {state.active === "gallery" && data && <JobsGallery jobs={shown} total={jobs.length} events={events} drawerOpen={openId != null} onOpen={setOpenId} />}

      {open && (
        <RecordDrawer job={open} index={index} total={ordered.length} tagOptions={tagOptions} hidden={drawerHidden} events={events} onClose={close}
          onPrev={() => { if (index > 0) setOpenId(ordered[index - 1].id); }}
          onNext={() => { if (index >= 0 && index < ordered.length - 1) setOpenId(ordered[index + 1].id); }} />
      )}
    </div>
  );
}
