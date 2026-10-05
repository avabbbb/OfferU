"use client";

import { useEffect, useState } from "react";
import { Button, Input } from "@nextui-org/react";
import { useSWRConfig } from "swr";
import { dataSafetyApi } from "@/lib/api";
import { resolveApiBase } from "@/lib/apiBase";
import { safeClientErrorMessage } from "@/lib/safe-error";
import { freshResetApi, type FreshResetProposal } from "@/lib/freshResetApi";
import { getRuntimeIdentity, isDesktopRuntime, type RuntimeIdentity } from "@/lib/runtimeIdentityApi";
import { resetOnboardingForFreshStart } from "@/lib/useOnboarding";
import { SHOWCASE } from "@/lib/showcase/router";

const CONFIRMATION_TEXT = "全清并重新开始";

function asRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" ? value as Record<string, any> : null;
}

function backupIdFrom(value: unknown, actionId: string): string {
  const payload = asRecord(value);
  const group = asRecord(payload?.group);
  const step = (Array.isArray(group?.nodes) ? group.nodes : []).find(
    (item: Record<string, any>) => item.id === actionId,
  );
  const stepResult = asRecord(step?.result);
  const operationResult = asRecord(stepResult?.operation_result);
  const direct = asRecord(operationResult?.outputs)?.backup;
  if (typeof direct?.backup_id === "string") return direct.backup_id;
  const toolCalls = Array.isArray(payload?.tool_calls) ? payload.tool_calls : [];
  for (const call of toolCalls) {
    const operation = asRecord(call?.result);
    const backup = asRecord(operation?.outputs)?.backup;
    if (typeof backup?.backup_id === "string") return backup.backup_id;
  }
  return "";
}

export function FreshResetPanel() {
  return SHOWCASE ? null : <FreshResetPanelContent />;
}

function FreshResetPanelContent() {
  const { mutate } = useSWRConfig();
  const [identity, setIdentity] = useState<RuntimeIdentity | null>(null);
  const [status, setStatus] = useState<Awaited<ReturnType<typeof dataSafetyApi.status>> | null>(null);
  const [proposal, setProposal] = useState<FreshResetProposal | null>(null);
  const [confirmationText, setConfirmationText] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [backupId, setBackupId] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const [nextIdentity, nextStatus, pending] = await Promise.all([
        getRuntimeIdentity(),
        dataSafetyApi.status(),
        freshResetApi.pendingProposal(),
      ]);
      setIdentity(nextIdentity);
      setStatus(nextStatus);
      setProposal(pending);
    } catch (cause) {
      setFeedback({ type: "error", message: safeClientErrorMessage(cause, "全清状态读取失败") });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const propose = async () => {
    if (!isDesktopRuntime() || confirmationText !== CONFIRMATION_TEXT || !identity?.data_root) return;
    setBusy(true);
    setFeedback(null);
    try {
      setProposal(await freshResetApi.createProposal());
      setFeedback({ type: "success", message: "已准备好全清；数据尚未删除。请确认清空或取消。" });
    } catch (cause) {
      setFeedback({ type: "error", message: safeClientErrorMessage(cause, "准备清理失败") });
    } finally {
      setBusy(false);
    }
  };

  const decide = async (approve: boolean) => {
    if (!proposal || !isDesktopRuntime() || (approve && confirmationText !== CONFIRMATION_TEXT)) return;
    setBusy(true);
    setFeedback(null);
    try {
      const decision = approve
        ? await freshResetApi.approve(proposal)
        : await freshResetApi.reject(proposal);
      const step = decision.group?.nodes.find((item) => item.id === proposal.actionId);
      const committed = decision.receipts?.some((receipt) => receipt.node_id === proposal.actionId
        && receipt.status === "completed" && receipt.effect_state === "committed");
      if (!decision.ok || (approve && (step?.status !== "completed" || !committed)) || (!approve && decision.group?.status !== "rejected")) {
        throw new Error(decision.errors?.join("；") || "OfferU 未保存该提案决定。");
      }
      if (!approve) {
        setProposal(null);
        setFeedback({ type: "success", message: "提案已拒绝；职业数据保持不变。" });
        return;
      }

      const nextBackupId = backupIdFrom(decision, proposal.actionId);
      resetOnboardingForFreshStart();
      setProposal(null);
      setConfirmationText("");
      setBackupId(nextBackupId);
      let cacheWarning = "";
      try {
        await mutate((key) => typeof key === "string" && key.startsWith(resolveApiBase()));
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
      setFeedback({ type: "error", message: safeClientErrorMessage(cause, approve ? "执行清理失败" : "拒绝提案失败") });
      if (approve) await load();
    } finally {
      setBusy(false);
    }
  };

  const canPropose = isDesktopRuntime() && !!identity?.data_root && !status?.pending_restore;
  const canApprove = canPropose && confirmationText === CONFIRMATION_TEXT;

  return (
    <section className="bauhaus-panel space-y-4 p-5" data-testid="fresh-reset-panel">
      <div>
        <p className="bauhaus-label text-[var(--foreground-muted)]">独立的清洁起点</p>
        <h2 className="mt-2 text-xl font-bold text-[var(--foreground)]">全清并重新开始</h2>
        <p className="mt-2 text-sm leading-relaxed text-[var(--foreground-muted)]">
          创建可恢复备份后，清空当前 OfferU 职业工作区和本机运行上下文，再回到空白首次建档。
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="bauhaus-panel-sm space-y-2 bg-[var(--surface-muted)] p-4">
          <p className="text-sm font-semibold">当前数据位置</p>
          <p className="break-all font-mono text-xs" data-testid="fresh-reset-data-root">
            {loading ? "正在读取…" : identity?.data_root || "未知；无法确认安全清理范围"}
          </p>
          <p className="text-xs text-[var(--foreground-muted)]">
            {status ? `现有备份 ${status.backup_count} 份` : "备份状态未知"}
          </p>
        </div>
        <div className="bauhaus-panel-sm space-y-2 bg-[var(--status-blush)] p-4">
          <p className="text-sm font-semibold">清理范围</p>
          <p className="text-xs leading-relaxed">
            Profile、岗位、简历、投递、面试、待确认的职业建议和后台任务；OfferU 内的对话/Agent 执行记录、运行文件、导出物及旧岗位/简历搜索索引。
          </p>
        </div>
        <div className="bauhaus-panel-sm space-y-2 bg-[var(--surface-muted)] p-4">
          <p className="text-sm font-semibold">保留对象</p>
          <p className="text-xs leading-relaxed">
            本地配置、系统钥匙串与模型密钥、连接账号元数据、已安装 Skill、OfferU 数据目录外的源简历和外部 Agent Memory、审计及全部备份。
          </p>
        </div>
        <div className="bauhaus-panel-sm space-y-2 bg-[var(--surface-muted)] p-4">
          <p className="text-sm font-semibold">恢复方式</p>
          <p className="text-xs leading-relaxed">
            执行前自动创建 SQLite 一致性备份，并把受管文件与 Agent session 一并归档；之后可在数据安全区选择备份恢复。
          </p>
        </div>
      </div>

      {status?.pending_restore && (
        <p className="text-sm text-amber-700" role="status">
          有一份备份正在等待重启恢复。请先取消恢复，再重新开始。
        </p>
      )}
      {!isDesktopRuntime() && (
        <p className="text-sm text-[var(--foreground-muted)]" role="status">
          请在 OfferU Desktop 中确认此操作；当前网页不会执行清理。
        </p>
      )}
      {feedback && (
        <p className={`text-sm ${feedback.type === "error" ? "text-[var(--primary-red)]" : "text-[var(--primary-blue)]"}`} role="status">
          {feedback.message}
        </p>
      )}
      {backupId && (
        <p className="text-xs text-[var(--foreground-muted)]" data-testid="fresh-reset-backup-id">
          重置前备份：<span className="font-mono">{backupId}</span>
        </p>
      )}

      <Input
        label={`输入“${CONFIRMATION_TEXT}”以继续`}
        value={confirmationText}
        onValueChange={setConfirmationText}
        autoComplete="off"
        isDisabled={busy}
        data-testid="fresh-reset-confirmation"
      />

      {proposal ? (
        <div className="flex flex-wrap gap-2" data-testid="fresh-reset-pending-proposal">
          <Button color="danger" isDisabled={!canApprove || busy} isLoading={busy} onPress={() => void decide(true)}>
            确认清空并重新开始
          </Button>
          <Button variant="bordered" isDisabled={!isDesktopRuntime() || busy} onPress={() => void decide(false)}>
            取消并保留数据
          </Button>
        </div>
      ) : backupId ? (
        <Button color="primary" onPress={() => {
          window.location.hash = "#/";
          window.location.reload();
        }}>
          返回 Today，开始首次建档
        </Button>
      ) : (
        <Button
          color="danger"
          isDisabled={!canPropose || busy || confirmationText !== CONFIRMATION_TEXT}
          isLoading={busy}
          onPress={() => void propose()}
        >
          继续，进入确认
        </Button>
      )}

      <p className="text-xs leading-relaxed text-[var(--foreground-muted)]">
        {proposal ? "尚未清理数据。请确认清空，或取消并保留当前数据。" : "继续后仍会先让你检查并确认；未确认前不会清理数据。"}
      </p>
    </section>
  );
}
