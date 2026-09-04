"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  Button,
  Card,
  CardBody,
  Chip,
  Checkbox,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Select,
  SelectItem,
  useDisclosure,
} from "@nextui-org/react";
import {
  AlertCircle,
  Building2,
  CalendarPlus,
  Clock,
  Inbox,
  Info,
  Link2,
  Mail,
  MapPin,
  RefreshCw,
  Shield,
  Trash2,
} from "lucide-react";
import {
  autoFillCalendar,
  getEmailAuthUrl,
  imapConnect,
  revokeEmailAccount,
  syncEmails,
  useEmailStatus,
  useNotifications,
} from "@/lib/hooks";
import { safeClientErrorMessage } from "@/lib/safe-error";
import {
  bauhausFieldClassNames,
  bauhausModalContentClassName,
  bauhausSelectClassNames,
} from "@/lib/bauhaus";

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.08 } },
};

const item = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { duration: 0.24, ease: "easeOut" } },
};

const CATEGORY_CLASS: Record<string, string> = {
  application: "border border-[var(--border-strong)] bg-white text-[var(--foreground)] font-semibold",
  written_test: "border border-[var(--border-strong)] bg-[var(--surface-muted)] text-[var(--foreground)] font-semibold",
  assessment: "border border-[var(--border-strong)] bg-[var(--surface-muted)] text-[var(--foreground)] font-semibold",
  interview_1: "border border-[var(--border-strong)] bg-[var(--surface-muted)] text-[var(--foreground)] font-semibold",
  interview_2: "border border-[var(--border-strong)] bg-[var(--surface-muted)] text-[var(--foreground)] font-semibold",
  interview_hr: "border border-[var(--border-strong)] bg-[var(--status-blush)] text-[var(--foreground)] font-semibold",
  offer: "border border-[var(--border-strong)] bg-black text-white font-semibold",
  rejection: "border border-[var(--border-strong)] bg-[var(--status-blush)] text-[var(--foreground)] font-semibold",
  unknown: "border border-[var(--border-strong)] bg-white text-[var(--foreground)] font-semibold",
};

const PROVIDERS = [
  { key: "qq", label: "QQ邮箱" },
  { key: "163", label: "163邮箱" },
  { key: "126", label: "126邮箱" },
  { key: "gmail", label: "Gmail" },
  { key: "outlook", label: "Outlook / 365" },
];

function isTrustedGmailAuthUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "accounts.google.com" &&
      parsed.port === "" &&
      parsed.pathname === "/o/oauth2/v2/auth" &&
      !parsed.username &&
      !parsed.password &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}

export default function EmailPage() {
  const { data: notifications, mutate } = useNotifications();
  const { data: emailStatus, mutate: mutateStatus } = useEmailStatus();
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState("");
  const [authResult, setAuthResult] = useState<string | null>(null);
  const [emailError, setEmailError] = useState("");
  const [emailConsent, setEmailConsent] = useState(false);
  const [revokingAccountId, setRevokingAccountId] = useState<string | null>(null);
  const { isOpen, onOpen, onOpenChange } = useDisclosure();

  // Gmail OAuth 回调：{frontend}/email?auth=success|error → 展示提示并清理 URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("auth");
    if (outcome) {
      setAuthResult(outcome === "success" ? "Gmail 授权成功，开始同步邮件" : "Gmail 授权失败，请重试");
      mutateStatus();
      window.history.replaceState({}, "", window.location.pathname + window.location.hash);
    }
  }, [mutateStatus]);

  const [imapProvider, setImapProvider] = useState("qq");
  const [imapUser, setImapUser] = useState("");
  const [imapPassword, setImapPassword] = useState("");
  const [imapLoading, setImapLoading] = useState(false);
  const [imapError, setImapError] = useState("");

  const isConnected = emailStatus?.connected ?? false;
  const isGmail = emailStatus?.gmail_connected ?? false;
  const isImap = emailStatus?.imap_connected ?? false;
  const activeAccounts = (emailStatus?.accounts ?? []).filter((account) => account.status === "active");

  const handleAuth = async () => {
    if (!emailConsent) {
      setEmailError("请先确认邮箱只读同步范围");
      return;
    }
    setEmailError("");
    try {
      const result = await getEmailAuthUrl(true);
      if (result.auth_url) {
        if (!isTrustedGmailAuthUrl(result.auth_url)) {
          setEmailError("Gmail 授权地址异常，已停止跳转");
          return;
        }
        window.location.href = result.auth_url;
      } else {
        setEmailError(safeClientErrorMessage(result.message, "无法生成 Gmail 授权链接"));
      }
    } catch (cause) {
      setEmailError(safeClientErrorMessage(cause, "无法生成 Gmail 授权链接"));
    }
  };

  const handleImapConnect = async (onClose: () => void) => {
    if (!emailConsent) {
      setImapError("请先确认邮箱只读同步范围");
      return;
    }
    setImapLoading(true);
    setImapError("");
    const { ok, data } = await imapConnect({
      user: imapUser,
      password: imapPassword,
      provider: imapProvider,
      user_confirmed: true,
    });
    setImapLoading(false);
    if (ok) {
      await mutateStatus();
      onClose();
    } else {
      setImapError(safeClientErrorMessage(data?.message, "连接失败"));
    }
  };

  const handleRevoke = async (account: { account_id: string; email_address: string; provider: string }) => {
    if (!window.confirm(`确认撤销 ${account.email_address || account.provider} 的邮箱授权？这会停止同步、删除本地凭据，并使未确认的邮件候选失效。`)) return;
    setRevokingAccountId(account.account_id);
    setEmailError("");
    try {
      await revokeEmailAccount(account.account_id, "使用者在邮箱设置中撤销授权");
      await mutateStatus();
    } catch (cause) {
      setEmailError(safeClientErrorMessage(cause, "撤销邮箱授权失败"));
    } finally {
      setRevokingAccountId(null);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    setSyncResult("");
    try {
      const result = await syncEmails();
      if (result.synced !== undefined) {
        setSyncResult(
          `已同步 ${result.synced} 条通知（共发现 ${result.total_found} 封邮件），自动创建 ${result.calendar_created ?? 0} 个日历事件`
        );
      } else {
        setSyncResult(safeClientErrorMessage(result.message, "同步完成"));
      }
    } catch {
      setSyncResult("同步失败，请检查网络");
    }
    await mutate();
    await mutateStatus();
    setSyncing(false);
  };

  const handleAutoFill = async () => {
    const result = await autoFillCalendar();
    setSyncResult(`已补建 ${result.created} 个日历事件（扫描 ${result.scanned} 条通知）`);
  };

  return (
    <motion.div variants={container} initial="hidden" animate="show" className="space-y-8">
      <motion.section variants={item} className="bauhaus-panel overflow-hidden bg-white">
        <div className="grid gap-6 p-6 md:p-8 xl:grid-cols-[1.05fr_0.95fr]">
          <div className="space-y-4">
            <span className="bauhaus-chip bg-[var(--surface-muted)] text-[var(--foreground)]">邮件接入</span>
            <div>
              <p className="bauhaus-label text-[var(--foreground-muted)]">收件箱解析</p>
              <h1 className="mt-3 text-5xl font-black uppercase leading-[0.88] tracking-[-0.08em] sm:text-6xl">进展</h1>
              <p className="mt-4 max-w-2xl text-base font-medium leading-relaxed text-[var(--foreground-muted)]">
                把邮箱授权、通知分类和日历同步集中到一块面板里，避免面试邮件遗漏，
                也方便我们把下一步动作自动推进到日程与投递流程。
              </p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3 xl:grid-cols-1">
            <div className="bauhaus-panel-sm bg-[var(--surface-muted)] p-4 text-[var(--foreground)]">
              <p className="bauhaus-label text-[var(--foreground-muted)]">Gmail</p>
              <p className="mt-3 text-2xl font-black uppercase tracking-[-0.05em]">{isGmail ? "已连接" : "待连接"}</p>
            </div>
            <div className="bauhaus-panel-sm bg-[var(--surface-muted)] p-4 text-[var(--foreground)]">
              <p className="bauhaus-label text-[var(--foreground-muted)]">IMAP</p>
              <p className="mt-3 text-2xl font-black uppercase tracking-[-0.05em]">{isImap ? "已连接" : "待连接"}</p>
            </div>
            <div className="bauhaus-panel-sm bg-[var(--status-blush)] p-4 text-[var(--foreground)]">
              <p className="bauhaus-label text-[var(--foreground-muted)]">已解析</p>
              <p className="mt-3 text-4xl font-black uppercase tracking-[-0.08em]">{notifications?.length ?? 0}</p>
            </div>
          </div>
        </div>
      </motion.section>

      <motion.section variants={item} className="bauhaus-panel-sm flex items-start gap-3 bg-[var(--surface-muted)] p-4 text-[var(--foreground)]">
        <Info size={16} className="mt-0.5 shrink-0" />
        <div className="space-y-3">
          <p className="text-sm font-medium leading-relaxed text-[var(--foreground-muted)]">
            本功能仅供个人学习和求职使用，请勿用于商业抓取或批量数据采集。使用前请确认已阅读平台条款和邮件服务规则。
          </p>
          <Checkbox isSelected={emailConsent} onValueChange={setEmailConsent}>
            <span className="text-xs font-semibold">我确认只读同步邮箱中的求职进展邮件</span>
          </Checkbox>
          <p className="pl-7 text-[11px] leading-5 text-[var(--foreground-muted)]">
            Gmail 使用只读权限；IMAP 仅以只读方式读取 INBOX。OfferU 只为识别面试、笔试和 Offer 等进展暂时读取相关邮件，默认保存最小摘要和哈希，不自动修改投递阶段。可在下方随时撤销授权。
          </p>
          {emailError && <p role="alert" className="pl-7 text-xs font-semibold text-[#b7483c]">{emailError}</p>}
        </div>
      </motion.section>

      <motion.section variants={item} className="flex flex-wrap gap-2">
        <Button
          startContent={<Link2 size={16} />}
          onPress={handleAuth}
          isDisabled={!emailConsent}
          className={`bauhaus-button !px-4 !py-3 !text-[11px] ${
            isGmail ? "bauhaus-button-yellow" : "bauhaus-button-outline"
          }`}
        >
          {isGmail ? "Gmail 已连" : "授权 Gmail"}
        </Button>
        <Button
          startContent={<Inbox size={16} />}
          onPress={onOpen}
          className={`bauhaus-button !px-4 !py-3 !text-[11px] ${
            isImap ? "bauhaus-button-blue" : "bauhaus-button-outline"
          }`}
        >
          {isImap ? `IMAP 已连 (${emailStatus?.imap_host})` : "IMAP 直连"}
        </Button>
        <Button
          startContent={<RefreshCw size={16} className={syncing ? "animate-spin" : ""} />}
          onPress={handleSync}
          isLoading={syncing}
          isDisabled={!isConnected}
          className="bauhaus-button bauhaus-button-red !px-4 !py-3 !text-[11px]"
        >
          同步邮件
        </Button>
        <Button
          startContent={<CalendarPlus size={16} />}
          onPress={handleAutoFill}
          className="bauhaus-button bauhaus-button-yellow !px-4 !py-3 !text-[11px]"
        >
          补建日历
        </Button>
      </motion.section>

      {activeAccounts.length > 0 && (
        <motion.section variants={item}>
          <Card className="bauhaus-panel rounded-none bg-white shadow-none">
            <CardBody className="space-y-4 p-5">
              <div>
                <p className="bauhaus-label text-[var(--foreground-muted)]">权限管理</p>
                <h2 className="mt-2 text-2xl font-black tracking-[-0.05em] text-[var(--foreground)]">已授权邮箱</h2>
                <p className="mt-2 text-sm font-medium leading-relaxed text-[var(--foreground-muted)]">撤销后会停止后续同步、删除本地钥匙串凭据，并使尚未确认的邮件候选失效。</p>
              </div>
              {activeAccounts.map((account) => (
                <div key={account.account_id} className="bauhaus-panel-sm flex flex-col gap-3 bg-[var(--surface-muted)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-semibold text-[var(--foreground)]">{account.email_address || account.provider}</p>
                    <p className="mt-1 text-xs font-medium text-[var(--foreground-muted)]">{account.provider === "gmail" ? "Gmail 只读授权" : `IMAP 只读 · ${account.host}`}</p>
                  </div>
                  <Button
                    size="sm"
                    variant="light"
                    startContent={<Trash2 size={14} />}
                    onPress={() => handleRevoke(account)}
                    isLoading={revokingAccountId === account.account_id}
                    className="bauhaus-button bauhaus-button-outline !px-3 !py-2 !text-[11px]"
                  >
                    撤销授权
                  </Button>
                </div>
              ))}
            </CardBody>
          </Card>
        </motion.section>
      )}

      <motion.section variants={item}>
        <Card className="bauhaus-panel rounded-none bg-white shadow-none">
          <CardBody className="flex flex-col gap-4 p-5 md:flex-row md:items-center">
            <div className="bauhaus-panel-sm flex h-12 w-12 items-center justify-center bg-[var(--surface-muted)] text-[var(--foreground)]">
              <Mail size={22} />
            </div>
            <div className="flex-1">
              <p className="text-lg font-black uppercase tracking-[-0.04em] text-[var(--foreground)]">邮箱状态</p>
              <p className="mt-2 text-sm font-medium leading-relaxed text-[var(--foreground-muted)]">
                {isConnected
                  ? `${isImap ? `IMAP: ${emailStatus?.imap_user}` : ""}${isImap && isGmail ? " + " : ""}${isGmail ? "Gmail OAuth" : ""} · 已解析 ${notifications?.length ?? 0} 条通知`
                  : "尚未连接邮箱。支持 QQ邮箱 / 163邮箱 / Gmail IMAP 直连，也支持 Gmail OAuth。"}
              </p>
              {authResult && <p className="mt-2 text-sm font-medium text-[#2f7d4f]">{authResult}</p>}
              {syncResult && <p className="mt-2 text-sm font-medium text-[#7a8f7e]">{syncResult}</p>}
            </div>
            <Chip
              variant="flat"
              className={`border border-[var(--border-strong)] font-semibold ${
                isConnected ? "bg-[var(--surface-muted)] text-[var(--foreground)]" : "bg-white text-[var(--foreground)]"
              }`}
            >
              {isConnected ? "已连接" : "未连接"}
            </Chip>
          </CardBody>
        </Card>
      </motion.section>

      <Modal isOpen={isOpen} onOpenChange={onOpenChange} placement="center">
        <ModalContent className={bauhausModalContentClassName}>
          {(onClose) => (
            <>
              <ModalHeader className="border-b border-[var(--border-strong)]/12 bg-[var(--surface-muted)] px-6 py-5 text-xl font-black tracking-[-0.06em] text-[var(--foreground)]">
                <div className="flex items-center gap-2">
                  <Shield size={20} />
                  IMAP 邮箱直连
                </div>
              </ModalHeader>
              <ModalBody className="space-y-4 px-6 py-6">
                <div className="bauhaus-panel-sm bg-[var(--surface-muted)] p-4 text-sm font-medium leading-relaxed text-[var(--foreground-muted)]">
                  QQ邮箱 / 163邮箱需要使用授权码而不是登录密码。OfferU 会先以只读方式校验连接，再把凭据保存到本地钥匙串；不会把密码写入数据库。
                </div>
                <Select
                  label="邮箱服务商"
                  selectedKeys={[imapProvider]}
                  onSelectionChange={(keys) => {
                    const value = Array.from(keys)[0] as string;
                    if (value) setImapProvider(value);
                  }}
                  classNames={bauhausSelectClassNames}
                >
                  {PROVIDERS.map((provider) => (
                    <SelectItem key={provider.key}>{provider.label}</SelectItem>
                  ))}
                </Select>
                <Input
                  label="邮箱地址"
                  placeholder="your@qq.com"
                  value={imapUser}
                  onValueChange={setImapUser}
                  classNames={bauhausFieldClassNames}
                />
                <Input
                  label="授权码 / 应用密码"
                  type="password"
                  placeholder="QQ邮箱→设置→账户→生成授权码"
                  value={imapPassword}
                  onValueChange={setImapPassword}
                  classNames={bauhausFieldClassNames}
                />
                {imapError && (
                  <div className="bauhaus-panel-sm flex items-center gap-2 bg-[var(--status-blush)] px-4 py-3 text-sm font-medium text-[#b7483c]">
                    <AlertCircle size={14} /> {imapError}
                  </div>
                )}
              </ModalBody>
              <ModalFooter className="border-t-2 border-[var(--border-strong)] px-6 py-5">
                <Button variant="light" onPress={onClose} className="bauhaus-button bauhaus-button-outline !px-4 !py-3 !text-[11px]">
                  取消
                </Button>
                <Button
                  onPress={() => handleImapConnect(onClose)}
                  isLoading={imapLoading}
                  isDisabled={!imapUser || !imapPassword || !emailConsent}
                  className="bauhaus-button bauhaus-button-blue !px-4 !py-3 !text-[11px]"
                >
                  测试并连接
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>

      {notifications && notifications.length > 0 ? (
        <div className="space-y-4">
          {notifications.map((notification) => (
            <motion.div key={notification.id} variants={item}>
              <Card className="bauhaus-panel rounded-none bg-white shadow-none">
                <CardBody className="space-y-3 p-5">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Chip
                          size="sm"
                          variant="flat"
                          className={CATEGORY_CLASS[notification.category] || CATEGORY_CLASS.unknown}
                        >
                          {notification.category_display || notification.category}
                        </Chip>
                        <h3 className="text-xl font-black tracking-[-0.04em] text-[var(--foreground)]">
                          {notification.position || notification.email_subject}
                        </h3>
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm font-medium text-[var(--foreground-muted)]">
                        {notification.company && (
                          <span className="flex items-center gap-1">
                            <Building2 size={12} />
                            {notification.company}
                          </span>
                        )}
                        {notification.location && (
                          <span className="flex items-center gap-1">
                            <MapPin size={12} />
                            {notification.location}
                          </span>
                        )}
                      </div>
                    </div>

                    {notification.interview_time && (
                      <Chip size="sm" variant="flat" className="border border-[var(--border-strong)] bg-[var(--surface-muted)] font-semibold text-[var(--foreground)]">
                        <Clock size={12} className="mr-1" />
                        {new Date(notification.interview_time).toLocaleString("zh-CN")}
                      </Chip>
                    )}
                  </div>

                  {notification.action_required && (
                    <div className="bauhaus-panel-sm bg-[var(--surface-muted)] px-4 py-3 text-sm font-medium text-[var(--foreground)]">
                      下一步：{notification.action_required}
                    </div>
                  )}

                  <p className="text-xs font-medium text-[var(--foreground-muted)]">
                    来自: {notification.email_from} · 解析于 {notification.parsed_at}
                  </p>
                </CardBody>
              </Card>
            </motion.div>
          ))}
        </div>
      ) : (
        <motion.div variants={item}>
          <Card className="bauhaus-panel rounded-none bg-[var(--surface-muted)] text-[var(--foreground)] shadow-none">
            <CardBody className="p-10 text-center">
              <Mail size={54} className="mx-auto text-[var(--foreground-muted)]" />
              <p className="mt-4 text-2xl font-black uppercase tracking-[-0.05em]">暂无通知</p>
              <p className="mt-3 text-sm font-medium text-[var(--foreground-muted)]">
                先完成邮箱连接，然后同步邮件，这里会出现面试、笔试和 Offer 通知。
              </p>
            </CardBody>
          </Card>
        </motion.div>
      )}
    </motion.div>
  );
}
