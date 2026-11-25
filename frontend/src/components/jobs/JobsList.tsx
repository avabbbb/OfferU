"use client";

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import { ChevronRight, Search, X } from "lucide-react";

import { useContainerWide } from "@/components/settings/SettingsLayout";
import { Pill } from "@/components/ui";
import { useRouter, useSearchParams } from "next/navigation";
import { JOB_STATUS, type Job } from "@/lib/core";
import { searchHit, sortJobs, type Sort } from "@/lib/jobView";

import { JobDetail } from "./JobDetail";
import { ENDED, STAGE_FILTERS, STAGE_TONE, type StageFilter } from "./stage";
import "@/styles/jobs.css";

// 岗位列表（Apple Mail / 系统设置式）：搜索 + 阶段 chip + 排序分段，下面一张白卡里是岗位行（公司首字、岗位、阶段、匹配分）。
// 容器够宽：左列表 + 右详情（?job=ID，替换历史，不堆返回）；窄了：点行推入详情（push 一条历史，返回键 / 手势回到列表）。
// /jobs/:id 的深链仍是整页详情。筛选和排序记在本机浏览器。

export const SPLIT_MIN_WIDTH = 880;
type SortKey = "score" | "recent" | "stage";
const SORTS: Array<{ value: SortKey; label: string; sort: Sort[] }> = [
  { value: "score", label: "匹配度", sort: [{ field: "score", desc: true }, { field: "created_at", desc: true }] },
  { value: "recent", label: "最近", sort: [{ field: "created_at", desc: true }] },
  { value: "stage", label: "阶段", sort: [{ field: "status", desc: false }, { field: "score", desc: true }] },
];
const PREFS_KEY = "offeru.jobs.list.v1";
const SELECT_SPRING = { type: "spring", stiffness: 520, damping: 42, mass: 0.9 } as const;
const pushVariants = {
  enter: (direction: number) => ({ x: direction > 0 ? "18%" : "-10%", opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (direction: number) => ({ x: direction > 0 ? "-10%" : "18%", opacity: 0 }),
};
const pushTransition = { x: { type: "spring", stiffness: 380, damping: 38, mass: 0.9 }, opacity: { duration: 0.2 } } as const;

function loadPrefs(): { stage: StageFilter; sort: SortKey } {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null") as { stage?: string; sort?: string } | null;
    return {
      stage: STAGE_FILTERS.some((f) => f.value === raw?.stage) ? (raw!.stage as StageFilter) : "all",
      sort: SORTS.some((s) => s.value === raw?.sort) ? (raw!.sort as SortKey) : "score",
    };
  } catch {
    return { stage: "all", sort: "score" };
  }
}

/** 一条轨道上的滑动白胶囊（分段）。 */
export function ModeTrack<T extends string>({ label, value, options, onChange, testId }: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  testId?: string;
}) {
  return (
    <LayoutGroup id={"jb-" + label}>
      <div className="jb-mode-track" role="radiogroup" aria-label={label} data-testid={testId}>
        {options.map((o) => {
          const active = o.value === value;
          return (
            <button key={o.value} type="button" role="radio" aria-checked={active} className="jb-mode-item" onClick={() => onChange(o.value)}>
              {active && <motion.span layoutId="pill" className="jb-pill-bg" transition={SELECT_SPRING} aria-hidden="true" />}
              <span>{o.label}</span>
            </button>
          );
        })}
      </div>
    </LayoutGroup>
  );
}

function JobRow({ job, selected, push, onOpen }: { job: Job; selected: boolean; push: boolean; onOpen: () => void }) {
  const company = job.company || "未填公司";
  return (
    <button type="button" className="jb-row" aria-current={selected ? "true" : undefined} onClick={onOpen} data-testid="jobs-list-row"
      data-dim={ENDED.includes(job.status) ? "" : undefined}>
      {selected && <motion.span layoutId="jobs-row-selection" className="jb-row-bg" transition={SELECT_SPRING} aria-hidden="true" />}
      <span className="jb-mono" aria-hidden="true">{Array.from(company)[0]}</span>
      <span className="jb-row-text">
        <span className="jb-row-title" title={job.title}>{job.title || "未填岗位"}</span>
        <span className="jb-row-sub">{company}{job.city ? " · " + job.city : ""}<span data-stage> · {JOB_STATUS[job.status]}</span></span>
      </span>
      <span className="jb-row-end">
        <Pill tone={STAGE_TONE[job.status]}>{JOB_STATUS[job.status]}</Pill>
        {job.score != null
          ? <span className="jb-score" aria-label={`匹配 ${job.score} 分`}>{job.score}<small>分</small></span>
          : <span className="jb-score" data-empty="" aria-label="还没评估">—</span>}
        {push && <ChevronRight size={16} className="jb-row-chevron" aria-hidden="true" />}
      </span>
    </button>
  );
}

export function JobsList({ jobs, loaded, search, setSearch, header }: {
  /** 页头（标题、视图分段、添加岗位）：窄屏推入详情时让位给返回栏；双栏时右侧详情有墨黑的下一步，「添加岗位」退成白胶囊。 */
  header: (opts: { inkAdd: boolean }) => ReactNode;
  jobs: Job[];
  loaded: boolean;
  search: string;
  setSearch: (q: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const wide = useContainerWide(rootRef, SPLIT_MIN_WIDTH);
  const router = useRouter();
  const params = useSearchParams();
  const [prefs, setPrefs] = useState(loadPrefs);
  useEffect(() => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* 隐私模式存不进去就算了 */ } }, [prefs]);

  const searched = useMemo(() => jobs.filter((j) => searchHit(j, search)), [jobs, search]);
  const counts = useMemo(() => Object.fromEntries(STAGE_FILTERS.map((f) => [f.value, f.statuses ? searched.filter((j) => f.statuses!.includes(j.status)).length : searched.length])), [searched]);
  const stage = STAGE_FILTERS.find((f) => f.value === prefs.stage) ?? STAGE_FILTERS[0];
  const shown = useMemo(() => sortJobs(
    stage.statuses ? searched.filter((j) => stage.statuses!.includes(j.status)) : searched,
    SORTS.find((s) => s.value === prefs.sort)!.sort,
  ), [searched, stage, prefs.sort]);

  const requested = Number(params.get("job")) || null;
  // 宽屏总有一条在右侧打开（默认列表第一条）；窄屏没有选中就是列表。
  const active = requested ?? (wide ? shown[0]?.id ?? null : null);
  const pushed = useRef(false);
  const keep = (id: number | null) => {
    const next = new URLSearchParams(params);
    if (id == null) next.delete("job"); else next.set("job", String(id));
    const q = next.toString();
    return "/jobs" + (q ? "?" + q : "");
  };
  const open = (id: number) => {
    if (wide) router.replace(keep(id));
    else { pushed.current = true; router.push(keep(id)); }
  };
  const close = () => {
    if (pushed.current) { pushed.current = false; router.back(); } else router.replace(keep(null));
  };
  useEffect(() => {
    if (!wide) rootRef.current?.closest("main")?.scrollTo({ top: 0 });
  }, [active, wide]);

  const clear = () => { setSearch(""); setPrefs((p) => ({ ...p, stage: "all" })); };

  const tools = (
    <div className="jb-tools">
      <label className="jb-search">
        <Search size={16} aria-hidden="true" />
        <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索公司、岗位、城市、标签" aria-label="搜索岗位"
          onKeyDown={(e) => { if (e.key === "Escape") setSearch(""); }} />
        {search && <button type="button" className="jb-icon" style={{ width: "2rem", height: "2rem" }} aria-label="清除搜索" onClick={() => setSearch("")}><X size={15} aria-hidden="true" /></button>}
      </label>
      <div className="jb-tools-row">
        <LayoutGroup id="jb-stage">
          <div className="jb-chips" role="group" aria-label="按阶段筛选" data-testid="jobs-stage-filter">
            {STAGE_FILTERS.map((f) => {
              const on = f.value === prefs.stage;
              return (
                <button key={f.value} type="button" className="jb-chip" aria-pressed={on} onClick={() => setPrefs((p) => ({ ...p, stage: f.value }))}>
                  {on && <motion.span layoutId="pill" className="jb-pill-bg" transition={SELECT_SPRING} aria-hidden="true" />}
                  <span>{f.label}</span>
                  <span className="jb-chip-count">{counts[f.value]}</span>
                </button>
              );
            })}
          </div>
        </LayoutGroup>
        {!wide && (
          <div className="jb-sort">
            <span>排序</span>
            <ModeTrack label="排序" value={prefs.sort} options={SORTS} onChange={(sort) => setPrefs((p) => ({ ...p, sort }))} testId="jobs-sort" />
          </div>
        )}
      </div>
      {wide && (
        <div className="jb-sort">
          <span>排序</span>
          <ModeTrack label="排序" value={prefs.sort} options={SORTS} onChange={(sort) => setPrefs((p) => ({ ...p, sort }))} testId="jobs-sort" />
        </div>
      )}
    </div>
  );

  const empty = !loaded ? (
    <div className="jb-card" aria-hidden="true">
      {Array.from({ length: 4 }, (_, i) => <div key={i} className="jb-row"><span className="jb-mono" /><span className="ou-skeleton h-4" style={{ width: `${80 - i * 12}%` }} /><span /></div>)}
    </div>
  ) : !jobs.length ? (
    <div className="jb-card"><div className="jb-empty" data-testid="jobs-empty">
      <p className="jb-empty-title">还没有岗位</p>
      <p className="jb-empty-body">点右上角「添加岗位」，贴一个链接或整段 JD，OfferU 会拆好字段并评估匹配度。</p>
    </div></div>
  ) : !shown.length ? (
    <div className="jb-card"><div className="jb-empty" data-testid="jobs-filter-empty">
      <p className="jb-empty-title">没有符合条件的岗位</p>
      <p className="jb-empty-body">{search ? `「${search}」` : ""}{search && prefs.stage !== "all" ? "，" : ""}{prefs.stage !== "all" ? `阶段「${stage.label}」` : ""}里没有岗位。</p>
      <button type="button" className="jb-text" onClick={clear}>清除筛选</button>
    </div></div>
  ) : null;

  const list = empty ?? (
    <div className="jb-card">
      <LayoutGroup id="jobs-rows">
        <ul aria-label="岗位列表">
          <AnimatePresence initial={false}>
            {shown.map((job) => (
              <motion.li key={job.id} layout={shown.length <= 60 ? "position" : false} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
                <JobRow job={job} selected={wide && job.id === active} push={!wide} onOpen={() => open(job.id)} />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      </LayoutGroup>
      <p className="jb-count">{shown.length === jobs.length ? `共 ${jobs.length} 个岗位` : `${shown.length} / ${jobs.length} 个岗位`}</p>
    </div>
  );

  return (
    <div ref={rootRef} className="jb">
      {wide ? (
        <div className="flex flex-col gap-6">
        {header({ inkAdd: false })}
        <div className="jb-split">
          <div className="jb-split-list">
            {tools}
            <div className="jb-scroll">{list}</div>
          </div>
          <div className="jb-split-detail jb-stage">
            <AnimatePresence mode="popLayout" initial={false}>
              {active != null && (
                <motion.div key={active} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
                  transition={{ y: { type: "spring", stiffness: 420, damping: 40 }, opacity: { duration: 0.18 } }}>
                  <JobDetail id={active} mode="pane" />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
        </div>
      ) : (
        <div className="jb-stage">
          <AnimatePresence mode="popLayout" initial={false} custom={active ? 1 : -1}>
            {active != null ? (
              <motion.div key={`detail-${active}`} custom={1} variants={pushVariants} initial="enter" animate="center" exit="exit" transition={pushTransition}>
                <JobDetail id={active} mode="push" onBack={close} />
              </motion.div>
            ) : (
              <motion.div key="index" custom={-1} variants={pushVariants} initial="enter" animate="center" exit="exit" transition={pushTransition} className="flex flex-col gap-4">
                {header({ inkAdd: true })}
                {tools}
                {list}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
