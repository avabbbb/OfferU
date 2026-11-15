"use client";

import { ChevronLeft, ChevronRight, CircleHelp } from "lucide-react";
import Link from "next/link";
import { type CSSProperties, type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { JobTag } from "@/components/jobs/JobPickers";
import { Button, Pill, Popover } from "@/components/ui";
import { type Event, JOB_STATUS, type Job, when } from "@/lib/core";
import {
  GALLERY_REACH, type GalleryGroupKey, clampIndex, framePose, galleryGroups, galleryJobs, galleryWheelDelta, nextDeadline, topMatch,
} from "@/lib/jobGallery";
import { STATUS_TONE } from "@/lib/jobView";

// 画廊视图（参考 Inspora · Alim Joldaspayev「new portfolio」）：岗位是一排朝消失点退去的画框，焦点帧正对镜头，
// Shift+滚轮 / 横向轻扫 / ←→ / 底部箭头一帧一帧走（普通滚轮照常滚页面）；点焦点帧或回车「走上前」展开成详情，两边退成细条，Esc 退回。
// 焦点帧是设计工具里的选中态：细描边 + 四角小方块 + 左上名字条 + 左下「打开岗位 ↗」。颜色全走 Glass token。

const WHEEL_STEP = 40;
const WHEEL_LOCK_MS = 260;

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

function Frame({ job, d, stepped, flat, deadline, top, onClick, onOpen }: {
  job: Job; d: number; stepped: boolean; flat: boolean; deadline?: Event; top: boolean;
  onClick: () => void; onOpen: (id: number) => void;
}) {
  const focus = d === 0;
  const detail = focus && stepped;
  const p = framePose(d, stepped, flat);
  const style = {
    transform: `translate(-50%, -50%) translate3d(calc(var(--ou-gallery-w) * ${p.x}), 0, calc(var(--ou-gallery-w) * ${p.z})) rotateY(${p.rotate}deg) scale(${p.scale})`,
    opacity: p.opacity,
    filter: p.blur ? `blur(${p.blur}px)` : undefined,
  } as CSSProperties;
  const company = job.company || "未填公司";
  const title = job.title || "未填岗位";
  const tags = (job.tags ?? []).slice(0, detail ? 6 : 3);
  const posting = job.posting;
  const highlights = (job.reasons?.length ? job.reasons : posting?.responsibilities ?? []).slice(0, 4);
  return (
    <div role="group" aria-roledescription="岗位画框" aria-label={`${company} ${title}`} aria-hidden={!focus || undefined}
      className={"ou-gallery-frame" + (focus ? " is-focus" : "") + (detail ? " is-detail" : "")} style={style}
      onClick={onClick}>
      {focus && (
        <>
          <span className="ou-gallery-handle" data-corner="tl" aria-hidden />
          <span className="ou-gallery-handle" data-corner="tr" aria-hidden />
          <span className="ou-gallery-handle" data-corner="bl" aria-hidden />
          <span className="ou-gallery-handle" data-corner="br" aria-hidden />
          <span className="ou-gallery-chip ou-gallery-chip-top" aria-hidden>{company} / {title}</span>
          {job.url && (
            <a className="ou-gallery-chip ou-gallery-chip-bottom" href={job.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
              打开岗位 ↗
            </a>
          )}
        </>
      )}
      {top && !stepped && <span className="ou-gallery-cursor" aria-hidden><span className="ou-gallery-cursor-tip" />OfferU · 最匹配</span>}
      <div className="ou-gallery-face">
        <div className="flex flex-wrap items-center gap-1.5">
          <Pill tone={STATUS_TONE[job.status]}>{JOB_STATUS[job.status]}</Pill>
          {job.score != null && <span className="ou-gallery-score" title="匹配评分">匹配 {job.score}</span>}
        </div>
        <h3 className="ou-gallery-company" title={company}>{company}</h3>
        <p className="ou-gallery-title" title={title}>{title}</p>
        <dl className="ou-gallery-meta">
          {job.city && <><dt>城市</dt><dd>{job.city}</dd></>}
          {deadline?.at && <><dt>截止</dt><dd>{when(deadline.at)}</dd></>}
          {posting?.hire_type && <><dt>类型</dt><dd>{posting.hire_type}</dd></>}
          {detail && posting?.salary && <><dt>薪资</dt><dd>{posting.salary}</dd></>}
          {detail && job.applied_at && <><dt>投递</dt><dd>{when(job.applied_at.slice(0, 10))}</dd></>}
        </dl>
        {tags.length > 0 && <div className="flex flex-wrap gap-1">{tags.map((t) => <JobTag key={t} text={t} />)}</div>}
        {detail && (
          <div className="ou-gallery-detail">
            {posting?.essence && <p className="ou-gallery-essence">{posting.essence}</p>}
            {highlights.length > 0 && (
              <section>
                <h4>{job.reasons?.length ? "评估要点" : "主要职责"}</h4>
                <ul>{highlights.map((h, i) => <li key={i}>{h}</li>)}</ul>
              </section>
            )}
            {!posting?.essence && !highlights.length && <p className="ou-gallery-muted">还没有 JD 摘要和评估，打开详情补一下。</p>}
            <div className="flex flex-wrap items-center gap-2 pt-1" onClick={(e) => e.stopPropagation()}>
              <Button variant="primary" size="sm" onClick={() => onOpen(job.id)}>打开详情</Button>
              <Link href={`/jobs/${job.id}`} className="ou-button ou-button-secondary ou-button-sm">完整页</Link>
              {job.url && <a href={job.url} target="_blank" rel="noreferrer" className="ou-button ou-button-ghost ou-button-sm">打开链接 ↗</a>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function JobsGallery({ jobs, total, events, drawerOpen, onOpen }: {
  /** applyView 之后的岗位（已按视图筛选 / 排序 / 搜索）。 */
  jobs: Job[];
  /** 筛选前的岗位总数，用来区分「还没有岗位」和「筛没了」。 */
  total: number;
  events: Event[];
  drawerOpen: boolean;
  onOpen: (id: number) => void;
}) {
  const [group, setGroup] = useState<GalleryGroupKey>("all");
  const [index, setIndex] = useState(0);
  const [stepped, setStepped] = useState(false);
  const flat = useReducedMotion();
  const stage = useRef<HTMLDivElement>(null);
  const wheel = useRef({ acc: 0, lockedUntil: 0 });

  const groups = useMemo(() => galleryGroups(jobs), [jobs]);
  // 选中的状态组被筛没了就回到「全部」。
  const activeGroup = groups.some((g) => g.key === group) ? group : "all";
  const list = useMemo(() => galleryJobs(jobs, activeGroup), [jobs, activeGroup]);
  const n = list.length;
  const at = clampIndex(index, n);
  const current = list[at];
  const top = useMemo(() => topMatch(list), [list]);

  const go = useCallback((delta: number) => setIndex((i) => clampIndex(clampIndex(i, n) + delta, n)), [n]);
  const pickGroup = (key: GalleryGroupKey) => { setGroup(key); setIndex(0); setStepped(false); };

  // 普通滚轮不拦，照常滚页面；Shift+滚轮或横向为主的触控板轻扫才切帧。累计到一格才走一帧，走完锁一小会儿，一次轻扫不会连跳；到头了放行。
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const delta = galleryWheelDelta(e);
      const dir = Math.sign(delta);
      if (!dir || (dir < 0 && at === 0) || (dir > 0 && at >= n - 1)) return;
      e.preventDefault();
      const w = wheel.current;
      const now = performance.now();
      if (now < w.lockedUntil) return;
      w.acc += delta;
      if (Math.abs(w.acc) >= WHEEL_STEP) {
        go(Math.sign(w.acc));
        w.acc = 0;
        w.lockedUntil = now + WHEEL_LOCK_MS;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [at, n, go]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
    else if (e.key === "Home") { e.preventDefault(); setIndex(0); }
    else if (e.key === "End") { e.preventDefault(); setIndex(n - 1); }
    else if ((e.key === "Enter" || e.key === " ") && current) { e.preventDefault(); setStepped((s) => !s); }
    else if (e.key === "Escape" && stepped && !drawerOpen) { e.preventDefault(); setStepped(false); }
  };

  if (!jobs.length) {
    return (
      <div className="ou-gallery ou-gallery-empty" role="status">
        <p className="ou-gallery-company">{total ? "没有符合条件的岗位" : "画廊还空着"}</p>
        <p className="ou-gallery-muted">{total ? "改一改筛选或搜索，岗位会排成一排出现在这里。" : "点右上角「添加岗位」贴一个链接或 JD，它会挂上这面墙。"}</p>
      </div>
    );
  }

  return (
    <div ref={stage} tabIndex={0} role="region" aria-roledescription="画廊" aria-label="岗位画廊：左右键切换，回车放大，Esc 返回"
      className={"ou-gallery" + (stepped ? " is-stepped" : "") + (flat ? " is-flat" : "")} onKeyDown={onKeyDown}>
      <span className="sr-only" aria-live="polite">
        {current ? `第 ${at + 1} 个，共 ${n} 个：${current.company ?? ""} ${current.title ?? ""}，${JOB_STATUS[current.status]}${stepped ? "，已放大" : ""}` : ""}
      </span>
      <div className="ou-gallery-track">
        {list.map((job, i) => {
          const d = i - at;
          if (Math.abs(d) > GALLERY_REACH) return null;
          return (
            <Frame key={job.id} job={job} d={d} stepped={stepped} flat={flat} deadline={nextDeadline(job, events)} top={job.id === top}
              onOpen={onOpen}
              onClick={() => { if (d === 0) setStepped((s) => !s); else { setIndex(i); setStepped(false); } stage.current?.focus(); }} />
          );
        })}
      </div>

      <nav className="ou-gallery-nav" aria-label="画廊导航">
        <div className="ou-gallery-groups" role="toolbar" aria-label="按状态分组">
          {groups.map((g) => (
            <button key={g.key} type="button" aria-pressed={g.key === activeGroup} onClick={() => pickGroup(g.key)}
              className="ou-gallery-group" aria-label={`${g.label}，${g.count} 个`}>
              {g.label}<span className="tabular-nums">{g.count}</span>
            </button>
          ))}
        </div>
        <span className="ou-gallery-sep" aria-hidden />
        <button type="button" className="ou-gallery-arrow" aria-label="上一个" disabled={at <= 0} onClick={() => go(-1)}>
          <ChevronLeft size={16} strokeWidth={1.75} aria-hidden />
        </button>
        <span className="ou-gallery-count tabular-nums" aria-label={`第 ${at + 1} 个，共 ${n} 个`}>{at + 1} / {n}</span>
        <button type="button" className="ou-gallery-arrow" aria-label="下一个" disabled={at >= n - 1} onClick={() => go(1)}>
          <ChevronRight size={16} strokeWidth={1.75} aria-hidden />
        </button>
        <Popover side="top" align="end" label="怎么用" className="ou-gallery-help"
          trigger={<button type="button" className="ou-gallery-arrow" aria-label="怎么用"><CircleHelp size={16} strokeWidth={1.75} aria-hidden /></button>}>
          <p className="ou-gallery-help-title">怎么用</p>
          <ul>
            <li>Shift+滚轮或 ← → 键切换</li>
            <li>点击或回车放大</li>
            <li>Esc 返回</li>
          </ul>
        </Popover>
      </nav>
    </div>
  );
}
