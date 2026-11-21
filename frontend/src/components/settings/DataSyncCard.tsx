"use client";

import { useEffect, useState } from "react";
import { Button, Field, Input, Select, Switch } from "@/components/ui";
import { safeClientErrorMessage } from "@/lib/safe-error";
import { SHOWCASE } from "@/lib/showcase";
import { bridgeActive } from "@/lib/bridge";
import { refreshAll } from "@/lib/core";
import { corsExample, describeSyncResult, syncApi, type SyncConfigView, type SyncStatus } from "@/lib/sync";

const AUTO_OPTIONS = [
  { value: "0", label: "只手动同步" },
  { value: "15", label: "每 15 分钟" },
  { value: "30", label: "每 30 分钟" },
  { value: "60", label: "每小时" },
];

type Form = {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  access_key_id: string;
  secret_access_key: string;
  passphrase: string;
  device_name: string;
  auto_minutes: string;
  sync_on_start: boolean;
  force_path_style: boolean;
};

function formOf(view: SyncConfigView): Form {
  return {
    endpoint: view.endpoint,
    region: view.region || "auto",
    bucket: view.bucket,
    prefix: view.prefix || "offeru/",
    access_key_id: view.access_key_id,
    secret_access_key: "",
    passphrase: "",
    device_name: view.device_name,
    auto_minutes: String(view.auto_minutes || 0),
    sync_on_start: view.sync_on_start,
    force_path_style: view.force_path_style,
  };
}

function when(iso: string | null): string {
  if (!iso) return "从未";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** 设置 → 数据 → 数据同步（S3 兼容存储：R2 / S3 / MinIO / OSS…，端到端加密）。 */
export function DataSyncCard() {
  const webOnly = SHOWCASE && !bridgeActive();
  const [view, setView] = useState<SyncConfigView | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [busy, setBusy] = useState<"" | "save" | "run" | "clear">("");
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const load = async () => {
    try {
      const [nextView, nextStatus] = await Promise.all([syncApi.config(), syncApi.status()]);
      setView(nextView);
      setForm(formOf(nextView));
      setStatus(nextStatus);
    } catch (cause) {
      setFeedback({ type: "error", message: safeClientErrorMessage(cause, "读取同步设置失败") });
    }
  };

  useEffect(() => {
    if (!webOnly) void load();
  }, [webOnly]);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((prev) => (prev ? { ...prev, [key]: value } : prev));

  const save = async () => {
    if (!form) return;
    setBusy("save");
    setFeedback(null);
    try {
      const next = await syncApi.saveConfig({
        endpoint: form.endpoint,
        region: form.region,
        bucket: form.bucket,
        prefix: form.prefix,
        access_key_id: form.access_key_id,
        secret_access_key: form.secret_access_key,
        passphrase: form.passphrase,
        device_name: form.device_name,
        auto_minutes: Number(form.auto_minutes),
        sync_on_start: form.sync_on_start,
        force_path_style: form.force_path_style,
      });
      setView(next);
      setForm(formOf(next));
      setFeedback({ type: "success", message: next.configured ? "已保存。凭证和口令只存在这台设备上。" : "已保存，还差几项才能同步。" });
    } catch (cause) {
      setFeedback({ type: "error", message: safeClientErrorMessage(cause, "保存同步设置失败") });
    } finally {
      setBusy("");
    }
  };

  const run = async () => {
    setBusy("run");
    setFeedback(null);
    try {
      const result = await syncApi.run();
      setFeedback({ type: "success", message: `同步完成：${describeSyncResult(result)}。` });
      if (result.pulled > 0) await refreshAll().catch(() => undefined);
    } catch (cause) {
      setFeedback({ type: "error", message: safeClientErrorMessage(cause, "同步失败") });
    } finally {
      setBusy("");
      setStatus(await syncApi.status().catch(() => status));
    }
  };

  const clear = async () => {
    setBusy("clear");
    setFeedback(null);
    try {
      await syncApi.clearConfig();
      await load();
      setFeedback({ type: "success", message: "已清除这台设备上的同步凭证与口令；远端数据没动。" });
    } catch (cause) {
      setFeedback({ type: "error", message: safeClientErrorMessage(cause, "清除失败") });
    } finally {
      setBusy("");
    }
  };

  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const cors = corsExample(origin);

  return (
    <section className="ou-sheet space-y-4 p-5" data-testid="data-sync-card">
      <div>
        <h2 className="text-xl font-semibold text-[var(--foreground)]">数据同步</h2>
        <p className="mt-1 text-sm text-[var(--foreground-muted)]">
          用你自己的 S3 兼容存储（Cloudflare R2、AWS S3、MinIO、阿里云 OSS 等）在多台设备间同步记录和附件。数据先用同步口令加密再上传，存储商看不到内容。
        </p>
      </div>

      {webOnly ? (
        <p className="text-sm text-[var(--foreground-muted)]">网页版的同步会在浏览器本地存储接入后开放；现在可以连接本机 OfferU 后在这里配置。</p>
      ) : !form ? (
        <p className="text-sm text-[var(--foreground-muted)]">正在读取…</p>
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Endpoint" hint="R2：https://<账号ID>.r2.cloudflarestorage.com">
              {(id) => <Input id={id} value={form.endpoint} onChange={(e) => set("endpoint", e.target.value)} placeholder="https://…" autoComplete="off" spellCheck={false} />}
            </Field>
            <Field label="Region" hint="R2 填 auto">
              {(id) => <Input id={id} value={form.region} onChange={(e) => set("region", e.target.value)} autoComplete="off" spellCheck={false} />}
            </Field>
            <Field label="Bucket">
              {(id) => <Input id={id} value={form.bucket} onChange={(e) => set("bucket", e.target.value)} autoComplete="off" spellCheck={false} />}
            </Field>
            <Field label="目录前缀" hint="同一个桶可放多套数据">
              {(id) => <Input id={id} value={form.prefix} onChange={(e) => set("prefix", e.target.value)} autoComplete="off" spellCheck={false} />}
            </Field>
            <Field label="Access Key ID">
              {(id) => <Input id={id} value={form.access_key_id} onChange={(e) => set("access_key_id", e.target.value)} autoComplete="off" spellCheck={false} />}
            </Field>
            <Field label="Secret Access Key" hint={view?.has_secret ? "已保存，留空不变" : undefined}>
              {(id) => <Input id={id} type="password" value={form.secret_access_key} onChange={(e) => set("secret_access_key", e.target.value)} placeholder={view?.has_secret ? "••••••••" : ""} autoComplete="new-password" />}
            </Field>
            <Field label="同步口令" hint={view?.has_passphrase ? "已保存，留空不变；忘了口令就解不开远端数据" : "至少 8 位；每台设备填同一个口令"}>
              {(id) => <Input id={id} type="password" value={form.passphrase} onChange={(e) => set("passphrase", e.target.value)} placeholder={view?.has_passphrase ? "••••••••" : ""} autoComplete="new-password" />}
            </Field>
            <Field label="设备名称" hint="冲突副本里会写上它">
              {(id) => <Input id={id} value={form.device_name} onChange={(e) => set("device_name", e.target.value)} autoComplete="off" />}
            </Field>
            <Field label="自动同步">
              {(id) => <Select id={id} value={form.auto_minutes} onValueChange={(value) => set("auto_minutes", value)} options={AUTO_OPTIONS} />}
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <label className="flex items-center gap-2">
              <Switch checked={form.sync_on_start} onCheckedChange={(value) => set("sync_on_start", value)} aria-label="启动时同步" />
              启动时同步
            </label>
            <label className="flex items-center gap-2">
              <Switch checked={form.force_path_style} onCheckedChange={(value) => set("force_path_style", value)} aria-label="路径式地址" />
              路径式地址（R2 / MinIO 保持打开）
            </label>
          </div>

          {status && (
            <p className="text-xs text-[var(--foreground-muted)]" data-testid="data-sync-status">
              上次成功：{when(status.last_ok_at)}
              {status.last_result ? `（${describeSyncResult(status.last_result)}）` : ""}
              {status.last_error ? ` · 上次出错：${status.last_error}` : ""}
            </p>
          )}
          {feedback && (
            <p className={`text-sm ${feedback.type === "error" ? "text-[var(--primary-red)]" : "text-[var(--primary-blue)]"}`} role="status">
              {feedback.message}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled={Boolean(busy) || !view?.configured} onClick={() => void run()}>
              {busy === "run" ? "同步中…" : "立即同步"}
            </Button>
            <Button disabled={Boolean(busy)} onClick={() => void save()}>{busy === "save" ? "保存中…" : "保存设置"}</Button>
            {view?.configured && (
              <Button variant="ghost" disabled={Boolean(busy)} onClick={() => void clear()}>清除本机凭证</Button>
            )}
          </div>
        </>
      )}

      <details className="text-sm">
        <summary className="cursor-pointer text-[var(--foreground-muted)]">浏览器直连需要的桶 CORS 设置</summary>
        <div className="mt-3 space-y-3 text-xs text-[var(--foreground-muted)]">
          <p>只在网页版（浏览器直接连 S3）时需要；本机 OfferU 不需要。必须暴露 ETag，同步靠它防止两台设备同时写坏。</p>
          <p>Cloudflare R2：桶 → Settings → CORS Policy，粘贴：</p>
          <pre className="overflow-x-auto rounded-[var(--ou-radius-card)] bg-[var(--ou-bg-control)] p-3">{cors.r2}</pre>
          <p>AWS S3：桶 → Permissions → CORS，粘贴同样的数组；或用 CLI <code>aws s3api put-bucket-cors --bucket 桶名 --cors-configuration file://cors.json</code>，cors.json：</p>
          <pre className="overflow-x-auto rounded-[var(--ou-radius-card)] bg-[var(--ou-bg-control)] p-3">{cors.s3}</pre>
          <p>MinIO / 其他：按各家文档放行上面的来源、方法与 ETag。</p>
        </div>
      </details>
    </section>
  );
}
