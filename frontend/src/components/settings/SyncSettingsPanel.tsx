"use client";

import { useEffect, useState } from "react";

import { Button, Field, Input, Pill, Switch } from "@/components/ui";
import { refreshAll } from "@/lib/core";
import { safeClientErrorMessage } from "@/lib/safe-error";
import { EMPTY_SYNC_FORM, browserSyncMode, syncApi, type SyncForm, type SyncStatusView } from "@/lib/syncClient";

// 设置 › 数据 › 云同步：用户自己的 S3 / R2 存储桶，端到端加密。
// 任务：连上自己的桶并同步。状态：未设置 / 已连接 / 出错。主操作：未设置时「保存并连接」，已连接时「立即同步」。
// 存储桶参数默认收起（渐进式披露），只有未设置或用户展开时才出现。

function when(iso: string | null): string {
  if (!iso) return "还没同步过";
  return new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function SyncSettingsPanel() {
  const [status, setStatus] = useState<SyncStatusView | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [form, setForm] = useState<SyncForm>(EMPTY_SYNC_FORM);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<"" | "save" | "sync" | "clear">("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const adopt = (next: SyncStatusView) => {
    setStatus(next);
    if (next.config) setForm((current) => ({ ...current, ...next.config, accessKeyId: current.accessKeyId, secretAccessKey: "", passphrase: "" }));
  };

  useEffect(() => {
    syncApi().status().then(adopt).catch((cause) => {
      const message = safeClientErrorMessage(cause, "");
      if (/404|not found/i.test(message)) setUnsupported(true);
      else setError(message || "读取同步状态失败");
    });
  }, []);

  if (unsupported) {
    return (
      <section className="ou-sheet space-y-1 p-4" data-testid="sync-settings">
        <h3 className="text-sm font-semibold text-[var(--ou-text-primary)]">云同步</h3>
        <p className="text-sm text-[var(--ou-text-secondary)]">当前后端还不支持同步：需要用 TS 后端（backend-ts）启动 OfferU。</p>
      </section>
    );
  }

  const set = <K extends keyof SyncForm>(key: K, value: SyncForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const configured = Boolean(status?.configured);
  const showForm = !configured || editing || Boolean(status?.needs_secret);

  const run = async (kind: "save" | "sync" | "clear") => {
    setBusy(kind);
    setError("");
    setNote("");
    try {
      if (kind === "save") {
        adopt(await syncApi().configure(form));
        setEditing(false);
        setNote("已连接。口令请另外记好：换设备时要用，丢了数据就解不开。");
      } else if (kind === "clear") {
        adopt(await syncApi().disconnect());
        setForm(EMPTY_SYNC_FORM);
      } else {
        const { result, status: next } = await syncApi().now();
        adopt(next);
        const parts = [`拉取 ${result.pulled} 条`, `推送 ${result.pushed} 条`, `上传 ${result.uploaded.objects} 个加密对象`];
        if (result.conflicts) parts.push(`${result.conflicts} 处冲突已保留副本（在文档里）`);
        setNote(`同步完成：${parts.join("，")}。`);
        await refreshAll().catch(() => undefined);
      }
    } catch (cause) {
      setError(safeClientErrorMessage(cause, "同步失败"));
      syncApi().status().then(setStatus).catch(() => undefined);
    } finally {
      setBusy("");
    }
  };

  const pill = status?.last_error
    ? <Pill tone="red">出错</Pill>
    : configured
      ? <Pill tone="green">已连接</Pill>
      : <Pill tone="gray">未设置</Pill>;

  return (
    <section className="ou-sheet space-y-4 p-4" data-testid="sync-settings">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-[var(--ou-text-primary)]">云同步</h3>
            {pill}
          </div>
          <p className="text-sm text-[var(--ou-text-secondary)]">
            同步到你自己的 S3 / Cloudflare R2 存储桶，上传前在本机加密，桶里看不到内容。
            {browserSyncMode() ? "（展示站：同步的是浏览器里的演示数据）" : ""}
          </p>
          {configured && (
            <p className="text-xs text-[var(--ou-text-tertiary)]">
              {status?.config?.bucket}/{status?.config?.prefix} · 上次同步 {when(status?.last_sync_at ?? null)}
              {typeof status?.pending === "number" ? ` · ${status.pending} 条本地改动待同步` : ""}
            </p>
          )}
        </div>
        {configured && (
          <div className="flex shrink-0 gap-2">
            <Button variant="ghost" size="sm" onClick={() => setEditing((value) => !value)} aria-expanded={showForm}>
              {editing ? "收起设置" : "存储桶设置"}
            </Button>
            <Button variant="primary" size="sm" onClick={() => void run("sync")} disabled={Boolean(busy) || Boolean(status?.needs_secret)}>
              {busy === "sync" ? "同步中…" : "立即同步"}
            </Button>
          </div>
        )}
      </header>

      {showForm && (
        <div className="space-y-3">
          {status?.needs_secret && <p className="text-sm text-[var(--ou-text-secondary)]">页面刷新过：Secret 和口令只存在内存里，请重新填写后保存。</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Endpoint" hint="R2：https://<账户ID>.r2.cloudflarestorage.com；AWS 可留空">
              {(id) => <Input id={id} value={form.endpoint} onChange={(e) => set("endpoint", e.target.value)} placeholder="https://…" autoComplete="off" spellCheck={false} />}
            </Field>
            <Field label="存储桶">
              {(id) => <Input id={id} value={form.bucket} onChange={(e) => set("bucket", e.target.value)} autoComplete="off" spellCheck={false} />}
            </Field>
            <Field label="区域" hint="R2 填 auto">
              {(id) => <Input id={id} value={form.region} onChange={(e) => set("region", e.target.value)} autoComplete="off" spellCheck={false} />}
            </Field>
            <Field label="前缀" hint="桶里的目录，默认 offeru">
              {(id) => <Input id={id} value={form.prefix} onChange={(e) => set("prefix", e.target.value)} autoComplete="off" spellCheck={false} />}
            </Field>
            <Field label="Access Key ID" hint={configured ? "留空则沿用已保存的" : undefined}>
              {(id) => <Input id={id} value={form.accessKeyId} onChange={(e) => set("accessKeyId", e.target.value)} autoComplete="off" spellCheck={false} />}
            </Field>
            <Field label="Secret Access Key" hint={configured ? "留空则沿用已保存的" : "只存在本机"}>
              {(id) => <Input id={id} type="password" value={form.secretAccessKey} onChange={(e) => set("secretAccessKey", e.target.value)} autoComplete="off" />}
            </Field>
          </div>
          <Field label="同步口令" hint="至少 8 位。所有设备用同一个口令；忘了就无法解密，OfferU 也找不回">
            {(id) => <Input id={id} type="password" value={form.passphrase} onChange={(e) => set("passphrase", e.target.value)} autoComplete="new-password" />}
          </Field>
          <label className="flex items-center gap-2 text-sm text-[var(--ou-text-secondary)]">
            <Switch checked={form.pathStyle} onCheckedChange={(value) => set("pathStyle", value)} aria-label="路径风格地址" />
            路径风格地址（R2 / MinIO 保持打开）
          </label>
          <p className="text-xs text-[var(--ou-text-tertiary)]">在浏览器里同步需要先给存储桶配置 CORS，做法见 docs/sync.md。</p>
          <div className="flex flex-wrap justify-end gap-2">
            {configured && (
              <Button variant="ghost" size="sm" onClick={() => void run("clear")} disabled={Boolean(busy)}>
                断开
              </Button>
            )}
            <Button variant={configured ? "secondary" : "primary"} size="sm" onClick={() => void run("save")} disabled={Boolean(busy) || !form.bucket.trim()}>
              {busy === "save" ? "连接中…" : "保存并连接"}
            </Button>
          </div>
        </div>
      )}

      {(error || status?.last_error) && (
        <p className="text-sm text-[var(--ou-tone-red-text)]" role="alert">{error || status?.last_error?.message}</p>
      )}
      {note && !error && <p className="text-sm text-[var(--ou-text-secondary)]" role="status">{note}</p>}
    </section>
  );
}
