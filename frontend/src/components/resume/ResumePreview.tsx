"use client";

// 右侧 A4 预览：iframe 里放 POST /api/resume/render 返回的 HTML，也就是 PDF 打印的那一份。
// 智能一页在这个 iframe 里量高度：临时改 CSS 变量、读高度、还原，不重新请求。
import { forwardRef, type ReactNode, useEffect, useImperativeHandle, useRef, useState } from "react";

import { apiUrl } from "@/lib/core";
import { PAGE_PX, SIDES, type ResumeStyle } from "@/lib/resumeStyle";
import type { Resume } from "@/lib/resumeModel";

const A4_W = 794; // 210mm @ 96dpi

// 只注入预览 iframe（导出的 PDF 不带）：悬停的块画一圈墨色细框，左上角一枚小标签「点击编辑」。
// iframe 里读不到外层的 --ou-* 变量，载入时把外层算好的值抄进 iframe 的 :root（见 hintVars）。
const HOVER_CSS = `
.resume .item, .resume h1, .resume p.contact, .resume section > h2 { position: relative; cursor: pointer; border-radius: var(--ou-radius-1); }
.resume .item:hover, .resume h1:hover, .resume p.contact:hover, .resume section > h2:hover {
  outline: 1px solid var(--ou-line-strong); outline-offset: 3px; background: var(--ou-bg-hover); }
.resume .item:hover::before, .resume section > h2:hover::before {
  content: "点击编辑"; position: absolute; left: -4px; bottom: 100%; margin-bottom: 4px; padding: 1px 7px; border-radius: var(--ou-radius-pill);
  background: var(--ou-action-primary); color: var(--ou-on-action-primary); font: 500 9px/1.6 system-ui, sans-serif; white-space: nowrap; }`;
const HINT_VARS = ["--ou-radius-1", "--ou-radius-pill", "--ou-line-strong", "--ou-bg-hover", "--ou-action-primary", "--ou-on-action-primary"];
function hintVars() {
  const root = getComputedStyle(document.documentElement);
  return ":root{" + HINT_VARS.map((name) => name + ":" + root.getPropertyValue(name).trim()).join(";") + "}";
}

// 缩放：「适应」随画布宽度铺满；也可以固定倍率，像「预览」App 一样。
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5];
type Zoom = "fit" | number;

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
  const [fitScale, setFitScale] = useState(1);
  const [zoom, setZoom] = useState<Zoom>("fit");
  const scale = zoom === "fit" ? fitScale : zoom;
  const step = (dir: 1 | -1) => setZoom((z) => {
    const now = z === "fit" ? fitScale : z;
    const next = dir > 0 ? ZOOMS.find((v) => v > now + 0.001) : [...ZOOMS].reverse().find((v) => v < now - 0.001);
    return next ?? z;
  });
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
    const ro = new ResizeObserver(() => setFitScale(Math.min(1.35, Math.max(0.3, (el.clientWidth - 48) / A4_W))));
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
    hint.textContent = hintVars() + HOVER_CSS;
    doc.head.appendChild(hint);
    doc.addEventListener("click", (event) => {
      const block = (event.target as Element | null)?.closest?.("[data-path]");
      if (block) locate.current?.(block.getAttribute("data-path") ?? "");
    });
  };

  return (
    <>
    <div ref={box} className="rp-canvas min-w-0 flex-1 overflow-auto px-6 pb-16 pt-4">
      {toolbar && <div className="rp-toolbar">{toolbar}</div>}
      {error && <p role="alert" className="rp-error">{error}</p>}
      <div className="relative mx-auto" style={{ width: A4_W * scale, height: height * scale }}>
        <iframe ref={frame} title="简历预览（和导出的 PDF 一致）" srcDoc={html} sandbox="allow-same-origin" onLoad={loaded}
          style={{ width: A4_W, height, transform: "scale(" + scale + ")", transformOrigin: "0 0", border: 0 }}
          className="rp-paper absolute left-0 top-0" />
        {height > PAGE_PX && (
          <div className="rp-break" style={{ top: PAGE_PX * scale }}>
            <span>第 1 页到这</span>
          </div>
        )}
      </div>
    </div>
    {/* 缩放胶囊放在画布外：画布自己是横向滚动容器，贴底要跟着整页滚动走。 */}
    <div className="rp-zoom-dock">
        <div className="rp-zoom" role="group" aria-label="预览缩放">
          <button type="button" aria-label="缩小" title="缩小" disabled={scale <= ZOOMS[0] + 0.001} onClick={() => step(-1)}>−</button>
          <span className="rp-zoom-value" aria-live="polite">{Math.round(scale * 100)}%</span>
          <button type="button" aria-label="放大" title="放大" disabled={scale >= ZOOMS[ZOOMS.length - 1] - 0.001} onClick={() => step(1)}>+</button>
          <button type="button" aria-pressed={zoom === "fit"} title="按画布宽度铺满" onClick={() => setZoom("fit")}>适应</button>
        </div>
      </div>
    </>
  );
});
