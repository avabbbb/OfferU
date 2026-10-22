"use client";

import { Fragment, useState } from "react";
import useSWR from "swr";

import { request } from "@/lib/api";
import { SHOWCASE } from "@/lib/showcase";
import { safeClientErrorMessage } from "@/lib/safe-error";

type Field = {
  id: string;
  section: string;
  group: string;
  label: string;
  kind: "fact" | "write" | "confirm" | "manual";
  value: string;
  existing: string;
  existing_state?: "filled" | "empty" | "unknown";
  sources: Array<{ id: string; label: string }>;
  unsupported: string[];
  existing_flags: string[];
  note: string;
  max_chars: number | null;
  copied: boolean;
  edited: boolean;
};
type Form = { id: number; site: string; status: "waiting" | "ready"; drafter: string; fields: Field[] };

const muted = "text-[var(--foreground-muted)]";
const darkButton = "inline-flex items-center rounded-lg bg-[var(--foreground)] px-3 py-1.5 text-[13px] font-medium disabled:opacity-50";
const small = { fontSize: 12 };
const quietButton = `text-[12px] ${muted} hover:text-[var(--foreground)] disabled:opacity-50`;

/** 把没有依据的句子标红；其余原样显示。 */
function Marked({ text, marks }: { text: string; marks: string[] }) {
  if (!marks.length) return <>{text}</>;
  const parts = text.split(new RegExp(`(${marks.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`));
  return <>{parts.map((part, i) => marks.includes(part)
    ? <mark key={i} className="rounded-sm bg-red-50 text-red-700">{part}</mark>
    : <Fragment key={i}>{part}</Fragment>)}</>;
}

const norm = (value: string) => value.replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase();

/** 官网把手机号显示成 138****5678 这种打码值时，只比没打码的部分。 */
function sameValue(existing: string, value: string) {
  if (!existing.includes("*")) return norm(existing) === norm(value);
  const [head, ...rest] = existing.split(/\*+/);
  return value.startsWith(head.trim()) && value.endsWith(rest.pop()?.trim() ?? "");
}

/** 为什么这条需要用户处理；null 表示可以折叠。 */
function attention(field: Field): { text: string; risk: boolean } | null {
  if (field.existing_flags.length) return { text: "原解析内容混入了其他经历，需要对比修改", risk: true };
  if (field.unsupported.length) return { text: `有 ${field.unsupported.length} 句在档案里找不到依据，复制前改掉或删掉`, risk: true };
  if (field.kind === "confirm") return { text: field.note || "档案里没有可靠记录，需要你确认", risk: false };
  if (field.kind === "fact" && field.existing && !sameValue(field.existing, field.value))
    return { text: `官网里是「${field.existing}」，和档案不一致`, risk: true };
  if (field.kind === "write") return { text: field.existing ? "按岗位重写，需要替换官网原内容" : "按岗位写好了，需要复制到官网", risk: false };
  return null;
}

/** 「CLIProxyAPI · 项目职责」：同名字段靠区块和序号区分。 */
function fieldTitle(field: Field) {
  const owner = field.group.includes("：") ? field.group.split("：").pop() : field.group;
  return owner ? `${owner} · ${field.label}` : field.label;
}

function copyState(field: Field) {
  return field.copied ? "已复制，还没确认已粘贴到官网" : "";
}

/** 已识别、没冲突的字段：一行，标题 + 值 + 复制。 */
function CompactRow({ field, onCopy }: { field: Field; onCopy: () => void }) {
  return (
    <div className="flex items-baseline gap-3 py-1.5 text-[13px]">
      <span className={`w-28 shrink-0 ${muted}`}>{field.label}</span>
      <span className="min-w-0 flex-1 truncate text-[var(--foreground)]">{field.value || <span className={muted}>{field.kind === "manual" ? field.value : "—"}</span>}</span>
      {field.existing_state === "unknown" && field.kind === "fact" && <span className={`shrink-0 text-[12px] ${muted}`}>无法确认原填写内容</span>}
      {field.value && field.kind === "fact" && (
        <button type="button" onClick={onCopy} style={small} className="shrink-0 text-[12px] font-medium text-[var(--foreground)] hover:underline">
          {field.copied ? "已复制" : "复制"}
        </button>
      )}
    </div>
  );
}

function FieldRow({ form, field, onChange }: { form: Form; field: Field; onChange: (form: Form) => void }) {
  const flagged = field.existing_flags.length > 0;
  const [editing, setEditing] = useState(false);
  const [compare, setCompare] = useState(flagged);
  const [showSources, setShowSources] = useState(false);
  const [draft, setDraft] = useState(field.value);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const path = `/api/apply-forms/${form.id}/fields/${field.id}`;
  const reason = attention(field);

  const run = async (name: string, work: () => Promise<{ form: Form }>) => {
    setBusy(name);
    setError("");
    try {
      onChange((await work()).form);
    } catch (cause) {
      setError(safeClientErrorMessage(cause, "没成功，请再试一次。"));
    } finally {
      setBusy("");
    }
  };
  const copy = () => run("copy", async () => {
    await navigator.clipboard.writeText(field.value);
    return request<{ form: Form }>(path, { method: "PATCH", body: JSON.stringify({ copied: true }) });
  });
  const save = () => run("save", async () => {
    const result = await request<{ form: Form }>(path, { method: "PATCH", body: JSON.stringify({ value: draft }) });
    setEditing(false);
    return result;
  });
  const regenerate = () => run("regen", async () => {
    const result = await request<{ form: Form }>(`${path}/regenerate`, { method: "POST" });
    setDraft(result.form.fields.find((item) => item.id === field.id)?.value ?? "");
    return result;
  });

  const count = field.kind === "write" ? `${field.value.length}${field.max_chars ? ` / ${field.max_chars}` : " 字"}` : "";
  const original = field.existing && (
    <div className="rounded-lg bg-[var(--background)] p-3">
      <p className={`text-[12px] ${muted}`}>官网原来的内容</p>
      <p className="mt-1 whitespace-pre-wrap text-[13px] leading-6 text-[var(--foreground)]"><Marked text={field.existing} marks={field.existing_flags} /></p>
    </div>
  );
  const unknownOriginal = !field.existing && field.existing_state === "unknown" && (
    <p className={`text-[12px] ${muted}`}>复制的页面文字里看不到这一项原来填了什么，请在官网上核对。</p>
  );
  return (
    <div className="py-3.5">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-[13px] font-medium text-[var(--foreground)]">{fieldTitle(field)}</span>
        {field.value && field.kind !== "manual" && !editing && (
          <button type="button" onClick={copy} disabled={!!busy} style={small} className="shrink-0 text-[12px] font-medium text-[var(--foreground)] hover:underline disabled:opacity-50">
            {field.copied ? "已复制" : "复制"}
          </button>
        )}
      </div>
      {reason && <p className={`mt-0.5 text-[12px] leading-5 ${reason.risk ? "text-red-700" : muted}`}>{reason.text}</p>}

      {editing ? (
        <div className="mt-2 space-y-2">
          {original}
          <textarea value={draft} style={{ fontSize: 13 }} onChange={(event) => setDraft(event.target.value)} rows={Math.min(10, Math.max(3, Math.ceil(draft.length / 48)))}
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--background)] p-2.5 leading-6 text-[var(--foreground)] outline-none focus:border-[var(--foreground-muted)]" />
        </div>
      ) : compare && field.existing ? (
        <div className="mt-2 grid gap-3 md:grid-cols-2">
          {original}
          <div className="rounded-lg border border-[var(--border)] p-3">
            <p className={`text-[12px] ${muted}`}>新草稿</p>
            <p className="mt-1 whitespace-pre-wrap text-[13px] leading-6 text-[var(--foreground)]"><Marked text={field.value} marks={field.unsupported} /></p>
          </div>
        </div>
      ) : field.value ? (
        <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-6 text-[var(--foreground)]"><Marked text={field.value} marks={field.unsupported} /></p>
      ) : null}
      {!editing && unknownOriginal && <div className="mt-1">{unknownOriginal}</div>}
      {showSources && field.sources.length > 0 && (
        <p className={`mt-1 text-[12px] ${muted}`}>来源：{field.sources.map((item) => item.label.split("｜").pop()).join("、")}</p>
      )}

      <div className="mt-1.5 flex flex-wrap items-center gap-3">
        {editing ? (
          <>
            <button type="button" onClick={save} disabled={!!busy} style={{ color: "var(--background)", fontSize: 13 }} className={darkButton}>保存</button>
            <button type="button" onClick={() => { setEditing(false); setDraft(field.value); }} style={small} className={quietButton}>取消</button>
          </>
        ) : (
          <>
            {field.kind !== "manual" && <button type="button" onClick={() => { setDraft(field.value); setEditing(true); }} style={small} className={quietButton}>{field.value ? "编辑" : "自己填写"}</button>}
            {field.kind === "write" && <button type="button" onClick={regenerate} disabled={!!busy} style={small} className={quietButton}>{busy === "regen" ? "正在重写…" : "重新生成"}</button>}
            {field.existing && <button type="button" onClick={() => setCompare(!compare)} style={small} className={quietButton}>{compare ? "收起原文" : "对比原文"}</button>}
            {field.sources.length > 0 && <button type="button" onClick={() => setShowSources(!showSources)} style={small} className={quietButton}>来源</button>}
          </>
        )}
        {count && <span className={`text-[12px] ${muted}`}>{count}</span>}
        {field.copied && <span className={`text-[12px] ${muted}`}>{copyState(field)}</span>}
        {field.edited && <span className={`text-[12px] ${muted}`}>你改过，只用于这次填写</span>}
      </div>
      {error && <p role="alert" className="mt-1 text-[12px] text-red-700">{error}</p>}
    </div>
  );
}

/** 一个区块：待处理的字段展开；已识别没冲突的折成一行摘要，点开逐项核对。 */
function SectionBlock({ form, name, fields, all, onChange }: {
  form: Form; name: string; fields: Field[]; all: boolean; onChange: (form: Form) => void;
}) {
  const [open, setOpen] = useState(false);
  const todo = fields.filter((field) => attention(field));
  const settled = fields.filter((field) => !attention(field));
  const unknown = settled.filter((field) => field.kind === "fact" && field.existing_state === "unknown").length;
  const copyFact = async (field: Field) => {
    await navigator.clipboard.writeText(field.value);
    onChange((await request<{ form: Form }>(`/api/apply-forms/${form.id}/fields/${field.id}`, {
      method: "PATCH", body: JSON.stringify({ copied: true }) })).form);
  };
  const summary = [
    settled.length && `${settled.length} 项已识别`,
    todo.length && `${todo.length} 项待处理`,
  ].filter(Boolean).join(" · ");
  const expanded = all || open;
  return (
    <div className="border-t border-[var(--border)] pt-3">
      <div className="flex items-baseline justify-between gap-4">
        <p className="text-[12px] font-medium text-[var(--foreground)]">{name}<span className={`ml-2 font-normal ${muted}`}>{summary}{unknown ? ` · ${unknown} 项看不到原填写内容` : ""}</span></p>
        {!all && settled.length > 0 && (
          <button type="button" onClick={() => setOpen(!open)} style={small} className={quietButton}>{open ? "收起" : "展开核对"}</button>
        )}
      </div>
      {(expanded ? fields : todo).map((field) => attention(field) || field.kind === "write"
        ? <FieldRow key={field.id} form={form} field={field} onChange={onChange} />
        : <CompactRow key={field.id} field={field} onCopy={() => void copyFact(field)} />)}
      <div className="pb-1" />
    </div>
  );
}

/** 官网投递助手 L1：粘贴招聘官网在线简历页 → 按页面字段逐条给出可复制内容。不打开、不填写、不提交网站。 */
export function ApplyFormAssistant({ jobId }: { jobId: number }) {
  const key = `/api/jobs/${jobId}/apply-form`;
  const { data, mutate } = useSWR<{ form: Form | null }>(SHOWCASE ? null : key, (path: string) => request(path), {
    refreshInterval: (latest) => (latest?.form?.status === "waiting" ? 3000 : 0),
  });
  const [text, setText] = useState("");
  const [pasting, setPasting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [promptCopied, setPromptCopied] = useState(false);
  const [showAll, setShowAll] = useState(false);
  if (!data) return null;
  const form = data.form;
  const showPaste = !form || pasting;

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await request<{ form: Form }>(key, { method: "POST", body: JSON.stringify({ page_text: text }) });
      await mutate(result, { revalidate: false });
      setPasting(false);
      setText("");
    } catch (cause) {
      setError(safeClientErrorMessage(cause, "没识别出来，请再试一次。"));
    } finally {
      setBusy(false);
    }
  };
  const agentPrompt = form ? `用 OfferU 官网投递助手，为表单 #${form.id} 按字段写草稿。` : "";
  const todoCount = form?.fields.filter((field) => attention(field)).length ?? 0;
  const sections: Array<[string, Field[]]> = [];
  for (const field of form?.fields ?? []) {
    const name = field.section || "其他";
    const last = sections[sections.length - 1];
    if (last && last[0] === name) last[1].push(field);
    else sections.push([name, [field]]);
  }

  return (
    <section id="apply-form" aria-labelledby="apply-form-title" className="scroll-mt-6 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
      <div className="flex items-start justify-between gap-6">
        <div>
          <h2 id="apply-form-title" className="text-[17px] font-semibold tracking-tight text-[var(--foreground)]">官网投递助手</h2>
          <p className={`mt-1 text-[13px] leading-6 ${muted}`}>
            {form && !pasting && form.status === "ready"
              ? `${form.site || "官网表单"} · ${todoCount} 项需要你处理，其余 ${form.fields.length - todoCount} 项已识别。复制只是放进剪贴板，粘贴和提交都在官网上由你完成。`
              : "打开招聘官网的在线简历页，全选复制（Ctrl+A、Ctrl+C）后粘贴到这里。OfferU 按页面上的字段逐条给出可复制的内容，不会打开或提交网站。"}
          </p>
        </div>
        {form && !pasting && (
          <div className="flex shrink-0 items-center gap-3">
            {form.status === "ready" && (
              <div role="group" aria-label="显示范围" className="flex rounded-lg border border-[var(--border)] p-0.5">
                {[["待处理", false], ["全部字段", true]].map(([label, value]) => (
                  <button key={String(label)} type="button" aria-pressed={showAll === value} onClick={() => setShowAll(value as boolean)}
                    style={{ fontSize: 12, color: showAll === value ? "var(--background)" : undefined }}
                    className={`rounded-md px-2.5 py-1 ${showAll === value ? "bg-[var(--foreground)]" : muted}`}>{label}</button>
                ))}
              </div>
            )}
            <button type="button" onClick={() => setPasting(true)} style={small} className={quietButton}>重新粘贴</button>
          </div>
        )}
      </div>

      {showPaste && (
        <div className="mt-4">
          <textarea value={text} onChange={(event) => setText(event.target.value)} rows={8} style={{ fontSize: 13 }} aria-label="招聘官网页面内容"
            placeholder="粘贴招聘官网在线简历页的全部文字"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 text-[13px] leading-6 text-[var(--foreground)] outline-none focus:border-[var(--foreground-muted)]" />
          <div className="mt-2 flex items-center gap-4">
            <button type="button" onClick={submit} disabled={busy || text.trim().length < 20} style={{ color: "var(--background)", fontSize: 13 }} className={darkButton}>
              {busy ? "正在识别…" : "识别填写字段"}
            </button>
            {form && <button type="button" onClick={() => setPasting(false)} style={small} className={quietButton}>取消</button>}
          </div>
          {error && <p role="alert" className="mt-2 text-[12px] text-red-700">{error}</p>}
        </div>
      )}

      {form && !pasting && form.status === "waiting" && (
        <div className="mt-4 rounded-lg bg-[var(--background)] p-4">
          <p className="text-[13px] text-[var(--foreground)]">页面已保存。没有可用的内置模型，可以让你的 Agent 来写，把这句话发给它：</p>
          <div className="mt-2 flex items-center justify-between gap-4">
            <code className="text-[13px] text-[var(--foreground)]">{agentPrompt}</code>
            <button type="button" style={small} className="shrink-0 text-[12px] font-medium text-[var(--foreground)] hover:underline"
              onClick={() => void navigator.clipboard.writeText(agentPrompt).then(() => setPromptCopied(true))}>
              {promptCopied ? "已复制" : "复制"}
            </button>
          </div>
          <p className={`mt-2 text-[12px] ${muted}`}>写好后这里会自动显示。</p>
        </div>
      )}

      {form && !pasting && form.status === "ready" && (
        <div className="mt-4 space-y-3">
          {sections.map(([name, fields]) => (
            <SectionBlock key={name} form={form} name={name} fields={fields} all={showAll}
              onChange={(next) => void mutate({ form: next }, { revalidate: false })} />
          ))}
        </div>
      )}
    </section>
  );
}
