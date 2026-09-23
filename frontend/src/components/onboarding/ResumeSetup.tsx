import { useState } from "react";
import { Button, Checkbox } from "@nextui-org/react";
import { confirmProfileCandidate, importProfileResume, updateProfileData, type ProfileData, type ProfileImportResult } from "@/lib/hooks";
import { safeClientErrorMessage } from "@/lib/safe-error";
import { getProfileBulletText, parseProfileSectionDraft } from "@/lib/profileSchema";

const FIELD_LABELS: Record<string, string> = {
  school: "学校", degree: "学历", major: "专业", startDate: "开始时间", endDate: "结束时间",
  gpa: "成绩", description: "内容", company: "公司", position: "岗位", name: "名称", role: "职责",
  url: "链接", category: "类别", itemsText: "技能", scoreOrLevel: "成绩或级别", issuer: "颁发机构",
  date: "日期", subtitle: "补充信息", highlightsText: "要点",
};

function CandidateContent({ candidate }: { candidate: ProfileImportResult["bullets"][number] }) {
  const section = { ...candidate, id: candidate.index };
  const fields = Object.entries(parseProfileSectionDraft(section)).filter(([, value]) => value);
  const original = String(candidate.content_json.bullet || "");
  return fields.length ? <><dl className="mt-2 space-y-1 text-sm">
    {fields.map(([key, value]) => <div key={key} className="flex gap-2">
      <dt className="shrink-0 text-[var(--foreground-muted)]">{FIELD_LABELS[key]}</dt>
      <dd className="min-w-0 whitespace-pre-wrap break-words">{String(value)}</dd>
    </div>)}
  </dl>{original && !fields.some(([, value]) => value === original) && <p className="mt-2 whitespace-pre-wrap break-words text-sm">{original}</p>}</>
    : <p className="mt-2 whitespace-pre-wrap break-words text-sm">{getProfileBulletText(section)}</p>;
}

const canConfirm = (candidate: ProfileImportResult["bullets"][number]) =>
  Number(candidate.memory_proposal_id) > 0 && ["pending", "pending_review", "deferred", "accepted"].includes(candidate.candidate_state || "pending");

export function ResumeSetup({ profile, onDone, onBusy }: {
  profile?: ProfileData; onDone: () => void; onBusy: (busy: boolean) => void;
}) {
  const [result, setResult] = useState<ProfileImportResult | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [confirmed, setConfirmed] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = result?.bullets.filter(canConfirm) || [];
  const setWorking = (value: boolean) => { setBusy(value); onBusy(value); };

  const upload = async (file?: File) => {
    if (!file || busy) return;
    setError("");
    if (!/\.(pdf|docx)$/i.test(file.name) || file.size > 10 * 1024 * 1024) {
      setError("请选择不超过 10 MB 的 PDF 或 Word 简历。");
      return;
    }
    setWorking(true);
    try {
      // The first import works without a model subscription or API key.
      const imported = await importProfileResume(file, "mechanical");
      setResult(imported);
      setSelected(imported.bullets.filter(canConfirm).map((item) => item.index));
      setConfirmed(imported.bullets.filter((item) => item.candidate_state === "accepted").map((item) => item.index));
      if (!imported.bullets.length) setError("没有识别到可确认的经历。可以换一份文字版简历，或稍后在职业档案中补充。");
    } catch (cause) {
      setError(safeClientErrorMessage(cause, "简历读取失败，请重试。"));
    } finally { setWorking(false); }
  };

  const confirm = async () => {
    if (!result || !selected.length || busy) return;
    setWorking(true);
    setError("");
    try {
      for (const index of selected) {
        if (confirmed.includes(index)) continue;
        const candidate = result.bullets.find((item) => item.index === index);
        if (!candidate?.memory_proposal_id || result.session_id <= 0) throw new Error("这条内容缺少来源，请重新导入简历。");
        await confirmProfileCandidate({ session_id: result.session_id, bullet_index: index });
        // A retry must not re-apply candidates that already succeeded.
        setConfirmed((current) => [...current, index]);
      }
      const base = Object.fromEntries(Object.entries(result.base_info || {}).filter(([, value]) => typeof value === "string" && value.trim()));
      if (Object.keys(base).length) await updateProfileData({
        ...(base.name ? { name: base.name } : {}),
        base_info_json: { ...(profile?.base_info_json || {}), ...base },
      });
      onDone();
    } catch (cause) {
      setError(safeClientErrorMessage(cause, "部分内容尚未保存，已成功的条目会保留，可以重试。"));
    } finally { setWorking(false); }
  };

  return <div className="space-y-4">
    <label className="block cursor-pointer rounded-xl border-2 border-dashed border-[var(--border)] p-6 text-center"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => { event.preventDefault(); void upload(event.dataTransfer.files[0]); }}>
      <span className="block font-semibold">{busy ? "正在整理，请稍候…" : "拖入简历，或点击选择文件"}</span>
      <span className="mt-2 block text-xs text-[var(--foreground-muted)]">PDF / Word · 最多 10 MB · 本机读取</span>
      <input className="sr-only" type="file" accept=".pdf,.docx" disabled={busy} aria-label="选择简历文件"
        onChange={(event) => { void upload(event.target.files?.[0]); event.target.value = ""; }} />
    </label>
    {result && <>
      <p className="text-sm">{result.filename} · 识别出 {result.bullets.length} 条内容，请核对后确认。</p>
      {Object.entries(result.base_info || {}).filter(([, value]) => value).length > 0 && <div className="rounded-lg bg-[var(--surface-muted)] p-3 text-sm">
        <p className="mb-1 font-medium">一并保存的个人信息</p>
        <p className="break-words">{Object.values(result.base_info || {}).filter(Boolean).join(" · ")}</p>
      </div>}
      <Checkbox isDisabled={busy} isSelected={pending.length > 0 && pending.every((item) => selected.includes(item.index))}
        onValueChange={(checked) => setSelected(checked ? pending.map((item) => item.index) : [])}>选择全部可确认内容</Checkbox>
      <ul className="max-h-64 space-y-2 overflow-y-auto">
        {result.bullets.map((candidate) => <li key={candidate.index} className="rounded-lg border border-[var(--border)] p-3">
          <Checkbox isDisabled={busy || !canConfirm(candidate) || confirmed.includes(candidate.index)}
            isSelected={selected.includes(candidate.index)} onValueChange={(checked) => setSelected((current) => checked ? [...current, candidate.index] : current.filter((index) => index !== candidate.index))}>
            {candidate.title}{confirmed.includes(candidate.index) ? " · 已确认" : ""}
          </Checkbox>
          <CandidateContent candidate={candidate} />
          <p className="mt-1 text-xs text-[var(--foreground-muted)]">{candidate.source_ref || "上传的简历"}{!candidate.memory_proposal_id ? " · 来源尚未建立，暂不能确认" : ""}</p>
        </li>)}
      </ul>
      <Button color="primary" isLoading={busy} isDisabled={!selected.length} onPress={() => void confirm()}>确认所选内容，建立档案</Button>
    </>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
  </div>;
}
