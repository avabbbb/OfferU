"use client";

// 右侧 A4 预览：iframe 里放 POST /api/resume/render 返回的 HTML，也就是 PDF 打印的那一份。
// 智能一页在这个 iframe 里量高度：临时改 CSS 变量、读高度、还原，不重新请求。
import { forwardRef, type ReactNode, useEffect, useImperativeHandle, useRef, useState } from "react";

import { apiUrl } from "@/lib/core";
import { PAGE_PX, SIDES, type ResumeStyle } from "@/lib/resumeStyle";
import type { Resume } from "@/lib/resumeModel";

const A4_W = 794; // 210mm @ 96dpi

// 只注入预览 iframe（导出的 PDF 不带）：悬停的块画橙色虚线框，左上角标「点击编辑此模块」。
const HOVER_CSS = `
.resume .item, .resume h1, .resume p.contact, .resume section > h2 { position: relative; cursor: pointer; border-radius: 2px; }
.resume .item:hover, .resume h1:hover, .resume p.contact:hover, .resume section > h2:hover {
  outline: 1px dashed #f97316; outline-offset: 2px; background: rgba(249, 115, 22, 0.04); }
.resume .item:hover::before, .resume section > h2:hover::before {
  content: "点击编辑此模块"; position: absolute; left: -3px; bottom: 100%; margin-bottom: 2px; padding: 1px 6px; border-radius: 3px 3px 0 0;
  background: #f97316; color: #fff; font: 500 9px/1.6 system-ui, sans-serif; letter-spacing: 0; white-space: nowrap; z-index: 1; }`;

export type PreviewHandle = { measure: (style: ResumeStyle) => number };

// toolbar：浮在画布顶部的一条（按岗位改写），不单独占一行。
type Props = { resume: Resume; style: ResumeStyle; onLocate?: (path: string) => void; toolbar?: ReactNode };

export const ResumePreview = forwardRef<PreviewHandle, Props>(function ResumePreview({ resume, style, onLocate, toolbar }, ref) {
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const seq = useRef(0);
  const locate = useRef(onLocate);
  locate.current = onLocate;
  const [html, setHtml] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [height, setHeight] = useState(PAGE_PX);
  const styleKey = JSON.stringify(style);

  // 停顿 250ms 再渲染；带序号，过时的响应丢掉。
  useEffect(() => {
    const id = ++seq.current;
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(apiUrl("/api/resume/render"), {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resume, style }),
        });
        const text = await res.text();
        if (id !== seq.current) return;
        if (!res.ok) {
          let detail = text;
          try { detail = String(JSON.parse(text).detail ?? text); } catch { /* 不是 JSON 就原样显示 */ }
          setError("预览失败：" + detail);
          return;
        }
        setError(null);
        setHtml(text);
      } catch {
        if (id === seq.current) setError("预览加载失败：后端没有响应");
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [resume, styleKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    // 按画布宽度铺满，允许放大到 1.35 倍，两侧只留 16px。
    const ro = new ResizeObserver(() => setScale(Math.min(1.35, Math.max(0.3, (el.clientWidth - 32) / A4_W))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useImperativeHandle(ref, () => ({
    measure(next) {
      const main = frame.current?.contentDocument?.querySelector<HTMLElement>("main.resume");
      if (!main) return 0;
      const before = main.getAttribute("style");
      const vars: Array<[string, string]> = [
        ["--body-size", next.bodySize + "pt"], ["--line-height", String(next.lineHeight)],
        ["--section-gap", next.sectionGap + "pt"], ["--item-gap", next.itemGap + "pt"],
        ...SIDES.map((side): [string, string] => ["--margin-" + side, next.margin[side] + "mm"]),
      ];
      for (const [name, value] of vars) main.style.setProperty(name, value);
      main.style.minHeight = "0";
      const measured = main.getBoundingClientRect().height;
      if (before === null) main.removeAttribute("style");
      else main.setAttribute("style", before);
      return measured;
    },
  }), []);

  // 每次新 HTML 载入：量内容高度（超过一页时画分页线），点预览里的块跳到左边对应位置。
  const loaded = () => {
    const doc = frame.current?.contentDocument;
    const main = doc?.querySelector<HTMLElement>("main.resume");
    if (!doc || !main) return;
    setHeight(Math.max(PAGE_PX, Math.ceil(main.scrollHeight)));
    const hint = doc.createElement("style");
    hint.textContent = HOVER_CSS;
    doc.head.appendChild(hint);
    doc.addEventListener("click", (event) => {
      const block = (event.target as Element | null)?.closest?.("[data-path]");
      if (block) locate.current?.(block.getAttribute("data-path") ?? "");
    });
  };

  return (
    <div ref={box} className="rp-canvas min-w-0 flex-1 overflow-auto px-4 pb-6 pt-3">
      {toolbar && <div className="rp-toolbar">{toolbar}</div>}
      {error && <p role="alert" className="mx-auto mb-3 max-w-[794px] text-[12.5px] text-red-600">{error}</p>}
      <div className="relative mx-auto" style={{ width: A4_W * scale, height: height * scale }}>
        <iframe ref={frame} title="简历预览（和导出的 PDF 一致）" srcDoc={html} sandbox="allow-same-origin" onLoad={loaded}
          style={{ width: A4_W, height, transform: "scale(" + scale + ")", transformOrigin: "0 0", border: 0, background: "#fff" }}
          className="rp-paper absolute left-0 top-0" />
        {height > PAGE_PX && (
          <div className="pointer-events-none absolute inset-x-0 border-t border-dashed border-red-400" style={{ top: PAGE_PX * scale }}>
            <span className="absolute -top-5 right-0 text-[11px] text-red-500">第一页到这</span>
          </div>
        )}
      </div>
    </div>
  );
});
