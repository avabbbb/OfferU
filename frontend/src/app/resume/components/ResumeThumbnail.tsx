"use client";

import { useEffect, useRef, useState } from "react";
import { FileText } from "lucide-react";
import { useResume } from "@/lib/hooks";
import ResumePreview from "./ResumePreview";

const PAGE_WIDTH_PX = 794; // A4 at 96dpi

/** 列表卡片上的缩略图：用和编辑器、导出同一套模板渲染第一页上半部分，而不是占位图标。 */
export default function ResumeThumbnail({ resumeId }: { resumeId: number }) {
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
