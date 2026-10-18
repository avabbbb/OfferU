"use client";

// 岗位卡片：照 Notion 画廊视图的写法——公司一行、岗位名一行、属性用彩色小标签，
// 整张卡可点开详情；勾选框和投递链接只在悬停或已选中时出现。

import { useRouter } from "next/navigation";
import { ArrowUpRight, Check } from "lucide-react";
import type { Job } from "@/lib/hooks";
import { ExternalUrlLink } from "@/components/ExternalUrlLink";
import { LetterAvatar, NOTION_CARD, NotionTag } from "@/components/ui/NotionTag";

export const SOURCE_LABELS: Record<string, string> = {
  boss: "BOSS直聘",
  zhilian: "智联招聘",
  linkedin: "领英",
  shixiseng: "实习僧",
  maimai: "脉脉",
  corporate: "官网",
};

interface JobCardProps {
  job: Job;
  showCheckbox?: boolean;
  selected?: boolean;
  onToggle?: (id: number, options?: { shiftKey?: boolean }) => void;
  onSelectPointerDown?: (id: number, options?: { shiftKey?: boolean }) => void;
  onSelectPointerEnter?: (id: number) => void;
}

function usableApplyUrl(job: Job): string {
  const url = job.apply_url || job.url || "";
  if (!url || /https?:\/\/[^/]*example\.(invalid|test|example|localhost)/i.test(url)) return "";
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : "";
  } catch {
    return "";
  }
}

export function JobCard({ job, showCheckbox, selected, onToggle, onSelectPointerDown, onSelectPointerEnter }: JobCardProps) {
  const router = useRouter();
  const applyUrl = usableApplyUrl(job);
  const source = SOURCE_LABELS[job.source];
  const openDetail = () => router.push(`/jobs/${job.id}`);

  return (
    <article
      role="article"
      aria-label={`${job.title} · ${job.company}`}
      tabIndex={0}
      onClick={openDetail}
      onKeyDown={(event) => { if (event.key === "Enter") openDetail(); }}
      onMouseEnter={() => onSelectPointerEnter?.(job.id)}
      className={`job-card group relative flex h-full cursor-pointer flex-col gap-2.5 p-3.5 outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] ${NOTION_CARD} ${
        selected ? "!bg-[#f3f8fb] !shadow-[0_0_0_1.5px_rgba(35,131,226,0.55)]" : ""
      }`}
    >
      <div className="flex items-center gap-2 pr-7">
        {job.company_logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={job.company_logo} alt="" width={22} height={22} className="h-[22px] w-[22px] shrink-0 rounded-[5px] object-cover" loading="lazy" referrerPolicy="no-referrer" />
        ) : (
          <LetterAvatar name={job.company} />
        )}
        <span className="min-w-0 truncate text-[13px] text-[#787774]">{job.company}</span>
      </div>

      <h3 className="line-clamp-2 text-[15px] font-semibold leading-snug text-[#37352f]">{job.title}</h3>

      {job.summary && <p className="line-clamp-2 text-[13px] leading-relaxed text-[#787774]">{job.summary}</p>}

      <div className="mt-auto flex flex-wrap gap-1 pt-1">
        {job.location && <NotionTag>{job.location}</NotionTag>}
        {job.is_campus && <NotionTag color="green">校招</NotionTag>}
        {job.job_type && <NotionTag color="blue">{job.job_type}</NotionTag>}
        {job.salary_text && <NotionTag color="orange">{job.salary_text}</NotionTag>}
        {job.education && <NotionTag color="purple">{job.education}</NotionTag>}
        {source && <NotionTag color="gray">{source}</NotionTag>}
      </div>

      {applyUrl && (
        <ExternalUrlLink
          href={applyUrl}
          onClick={(event) => event.stopPropagation()}
          className="absolute bottom-3 right-3 inline-flex items-center gap-0.5 rounded-[5px] px-1.5 py-0.5 text-[12px] text-[#787774] opacity-0 transition-opacity hover:bg-[rgba(55,53,47,0.08)] group-hover:opacity-100"
        >
          投递 <ArrowUpRight size={12} />
        </ExternalUrlLink>
      )}

      {showCheckbox && (
        <button
          type="button"
          aria-label={selected ? "取消选择岗位" : "选择岗位"}
          aria-pressed={selected}
          className={`absolute right-3 top-3 flex h-[18px] w-[18px] items-center justify-center rounded-[4px] transition-opacity ${
            selected
              ? "bg-[#2383e2] text-white opacity-100"
              : "bg-white text-transparent opacity-0 shadow-[inset_0_0_0_1.5px_rgba(55,53,47,0.35)] group-hover:opacity-100 focus-visible:opacity-100"
          }`}
          onClick={(event) => {
            event.stopPropagation();
            onToggle?.(job.id, { shiftKey: event.shiftKey });
          }}
          onMouseDown={(event) => {
            if (event.button !== 0) return;
            event.stopPropagation();
            onSelectPointerDown?.(job.id, { shiftKey: event.shiftKey });
          }}
        >
          <Check size={13} strokeWidth={3} />
        </button>
      )}
    </article>
  );
}
