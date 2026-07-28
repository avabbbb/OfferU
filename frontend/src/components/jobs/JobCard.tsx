"use client";

import { useRouter } from "next/navigation";
import {
  Briefcase,
  Building2,
  Check,
  DollarSign,
  GraduationCap,
  MapPin,
} from "lucide-react";
import type { Job } from "@/lib/hooks";

const sourceAccentMap: Record<
  string,
  { badge: string; marker: string; meta: string }
> = {
  boss: {
    badge: "bg-[#f7ece9] text-black",
    marker: "rounded-full bg-[#e8d2cd]",
    meta: "BOSS直聘",
  },
  zhilian: {
    badge: "bg-[#eaf0eb] text-black",
    marker: "bg-[#d8e2da]",
    meta: "智联招聘",
  },
  linkedin: {
    badge: "bg-[#f3ead2] text-black",
    marker: "bauhaus-triangle bg-[#d8e2da]",
    meta: "领英",
  },
  shixiseng: {
    badge: "bg-[var(--surface-muted)] text-black",
    marker: "rounded-full bg-[#e8d2cd]",
    meta: "实习僧",
  },
  maimai: {
    badge: "bg-[#f7ece9] text-black",
    marker: "bg-[#d8e2da]",
    meta: "脉脉",
  },
  corporate: {
    badge: "bg-[#eaf0eb] text-black",
    marker: "bauhaus-triangle bg-[#f3ead2]",
    meta: "大厂官网",
  },
};

interface JobCardProps {
  job: Job;
  showCheckbox?: boolean;
  selected?: boolean;
  onToggle?: (id: number, options?: { shiftKey?: boolean }) => void;
  onSelectPointerDown?: (id: number, options?: { shiftKey?: boolean }) => void;
  onSelectPointerEnter?: (id: number) => void;
}

export function JobCard({
  job,
  showCheckbox,
  selected,
  onToggle,
  onSelectPointerDown,
  onSelectPointerEnter,
}: JobCardProps) {
  const router = useRouter();
  const accent = sourceAccentMap[job.source] || {
    badge: "bg-[var(--surface-muted)] text-black",
    marker: "rounded-full bg-[#e8d2cd]",
    meta: "其他来源",
  };
  const applyUrl = job.apply_url || job.url;

  const openDetail = () => {
    router.push(`/jobs/${job.id}`);
  };

  return (
    <article
      className={`group relative flex h-full min-h-[280px] max-w-full flex-col overflow-hidden border border-black/15 bg-[var(--surface)] transition-all duration-[var(--dur-quick)] ease-[var(--ease-snap)] ${
        selected
          ? "bg-[var(--surface-muted)] shadow-[1px_1px_0_0_rgba(18,18,18,0.16)]"
          : "shadow-[1px_1px_0_0_rgba(18,18,18,0.08)] hover:-translate-y-0.5 hover:shadow-[2px_2px_0_0_rgba(18,18,18,0.14)]"
      }`}
      onMouseEnter={() => onSelectPointerEnter?.(job.id)}
    >
      <span
        className={`absolute right-4 top-4 z-[1] h-3 w-3 border border-black/20 ${accent.marker}`}
      />

      <div className="relative z-[1] flex h-full flex-col gap-4 p-5">
        <div className="flex items-start gap-3">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden border border-black/15 bg-[var(--surface-muted)]">
            {job.company_logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={job.company_logo}
                alt={`${job.company} logo`}
                className="h-full w-full object-cover"
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            ) : (
              <span className="text-lg font-bold text-black/70">
                {(job.company || "?").slice(0, 1)}
              </span>
            )}
          </div>

          <div className="min-w-0 flex-1">
            <p className="bauhaus-label text-black/50">{accent.meta}</p>
            <h3 className="mt-1 line-clamp-2 text-xl font-semibold leading-tight text-black">
              {job.title}
            </h3>
            <p className="mt-2 line-clamp-1 text-sm font-medium text-black/62">
              {job.company}
            </p>
          </div>

          <span className={`bauhaus-chip ${accent.badge}`}>{accent.meta}</span>
        </div>

        <div className="flex flex-wrap gap-1.5 text-xs font-medium text-black/65">
          {job.salary_text && (
            <span className="bauhaus-chip bg-[#f3ead2]">
              <DollarSign size={12} strokeWidth={2} />
              {job.salary_text}
            </span>
          )}
          {job.location && (
            <span className="bauhaus-chip">
              <MapPin size={12} strokeWidth={2} />
              {job.location}
            </span>
          )}
          {job.education && (
            <span className="bauhaus-chip">
              <GraduationCap size={12} strokeWidth={2} />
              {job.education}
            </span>
          )}
          {job.experience && (
            <span className="bauhaus-chip">
              <Briefcase size={12} strokeWidth={2} />
              {job.experience}
            </span>
          )}
          {job.company_size && (
            <span className="bauhaus-chip">
              <Building2 size={12} strokeWidth={2} />
              {job.company_size}
            </span>
          )}
        </div>

        <p className="line-clamp-3 flex-1 text-sm font-medium leading-relaxed text-black/68">
          {job.summary || "该岗位暂时没有摘要，点击卡片查看完整详情。"}
        </p>

        <div className="flex flex-wrap gap-2">
          {job.is_campus && (
            <span className="bauhaus-chip bg-[#eaf0eb] text-black">校招</span>
          )}
          {job.job_type && (
            <span className="bauhaus-chip bg-[#f7ece9] text-black">
              {job.job_type}
            </span>
          )}
          {job.keywords?.slice(0, 2).map((keyword, index) => (
            <span
              key={`${keyword}-${index}`}
              className={`bauhaus-chip ${
                index % 2 === 0
                  ? "bg-[var(--surface)] text-black"
                  : "bg-[var(--surface-muted)] text-black/75"
              }`}
            >
              {keyword}
            </span>
          ))}
        </div>

        <div className="flex flex-wrap gap-2 pt-1">
          <button
            type="button"
            className="bauhaus-button bauhaus-button-outline z-20 !min-h-8 !px-3 !py-2 !text-[11px]"
            onClick={(event) => {
              event.stopPropagation();
              openDetail();
            }}
          >
            查看详情
          </button>
          {applyUrl && (
            <a
              href={applyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="bauhaus-button bauhaus-button-blue z-20 !min-h-8 !px-3 !py-2 !text-[11px]"
              onClick={(event) => event.stopPropagation()}
            >
              投递入口
            </a>
          )}
        </div>
      </div>

      {showCheckbox && (
        <button
          type="button"
          aria-label={selected ? "取消选择岗位" : "选择岗位"}
          aria-pressed={selected}
          className={`absolute bottom-4 right-4 z-20 flex h-11 w-11 items-center justify-center border border-black/20 transition-all duration-[var(--dur-quick)] ease-[var(--ease-snap)] ${
            selected
              ? "bg-[#e4ece6] text-black shadow-[1px_1px_0_0_rgba(18,18,18,0.14)]"
              : "bg-[var(--surface)] text-black shadow-[1px_1px_0_0_rgba(18,18,18,0.1)] hover:bg-[var(--surface-muted)]"
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
          <Check
            size={18}
            strokeWidth={2.6}
            className={selected ? "opacity-100" : "opacity-0"}
          />
        </button>
      )}
    </article>
  );
}
