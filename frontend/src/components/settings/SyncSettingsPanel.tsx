"use client";

import { useEffect, useState } from "react";
import { ChevronRight, Cloud } from "lucide-react";

import { Button, Field, Input, Pill, Switch } from "@/components/ui";
import { refreshAll } from "@/lib/core";
import { safeClientErrorMessage } from "@/lib/safe-error";
import { EMPTY_SYNC_FORM, browserSyncMode, syncApi, type SyncForm, type SyncStatusView } from "@/lib/syncClient";
import { DisclosurePanel, SettingsGroup } from "./SettingsLayout";

// 设置 › 数据 › 云同步：用户自己的 S3 / R2 存储桶，端到端加密。
// 任务：连上自己的桶并同步。状态：未设置 / 已连接 / 出错。主操作：未设置时「保存并连接」，已连接时「立即同步」。
// 表单默认收起，分三步（存储桶 → 访问密钥 → 加密口令）；区域、前缀、路径风格放在「高级」里。

function when(iso: string | null): string {
  if (!iso) return "还没同步过";
  return new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children: React.ReactNode }) {
  return (
    <div className="ou-sync-step" data-done={done ? "" : undefined}>
      <span className="ou-sync-step-num" aria-hidden="true">{n}</span>
      <span className="ou-sync-step-title">{title}</span>
      {children}
    </div>
  );
}

export function SyncSettingsPanel() {
  const [status, setStatus] = useState<SyncStatusView | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [form, setForm] = useState<SyncForm>(EMPTY_SYNC_FORM);
  const [editing, setEditing] = useState(false);
  const [advanced, setAdvanced] = useState(false);
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
      if (/404|501|not found|没有开启同步/i.test(message)) setUnsupported(true);
      else setError(message || "读取同步状态失败");
    });
  }, []);

  if (unsupported) {
    return (
      <SettingsGroup label="云同步" testId="sync-settings">
        <div className="ou-settings-item">
          <span className="ou-tile" aria-hidden="true"><Cloud size={16} /></span>
          <div className="ou-settings-item-text">
            <span className="ou-settings-item-label">云同步</span>
            <span className="ou-settings-item-desc">当前运行环境还不能同步：用本机 OfferU（TS 后端）启动后可用。</span>
          </div>
          <div className="ou-settings-item-control"><Pill tone="gray">不可用</Pill></div>
        </div>
      </SettingsGroup>
    );
  }

  const set = <K extends keyof SyncForm>(key: K, value: SyncForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const configured = Boolean(status?.configured);
  const needsSecret = Boolean(status?.needs_secret);
  const showForm = editing || needsSecret;

  const bucketDone = Boolean(form.bucket.trim());
  const keysDone = configured || Boolean(form.accessKeyId.trim() && form.secretAccessKey);
  const passphraseDone = form.passphrase.length >= 8 || (configured && !needsSecret && !form.passphrase);
  const blocker = !bucketDone
    ? "先填存储桶名称"
    : !keysDone
      ? "填写 Access Key ID 和 Secret"
      : !passphraseDone
        ? "同步口令至少 8 位"
        : "";

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
        setEditing(false);
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

  const summary = configured
    ? `${status?.config?.bucket}/${status?.config?.prefix} · 上次同步 ${when(status?.last_sync_at ?? null)}${typeof status?.pending === "number" && status.pending ? ` · ${status.pending} 条待同步` : ""}`
    : `同步到你自己的 S3 / R2 存储桶，上传前在本机加密${browserSyncMode() ? "（展示站：同步演示数据）" : ""}`;

  return (
    <SettingsGroup label="云同步" testId="sync-settings" note={configured ? undefined : "桶里只有加密后的数据，OfferU 和存储商都看不到内容。"}>
      <div className="ou-settings-item">
        <span className="ou-tile" aria-hidden="true"><Cloud size={16} /></span>
        <div className="ou-settings-item-text">
          <span className="ou-settings-item-label flex flex-wrap items-center gap-2">云同步 {pill}</span>
          <span className="ou-settings-item-desc">{summary}</span>
        </div>
        <div className="ou-settings-item-control">
          {!needsSecret && (
            <button
              type="button"
              className="ou-text-button ou-disclosure-trigger"
              data-testid="sync-setup-toggle"
              aria-expanded={showForm}
              aria-controls="sync-form"
              onClick={() => setEditing((value) => !value)}
            >
              {configured ? "存储桶设置" : "设置云同步"}
              <ChevronRight size={14} aria-hidden="true" className="ou-disclosure-chevron" />
            </button>
          )}
          {configured && (
            <Button variant="primary" onClick={() => void run("sync")} disabled={Boolean(busy) || needsSecret}>
              {busy === "sync" ? "同步中…" : "立即同步"}
            </Button>
          )}
        </div>
      </div>

      <DisclosurePanel open={showForm} id="sync-form">
        <form
          className="ou-sync-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!blocker && !busy) void run("save");
          }}
        >
          {needsSecret && <p className="ou-settings-callout" data-tone="yellow">页面刷新过：Secret 和口令只存在内存里，请重新填写后保存。</p>}
          <Step n={1} title="存储桶" done={bucketDone}>
            <div className="ou-sync-step-fields">
              <Field label="Endpoint" hint="R2 填账户的 r2.cloudflarestorage.com 地址；AWS 留空">
                {(id) => <Input id={id} value={form.endpoint} onChange={(e) => set("endpoint", e.target.value)} placeholder="https://…" autoComplete="off" spellCheck={false} />}
              </Field>
              <Field label="存储桶">
                {(id) => <Input id={id} value={form.bucket} onChange={(e) => set("bucket", e.target.value)} placeholder="offeru-sync" autoComplete="off" spellCheck={false} />}
              </Field>
            </div>
          </Step>
          <Step n={2} title="访问密钥" done={keysDone}>
            <div className="ou-sync-step-fields">
              <Field label="Access Key ID" hint={configured ? "留空沿用已保存的" : undefined}>
                {(id) => <Input id={id} value={form.accessKeyId} onChange={(e) => set("accessKeyId", e.target.value)} autoComplete="off" spellCheck={false} />}
              </Field>
              <Field label="Secret Access Key" hint={configured ? "留空沿用已保存的" : "只存在本机"}>
                {(id) => <Input id={id} type="password" value={form.secretAccessKey} onChange={(e) => set("secretAccessKey", e.target.value)} autoComplete="off" />}
              </Field>
            </div>
          </Step>
          <Step n={3} title="加密口令" done={passphraseDone}>
            <div className="ou-sync-step-fields">
              <Field label="同步口令" hint="所有设备用同一个；忘了就解不开，OfferU 也找不回">
                {(id) => <Input id={id} type="password" value={form.passphrase} onChange={(e) => set("passphrase", e.target.value)} placeholder="至少 8 位" autoComplete="new-password" />}
              </Field>
            </div>
          </Step>
          <div className="ou-sync-step">
            <span aria-hidden="true" />
            <button
              type="button"
              className="ou-text-button ou-disclosure-trigger justify-self-start"
              data-testid="sync-advanced-toggle"
              aria-expanded={advanced}
              aria-controls="sync-advanced"
              onClick={() => setAdvanced((value) => !value)}
            >
              高级
              <ChevronRight size={14} aria-hidden="true" className="ou-disclosure-chevron" />
            </button>
            <div className="col-start-2">
              <DisclosurePanel open={advanced} id="sync-advanced">
                <div className="ou-sync-advanced">
                  <div className="ou-sync-step-fields">
                    <Field label="区域" hint="R2 填 auto">
                      {(id) => <Input id={id} value={form.region} onChange={(e) => set("region", e.target.value)} autoComplete="off" spellCheck={false} />}
                    </Field>
                    <Field label="前缀" hint="桶里的目录">
                      {(id) => <Input id={id} value={form.prefix} onChange={(e) => set("prefix", e.target.value)} autoComplete="off" spellCheck={false} />}
                    </Field>
                  </div>
                  <label className="ou-sync-pathstyle">
                    <span>路径风格地址<span className="ou-settings-hint"> · R2 / MinIO 保持打开</span></span>
                    <Switch checked={form.pathStyle} onCheckedChange={(value) => set("pathStyle", value)} aria-label="路径风格地址" />
                  </label>
                  <p className="ou-settings-hint">浏览器里同步需要先给存储桶配置 CORS，见 docs/sync.md。</p>
                </div>
              </DisclosurePanel>
            </div>
          </div>
          <div className="ou-sync-footer">
            <p className="ou-settings-hint" id="sync-save-reason" aria-live="polite">{blocker}</p>
            {configured && (
              <button type="button" className="ou-text-button" data-tone="danger" onClick={() => void run("clear")} disabled={Boolean(busy)}>
                断开
              </button>
            )}
            <Button type="submit" variant={configured ? "secondary" : "primary"} disabled={Boolean(busy) || Boolean(blocker)} aria-describedby={blocker ? "sync-save-reason" : undefined}>
              {busy === "save" ? "连接中…" : "保存并连接"}
            </Button>
          </div>
          {error && <p className="ou-settings-error text-right" role="alert">{error}</p>}
        </form>
      </DisclosurePanel>

      {!showForm && (error || status?.last_error) && (
        <p className="ou-settings-error px-4 pb-3" role="alert">{error || status?.last_error?.message}</p>
      )}
      {showForm && !error && status?.last_error && (
        <p className="ou-settings-error px-4 pb-3" role="alert">{status.last_error.message}</p>
      )}
      {note && !error && <p className="ou-settings-status px-4 pb-3" role="status">{note}</p>}
    </SettingsGroup>
  );
}
