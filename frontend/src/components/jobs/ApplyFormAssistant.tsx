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

function FieldRow({ form, field, onChange }: { form: Form; field: Field; onChange: (form: Form) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(field.value);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const path = `/api/apply-forms/${form.id}/fields/${field.id}`;

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

  const tag = field.kind === "confirm" ? "需要确认" : field.kind === "manual" ? "手动操作" : "";
  const count = field.kind === "write" ? `${field.value.length}${field.max_chars ? ` / ${field.max_chars}` : " 字"}` : "";
  return (
    <div className="py-4">
      <div className="flex items-baseline gap-2">
        <span className="text-[13px] font-medium text-[var(--foreground)]">{field.label}</span>
        {tag && <span className="text-[12px] text-amber-700">{tag}</span>}
      </div>
      {field.existing_flags.length > 0 && (
        <p className="mt-1.5 text-[12px] leading-5 text-red-700">页面原来填的这句可能混入了别的经历，不要直接照搬：{field.existing_flags.join(" ")}</p>
      )}
      {editing ? (
        <textarea value={draft} style={{ fontSize: 13 }} onChange={(event) => setDraft(event.target.value)} rows={Math.min(10, Math.max(2, Math.ceil(draft.length / 48)))}
          className="mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] p-2.5 text-[13px] leading-6 text-[var(--foreground)] outline-none focus:border-[var(--foreground-muted)]" />
      ) : field.value ? (
        <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-6 text-[var(--foreground)]"><Marked text={field.value} marks={field.unsupported} /></p>
      ) : null}
      {field.note && <p className={`mt-1 text-[12px] leading-5 ${muted}`}>{field.note}</p>}
      {field.unsupported.length > 0 && !editing && <p className="mt-1 text-[12px] text-red-700">标红的句子在你的档案里找不到依据，改掉或删掉再用。</p>}
      <div className="mt-2 flex flex-wrap items-center gap-4">
        {editing ? (
          <>
            <button type="button" onClick={save} disabled={!!busy} style={{ color: "var(--background)", fontSize: 13 }} className={darkButton}>保存</button>
            <button type="button" onClick={() => { setEditing(false); setDraft(field.value); }} style={small} className={quietButton}>取消</button>
          </>
        ) : (
          <>
            {field.value && field.kind !== "manual" && (
              <button type="button" onClick={copy} disabled={!!busy} style={small} className="text-[12px] font-medium text-[var(--foreground)] hover:underline disabled:opacity-50">
                {field.copied ? "已复制" : "复制"}
              </button>
            )}
            {field.kind !== "manual" && <button type="button" onClick={() => { setDraft(field.value); setEditing(true); }} style={small} className={quietButton}>{field.value ? "编辑" : "自己填写"}</button>}
            {field.kind === "write" && <button type="button" onClick={regenerate} disabled={!!busy} style={small} className={quietButton}>{busy === "regen" ? "正在重写…" : "重新生成"}</button>}
          </>
        )}
        {count && <span className={`text-[12px] ${muted}`}>{count}</span>}
        {field.sources.length > 0 && <span className={`truncate text-[12px] ${muted}`}>来源：{field.sources.map((s) => s.label.split("｜").pop()).join("、")}</span>}
        {field.edited && <span className={`text-[12px] ${muted}`}>你改过，只用于这次填写</span>}
      </div>
      {error && <p role="alert" className="mt-1 text-[12px] text-red-700">{error}</p>}
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
  const toConfirm = form?.fields.filter((field) => field.kind === "confirm").length ?? 0;

  return (
    <section id="apply-form" aria-labelledby="apply-form-title" className="scroll-mt-6 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
      <div className="flex items-start justify-between gap-6">
        <div>
          <h2 id="apply-form-title" className="text-[17px] font-semibold tracking-tight text-[var(--foreground)]">官网投递助手</h2>
          <p className={`mt-1 text-[13px] leading-6 ${muted}`}>
            {form && !pasting && form.status === "ready"
              ? `${form.site || "官网表单"} · ${form.fields.length} 个字段${toConfirm ? ` · ${toConfirm} 个需要你确认` : ""}。逐条复制到官网，提交前自己再看一眼。`
              : "打开招聘官网的在线简历页，全选复制（Ctrl+A、Ctrl+C）后粘贴到这里。OfferU 按页面上的字段逐条给出可复制的内容，不会打开或提交网站。"}
          </p>
        </div>
        {form && !pasting && <button type="button" onClick={() => setPasting(true)} style={small} className={`shrink-0 ${quietButton}`}>重新粘贴</button>}
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
        <div className="mt-2">
          {form.fields.map((field, index) => {
            const previous = form.fields[index - 1];
            const heading = !previous || previous.section !== field.section || previous.group !== field.group;
            return (
              <Fragment key={field.id}>
                {heading && (
                  <p className={`mt-4 border-b border-[var(--border)] pb-2 text-[12px] font-medium ${muted}`}>
                    {field.group || field.section}
                  </p>
                )}
                <div className={heading ? "" : "border-t border-[var(--border)]"}>
                  <FieldRow form={form} field={field} onChange={(next) => void mutate({ form: next }, { revalidate: false })} />
                </div>
              </Fragment>
            );
          })}
        </div>
      )}
    </section>
  );
}
