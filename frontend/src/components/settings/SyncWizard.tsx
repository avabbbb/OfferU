"use client";

import { useReducer, useState } from "react";

import { Button, ChoiceGroup, CodeBlock, Field, Input, Pill, Switch } from "@/components/ui";
import { syncApi, syncRunsInBrowser, type SyncClientError, type SyncStatusView } from "@/lib/syncClient";
import {
  CHECK_ORDER,
  PROVIDERS,
  WIZARD_STEPS,
  canAdvance,
  checkTone,
  corsPolicy,
  describeSyncError,
  initialWizard,
  needsCorsHelp,
  preset,
  wizardReducer,
  type SyncForm,
  type SyncProvider,
} from "@/lib/syncWizard";
import { CHECK_TITLES } from "@offeru/sync";

// 设置向导：服务商 → 存储桶 → 密钥 → 测试连接 → 同步口令。
// 每步只露出这一步要填的东西；「测试连接」把网络 / CORS / 时间 / 密钥 / 存储桶 / 写入分开报告，
// 失败时就地给出修法（CORS 直接给出可复制的规则）。最后一步才真正保存并连接。

const STATUS_TEXT = { ok: "通过", fail: "失败", warn: "注意", skip: "跳过" } as const;

export function SyncWizard({ saved, onDone, onCancel }: {
  saved: SyncStatusView["config"];
  onDone: (status: SyncStatusView) => void;
  onCancel?: () => void;
}) {
  const [state, dispatch] = useReducer(wizardReducer, saved, (config) => initialWizard(config as Partial<SyncForm> | null));
  const [busy, setBusy] = useState<"" | "test" | "save">("");
  const [error, setError] = useState<{ title: string; hint: string; detail: string } | null>(null);
  const [linkCode, setLinkCode] = useState("");
  const [linkError, setLinkError] = useState("");
  const { form, step, diagnosis } = state;
  const provider = preset(form.provider);
  const browser = syncRunsInBrowser();
  const gate = canAdvance(state);
  const set = <K extends keyof SyncForm>(key: K, value: SyncForm[K]) => dispatch({ type: "field", key, value });

  const test = async () => {
    setBusy("test");
    setError(null);
    try {
      dispatch({ type: "tested", diagnosis: await syncApi().test(form) });
    } catch (cause) {
      const failure = cause as SyncClientError;
      setError(describeSyncError(failure.code, failure.message));
    } finally {
      setBusy("");
    }
  };

  const save = async () => {
    setBusy("save");
    setError(null);
    try {
      onDone(await syncApi().configure(form));
    } catch (cause) {
      const failure = cause as SyncClientError;
      setError(describeSyncError(failure.code, failure.message));
    } finally {
      setBusy("");
    }
  };

  const applyLink = () => {
    setLinkError("");
    try {
      dispatch({ type: "link", code: linkCode });
    } catch (cause) {
      setLinkError(cause instanceof Error ? cause.message : "连接码无效");
    }
  };

  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const stepIndex = WIZARD_STEPS.findIndex((item) => item.id === step);

  return (
    <div className="space-y-4" data-testid="sync-wizard">
      <ol className="ou-segment flex-wrap" aria-label="设置步骤">
        {WIZARD_STEPS.map((item, index) => (
          <li key={item.id}>
            <button
              type="button"
              className="ou-segment-item"
              aria-current={item.id === step ? "step" : undefined}
              disabled={index > stepIndex}
              onClick={() => dispatch({ type: "go", step: item.id })}
            >
              {index + 1}. {item.label}
            </button>
          </li>
        ))}
      </ol>

      {step === "provider" && (
        <div className="space-y-4">
          <ChoiceGroup<SyncProvider>
            label="存储服务商"
            value={form.provider}
            onChange={(value) => dispatch({ type: "provider", provider: value })}
            options={PROVIDERS.map((item) => ({ value: item.id, label: item.label, description: item.description }))}
          />
          <Field label="已经在另一台设备上设置过？" hint="粘贴那台设备「换设备接入」里的连接码，存储桶信息会自动填好（连接码不含密钥和口令）。" error={linkError || undefined}>
            {(id) => (
              <div className="flex gap-2">
                <Input id={id} value={linkCode} onChange={(event) => setLinkCode(event.target.value)} placeholder="offeru-sync:…" autoComplete="off" spellCheck={false} />
                <Button size="sm" onClick={applyLink} disabled={!linkCode.trim()}>使用连接码</Button>
              </div>
            )}
          </Field>
        </div>
      )}

      {step === "bucket" && (
        <div className="grid gap-3 sm:grid-cols-2">
          {form.provider === "r2" && (
            <Field label="Cloudflare 账户 ID" hint="R2 概览页右侧的 Account ID；也可以直接粘贴「S3 API」地址">
              {(id) => <Input id={id} value={state.accountId} onChange={(event) => dispatch({ type: "account", value: event.target.value })} placeholder="32 位字母数字" autoComplete="off" spellCheck={false} />}
            </Field>
          )}
          <Field label="Endpoint" hint={provider.endpointHint}>
            {(id) => <Input id={id} value={form.endpoint} onChange={(event) => set("endpoint", event.target.value)} placeholder={form.provider === "s3" ? "留空" : "https://…"} autoComplete="off" spellCheck={false} />}
          </Field>
          <Field label="存储桶">
            {(id) => <Input id={id} value={form.bucket} onChange={(event) => set("bucket", event.target.value)} autoComplete="off" spellCheck={false} />}
          </Field>
          <Field label="区域" hint={provider.regionHint}>
            {(id) => <Input id={id} value={form.region} onChange={(event) => set("region", event.target.value)} autoComplete="off" spellCheck={false} />}
          </Field>
          <details className="sm:col-span-2">
            <summary className="cursor-pointer text-sm text-[var(--ou-text-secondary)]">高级：前缀、路径风格</summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="前缀" hint="桶里的目录；多台设备要一致，默认 offeru">
                {(id) => <Input id={id} value={form.prefix} onChange={(event) => set("prefix", event.target.value)} autoComplete="off" spellCheck={false} />}
              </Field>
              <label className="flex items-center gap-2 self-center text-sm text-[var(--ou-text-secondary)]">
                <Switch checked={form.pathStyle} onCheckedChange={(value) => set("pathStyle", value)} aria-label="路径风格地址" />
                路径风格地址（R2 / MinIO 打开，AWS 关闭）
              </label>
            </div>
          </details>
        </div>
      )}

      {step === "keys" && (
        <div className="space-y-3">
          <p className="text-sm text-[var(--ou-text-secondary)]">{provider.keyHelp}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Access Key ID" hint={state.editing ? "留空则沿用已保存的" : undefined}>
              {(id) => <Input id={id} value={form.accessKeyId} onChange={(event) => set("accessKeyId", event.target.value)} autoComplete="off" spellCheck={false} />}
            </Field>
            <Field label="Secret Access Key" hint={state.editing ? "留空则沿用已保存的" : browser ? "只存在这台设备的浏览器里" : "只存在这台电脑的数据目录"}>
              {(id) => <Input id={id} type="password" value={form.secretAccessKey} onChange={(event) => set("secretAccessKey", event.target.value)} autoComplete="off" />}
            </Field>
          </div>
        </div>
      )}

      {step === "test" && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant={diagnosis?.ok ? "secondary" : "primary"} size="sm" onClick={() => void test()} disabled={Boolean(busy)}>
              {busy === "test" ? "测试中…" : diagnosis ? "重新测试" : "测试连接"}
            </Button>
            <span className="text-xs text-[var(--ou-text-tertiary)]">会写入并删除一个临时对象 diagnostics/…，不会改动你的数据。</span>
          </div>
          {diagnosis && (
            <ul className="space-y-2" aria-label="测试结果">
              {[...diagnosis.checks].sort((a, b) => CHECK_ORDER.indexOf(a.id) - CHECK_ORDER.indexOf(b.id)).map((check) => (
                <li key={check.id} className="flex items-start gap-2 text-sm">
                  <Pill tone={checkTone(check.status)}>{STATUS_TEXT[check.status]}</Pill>
                  <span className="min-w-0">
                    <span className="font-medium text-[var(--ou-text-primary)]">{CHECK_TITLES[check.id]}</span>
                    <span className="text-[var(--ou-text-secondary)]">：{check.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {needsCorsHelp(diagnosis) && (
            <div className="space-y-2">
              <p className="text-sm text-[var(--ou-text-secondary)]">
                把这段规则粘到 <span className="font-medium text-[var(--ou-text-primary)]">{provider.corsWhere}</span>，保存后点「重新测试」。来源只写了当前打开 OfferU 的地址 {origin}；在别的地址也要用时加到 AllowedOrigins 里。
              </p>
              <CodeBlock code={corsPolicy([origin])} label="CORS 规则" />
            </div>
          )}
        </div>
      )}

      {step === "passphrase" && (
        <div className="space-y-3">
          <p className="text-sm text-[var(--ou-text-secondary)]">
            {diagnosis?.repo === "existing"
              ? "这个存储桶里已经有 OfferU 数据：输入第一台设备设置的同步口令。口令不对会立刻提示，不会下载或写入任何东西。"
              : "第一次连接：设置一个同步口令，所有设备都用它。数据在本机用它加密后才上传；口令丢了数据就解不开，OfferU 和存储服务商都找不回。"}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="同步口令" hint={state.editing ? "留空则沿用已保存的" : "至少 8 位，建议用一句话"}>
              {(id) => <Input id={id} type="password" value={form.passphrase} onChange={(event) => set("passphrase", event.target.value)} autoComplete="new-password" />}
            </Field>
            {diagnosis?.repo !== "existing" && !(state.editing && !form.passphrase) && (
              <Field label="再输一次">
                {(id) => <Input id={id} type="password" value={state.confirm} onChange={(event) => dispatch({ type: "confirm", value: event.target.value })} autoComplete="new-password" />}
              </Field>
            )}
          </div>
          {browser && (
            <label className="flex items-center gap-2 text-sm text-[var(--ou-text-secondary)]">
              <Switch checked={form.remember} onCheckedChange={(value) => set("remember", value)} aria-label="在这个浏览器记住 Secret 和口令" />
              在这个浏览器记住 Secret 和口令（用本机设备密钥加密保存；关掉则刷新后要重填）
            </label>
          )}
        </div>
      )}

      {error && (
        <div className="space-y-1" role="alert">
          <p className="text-sm font-medium text-[var(--ou-tone-red-text)]">{error.title}</p>
          <p className="text-sm text-[var(--ou-text-secondary)]">{error.detail}</p>
          {error.hint && <p className="text-xs text-[var(--ou-text-tertiary)]">{error.hint}</p>}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {!gate.ok && gate.reason && <span className="mr-auto text-xs text-[var(--ou-text-tertiary)]">{gate.reason}</span>}
        {onCancel && <Button variant="ghost" size="sm" onClick={onCancel} disabled={Boolean(busy)}>取消</Button>}
        {stepIndex > 0 && <Button variant="ghost" size="sm" onClick={() => dispatch({ type: "back" })} disabled={Boolean(busy)}>上一步</Button>}
        {step === "passphrase" ? (
          <Button variant="primary" size="sm" onClick={() => void save()} disabled={Boolean(busy) || !gate.ok}>
            {busy === "save" ? "连接中…" : "保存并连接"}
          </Button>
        ) : (
          <Button variant={step === "test" && !diagnosis?.ok ? "secondary" : "primary"} size="sm" onClick={() => dispatch({ type: "next" })} disabled={Boolean(busy) || !gate.ok}>
            下一步
          </Button>
        )}
      </div>
    </div>
  );
}
