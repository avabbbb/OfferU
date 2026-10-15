import { useState } from "react";
import { Button, Checkbox } from "@heroui/react";
import { importProfileResume, undoProfileResumeImport, type ProfileData, type ProfileImportResult } from "@/lib/hooks";
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

export function ResumeSetup({ onDone, onBusy }: {
  profile?: ProfileData; onDone: () => void; onBusy: (busy: boolean) => void;
}) {
  const [result, setResult] = useState<ProfileImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const setWorking = (value: boolean) => { setBusy(value); onBusy(value); };

  const upload = async (file?: File) => {
    if (!file || busy) return;
    setError("");
    setNotice("");
    if (!/\.(pdf|docx)$/i.test(file.name) || file.size > 10 * 1024 * 1024) {
      setError("请选择不超过 10 MB 的 PDF 或 Word 简历。");
      return;
    }
    setWorking(true);
    try {
      // The first import works without a model subscription or API key.
      // 解析出的经历和姓名 / 联系方式由后端直接写进档案，可整次撤销。
      const imported = await importProfileResume(file, "mechanical");
      setResult(imported);
      if (!imported.bullets.length) setError("没有识别到经历。可以换一份文字版简历，或稍后在职业档案中补充。");
    } catch (cause) {
      setError(safeClientErrorMessage(cause, "简历读取失败，请重试。"));
    } finally { setWorking(false); }
  };

  const undo = async () => {
    if (!result || busy) return;
    setWorking(true);
    setError("");
    try {
      await undoProfileResumeImport(result.session_id);
      setResult(null);
      setNotice("已撤销这次导入，可以换一份简历重新上传。");
    } catch (cause) {
      setError(safeClientErrorMessage(cause, "撤销失败，请重试。"));
    } finally { setWorking(false); }
  };

  const importedCount = result ? result.imported_count ?? result.bullets.length : 0;

  return <div className="space-y-4">
    <label className="block cursor-pointer rounded-xl border-2 border-dashed border-[var(--border)] p-6 text-center"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => { event.preventDefault(); void upload(event.dataTransfer.files[0]); }}>
      <span className="block font-semibold">{busy ? "正在整理，请稍候…" : "拖入简历，或点击选择文件"}</span>
      <span className="mt-2 block text-xs text-[var(--foreground-muted)]">PDF / Word · 最多 10 MB · 本机读取</span>
      <input className="sr-only" type="file" accept=".pdf,.docx" disabled={busy} aria-label="选择简历文件"
        onChange={(event) => { void upload(event.target.files?.[0]); event.target.value = ""; }} />
    </label>
    {notice && <p className="text-sm text-[var(--foreground-muted)]">{notice}</p>}
    {result && <>
      <p className="text-sm">已从 {result.filename} 导入 {importedCount} 条经历，之后可以在职业档案里随时改。</p>
      {Object.entries(result.base_info || {}).filter(([, value]) => value).length > 0 && <div className="rounded-lg bg-[var(--surface-muted)] p-3 text-sm">
        <p className="mb-1 font-medium">个人信息（只补档案里空着的）</p>
        <p className="break-words">{Object.values(result.base_info || {}).filter(Boolean).join(" · ")}</p>
      </div>}
      <ul className="max-h-64 space-y-2 overflow-y-auto">
        {result.bullets.map((candidate) => <li key={candidate.index}
          className={`rounded-lg border p-3 ${candidate.needs_look ? "border-amber-300 bg-amber-50" : "border-[var(--border)]"}`}>
          <p className="text-sm font-semibold">{candidate.title}</p>
          <CandidateContent candidate={candidate} />
          {candidate.needs_look && <p className="mt-1 text-xs font-semibold text-amber-700">这条没解析清楚，之后去档案里看一眼</p>}
          {candidate.import_error && <p className="mt-1 text-xs text-[var(--foreground-muted)]">没能入档：{candidate.import_error}</p>}
        </li>)}
      </ul>
      <div className="flex gap-2">
        <Button color="primary" isDisabled={busy} onPress={onDone}>继续</Button>
        <Button variant="light" isLoading={busy} onPress={() => void undo()}>撤销这次导入</Button>
      </div>
    </>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
  </div>;
}
