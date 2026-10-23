"use client";

import { useEffect, useRef, useState } from "react";

import { apiUrl, MEMORY_KIND, type Memory, type MemoryKind, type Profile, tool, upload, useTool, write } from "@/lib/core";

const FIELDS: Array<[Exclude<keyof Profile, "id">, string, string]> = [
  ["name", "姓名", "张三"], ["phone", "电话", "138 0000 0000"], ["email", "邮箱", "you@example.com"], ["city", "城市", "上海"],
  ["school", "学校", "复旦大学"], ["major", "专业", "计算机科学与技术"], ["degree", "学历", "本科"], ["grad_year", "毕业年份", "2026"],
  ["target", "求职方向", "后端开发 / 产品经理"],
];
const input = "w-full rounded-md bg-transparent px-2 py-1 text-[13.5px] text-[var(--foreground)] outline-none placeholder:text-[var(--foreground-muted)] placeholder:opacity-50 hover:bg-[var(--surface)] focus:bg-[var(--surface)]";

/** 失焦就存；空字符串等于删掉这个字段。 */
function Field({ value, onSave, ...rest }: { value?: string; onSave: (v: string | null) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value">) {
  const [v, setV] = useState(value ?? "");
  useEffect(() => setV(value ?? ""), [value]);
  return <input {...rest} value={v} onChange={(e) => setV(e.target.value)} style={{ fontSize: 13.5 }}
    onBlur={() => { if (v !== (value ?? "")) onSave(v.trim() || null); }} className={`${input} ${rest.className ?? ""}`} />;
}

function Body({ value, onSave }: { value?: string; onSave: (v: string | null) => void }) {
  const [v, setV] = useState(value ?? "");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setV(value ?? ""), [value]);
  useEffect(() => { const el = ref.current; if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; } }, [v]);
  return <textarea ref={ref} value={v} rows={1} onChange={(e) => setV(e.target.value)} placeholder="做了什么、结果是多少、用了什么。越具体，简历和网申越好写。"
    aria-label="经历内容" style={{ fontSize: 13 }} onBlur={() => { if (v !== (value ?? "")) onSave(v.trim() || null); }}
    className={`${input} resize-none overflow-hidden leading-6 text-[var(--foreground-muted)] focus:text-[var(--foreground)]`} />;
}

function MemoryItem({ memory }: { memory: Memory }) {
  const save = (data: Record<string, unknown>) => void write("save", { type: "memory", id: memory.id, data });
  return (
    <li className="group py-2">
      <div className="flex items-center gap-2">
        <Field value={memory.title} placeholder="标题，比如：字节跳动 | 后端开发实习生" aria-label="经历标题" className="font-medium" onSave={(title) => save({ title })} />
        <Field value={memory.start} placeholder="开始" aria-label="开始时间" className="!w-20 text-right text-[12.5px] text-[var(--foreground-muted)]" onSave={(start) => save({ start })} />
        <span className="text-[var(--foreground-muted)]">–</span>
        <Field value={memory.end} placeholder="结束" aria-label="结束时间" className="!w-20 text-[12.5px] text-[var(--foreground-muted)]" onSave={(end) => save({ end })} />
        <button type="button" onClick={() => void write("delete", { type: "memory", id: memory.id })}
          className="shrink-0 text-[12px] text-[var(--foreground-muted)] opacity-0 hover:text-[var(--foreground)] group-hover:opacity-100 focus:opacity-100">删除</button>
      </div>
      <Body value={memory.body} onSave={(body) => save({ body })} />
    </li>
  );
}

/** 档案：基本信息一份，经历一条一件事。简历、网申、面试都从这里取。 */
export default function ProfilePage() {
  const { data: profileData } = useTool<{ record: Profile | null }>("get", { type: "profile" });
  const { data: memoryData } = useTool<{ items: Memory[] }>("list", { type: "memory", full: true, limit: 500 }, 5000);
  const [importing, setImporting] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const profile = profileData?.record ?? {};
  const memories = [...(memoryData?.items ?? [])].sort((a, b) => a.id - b.id);
  const saveProfile = (data: Record<string, unknown>) => void write("save", { type: "profile", data });

  const importResume = async (file: File) => {
    setImporting("正在读取…");
    try {
      const { name, original } = await upload(file);
      const { text } = await tool<{ text: string }>("read_file", { path: name });
      await write("save", { type: "memory", data: { kind: "note", title: `旧简历原文：${original}`, body: text } });
      setImporting("已存进「其他」。在 Codex 里说「把档案里的旧简历拆成一条条经历」，或者等 Ctrl+K 助手上线后让它来拆。");
    } catch (e) {
      setImporting(e instanceof Error ? e.message : "读取失败");
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-10 px-6 py-10">
      <header className="flex items-start justify-between gap-6">
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight text-[var(--foreground)]">档案</h1>
          <p className="mt-1 text-[13.5px] text-[var(--foreground-muted)]">简历、网申、面试都从这里取。Agent 听到你的新经历，也会直接记在这里。</p>
        </div>
        <button type="button" onClick={() => fileRef.current?.click()} style={{ fontSize: 13 }}
          className="shrink-0 rounded-md border border-[var(--border)] px-3 py-1.5 text-[13px] text-[var(--foreground)] hover:bg-[var(--surface)]">导入旧简历</button>
        <input ref={fileRef} type="file" accept=".pdf,.docx,.txt,.md" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importResume(f); e.target.value = ""; }} />
      </header>
      {importing && <p className="-mt-6 text-[13px] text-[var(--foreground-muted)]">{importing}</p>}

      <section className="flex gap-8">
        <dl className="grid flex-1 grid-cols-[88px_1fr] items-center gap-x-2 gap-y-0.5">
          {FIELDS.map(([key, name, hint]) => (
            <div key={key} className="contents">
              <dt className="text-[13px] text-[var(--foreground-muted)]">{name}</dt>
              <dd><Field value={profile[key]} placeholder={hint} aria-label={name} onSave={(v) => saveProfile({ [key]: v })} /></dd>
            </div>
          ))}
        </dl>
        <button type="button" onClick={() => photoRef.current?.click()} aria-label="证件照"
          className={`flex h-[112px] w-[84px] shrink-0 items-center justify-center overflow-hidden rounded-md ${profile.photo ? "" : "border border-dashed border-[var(--border)]"} text-[12px] text-[var(--foreground-muted)] hover:border-[var(--foreground-muted)]`}>
          {profile.photo ? <img src={apiUrl(`/api/files/${profile.photo}`)} alt="证件照" className="h-full w-full object-cover" /> : "证件照"}
        </button>
        <input ref={photoRef} type="file" accept="image/png,image/jpeg,image/webp" hidden
          onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) saveProfile({ photo: (await upload(f)).name }); }} />
      </section>

      {(Object.keys(MEMORY_KIND) as MemoryKind[]).map((kind) => {
        const items = memories.filter((m) => m.kind === kind);
        if (!items.length && (kind === "preference" || kind === "note")) return null;
        return (
          <section key={kind}>
            <div className="flex items-baseline justify-between border-b border-[var(--border)] pb-1.5">
              <h2 className="text-[13px] font-medium text-[var(--foreground)]">{MEMORY_KIND[kind]}</h2>
              <button type="button" className="text-[12.5px] text-[var(--foreground-muted)] hover:text-[var(--foreground)]"
                onClick={() => void write("save", { type: "memory", data: { kind, title: `新的${MEMORY_KIND[kind]}` } })}>添加</button>
            </div>
            {items.length ? <ul className="divide-y divide-[var(--border)]">{items.map((m) => <MemoryItem key={m.id} memory={m} />)}</ul>
              : <p className="py-2 text-[13px] text-[var(--foreground-muted)]">还没有。</p>}
          </section>
        );
      })}
    </div>
  );
}
