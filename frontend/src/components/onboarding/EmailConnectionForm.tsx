import { useState } from "react";
import { Button, Checkbox, Input, Select, SelectItem } from "@nextui-org/react";
import { imapConnect, type EmailAccountSummary } from "@/lib/hooks";
import { safeClientErrorMessage } from "@/lib/safe-error";

const PROVIDERS = [
  { key: "qq", label: "QQ 邮箱", help: "在 QQ 邮箱的设置中找到账号安全，开启 IMAP 服务并生成授权码。" },
  { key: "163", label: "163 邮箱", help: "在网页版邮箱设置中开启 POP3/SMTP/IMAP 服务，并设置客户端授权密码。" },
  { key: "126", label: "126 邮箱", help: "在网页版邮箱设置中开启 POP3/SMTP/IMAP 服务，并设置客户端授权密码。" },
  { key: "gmail", label: "Gmail", help: "Google 账号需开启两步验证并允许生成应用专用密码。若账号不提供此选项，可稍后在邮箱页使用 Google 授权。" },
  { key: "outlook", label: "Outlook / 365", help: "是否允许密码方式接入由邮箱策略决定；不支持时请稍后设置。" },
];

export function EmailConnectionForm({ onConnected, onBusy }: {
  onConnected: (account: EmailAccountSummary) => void | Promise<void>;
  onBusy?: (busy: boolean) => void;
}) {
  const [provider, setProvider] = useState("qq");
  const [address, setAddress] = useState("");
  const [password, setPassword] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState<EmailAccountSummary | null>(null);
  const connect = async () => {
    if (busy || !consent) return;
    setBusy(true); onBusy?.(true); setError("");
    try {
      let account = connected;
      if (!account) {
        const authorizationCode = provider === "gmail" ? password.replace(/\s/g, "") : password.trim();
        const result = await imapConnect({ provider, user: address.trim(), password: authorizationCode });
        if (!result.ok || !result.data?.account_id) throw new Error(safeClientErrorMessage(result.data?.detail || result.data?.message, "连接失败，请检查邮箱地址和授权码。"));
        account = result.data as EmailAccountSummary;
        setConnected(account);
        setPassword("");
      }
      await onConnected(account);
    } catch (cause) { setError(safeClientErrorMessage(cause, "连接失败，请检查邮箱地址和授权码。")); }
    finally { setBusy(false); onBusy?.(false); }
  };
  return <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void connect(); }}>
    <Select label="邮箱服务商" selectedKeys={[provider]} isDisabled={busy || Boolean(connected)} onSelectionChange={(keys) => {
      const value = Array.from(keys)[0]; if (value) { setProvider(String(value)); setPassword(""); setError(""); }
    }}>{PROVIDERS.map((item) => <SelectItem key={item.key}>{item.label}</SelectItem>)}</Select>
    <Input label="邮箱地址" type="email" isRequired autoComplete="email" value={address} onValueChange={setAddress} isDisabled={busy || Boolean(connected)} />
    {!connected && <Input label="授权码 / 应用专用密码" type="password" isRequired autoComplete="off" value={password} onValueChange={setPassword} isDisabled={busy} />}
    <details className="text-sm text-[var(--foreground-muted)]"><summary className="cursor-pointer">在哪里获取授权码？</summary>
      <p className="mt-2 leading-6">{PROVIDERS.find((item) => item.key === provider)?.help}</p>
    </details>
    <Checkbox isSelected={consent} onValueChange={setConsent} isDisabled={busy}>允许只读同步求职邮件</Checkbox>
    <p className="text-xs leading-5 text-[var(--foreground-muted)]">首次整理最近 30 天，保留邮件未读状态。授权码保存到本机钥匙串；识别到的进展由你确认后更新。</p>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {connected && <p role="status" className="text-sm">邮箱已连接，授权码已保存。可以继续刷新连接状态。</p>}
    <Button type="submit" color="primary" isLoading={busy} isDisabled={!consent || (!connected && (!address.trim() || !password.trim()))}>{connected ? "继续" : "连接求职邮箱"}</Button>
  </form>;
}
