"use client";

// 基本信息卡片里的证件照和校徽。
// 证件照存在档案（profile.photo），这份简历放不放由 style.photo 决定；
// 校徽是 style.logo（选用和上传都由后端抠成透明底）：输入学校名边打边联想（内置校徽库；片段、简称、跳字如「华师」都能匹配），
// 挑一个就拷进数据目录用上；也可以自己上传。
import { type ReactNode, useEffect, useRef, useState } from "react";

import { apiUrl, upload, write } from "@/lib/core";
import type { ResumeStyle } from "@/lib/resumeStyle";

type Hit = { school_name: string; file: string; url: string };
type Props = { style: ResumeStyle; onStyle: (next: ResumeStyle) => void; photo?: string; school: string; onPhoto: () => void };

// 学校名里出现在输入中的字加粗，让用户看出为什么匹配上。
function marked(name: string, query: string): ReactNode[] {
  const chars = new Set(query.replace(/\s+/g, ""));
  return Array.from(name, (ch, i) => (chars.has(ch) ? <mark key={i}>{ch}</mark> : ch));
}

export function BasicsMedia({ style, onStyle, photo, school, onPhoto }: Props) {
  const photoInput = useRef<HTMLInputElement>(null);
  const logoInput = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(school);
  const [open, setOpen] = useState(false);
  const [found, setFound] = useState<{ q: string; items: Hit[] }>({ q: "", items: [] });
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const set = (patch: Partial<ResumeStyle>) => onStyle({ ...style, ...patch });
  const q = query.trim();

  // 边打边查：停顿 200ms 再请求；带序号，过时的响应丢掉。
  useEffect(() => {
    if (!open || !q) return;
    const n = ++seq.current;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(apiUrl("/api/resume/assets/school-logos?q=" + encodeURIComponent(q)));
        if (!res.ok) throw new Error(await res.text());
        const body: unknown = await res.json();
        const items: Hit[] = body && typeof body === "object" && "items" in body && Array.isArray(body.items) ? body.items : [];
        if (n !== seq.current) return;
        setFound({ q, items });
        setActive(0);
        setError(null);
      } catch {
        if (n === seq.current) setError("搜索校徽失败");
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [q, open]);

  const run = async (label: string, job: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await job();
    } catch {
      setError(label + "失败");
    } finally {
      setBusy("");
    }
  };
  const uploadPhoto = (file: File) => run("上传证件照", async () => {
    const { name } = await upload(file);
    await write("save", { type: "profile", data: { photo: name } });
    onPhoto();
    set({ photo: true });
  });
  // 校徽走专门的接口：后端抠成透明底再存。
  const uploadLogo = (file: File) => run("上传校徽", async () => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(apiUrl("/api/resume/logo"), { method: "POST", body: form });
    if (!res.ok) throw new Error(await res.text());
    const body: unknown = await res.json();
    if (!body || typeof body !== "object" || !("name" in body) || typeof body.name !== "string") throw new Error("bad response");
    set({ logo: body.name });
  });
  const pick = (hit: Hit) => {
    setQuery(hit.school_name);
    setOpen(false);
    void run("使用校徽", async () => {
      const res = await fetch(apiUrl("/api/resume/assets/school-logos/" + hit.file + "/use"), { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
      const body: unknown = await res.json();
      if (!body || typeof body !== "object" || !("name" in body) || typeof body.name !== "string") throw new Error("bad response");
      set({ logo: body.name });
    });
  };

  const showList = open && Boolean(q) && found.q === q;
  const hits = showList ? found.items : [];
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") { setOpen(false); return; }
    if (!hits.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(hits[Math.min(active, hits.length - 1)]);
    }
  };

  return (
    <div className="rf-media">
      <div className="rf-media-box">
        <span className="rf-label">证件照</span>
        <button type="button" className="rf-thumb rf-thumb-photo" onClick={() => photoInput.current?.click()}
          aria-label={photo ? "更换证件照" : "上传证件照"} title={photo ? "点击更换" : "点击上传"}>
          {photo ? <img src={apiUrl("/api/files/" + photo)} alt="证件照" /> : <span>上传</span>}
        </button>
        <label className="rf-check">
          <input type="checkbox" checked={style.photo} disabled={!photo} onChange={(e) => set({ photo: e.target.checked })} />
          放到简历上
        </label>
        <input ref={photoInput} type="file" accept="image/png,image/jpeg,image/webp" hidden
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void uploadPhoto(f); }} />
      </div>
      <div className="rf-media-box min-w-0 flex-1">
        <span className="rf-label">校徽</span>
        <div className="flex items-start gap-2">
          <span className="rf-thumb rf-thumb-logo">{style.logo ? <img src={apiUrl("/api/files/" + style.logo)} alt="校徽" /> : <span>无</span>}</span>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="rf-combo-box">
              <input value={query} placeholder="输入学校名，如 华南、师范、浙大" aria-label="搜索校徽"
                role="combobox" aria-expanded={showList} aria-controls="rf-logo-list" aria-autocomplete="list"
                aria-activedescendant={hits.length ? "rf-logo-" + Math.min(active, hits.length - 1) : undefined}
                onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
                onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onKeyDown={onKey}
                className="rf-input" />
              {showList && (
                <ul id="rf-logo-list" role="listbox" className="rf-suggest" aria-label="匹配的学校">
                  {hits.length ? hits.map((hit, i) => (
                    <li key={hit.file} id={"rf-logo-" + i} role="option" aria-selected={i === active} data-active={i === active || undefined}
                      onMouseDown={(e) => { e.preventDefault(); pick(hit); }} onMouseEnter={() => setActive(i)}>
                      <img src={apiUrl(hit.url)} alt="" />
                      <span>{marked(hit.school_name, q)}</span>
                    </li>
                  )) : <li className="rf-suggest-empty" aria-disabled="true">校徽库里没找到，可以自己上传一张</li>}
                </ul>
              )}
            </div>
            <div className="flex gap-3">
              <button type="button" className="rf-link" onClick={() => logoInput.current?.click()}>自己上传</button>
              {style.logo && <button type="button" className="rf-link" onClick={() => set({ logo: null })}>去掉</button>}
            </div>
          </div>
        </div>
        <input ref={logoInput} type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" hidden
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void uploadLogo(f); }} />
      </div>
      {(busy || error) && <p role="status" className={"w-full text-[12px] " + (error ? "text-red-600" : "rf-muted")}>{error ?? busy + "中…"}</p>}
    </div>
  );
}
