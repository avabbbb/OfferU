"use client";

import { useEffect, useRef, useState } from "react";

import { apiUrl, MEMORY_KIND, MEMORY_MODE, type Memory, type MemoryKind, type Profile, tool, upload, useTool, write } from "@/lib/core";

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
        {MEMORY_MODE[memory.kind] && (
          <select value={memory.mode ?? ""} aria-label="性质" onChange={(e) => save({ mode: e.target.value || null })}
            className="shrink-0 rounded-md bg-transparent px-1 py-1 text-[12.5px] text-[var(--foreground-muted)] outline-none hover:bg-[var(--surface)] focus:bg-[var(--surface)]">
            <option value="">性质未填</option>
            {MEMORY_MODE[memory.kind]?.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        )}
        <Field value={memory.start} placeholder="开始" aria-label="开始时间" className="!w-20 text-right text-[12.5px] text-[var(--foreground-muted)]" onSave={(start) => save({ start })} />
        <span className="text-[var(--foreground-muted)]">–</span>
        <Field value={memory.end} placeholder="结束" aria-label="结束时间" className="!w-20 text-[12.5px] text-[var(--foreground-muted)]" onSave={(end) => save({ end })} />
        {memory.confirmed === false && (
          <>
            <span className="shrink-0 text-[12px] text-amber-600" title="确认前不会写进定制简历">
              待确认{memory.source === "agent" ? " · 来源：Agent 推断" : ""}
            </span>
            <button type="button" onClick={() => save({ confirmed: true })}
              className="shrink-0 rounded-md border border-[var(--border-strong)] px-2 py-0.5 text-[12px] text-[var(--foreground)] hover:bg-[var(--surface-muted)]">确认</button>
          </>
        )}
        <button type="button" onClick={() => void write("delete", { type: "memory", id: memory.id })}
          className="shrink-0 text-[12px] text-[var(--foreground-muted)] opacity-0 hover:text-[var(--foreground)] group-hover:opacity-100 focus:opacity-100">删除</button>
      </div>
      <Body value={memory.body} onSave={(body) => save({ body })} />
    </li>
  );
}

type Finding = {
  kind: "conflict" | "status_drift" | "duplicate" | "stale_gap"; key: string; memory_ids: number[]; suggestion: string;
  evidence: Array<{ source: string; field?: string; text: string }>;
  proposed: { type: "memory"; id: number; data: Record<string, unknown> } | null;
};
const FINDING_KIND: Record<Finding["kind"], string> = { conflict: "说法冲突", status_drift: "进度对不上", duplicate: "可能重复", stale_gap: "待补太久" };
const small = "shrink-0 rounded-md border border-[var(--border-strong)] px-2 py-0.5 text-[12px] text-[var(--foreground)] hover:bg-[var(--surface-muted)]";

/** 待核对：reconcile_memory 找出的前后对不上的地方。采纳走 save（进最近改动，可撤销）；忽略只在本页隐藏。 */
function Reconcile() {
  const { data } = useTool<{ items: Finding[] }>("reconcile_memory", {}, 30000);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const dismiss = (key: string) => setDismissed((d) => [...d, key]);
  const items = (data?.items ?? []).filter((f) => !dismissed.includes(f.key));
  if (!items.length) return null;
  return (
    <section>
      <div className="border-b border-[var(--border)] pb-1.5"><h2 className="text-[13px] font-medium text-[var(--foreground)]">待核对</h2></div>
      <ul className="divide-y divide-[var(--border)]">
        {items.map((f) => (
          <li key={f.key} className="space-y-1 py-2">
            <div className="flex items-center gap-2 text-[13px]">
              <span className="shrink-0 text-[12px] text-amber-600">{FINDING_KIND[f.kind]}</span>
              <span className="flex-1 text-[var(--foreground)]">{f.suggestion}</span>
              {f.proposed && (
                <button type="button" className={small} title={String(f.proposed.data.body ?? "")}
                  onClick={() => { if (f.proposed) void write("save", f.proposed).then(() => dismiss(f.key)); }}>采纳</button>
              )}
              <button type="button" className={small} onClick={() => dismiss(f.key)}>忽略</button>
            </div>
            <ul className="space-y-0.5 text-[12.5px] text-[var(--foreground-muted)]">
              {f.evidence.map((e, i) => (
                <li key={i}><span className="mr-2 text-[12px]">{e.source === "profile" ? "档案" : e.source}{e.field === "quote" ? " 原话" : ""}</span>{e.text}</li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
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

  const [lastImport, setLastImport] = useState<number[]>([]);
  const importResume = async (file: File) => {
    setImporting("正在读取...");
    setLastImport([]);
    try {
      const { name, original } = await upload(file);
      try {
        setImporting("正在拆成一条条经历，可能要一两分钟...");
        const { count, change_ids } = await write<{ count: number; change_ids: number[] }>("split_resume", { path: name });
        setLastImport(change_ids);
        setImporting(`已从「${original}」拆出 ${count} 条经历，写进档案。`);
      } catch (e) {
        const { text } = await tool<{ text: string }>("read_file", { path: name });
        await write("save", { type: "memory", data: { kind: "note", title: `旧简历原文：${original}`, body: text } });
        setImporting(`没能自动拆分（${e instanceof Error ? e.message : "未知原因"}），原文已存进「其他」。可以在你的 Agent 里说「把档案里的旧简历拆成一条条经历」。`);
      }
    } catch (e) {
      setImporting(e instanceof Error ? e.message : "读取失败");
    }
  };
  const undoImport = async () => {
    for (const id of [...lastImport].reverse()) await write("undo", { change_id: id });
    setLastImport([]);
    setImporting("已撤销这次导入。");
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
      {importing && <p className="-mt-6 flex flex-wrap items-center gap-3 text-[13px] text-[var(--foreground-muted)]">{importing}{lastImport.length > 0 && <button type="button" onClick={() => void undoImport()} className="underline">撤销这次导入</button>}</p>}

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

      <Reconcile />

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
