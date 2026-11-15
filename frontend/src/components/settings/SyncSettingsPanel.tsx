"use client";

import { useCallback, useEffect, useState } from "react";

import { Button, CodeBlock, Dialog, Pill, Progress } from "@/components/ui";
import { refreshAll } from "@/lib/core";
import { browserSyncMode, syncApi, type ConflictView, type SyncClientError, type SyncStatusView } from "@/lib/syncClient";
import { describeSyncError, encodeLinkCode, formatBytes, progressLine } from "@/lib/syncWizard";

import { SyncBackupCard } from "./SyncBackupCard";
import { SyncWizard } from "./SyncWizard";

// 设置 › 数据 › 云同步：用户自己的 S3 / R2 存储桶，端到端加密，OfferU 不存任何东西。
// 状态：未设置（向导）/ 已连接（立即同步 + 进度）/ 出错（标题 + 修法）。
// 已连接时次要操作收在「存储桶设置」「换设备接入」里；有冲突时列出来逐条选。

function when(iso: string | null): string {
  if (!iso) return "还没同步过";
  return new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function show(value: unknown): string {
  if (value === null || value === undefined || value === "") return "（空）";
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function SyncSettingsPanel() {
  const [status, setStatus] = useState<SyncStatusView | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<"" | "sync" | "clear">("");
  const [error, setError] = useState<{ title: string; hint: string; detail: string } | null>(null);
  const [note, setNote] = useState("");
  const [linkOpen, setLinkOpen] = useState(false);
  const [conflicts, setConflicts] = useState<ConflictView[]>([]);
  const [resolving, setResolving] = useState<number | null>(null);

  const loadConflicts = useCallback(() => {
    syncApi().conflicts().then((out) => setConflicts(out.conflicts)).catch(() => setConflicts([]));
  }, []);

  useEffect(() => {
    syncApi().status().then((next) => {
      setStatus(next);
      if (next.configured) loadConflicts();
    }).catch((cause: SyncClientError) => {
      if (cause.code === "unsupported" || cause.status === 501) setUnsupported(true);
      else setError(describeSyncError(cause.code, cause.message));
    });
  }, [loadConflicts]);

  // 同步进行中：每半秒读一次进度（status 只读内存里的计数，很便宜）。
  useEffect(() => {
    if (busy !== "sync") return;
    const timer = setInterval(() => {
      syncApi().status().then((next) => setStatus((current) => (current && next.syncing ? { ...current, progress: next.progress, syncing: true } : current))).catch(() => undefined);
    }, 500);
    return () => clearInterval(timer);
  }, [busy]);

  if (unsupported) {
    return (
      <section className="ou-sheet space-y-1 p-4" data-testid="sync-settings">
        <h3 className="text-sm font-semibold text-[var(--ou-text-primary)]">云同步</h3>
        <p className="text-sm text-[var(--ou-text-secondary)]">当前后端还不支持同步：需要用 TS 后端（backend-ts）或网页版启动 OfferU。加密备份仍可在下面导出。</p>
      </section>
    );
  }

  const configured = Boolean(status?.configured);
  const wizard = !configured || editing || Boolean(status?.needs_secret);

  const syncNow = async () => {
    setBusy("sync");
    setError(null);
    setNote("");
    try {
      const { result, status: next } = await syncApi().now();
      setStatus(next);
      const parts = [`拉取 ${result.pulled} 条`, `推送 ${result.pushed} 条`];
      if (result.uploaded.objects) parts.push(`上传 ${result.uploaded.objects} 个加密对象（${formatBytes(result.uploaded.bytes)}）`);
      if (result.downloaded?.objects) parts.push(`下载 ${result.downloaded.objects} 个（${formatBytes(result.downloaded.bytes)}）`);
      if (result.skipped) parts.push(`${result.skipped} 个已在桶里，跳过`);
      if (result.conflicts) parts.push(`${result.conflicts} 处冲突，见下方`);
      setNote(`同步完成：${parts.join("，")}。`);
      loadConflicts();
      await refreshAll().catch(() => undefined);
    } catch (cause) {
      const failure = cause as SyncClientError;
      setError(describeSyncError(failure.code, failure.message));
      if (failure.code === "sync_network" || failure.code === "sync_http") setNote("已上传的部分会保留，网络恢复后再点「立即同步」会从断点继续。");
      syncApi().status().then(setStatus).catch(() => undefined);
    } finally {
      setBusy("");
    }
  };

  const disconnect = async () => {
    setBusy("clear");
    try {
      setStatus(await syncApi().disconnect());
      setEditing(false);
      setConflicts([]);
      setNote("已断开。存储桶里的加密数据没有删除，随时可以重新连接。");
    } catch (cause) {
      const failure = cause as SyncClientError;
      setError(describeSyncError(failure.code, failure.message));
    } finally {
      setBusy("");
    }
  };

  const resolve = async (conflict: ConflictView, keep: "mine" | "theirs") => {
    setResolving(conflict.id);
    try {
      const out = await syncApi().resolve(conflict.id, keep);
      setConflicts(out.conflicts);
      await refreshAll().catch(() => undefined);
    } catch (cause) {
      const failure = cause as SyncClientError;
      setError(describeSyncError(failure.code, failure.message));
    } finally {
      setResolving(null);
    }
  };

  const pill = status?.last_error
    ? <Pill tone="red">出错</Pill>
    : status?.needs_secret
      ? <Pill tone="yellow">需要重填密钥</Pill>
      : configured
        ? <Pill tone="green">已连接</Pill>
        : <Pill tone="gray">未设置</Pill>;
  const progress = busy === "sync" ? progressLine(status?.progress ?? null) : null;
  const config = status?.config ?? null;

  return (
    <>
      <section className="ou-sheet space-y-4 p-4" data-testid="sync-settings">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-[var(--ou-text-primary)]">云同步</h3>
              {pill}
            </div>
            <p className="text-sm text-[var(--ou-text-secondary)]">
              同步到你自己的 S3 / Cloudflare R2 存储桶，上传前在本机加密，OfferU 的服务器不经手也不保存任何数据。
              {browserSyncMode() ? "（展示站：同步的是浏览器里的演示数据）" : ""}
            </p>
            {configured && config && (
              <p className="text-xs text-[var(--ou-text-tertiary)]">
                {config.bucket}/{config.prefix} · 上次同步 {when(status?.last_sync_at ?? null)}
                {typeof status?.pending === "number" ? ` · ${status.pending} 条本地改动待同步` : ""}
                {status?.secrets === "session" ? " · 密钥只在本次会话" : ""}
              </p>
            )}
          </div>
          {configured && !wizard && (
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button variant="ghost" size="sm" onClick={() => setLinkOpen(true)}>换设备接入</Button>
              <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>存储桶设置</Button>
              <Button variant="primary" size="sm" onClick={() => void syncNow()} disabled={Boolean(busy)}>
                {busy === "sync" ? "同步中…" : "立即同步"}
              </Button>
            </div>
          )}
        </header>

        {progress && (
          <div className="space-y-1" aria-live="polite">
            <Progress value={progress.ratio} label="同步进度" />
            <p className="text-xs text-[var(--ou-text-tertiary)]">{progress.text || "同步中…"}</p>
          </div>
        )}

        {wizard && (
          <>
            {status?.needs_secret && (
              <p className="text-sm text-[var(--ou-text-secondary)]">这台浏览器没有保存 Secret 和口令（刷新过或清过站点数据）：存储桶信息还在，按向导重新填写密钥和口令即可。</p>
            )}
            <SyncWizard
              key={configured ? "edit" : "new"}
              saved={config}
              onCancel={configured && !status?.needs_secret ? () => setEditing(false) : undefined}
              onDone={(next) => {
                setStatus(next);
                setEditing(false);
                setError(null);
                setNote("已连接。口令请另外记好：换设备时要用，丢了数据就解不开。现在点「立即同步」做第一次同步。");
              }}
            />
            {configured && (
              <div className="flex justify-end">
                <Button variant="ghost" size="sm" onClick={() => void disconnect()} disabled={Boolean(busy)}>断开这台设备</Button>
              </div>
            )}
          </>
        )}

        {error && (
          <div className="space-y-1" role="alert">
            <p className="text-sm font-medium text-[var(--ou-tone-red-text)]">{error.title}</p>
            <p className="text-sm text-[var(--ou-text-secondary)]">{error.detail}</p>
            {error.hint && <p className="text-xs text-[var(--ou-text-tertiary)]">{error.hint}</p>}
          </div>
        )}
        {!error && status?.last_error && !busy && (
          <p className="text-sm text-[var(--ou-tone-red-text)]" role="alert">{describeSyncError(`sync_${status.last_error.code}`, "").title}：{status.last_error.message}</p>
        )}
        {note && <p className="text-sm text-[var(--ou-text-secondary)]" role="status">{note}</p>}

        {conflicts.length > 0 && (
          <div className="space-y-3" data-testid="sync-conflicts">
            <div className="space-y-1">
              <h4 className="text-sm font-semibold text-[var(--ou-text-primary)]">同步冲突 · {conflicts.length}</h4>
              <p className="text-xs text-[var(--ou-text-tertiary)]">两台设备改了同一条记录的同一个字段，已先按最后修改时间保留一边。逐条选要留哪边；选完会同步到所有设备，也可以在「最近改动」里撤销。</p>
            </div>
            <ul className="space-y-3">
              {conflicts.map((conflict) => (
                <li key={conflict.id} className="space-y-2">
                  <p className="text-sm font-medium text-[var(--ou-text-primary)]">{conflict.record.label}</p>
                  <div className="grid gap-2 text-sm sm:grid-cols-2">
                    {(["mine", "theirs"] as const).map((side) => (
                      <div key={side} className="min-w-0 space-y-1">
                        <p className="flex items-center gap-2 text-xs text-[var(--ou-text-tertiary)]">
                          {side === "mine" ? "这台设备" : "另一台设备"}
                          {conflict.current === side && <Pill tone="gray">当前采用</Pill>}
                        </p>
                        {conflict.fields.map((field) => (
                          <p key={field} className="break-words text-[var(--ou-text-secondary)]">
                            <span className="text-[var(--ou-text-tertiary)]">{field}：</span>{show(conflict[side][field])}
                          </p>
                        ))}
                      </div>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant={conflict.current === "mine" ? "secondary" : "ghost"} disabled={resolving !== null || (!conflict.resolvable && conflict.current !== "mine")} onClick={() => void resolve(conflict, "mine")}>保留这台设备的</Button>
                    <Button size="sm" variant={conflict.current === "theirs" ? "secondary" : "ghost"} disabled={resolving !== null || (!conflict.resolvable && conflict.current !== "theirs")} onClick={() => void resolve(conflict, "theirs")}>用另一台设备的</Button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <SyncBackupCard />

      {config && (
        <Dialog
          open={linkOpen}
          onOpenChange={setLinkOpen}
          title="换设备接入"
          description="在新设备打开 设置 › 数据 › 云同步，第一步粘贴这段连接码，存储桶信息就填好了。连接码只有 Endpoint、存储桶、区域和前缀，不含密钥和口令：密钥和同步口令请在新设备上自己输入。"
          footer={<Button variant="primary" size="sm" onClick={() => setLinkOpen(false)}>好</Button>}
        >
          <CodeBlock code={encodeLinkCode(config)} label="连接码" wrap />
        </Dialog>
      )}
    </>
  );
}
