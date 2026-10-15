"use client";

import { useEffect, useRef, useState } from "react";
import { FileText } from "lucide-react";
import { useResume } from "@/lib/hooks";
import ResumePreview from "./ResumePreview";

const PAGE_WIDTH_PX = 794; // A4 at 96dpi

/** 列表卡片上的缩略图：用和编辑器、导出同一套模板渲染第一页上半部分，而不是占位图标。 */
/**
 * variant="cover"：Notion 画廊封面——浅灰底上露出一张纸的上半截，纸本身没有边框只有一点投影。
 */
export default function ResumeThumbnail({ resumeId, variant = "framed" }: { resumeId: number; variant?: "framed" | "cover" }) {
  const { data } = useResume(resumeId);
  const boxRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  useEffect(() => {
    const node = boxRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setScale(entry.contentRect.width / PAGE_WIDTH_PX));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const preview = data && scale > 0 ? (
    <div className="pointer-events-none absolute left-0 top-0 origin-top-left" style={{ transform: `scale(${scale})` }}>
      <ResumePreview userName={data.user_name} title={data.title} photoUrl={data.photo_url} summary={data.summary} contactJson={data.contact_json || {}} sections={data.sections} styleConfig={data.style_config || {}} />
    </div>
  ) : null;
  if (variant === "cover") {
    return (
      <div className="relative aspect-[16/11] overflow-hidden bg-[#efeeea]" aria-hidden="true" data-testid="resume-thumbnail">
        <div ref={boxRef} className="absolute inset-x-[13%] bottom-0 top-[14px] overflow-hidden rounded-t-[3px] bg-white shadow-[0_0_0_1px_rgba(15,15,15,0.05),0_2px_6px_rgba(15,15,15,0.08)]">
          {preview ?? <div className="grid h-full place-items-center"><FileText size={28} className="text-[#d3d1cb]" /></div>}
        </div>
      </div>
    );
  }
  return (
    <div ref={boxRef} className="relative aspect-[210/170] overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface-muted)]" aria-hidden="true" data-testid="resume-thumbnail">
      {data && scale > 0 ? (
        <div className="pointer-events-none absolute left-0 top-0 origin-top-left" style={{ transform: `scale(${scale})` }}>
          <ResumePreview userName={data.user_name} title={data.title} photoUrl={data.photo_url} summary={data.summary} contactJson={data.contact_json || {}} sections={data.sections} styleConfig={data.style_config || {}} />
        </div>
      ) : <div className="grid h-full place-items-center"><FileText size={32} className="text-[var(--foreground-faint)]" /></div>}
    </div>
  );
}
