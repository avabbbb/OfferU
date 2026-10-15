"use client";

// =============================================
// 粘贴岗位描述原文或链接 → 确认草稿 → 建岗位并直接进入定制
// 链接只做一次匿名公开读取；需要登录的招聘站会请你自己复制原文，
// OfferU 不替你抓取。草稿必须看过、确认后才写库。
// =============================================

import { useState } from "react";
import { Button, Input, Textarea } from "@heroui/react";
import { ClipboardPaste, X } from "lucide-react";
import { jobsApi, type JobCaptureDraft, type JobCaptureFields } from "@/lib/api";
import { bauhausFieldClassNames } from "@/lib/bauhaus";
import { safeClientErrorMessage } from "@/lib/safe-error";

interface JobCaptureCardProps {
  onCreated: (jobId: number) => void;
  onClose?: () => void;
}

const EMPTY_FIELDS: JobCaptureFields = { title: "", company: "", location: "", url: "", jd_text: "" };
const MIN_JD_CHARS = 80;

export function JobCaptureCard({ onCreated, onClose }: JobCaptureCardProps) {
  const [input, setInput] = useState("");
  const [draft, setDraft] = useState<JobCaptureDraft | null>(null);
  const [fields, setFields] = useState<JobCaptureFields>(EMPTY_FIELDS);
  const [rememberedUrl, setRememberedUrl] = useState("");
  const [busy, setBusy] = useState<"" | "draft" | "create">("");
  const [error, setError] = useState("");

  const recognise = async () => {
    const text = input.trim();
    if (!text) return;
    setBusy("draft");
    setError("");
    try {
      const result = await jobsApi.captureDraft(text);
      const url = result.draft.url || rememberedUrl;
      setRememberedUrl(url);
      setDraft(result);
      if (result.status === "needs_text") {
        // 链接读不到：清空输入框，让用户直接粘原文，链接保留。
        setInput("");
        setFields({ ...EMPTY_FIELDS, url });
      } else {
        setFields({ ...result.draft, url });
      }
    } catch (err) {
      setError(safeClientErrorMessage(err, "识别失败，请重试。"));
    } finally {
      setBusy("");
    }
  };

  const create = async () => {
    setBusy("create");
    setError("");
    try {
      const result = await jobsApi.capture({
        title: fields.title.trim(),
        company: fields.company.trim(),
        location: fields.location.trim(),
        url: fields.url.trim(),
        jd_text: fields.jd_text.trim(),
      });
      onCreated(result.job_id);
      setInput("");
      setDraft(null);
      setFields(EMPTY_FIELDS);
      setRememberedUrl("");
    } catch (err) {
      setError(safeClientErrorMessage(err, "建岗位失败，请重试。"));
    } finally {
      setBusy("");
    }
  };

  const showingDraft = draft !== null && draft.status !== "needs_text";
  const jdTooShort = fields.jd_text.trim().length < MIN_JD_CHARS;
  const canCreate = Boolean(fields.title.trim() && fields.company.trim()) && !jdTooShort && !busy;
  const set = (key: keyof JobCaptureFields) => (value: string) => setFields((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="space-y-2 rounded-[10px] border border-[var(--border)] bg-[var(--surface-muted)] p-3" data-testid="job-capture-card">
      <div className="flex items-center justify-between">
        <p className="text-[13px] font-semibold text-[var(--foreground)]">粘贴岗位描述或链接</p>
        {onClose && (
          <button type="button" aria-label="收起" onClick={onClose} className="text-[var(--foreground-muted)] hover:text-[var(--foreground)]">
            <X size={14} />
          </button>
        )}
      </div>

      {!showingDraft ? (
        <>
          {draft?.status === "needs_text" && (
            <p role="status" className="text-xs leading-relaxed text-[var(--foreground)]">{draft.message}</p>
          )}
          <Textarea
            aria-label="岗位描述原文或链接"
            placeholder={draft?.status === "needs_text" ? "把岗位描述原文粘贴到这里" : "整段岗位描述原文，或一个岗位链接"}
            minRows={3}
            maxRows={8}
            value={input}
            onValueChange={setInput}
            classNames={bauhausFieldClassNames}
          />
          <Button
            size="sm"
            className="bauhaus-button w-full"
            startContent={<ClipboardPaste size={14} />}
            isLoading={busy === "draft"}
            isDisabled={!input.trim() || Boolean(busy)}
            onPress={() => void recognise()}
          >
            识别
          </Button>
        </>
      ) : (
        <>
          {draft?.message && <p role="status" className="text-xs leading-relaxed text-[var(--foreground)]">{draft.message}</p>}
          {(draft?.conflicts || []).map((conflict) => {
            const label = conflict.field === "title" ? "岗位名称" : conflict.field === "company" ? "公司" : "地点";
            return (
              <div key={conflict.field} className="flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--foreground-muted)]">
                <span>{label}：</span>
                {[conflict.structured, conflict.llm].map((value, index) => (
                  <button
                    key={`${conflict.field}-${index}`}
                    type="button"
                    onClick={() => set(conflict.field)(value)}
                    className={`rounded-full border px-2 py-0.5 ${fields[conflict.field] === value ? "border-[var(--foreground)] text-[var(--foreground)]" : "border-[var(--border)]"}`}
                  >
                    {index === 0 ? "页面声明" : "模型读到"}：{value}
                  </button>
                ))}
              </div>
            );
          })}
          {draft?.extractor === "rules" && (
            <p className="text-[11px] leading-relaxed text-[var(--foreground-muted)]">没连上模型，用规则识别的，请核对岗位名称和公司。</p>
          )}
          <Input size="sm" label="岗位名称" value={fields.title} onValueChange={set("title")} isInvalid={!fields.title.trim()} errorMessage={!fields.title.trim() ? "没识别出来，请填写" : undefined} classNames={bauhausFieldClassNames} />
          <Input size="sm" label="公司" value={fields.company} onValueChange={set("company")} isInvalid={!fields.company.trim()} errorMessage={!fields.company.trim() ? "没识别出来，请填写" : undefined} classNames={bauhausFieldClassNames} />
          <Input size="sm" label="地点（可选）" value={fields.location} onValueChange={set("location")} classNames={bauhausFieldClassNames} />
          <Textarea
            label="岗位描述"
            minRows={4}
            maxRows={10}
            value={fields.jd_text}
            onValueChange={set("jd_text")}
            isInvalid={jdTooShort}
            errorMessage={jdTooShort ? "岗位描述太短，AI 没法据此定制" : undefined}
            classNames={bauhausFieldClassNames}
          />
          {fields.url && <p className="truncate text-[11px] text-[var(--foreground-muted)]">来源：{fields.url}</p>}
          <div className="flex gap-2">
            <Button size="sm" variant="light" isDisabled={Boolean(busy)} onPress={() => { setDraft(null); setFields(EMPTY_FIELDS); }}>
              重新粘贴
            </Button>
            <Button size="sm" className="bauhaus-button bauhaus-button-red flex-1" isLoading={busy === "create"} isDisabled={!canCreate} onPress={() => void create()}>
              建岗位并开始定制
            </Button>
          </div>
        </>
      )}
      {error && <p role="alert" className="text-xs text-[var(--primary-red)]">{error}</p>}
    </div>
  );
}
