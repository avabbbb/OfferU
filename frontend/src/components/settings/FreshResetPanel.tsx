"use client";

import { useEffect, useState } from "react";
import { Button, Field, Input } from "@/components/ui";
import { dataSafetyApi } from "@/lib/api";
import { safeClientErrorMessage } from "@/lib/safe-error";
import { freshResetApi } from "@/lib/freshResetApi";
import { getRuntimeIdentity, type RuntimeIdentity } from "@/lib/runtimeIdentityApi";
import { resetOnboardingForFreshStart } from "@/lib/useOnboarding";
import { SHOWCASE } from "@/lib/showcase";
import { refreshAll } from "@/lib/core";

const CONFIRMATION_TEXT = "全清并重新开始";

export function FreshResetPanel() {
  return SHOWCASE ? null : <FreshResetPanelContent />;
}

function FreshResetPanelContent() {
  const [identity, setIdentity] = useState<RuntimeIdentity | null>(null);
  const [status, setStatus] = useState<Awaited<ReturnType<typeof dataSafetyApi.status>> | null>(null);
  const [confirmationText, setConfirmationText] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [backupId, setBackupId] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const [nextIdentity, nextStatus] = await Promise.all([getRuntimeIdentity(), dataSafetyApi.status()]);
      setIdentity(nextIdentity);
      setStatus(nextStatus);
    } catch (cause) {
      setFeedback({ type: "error", message: safeClientErrorMessage(cause, "全清状态读取失败") });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const reset = async () => {
    if (confirmationText !== CONFIRMATION_TEXT || !identity?.data_root) return;
    setBusy(true);
    setFeedback(null);
    try {
      const result = await freshResetApi.reset();
      const nextBackupId = typeof result.backup?.backup_id === "string" ? result.backup.backup_id : "";
      resetOnboardingForFreshStart();
      setConfirmationText("");
      setBackupId(nextBackupId);
      let cacheWarning = "";
      try {
        await refreshAll();
      } catch {
        cacheWarning = "部分页面缓存未能立即刷新。";
      }
      const [backupsResult, statusResult] = await Promise.allSettled([
        dataSafetyApi.listBackups(),
        dataSafetyApi.status(),
      ]);
      if (statusResult.status === "fulfilled") setStatus(statusResult.value);
      const backupVerified = Boolean(
        nextBackupId
        && backupsResult.status === "fulfilled"
        && backupsResult.value.items.some(
          (item) => item.backup_id === nextBackupId && item.reason === "pre_reset",
        ),
      );
      setFeedback({
        type: backupVerified ? "success" : "error",
        message: backupVerified
          ? `本地 OfferU 职业数据已清理，空白档案已准备好。${cacheWarning}`
          : `清理已完成，但无法核实重置前备份${nextBackupId ? ` ${nextBackupId}` : ""}；请检查数据安全区。${cacheWarning}`,
      });
    } catch (cause) {
      setFeedback({ type: "error", message: safeClientErrorMessage(cause, "执行清理失败") });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const canReset = !!identity?.data_root && !status?.pending_restore && confirmationText === CONFIRMATION_TEXT;

  const scope: Array<[string, string]> = [
    ["清理范围", "Profile、岗位、简历、投递、面试、待确认的职业建议和后台任务；OfferU 内的对话 / Agent 执行记录、运行文件、导出物及旧岗位 / 简历搜索索引。"],
    ["保留对象", "本地配置、系统钥匙串与模型密钥、连接账号元数据、已安装 Skill、OfferU 数据目录外的源简历和外部 Agent Memory、审计及全部备份。"],
    ["恢复方式", "执行前自动创建 SQLite 一致性备份，并把受管文件与 Agent session 一并归档；之后可在上方「备份与恢复」选择备份恢复。"],
  ];

  return (
    <div className="ou-settings-item-body px-4 pb-4" data-testid="fresh-reset-panel">
      <p className="ou-settings-item-desc">创建可恢复备份后，清空当前 OfferU 职业工作区和本机运行上下文，再回到空白首次建档。</p>
      <dl className="ou-settings-kv ou-settings-kv--flush">
        <div>
          <dt>当前数据位置</dt>
          <dd className="ou-settings-mono" data-testid="fresh-reset-data-root">{loading ? "正在读取…" : identity?.data_root || "未知；无法确认安全清理范围"}</dd>
        </div>
        <div>
          <dt>现有备份</dt>
          <dd>{status ? `${status.backup_count} 份` : "未知"}</dd>
        </div>
      </dl>
      {scope.map(([title, text]) => (
        <p key={title} className="ou-settings-hint"><strong className="font-semibold text-[var(--ou-text-secondary)]">{title}：</strong>{text}</p>
      ))}

      {status?.pending_restore && <p className="ou-settings-callout" data-tone="yellow" role="status">有一份备份正在等待重启恢复。请先取消恢复，再重新开始。</p>}
      {feedback && <p className={feedback.type === "error" ? "ou-settings-error" : "ou-settings-status"} role="status">{feedback.message}</p>}
      {backupId && (
        <p className="ou-settings-hint" data-testid="fresh-reset-backup-id">
          重置前备份：<span className="ou-settings-mono">{backupId}</span>
        </p>
      )}

      {backupId ? (
        <div className="ou-settings-actions ou-settings-actions--end">
          <Button variant="primary" onClick={() => {
            window.location.hash = "#/";
            window.location.reload();
          }}>
            返回 Today，开始首次建档
          </Button>
        </div>
      ) : (
        <div className="ou-sync-footer">
          <div className="min-w-0 flex-1">
            <Field label={`输入“${CONFIRMATION_TEXT}”以继续`} hint="点击后会先自动备份，再清空。">
              {(id) => <Input id={id} value={confirmationText} onChange={(event) => setConfirmationText(event.target.value)} autoComplete="off" disabled={busy} data-testid="fresh-reset-confirmation" />}
            </Field>
          </div>
          <Button className="ou-settings-danger self-end" disabled={!canReset || busy} onClick={() => void reset()}>
            {busy ? "清理中…" : "清空并重新开始"}
          </Button>
        </div>
      )}
    </div>
  );
}
