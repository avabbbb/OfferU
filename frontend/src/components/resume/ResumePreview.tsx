"use client";

// 右侧 A4 预览：iframe 里放 POST /api/resume/render 返回的 HTML，也就是 PDF 打印的那一份。
// 智能一页在这个 iframe 里量高度：临时改 CSS 变量、读高度、还原，不重新请求。
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

import { apiUrl } from "@/lib/core";
import { PAGE_PX, SIDES, type ResumeStyle } from "@/lib/resumeStyle";

const A4_W = 794; // 210mm @ 96dpi

export type PreviewHandle = { measure: (style: ResumeStyle) => number };

type Props = { body: string; style: ResumeStyle; onLocate?: (line: number) => void };

export const ResumePreview = forwardRef<PreviewHandle, Props>(function ResumePreview({ body, style, onLocate }, ref) {
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
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body, style }),
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
  }, [body, styleKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(Math.min(1, (el.clientWidth - 32) / A4_W)));
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
    doc.addEventListener("click", (event) => {
      const block = (event.target as Element | null)?.closest?.("[data-line]");
      if (block) locate.current?.(Number(block.getAttribute("data-line")));
    });
  };

  return (
    <div ref={box} className="min-w-0 flex-1 overflow-auto bg-[var(--surface)] px-4 py-6">
      {error && <p role="alert" className="mx-auto mb-3 max-w-[794px] text-[12.5px] text-red-600">{error}</p>}
      <div className="relative mx-auto" style={{ width: A4_W * scale, height: height * scale }}>
        <iframe ref={frame} title="简历预览（和导出的 PDF 一致）" srcDoc={html} sandbox="allow-same-origin" onLoad={loaded}
          style={{ width: A4_W, height, transform: "scale(" + scale + ")", transformOrigin: "0 0", border: 0, background: "#fff" }}
          className="absolute left-0 top-0 shadow-[0_0_0_1px_var(--border),0_10px_30px_rgba(0,0,0,0.06)]" />
        {height > PAGE_PX && (
          <div className="pointer-events-none absolute inset-x-0 border-t border-dashed border-red-400" style={{ top: PAGE_PX * scale }}>
            <span className="absolute -top-5 right-0 text-[11px] text-red-500">第一页到这</span>
          </div>
        )}
      </div>
    </div>
  );
});
