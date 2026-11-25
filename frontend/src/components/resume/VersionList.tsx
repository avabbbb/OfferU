"use client";

// 我的简历（版本）：宽屏是左侧一列，窄屏是一排可横滑的胶囊（布局全在 styles/resume.css 里按容器宽度切换）。
// 选中的一份是一颗白胶囊，切换时滑过去（framer layoutId）。改名 / 复制 / 删除收进每行的「…」菜单，新建收进底部一个安静的文字钮。
// 取代原来顶栏简历名上的下拉（ResumeSwitcher），行为一致：改名立即存、复制带上当前没存的内容、删除先确认。
import { motion } from "framer-motion";
import { Copy, MoreHorizontal, Pencil, Plus, Trash2, UserRound, FilePlus2 } from "lucide-react";
import Link from "next/link";
import { useId, useRef, useState } from "react";

import { SPRING } from "@/app/interview/kit";
import { Menu } from "@/components/ui";
import type { Doc, Job } from "@/lib/core";

type Props = {
  docs: Doc[];
  current: Doc;
  jobs: Job[];
  /** 当前这份的名字（编辑器里的状态，可能还没回写到 docs）。 */
  title: string;
  onRename: (doc: Doc, title: string) => void;
  onCreate: (fromProfile: boolean) => void;
  onCopy: (doc: Doc) => void;
  onDelete: (doc: Doc) => void;
};

export function VersionList({ docs, current, jobs, title, onRename, onCreate, onCopy, onDelete }: Props) {
  const group = useId();
  const [editing, setEditing] = useState<number | null>(null);
  const cancelled = useRef(false);
  const nameOf = (d: Doc) => (d.id === current.id ? title : d.title ?? "").trim() || "未命名简历";
  const jobOf = (d: Doc) => (d.job_id ? jobs.find((j) => j.id === d.job_id)?.label : undefined);
  const finish = (d: Doc, value: string) => {
    const next = value.trim();
    setEditing(null);
    if (!cancelled.current && next && next !== nameOf(d)) onRename(d, next);
  };

  return (
    <nav className="rv" aria-label="我的简历" data-shot="versions-list">
      <div className="rv-head">
        <h2 className="rv-heading">我的简历</h2>
        <span className="rv-count">{docs.length} 份</span>
      </div>
      <ul className="rv-list">
        {docs.map((d) => {
          const active = d.id === current.id;
          const sub = jobOf(d) ?? (d.job_id ? "定制版" : "通用版");
          return (
            <li key={d.id} className="rv-row" data-current={active || undefined}>
              {active && <motion.span layoutId={group + "-hl"} className="rv-highlight" transition={SPRING} aria-hidden />}
              {editing === d.id ? (
                <input autoFocus defaultValue={nameOf(d)} aria-label="简历名称" className="rv-input"
                  onFocus={(e) => { cancelled.current = false; e.currentTarget.select(); }}
                  onBlur={(e) => finish(d, e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing) return;
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") { e.stopPropagation(); cancelled.current = true; e.currentTarget.blur(); }
                  }} />
              ) : (
                <Link href={"/resume/" + d.id} className="rv-link" aria-current={active ? "page" : undefined} title={nameOf(d)}>
                  <span className="rv-title">{nameOf(d)}</span>
                  <span className="rv-sub">{sub}</span>
                </Link>
              )}
              {editing !== d.id && (
                <Menu label={nameOf(d) + " 更多操作"} align="end" trigger={
                  <button type="button" className="rv-more" aria-label={nameOf(d) + " 更多操作"} title="改名、复制、删除">
                    <MoreHorizontal size={16} aria-hidden />
                  </button>
                } items={[
                  { label: "改名", icon: <Pencil size={15} />, onSelect: () => setEditing(d.id) },
                  { label: "复制一份", description: "比如按另一个岗位改", icon: <Copy size={15} />, onSelect: () => onCopy(d) },
                  "separator",
                  {
                    label: "删除", icon: <Trash2 size={15} />, danger: true,
                    onSelect: () => { if (window.confirm("删除「" + nameOf(d) + "」？")) onDelete(d); },
                  },
                ]} />
              )}
            </li>
          );
        })}
        <li className="rv-new-cell">
          <Menu label="新建简历" align="start" trigger={
            <button type="button" className="rv-new" aria-label="新建简历"><Plus size={15} aria-hidden /><span>新建</span></button>
          } items={[
            { label: "从档案生成", description: "按档案里的经历起一份草稿", icon: <UserRound size={15} />, onSelect: () => onCreate(true) },
            { label: "空白开始", description: "只有几个常用模块", icon: <FilePlus2 size={15} />, onSelect: () => onCreate(false) },
          ]} />
        </li>
      </ul>
    </nav>
  );
}
