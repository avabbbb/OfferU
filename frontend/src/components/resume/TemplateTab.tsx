"use client";

// 右栏「更换模版」：每个模板一张卡，缩略图就是用你自己的内容按那个模板渲染出来的第一页（和预览 / PDF 同一个渲染接口）。
// 点一下换模板：字体、字号、间距、边距、颜色回到新模板的默认（withTemplate），照片和校徽保留；可在「最近改动」撤销。
import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { apiUrl } from "@/lib/core";
import type { Resume } from "@/lib/resumeModel";
import { RESUME_TEMPLATES, type ResumeStyle, type ResumeTemplate, withTemplate } from "@/lib/resumeStyle";

const A4_W = 794;
const A4_H = 1123;

const NOTE: Record<ResumeTemplate, string> = {
  classic: "黑白、信息密，校招通用",
  clear: "标题分隔清楚，留白适中",
  kami: "宋体 + 大留白，适合内容精炼",
  compact: "紧凑，经历多也能压一页",
};

function Thumb({ resume, style, label }: { resume: Resume; style: ResumeStyle; label: string }) {
  const [html, setHtml] = useState("");
  const [failed, setFailed] = useState(false);
  const [scale, setScale] = useState(0.2);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(el.clientWidth / A4_W));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const key = JSON.stringify([resume, style]);
  // 停顿 400ms 再渲染（左边还在打字时不刷四张图）；过时的响应丢掉。
  useEffect(() => {
    let live = true;
    const t = window.setTimeout(async () => {
      try {
        const res = await fetch(apiUrl("/api/resume/render"), {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resume, style }),
        });
        if (!live) return;
        if (!res.ok) { setFailed(true); return; }
        setFailed(false);
        setHtml(await res.text());
      } catch {
        if (live) setFailed(true);
      }
    }, 400);
    return () => { live = false; window.clearTimeout(t); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <span ref={box} className="re-thumb" aria-hidden>
      {failed ? <span className="re-thumb-empty">预览加载失败</span> : (
        <iframe title={label + " 缩略图"} srcDoc={html} sandbox="" tabIndex={-1} loading="lazy"
          style={{ width: A4_W, height: A4_H, transform: "scale(" + scale + ")" }} className="re-thumb-frame" />
      )}
    </span>
  );
}

export function TemplateTab({ resume, style, onChange }: { resume: Resume; style: ResumeStyle; onChange: (next: ResumeStyle) => void }) {
  return (
    <div className="re-module">
      <p className="re-tab-lead">换模板会把字体、字号、间距和颜色换成模板默认，内容不变；照片和校徽保留。</p>
      <div className="re-templates" role="radiogroup" aria-label="简历模板">
        {(Object.keys(RESUME_TEMPLATES) as ResumeTemplate[]).map((t) => {
          const on = style.template === t;
          return (
            <button key={t} type="button" role="radio" aria-checked={on} className="re-template" onClick={() => { if (!on) onChange(withTemplate(style, t)); }}>
              <Thumb resume={resume} style={on ? style : withTemplate(style, t)} label={RESUME_TEMPLATES[t]} />
              <span className="re-template-name">
                {on && <Check size={14} aria-hidden />}{RESUME_TEMPLATES[t]}
              </span>
              <span className="re-template-note">{NOTE[t]}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
