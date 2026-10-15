"use client";

// =============================================
// 档案为空时的冷启动：用户二选一
//  (a) 导入旧简历 → 抽出候选 → 逐条确认才写入档案（走来源证据提案）
//  (b) 直接写几条经历 → 用户亲手写、勾选「这是真实经历」才保存为已确认事实
// 任何一条都不会在用户点确认前进入档案。
// =============================================

import { useRef, useState } from "react";
import { Button, Input, Textarea } from "@heroui/react";
import { Check, FileUp, PenLine, X } from "lucide-react";
import {
  createProfileSection,
  importProfileResume,
  type ProfileBulletCandidate,
  type ProfileImportResult,
  undoProfileResumeImport,
} from "@/lib/hooks";
import { memoryApi } from "@/lib/api";
import { bauhausFieldClassNames } from "@/lib/bauhaus";
import { safeClientErrorMessage } from "@/lib/safe-error";

type Mode = "import" | "manual";
type CandidateState = "kept" | "removed";
type ManualKind = "experience" | "internship" | "project";

interface ProfileColdStartProps {
  verifiedCount: number;
  /** 档案有变化（新增已确认条目）后刷新外层数据。 */
  onProfileChanged: () => void | Promise<unknown>;
  /** 用户确认够了，回到定制。 */
  onDone: () => void;
}

const MANUAL_KINDS: Array<{ key: ManualKind; label: string }> = [
  { key: "internship", label: "实习" },
  { key: "experience", label: "工作" },
  { key: "project", label: "项目" },
];

export function candidateSummary(candidate: ProfileBulletCandidate): string {
  const content = candidate.content_json || {};
  const direct = [content.bullet, content.description, content.summary].find(
    (value) => typeof value === "string" && value.trim()
  );
  if (direct) return String(direct).trim();
  const normalized = content.normalized;
  if (normalized && typeof normalized === "object") {
    return Object.values(normalized)
      .filter((value) => typeof value === "string" && value.trim())
      .join(" · ")
      .trim();
  }
  return "";
}

/** 把用户手写的一条经历转成档案条目载荷；只有用户勾选真实后才会被调用。 */
export function manualSectionPayload(input: {
  kind: ManualKind;
  org: string;
  role: string;
  period: string;
  description: string;
}) {
  const [startDate = "", endDate = ""] = input.period.split(/\s*(?:-|–|—|~|至|到)\s*/);
  const description = input.description.trim();
  const isProject = input.kind === "project";
  return {
    section_type: isProject ? "project" : "experience",
    category_label: isProject ? "项目经历" : input.kind === "internship" ? "实习经历" : "工作经历",
    title: input.org.trim(),
    content_json: isProject
      ? { name: input.org.trim(), role: input.role.trim(), start_date: startDate.trim(), end_date: endDate.trim(), description, bullet: description }
      : { company: input.org.trim(), position: input.role.trim(), start_date: startDate.trim(), end_date: endDate.trim(), description, bullet: description },
    source: "manual",
    confidence: 1,
    tier: "verified_fact" as const,
  };
}

function chip(active: boolean) {
  return `flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
    active
      ? "border-[var(--foreground)] bg-[var(--foreground)] text-[var(--surface)]"
      : "border-[var(--border)] text-[var(--foreground-muted)] hover:text-[var(--foreground)]"
  }`;
}

export function ProfileColdStart({ verifiedCount, onProfileChanged, onDone }: ProfileColdStartProps) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [error, setError] = useState("");

  // (a) 导入旧简历
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<ProfileImportResult | null>(null);
  const [states, setStates] = useState<Record<number, CandidateState>>({});
  const [reviewing, setReviewing] = useState<number | null>(null);

  // (b) 直接写
  const [kind, setKind] = useState<ManualKind>("internship");
  const [org, setOrg] = useState("");
  const [role, setRole] = useState("");
  const [period, setPeriod] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedTitles, setSavedTitles] = useState<string[]>([]);

  const [undone, setUndone] = useState(false);

  const upload = async (file: File) => {
    setImporting(true);
    setError("");
    setUndone(false);
    try {
      const result = await importProfileResume(file, "ai");
      setImported(result);
      setStates({});
      await onProfileChanged();
    } catch (err) {
      setError(safeClientErrorMessage(err, "简历解析失败，换一份 PDF/DOCX 试试，或改用「直接写几条经历」。"));
    } finally {
      setImporting(false);
    }
  };

  // 单条「不是我的」：撤回这条已入档的经历
  const removeOne = async (index: number) => {
    if (!imported || reviewing !== null) return;
    const proposalId = Number(imported.bullets[index]?.memory_proposal_id || 0);
    if (!proposalId) return;
    setReviewing(index);
    setError("");
    try {
      await memoryApi.reviewProposal(proposalId, "revoke", "用户在导入结果里删掉");
      setStates((prev) => ({ ...prev, [index]: "removed" }));
      await onProfileChanged();
    } catch (err) {
      setError(safeClientErrorMessage(err, "删除失败，请重试。"));
    } finally {
      setReviewing(null);
    }
  };

  const undoImport = async () => {
    if (!imported) return;
    setReviewing(-1);
    setError("");
    try {
      await undoProfileResumeImport(imported.session_id);
      setUndone(true);
      setImported(null);
      await onProfileChanged();
    } catch (err) {
      setError(safeClientErrorMessage(err, "撤销失败，请重试。"));
    } finally {
      setReviewing(null);
    }
  };

  const saveManual = async () => {
    setSaving(true);
    setError("");
    try {
      await createProfileSection(manualSectionPayload({ kind, org, role, period, description }));
      setSavedTitles((prev) => [...prev, `${org.trim()}${role.trim() ? ` · ${role.trim()}` : ""}`]);
      setOrg("");
      setRole("");
      setPeriod("");
      setDescription("");
      await onProfileChanged();
    } catch (err) {
      setError(safeClientErrorMessage(err, "保存失败，请重试。"));
    } finally {
      setSaving(false);
    }
  };

  const importedCount = imported ? imported.imported_count ?? imported.bullets.length : 0;
  const canSaveManual = Boolean(org.trim() && description.trim().length >= 10) && !saving;

  return (
    <div className="flex h-full flex-col overflow-y-auto p-5 custom-scrollbar" data-testid="profile-cold-start">
      <h3 className="text-[15px] font-semibold text-[var(--foreground)]">先给 AI 你的经历</h3>
      <p className="mt-1 text-[13px] leading-relaxed text-[var(--foreground-muted)]">
        导入旧简历或直接写几条，定制只在这些经历上改措辞，不会编新事实。
      </p>

      <div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label="冷启动方式">
        <button type="button" role="tab" aria-selected={mode === "import"} className={chip(mode === "import")} onClick={() => setMode("import")}>
          <FileUp size={13} /> 导入旧简历
        </button>
        <button type="button" role="tab" aria-selected={mode === "manual"} className={chip(mode === "manual")} onClick={() => setMode("manual")}>
          <PenLine size={13} /> 直接写几条经历
        </button>
      </div>

      {mode === "import" && (
        <div className="mt-4 space-y-3">
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.docx"
            className="hidden"
            aria-label="选择简历文件"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void upload(file);
            }}
          />
          {!imported ? (
            <Button size="sm" className="bauhaus-button" isLoading={importing} startContent={!importing ? <FileUp size={14} /> : undefined} onPress={() => fileRef.current?.click()}>
              {importing ? "正在读取简历…" : "选择 PDF / DOCX"}
            </Button>
          ) : null}
          {!imported && undone ? (
            <p className="text-xs text-[var(--foreground-muted)]">已撤销上次导入，档案里那批经历已移除。</p>
          ) : null}
          {imported ? (
            <>
              <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--foreground-muted)]">
                <span>已从 {imported.filename} 导入 {importedCount} 条经历，定制时直接用；之后可以在档案里改。</span>
                <Button size="sm" variant="light" isLoading={reviewing === -1} isDisabled={reviewing !== null} onPress={() => void undoImport()}>
                  撤销这次导入
                </Button>
              </div>
              {imported.bullets.length === 0 && (
                <p className="text-sm text-[var(--foreground)]">没读出经历，改用「直接写几条经历」更快。</p>
              )}
              <ul className="space-y-2">
                {imported.bullets.map((candidate, index) => {
                  const removed = states[index] === "removed";
                  return (
                    <li
                      key={`${candidate.index}-${candidate.title}`}
                      className={`rounded-[10px] border p-3 ${candidate.needs_look && !removed ? "border-amber-300 bg-amber-50" : "border-[var(--border)]"} ${removed ? "opacity-50" : ""}`}
                    >
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-[13px] font-semibold text-[var(--foreground)]">{candidate.title || `经历 ${index + 1}`}</p>
                          <p className="mt-0.5 break-words text-xs leading-relaxed text-[var(--foreground-muted)]">{candidateSummary(candidate)}</p>
                          {candidate.needs_look && !removed && (
                            <p className="mt-0.5 text-[11px] font-semibold text-amber-700">这条没解析清楚，去档案里看一眼</p>
                          )}
                          {candidate.import_error && <p className="mt-0.5 text-[11px] text-[var(--foreground-muted)]">没能入档：{candidate.import_error}</p>}
                        </div>
                        {removed ? (
                          <span className="shrink-0 text-[11px] font-semibold text-[var(--foreground-muted)]">已删掉</span>
                        ) : candidate.candidate_state === "accepted" ? (
                          <Button size="sm" variant="light" startContent={<X size={13} />} isLoading={reviewing === index} isDisabled={reviewing !== null} onPress={() => void removeOne(index)}>
                            不是我的
                          </Button>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : null}
        </div>
      )}

      {mode === "manual" && (
        <div className="mt-4 space-y-2">
          <div className="flex gap-1.5">
            {MANUAL_KINDS.map((item) => (
              <button key={item.key} type="button" className={chip(kind === item.key)} onClick={() => setKind(item.key)}>{item.label}</button>
            ))}
          </div>
          <Input size="sm" label={kind === "project" ? "项目名称" : "公司"} value={org} onValueChange={setOrg} classNames={bauhausFieldClassNames} />
          <Input size="sm" label={kind === "project" ? "你的角色（可选）" : "职位（可选）"} value={role} onValueChange={setRole} classNames={bauhausFieldClassNames} />
          <Input size="sm" label="时间（可选，如 2024.07 - 2024.10）" value={period} onValueChange={setPeriod} classNames={bauhausFieldClassNames} />
          <Textarea
            label="你做了什么、结果如何"
            placeholder="写真实发生的事和数字，AI 只会改措辞，不会加内容"
            minRows={3}
            value={description}
            onValueChange={setDescription}
            classNames={bauhausFieldClassNames}
          />
          <Button size="sm" className="bauhaus-button" isLoading={saving} isDisabled={!canSaveManual} onPress={() => void saveManual()}>
            保存这条
          </Button>
          {savedTitles.length > 0 && (
            <ul className="space-y-1 pt-1 text-xs text-[var(--foreground-muted)]">
              {savedTitles.map((title, index) => (
                <li key={`${title}-${index}`} className="flex items-center gap-1.5"><Check size={12} /> 已保存：{title}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && <p role="alert" className="mt-3 text-xs text-[var(--primary-red)]">{error}</p>}

      <div className="mt-auto flex items-center justify-between gap-3 border-t border-[var(--border)] pt-4">
        <p className="text-xs text-[var(--foreground-muted)]">
          {verifiedCount > 0 ? `档案里已有 ${verifiedCount} 条确认过的经历` : "还没有确认过的经历"}
        </p>
        <Button size="sm" className="bauhaus-button bauhaus-button-red" isDisabled={verifiedCount === 0} onPress={onDone}>
          {verifiedCount > 0 ? "够了，开始定制" : "确认 1 条后可开始"}
        </Button>
      </div>
    </div>
  );
}
