"use client";

// 下载按钮：主按钮直接下 PDF，右边小箭头展开更多格式（目前是 PNG）。点外面或按 Esc 收起。
import { useEffect, useRef, useState } from "react";

import { apiUrl } from "@/lib/core";

export function DownloadButton({ docId }: { docId: number }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const base = "/api/resume/" + docId;

  return (
    <div ref={box} className="rs-download-group">
      <a href={apiUrl(base + "/pdf")} download className="rs-download rs-download-main">下载 PDF</a>
      <button type="button" className="rs-download rs-download-caret" aria-label="更多下载格式" aria-haspopup="menu"
        aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <svg viewBox="0 0 12 12" aria-hidden="true" className="rs-caret-icon" data-open={open || undefined}>
          <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div role="menu" className="rs-download-menu">
          <a role="menuitem" href={apiUrl(base + "/png")} download className="rs-option" onClick={() => setOpen(false)}>
            下载 PNG <span className="rs-unit">高清图片</span>
          </a>
        </div>
      )}
    </div>
  );
}
