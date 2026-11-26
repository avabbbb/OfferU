"use client";

import { useEffect, useState } from "react";
import { ChevronRight, ExternalLink, Eye, EyeOff, Mail, Monitor, Puzzle } from "lucide-react";

import { ExternalUrlLink } from "@/components/ExternalUrlLink";
import { Button, Field, Input, Pill, Select, Switch } from "@/components/ui";
import { extensionInstallUrl } from "@/lib/local/extensionPrompt";
import { useExtensionMail, WEBMAIL_OPTIONS, type WebmailId } from "@/lib/local/extensionMail";
import { safeClientErrorMessage } from "@/lib/safe-error";
import {
  isMailUnsupported, mailApi, providerFor,
  type MailForm, type MailProvider, type MailServer, type MailStatusView, type MailTestResult,
} from "@/lib/mailClient";
import { DisclosurePanel, SettingsGroup } from "./SettingsLayout";

// 设置 › 连接 › 邮箱：桌面版用授权码连上自己的邮箱（IMAP / SMTP）；网页版用浏览器插件在你已登录的邮箱网页里填写草稿。
// 任务：连上邮箱，让 Agent 读邀约邮件、投递邮件存进草稿箱并由你确认后发出。
// 状态：网页版（插件已就绪 / 没检测到插件）/ 未连接 / 已连接。主操作：未连接时「连接」（先登录 IMAP 和 SMTP，两边都通才保存）。
// 表单默认收起；服务器地址只有「其他邮箱」默认展开，预设邮箱放在「服务器设置」里。

const EMPTY_SERVER: MailServer = { host: "", port: 993, secure: true };

function blankForm(provider: MailProvider | undefined): MailForm {
  return {
    provider: provider?.id ?? "qq",
    address: "",
    password: "",
    imap: provider?.imap ?? EMPTY_SERVER,
    smtp: provider?.smtp ?? { host: "", port: 465, secure: true },
  };
}

function ServerFields({ label, value, onChange }: { label: string; value: MailServer; onChange: (next: MailServer) => void }) {
  return (
    <div className="ou-sync-step-fields">
      <Field label={`${label} 服务器`}>
        {(id) => <Input id={id} value={value.host} onChange={(e) => onChange({ ...value, host: e.target.value.trim() })} placeholder={label === "IMAP" ? "imap.example.com" : "smtp.example.com"} autoComplete="off" spellCheck={false} />}
      </Field>
      <Field label="端口" hint={value.secure ? "SSL / TLS 直连" : "STARTTLS"}>
        {(id) => <Input id={id} inputMode="numeric" value={String(value.port || "")} onChange={(e) => onChange({ ...value, port: Number(e.target.value.replace(/\D/g, "")) || 0 })} autoComplete="off" />}
      </Field>
      <label className="ou-sync-pathstyle">
        <span>{label} 用 SSL / TLS 直连</span>
        <Switch checked={value.secure} onCheckedChange={(secure) => onChange({ ...value, secure })} aria-label={`${label} 用 SSL / TLS 直连`} />
      </label>
    </div>
  );
}

/**
 * 网页版：不连 IMAP / SMTP，也不用任何邮件 API / OAuth。浏览器插件在你已经登录的 Gmail / QQ / 163 网页里
 * 打开写信页、填好收件人、标题、正文并附上简历，发送由你自己在邮箱里点；读信只读你点「交给 OfferU」的那一封。
 * 主操作：没插件时「安装插件」；有插件时选默认邮箱（选一次）。桌面版的说明收在披露行里。
 */
function WebMailViaExtension() {
  const [ext, choose] = useExtensionMail();
  const [desktop, setDesktop] = useState(false);
  const [error, setError] = useState("");
  const ready = ext.status === "ready";
  const provider = ready ? ext.caps.provider : null;
  const pill = ext.status === "checking"
    ? <Pill tone="gray">检测插件中</Pill>
    : ready ? <Pill tone="green">用浏览器插件</Pill> : <Pill tone="gray">没检测到插件</Pill>;
  const pick = (value: string) => {
    setError("");
    choose(value as WebmailId).catch((cause) => setError(safeClientErrorMessage(cause, "没保存上")));
  };
  return (
    <SettingsGroup
      label="邮箱"
      testId="mail-settings"
      note="插件不会替你点发送，也不扫描收件箱；只在你点「交给 OfferU」时读当前打开的这一封。邮箱网页改版时可能填不上，会退回复制内容。"
    >
      <div className="ou-settings-item">
        <span className="ou-tile" aria-hidden="true"><Puzzle size={16} /></span>
        <div className="ou-settings-item-text">
          <span className="ou-settings-item-label flex flex-wrap items-center gap-2">邮箱 {pill}</span>
          <span className="ou-settings-item-desc">
            {ready
              ? "写投递邮件时，在你已登录的邮箱网页里打开草稿：收件人、标题、正文和简历附件都填好，你检查后自己点发送。"
              : "装上 OfferU 浏览器插件，投递邮件就能在你已登录的 Gmail / QQ / 163 网页里自动填好草稿；不用授权码，也不需要邮箱授权。"}
          </span>
        </div>
        <div className="ou-settings-item-control">
          {ready ? (
            <Select
              aria-label="默认邮箱"
              value={provider ?? undefined}
              placeholder="选默认邮箱"
              onValueChange={pick}
              options={WEBMAIL_OPTIONS}
            />
          ) : ext.status === "missing" ? (
            <ExternalUrlLink href={extensionInstallUrl()} className="ou-text-button" data-testid="mail-install-extension">
              安装插件<ExternalLink size={13} aria-hidden="true" />
            </ExternalUrlLink>
          ) : null}
        </div>
      </div>
      {ready && !provider && <p className="ou-settings-hint px-4 pb-3" role="status">先选一次默认邮箱，之后「写投递邮件」会直接打开它。</p>}
      {error && <p className="ou-settings-error px-4 pb-3" role="alert">{error}</p>}
      <div className="ou-settings-item">
        <span className="ou-tile" aria-hidden="true"><Monitor size={16} /></span>
        <div className="ou-settings-item-text">
          <span className="ou-settings-item-label">桌面版直连邮箱</span>
          <span className="ou-settings-item-desc">让 Agent 自己读收件箱、在 OfferU 里确认发送，要用桌面版。</span>
        </div>
        <div className="ou-settings-item-control">
          <button
            type="button"
            className="ou-text-button ou-disclosure-trigger"
            aria-expanded={desktop}
            aria-controls="mail-desktop-note"
            onClick={() => setDesktop((value) => !value)}
          >
            了解
            <ChevronRight size={14} aria-hidden="true" className="ou-disclosure-chevron" />
          </button>
        </div>
      </div>
      <DisclosurePanel open={desktop} id="mail-desktop-note">
        <p className="ou-settings-callout mx-4 mb-3" data-tone="gray">
          桌面版用邮箱授权码直连 IMAP / SMTP：Agent 能直接读邀约邮件更新看板，投递邮件存进草稿箱，你在岗位详情点「确认发送」才发出。授权码只该留在本机，所以网页版不做这条路。
        </p>
      </DisclosurePanel>
    </SettingsGroup>
  );
}

function Checks({ result }: { result: MailTestResult }) {
  return (
    <ul className="ou-mail-checks" aria-label="连接测试结果">
      {(["imap", "smtp"] as const).map((side) => (
        <li key={side} data-ok={result[side].ok ? "" : undefined}>
          <Pill tone={result[side].ok ? "green" : "red"}>{side === "imap" ? "收信 IMAP" : "发信 SMTP"} {result[side].ok ? "正常" : "失败"}</Pill>
          {result[side].error && <span>{result[side].error}</span>}
        </li>
      ))}
    </ul>
  );
}

export function MailSettingsPanel() {
  const [status, setStatus] = useState<MailStatusView | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [form, setForm] = useState<MailForm>(blankForm(undefined));
  const [editing, setEditing] = useState(false);
  const [servers, setServers] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState<"" | "save" | "test" | "clear">("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [checks, setChecks] = useState<MailTestResult | null>(null);

  const adopt = (next: MailStatusView) => {
    setStatus(next);
    setForm(next.account ? { ...next.account, password: "" } : blankForm(next.providers[0]));
  };

  useEffect(() => {
    mailApi.status().then(adopt).catch((cause) => {
      if (isMailUnsupported(cause)) setUnsupported(true);
      else setError(safeClientErrorMessage(cause, "读取邮箱状态失败"));
    });
  }, []);

  if (unsupported) return <WebMailViaExtension />;

  const providers = status?.providers ?? [];
  const provider = providers.find((item) => item.id === form.provider);
  const connected = Boolean(status?.connected);
  const custom = form.provider === "custom";
  const secret = provider?.secret ?? "授权码";
  const keepPassword = connected && status?.account?.address === form.address.trim();

  const pickProvider = (id: string) => {
    const next = providers.find((item) => item.id === id);
    setForm((current) => ({ ...current, provider: next?.id ?? "custom", imap: next?.imap ?? current.imap, smtp: next?.smtp ?? current.smtp }));
    setChecks(null);
  };
  const setAddress = (address: string) => {
    setForm((current) => ({ ...current, address }));
    setChecks(null);
  };
  // 地址填完：域名对得上预设就自动换服务商（qq.com → QQ 邮箱），用户手动选过「其他邮箱」也照样换回预设。
  const settleAddress = () => {
    const guess = providerFor(form.address.trim(), providers);
    if (guess !== "custom" && guess !== form.provider) pickProvider(guess);
  };

  const blocker = !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.address.trim())
    ? "先填邮箱地址"
    : !form.password.trim() && !keepPassword
      ? `填${secret}`
      : custom && (!form.imap.host || !form.smtp.host || !form.imap.port || !form.smtp.port)
        ? "填 IMAP 和 SMTP 服务器"
        : "";

  const run = async (kind: "save" | "test" | "clear") => {
    setBusy(kind);
    setError("");
    setNote("");
    try {
      if (kind === "save") {
        setChecks(null);
        adopt(await mailApi.configure({ ...form, address: form.address.trim() }));
        setEditing(false);
        setReveal(false);
        setNote("已连接。授权码只存在这台电脑的 OfferU 数据目录里。");
      } else if (kind === "test") {
        const result = await mailApi.test(editing ? { ...form, address: form.address.trim() } : undefined);
        setChecks(result);
        if (result.ok) setNote("收信和发信都能登录。");
      } else {
        adopt(await mailApi.disconnect());
        setEditing(false);
        setChecks(null);
        setNote("已断开，授权码已从本机删除。");
      }
    } catch (cause) {
      setError(safeClientErrorMessage(cause, kind === "save" ? "没连上" : kind === "test" ? "测试失败" : "断开失败"));
    } finally {
      setBusy("");
    }
  };

  const pill = connected ? <Pill tone="green">已连接</Pill> : <Pill tone="gray">未连接</Pill>;
  const summary = connected && status?.account
    ? `${status.account.address} · ${providers.find((item) => item.id === status.account?.provider)?.label ?? "邮箱"}`
    : "连上后，Agent 能读笔试 / 面试邀约更新看板，投递邮件能直接存进草稿箱，你确认后再发出。";

  return (
    <SettingsGroup label="邮箱" testId="mail-settings" note={connected ? undefined : "用邮箱的授权码登录，不是网页登录密码；授权码只存在本机，不会同步，也不会发给模型。"}>
      <div className="ou-settings-item">
        <span className="ou-tile" aria-hidden="true"><Mail size={16} /></span>
        <div className="ou-settings-item-text">
          <span className="ou-settings-item-label flex flex-wrap items-center gap-2">邮箱 {pill}</span>
          <span className="ou-settings-item-desc">{summary}</span>
        </div>
        <div className="ou-settings-item-control">
          {connected && !editing && (
            <button type="button" className="ou-text-button" onClick={() => void run("test")} disabled={Boolean(busy)} data-testid="mail-test">
              {busy === "test" ? "测试中…" : "测试连接"}
            </button>
          )}
          <button
            type="button"
            className="ou-text-button ou-disclosure-trigger"
            data-testid="mail-setup-toggle"
            aria-expanded={editing}
            aria-controls="mail-form"
            onClick={() => setEditing((value) => !value)}
          >
            {connected ? "邮箱设置" : "连接邮箱"}
            <ChevronRight size={14} aria-hidden="true" className="ou-disclosure-chevron" />
          </button>
        </div>
      </div>

      <DisclosurePanel open={editing} id="mail-form">
        <form
          className="ou-sync-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!blocker && !busy) void run("save");
          }}
        >
          <div className="ou-sync-step-fields">
            <Field label="服务商">
              {(id) => <Select id={id} value={form.provider} onValueChange={pickProvider} options={providers.map((item) => ({ value: item.id, label: item.label }))} />}
            </Field>
            <Field label="邮箱地址">
              {(id) => <Input id={id} type="email" value={form.address} onChange={(e) => setAddress(e.target.value)} onBlur={settleAddress} placeholder="you@qq.com" autoComplete="email" spellCheck={false} />}
            </Field>
          </div>
          <Field
            label={secret}
            hint={keepPassword ? `留空沿用已保存的${secret}` : provider?.note}
          >
            {(id) => (
              <div className="ou-mail-secret">
                <Input
                  id={id}
                  type={reveal ? "text" : "password"}
                  value={form.password}
                  onChange={(e) => { setForm((current) => ({ ...current, password: e.target.value })); setChecks(null); }}
                  placeholder={keepPassword ? "••••••••" : provider?.id === "custom" ? "密码或授权码" : `16 位${secret}`}
                  autoComplete="off"
                  spellCheck={false}
                />
                <button type="button" onClick={() => setReveal((value) => !value)} className="ou-icon-button" aria-label={reveal ? `隐藏${secret}` : `显示${secret}`} aria-pressed={reveal}>
                  {reveal ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            )}
          </Field>
          {provider?.help && (
            <ExternalUrlLink href={provider.help} className="ou-text-button ou-mail-help">
              怎么获取{secret}<ExternalLink size={13} aria-hidden="true" />
            </ExternalUrlLink>
          )}
          {provider?.warning && <p className="ou-settings-callout" data-tone="yellow">{provider.note}</p>}

          {custom ? (
            <div className="ou-sync-advanced ou-mail-servers">
              <ServerFields label="IMAP" value={form.imap} onChange={(imap) => setForm((current) => ({ ...current, imap }))} />
              <ServerFields label="SMTP" value={form.smtp} onChange={(smtp) => setForm((current) => ({ ...current, smtp }))} />
            </div>
          ) : (
            <div>
              <button
                type="button"
                className="ou-text-button ou-disclosure-trigger -ml-2"
                data-testid="mail-servers-toggle"
                aria-expanded={servers}
                aria-controls="mail-servers"
                onClick={() => setServers((value) => !value)}
              >
                服务器设置
                <ChevronRight size={14} aria-hidden="true" className="ou-disclosure-chevron" />
              </button>
              <DisclosurePanel open={servers} id="mail-servers">
                <div className="ou-sync-advanced ou-mail-servers mt-2">
                  <ServerFields label="IMAP" value={form.imap} onChange={(imap) => setForm((current) => ({ ...current, imap }))} />
                  <ServerFields label="SMTP" value={form.smtp} onChange={(smtp) => setForm((current) => ({ ...current, smtp }))} />
                </div>
              </DisclosurePanel>
            </div>
          )}

          {checks && <Checks result={checks} />}
          <div className="ou-sync-footer">
            <p className="ou-settings-hint" id="mail-save-reason" aria-live="polite">{blocker}</p>
            {connected && (
              <button type="button" className="ou-text-button" data-tone="danger" onClick={() => void run("clear")} disabled={Boolean(busy)}>
                断开
              </button>
            )}
            <button type="button" className="ou-text-button" onClick={() => void run("test")} disabled={Boolean(busy) || Boolean(blocker)}>
              {busy === "test" ? "测试中…" : "测试连接"}
            </button>
            <Button type="submit" variant={connected ? "secondary" : "primary"} disabled={Boolean(busy) || Boolean(blocker)} aria-describedby={blocker ? "mail-save-reason" : undefined}>
              {busy === "save" ? "连接中…" : connected ? "保存" : "连接"}
            </Button>
          </div>
          {error && <p className="ou-settings-error text-right" role="alert">{error}</p>}
        </form>
      </DisclosurePanel>

      {!editing && checks && <div className="px-4 pb-3"><Checks result={checks} /></div>}
      {!editing && error && <p className="ou-settings-error px-4 pb-3" role="alert">{error}</p>}
      {note && !error && <p className="ou-settings-status px-4 pb-3" role="status">{note}</p>}
    </SettingsGroup>
  );
}
