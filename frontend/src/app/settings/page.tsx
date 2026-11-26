"use client";

import "@/styles/settings.css";

import { PageHeader } from "@/components/layout/PageHeader";
import { Button, Dialog, Field, Input, Pill, Select as UiSelect, Switch } from "@/components/ui";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ModelPicker } from "@/components/settings/ModelPicker";
import { FreshResetPanel } from "@/components/settings/FreshResetPanel";
import { SyncSettingsPanel } from "@/components/settings/SyncSettingsPanel";
import { MailSettingsPanel } from "@/components/settings/MailSettingsPanel";
import BuildIdentityPanel from "@/components/settings/BuildIdentityPanel";
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  Cpu,
  Database,
  Download,
  Eye,
  EyeOff,
  FlaskConical,
  Info,
  LifeBuoy,
  Mail,
  MessageSquare,
  Plus,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
  UserRound,
} from "lucide-react";
import {
  dataSafetyApi,
  diagnosticsApi,
  type DataBackupItem,
  type DataIntegrityReport,
  type DataSafetyStatus,
  type PrivacyHygieneStatus,
} from "@/lib/api";
import { resolveApiBase } from "@/lib/apiBase";
import { downloadUserDataExport } from "@/lib/dataExport";
import { StoragePersistenceCard } from "@/components/settings/StoragePersistenceCard";
import { LOCAL_WEB } from "@/lib/local/mode";
import { useLlmTransportMode } from "@/lib/local/llmTransport";
import { safeClientErrorMessage } from "@/lib/safe-error";
import { SHOWCASE } from "@/lib/showcase";
import { useConfig, updateConfig } from "@/lib/hooks";
import { syncApi } from "@/lib/syncClient";
import { isMailUnsupported, mailApi } from "@/lib/mailClient";
import { AgentConnectionPanel } from "@/components/workbench/AgentConnectionPanel";
import { DemoBridgeDialog } from "@/components/workbench/DemoBridgeDialog";
import { DemoDataDialog } from "@/components/workbench/DemoDataDialog";
import { JobSourceConnectionsCard } from "@/components/settings/JobSourceConnectionsCard";
import { PlatformConsentCard } from "@/components/settings/PlatformConsentCard";
import { BossLoginCard } from "@/components/boss-login";
import { useHintsEnabled } from "@/components/hints";
import { SettingsRow } from "@/components/settings/SettingsRow";
import { DisclosurePanel, SettingsGroup, SettingsItem, useContainerWide } from "@/components/settings/SettingsLayout";
import { useAgentConnection } from "@/lib/agentConnection";

// 设置（参考 Apple System Settings / iOS 设置）：分组目录 → 详情。
// 容器够宽（≥ 45rem）时左列表、右详情；窄时目录和详情是两屏，详情从右推入、带返回。
// 选中的分类写进 ?section=，前进后退、外部深链（?section=models）都能直接打开。

type SectionKey = "agent" | "models" | "mail" | "accounts" | "collect" | "data" | "about" | "feedback";

const SECTIONS: Array<{ key: SectionKey; title: string; group: string; icon: ReactNode; description: string }> = [
  { key: "agent", title: "我的 Agent", group: "连接", icon: <Bot size={16} />, description: "连接你已有的 Agent，让它读写 OfferU 的岗位、简历和待办。" },
  { key: "models", title: "模型服务", group: "连接", icon: <Cpu size={16} />, description: "内置 Agent 使用的模型服务、并发上限和兜底方式。" },
  { key: "mail", title: "邮箱", group: "连接", icon: <Mail size={16} />, description: "用授权码连上自己的邮箱：读邀约邮件更新看板，投递邮件存进草稿箱，你确认后再发。" },
  { key: "accounts", title: "账号与来源", group: "连接", icon: <UserRound size={16} />, description: "求职平台登录，以及 OfferU 读取岗位的数据来源。" },
  { key: "collect", title: "登录态采集", group: "连接", icon: <ShieldAlert size={16} />, description: "BOSS / 小红书等登录态采集的风险说明与同意。" },
  { key: "data", title: "数据", group: "数据与隐私", icon: <Database size={16} />, description: "本机存储、云同步、备份恢复与导出。" },
  { key: "about", title: "关于", group: "支持", icon: <Info size={16} />, description: "版本、运行身份与界面提示。" },
  { key: "feedback", title: "报告问题", group: "支持", icon: <LifeBuoy size={16} />, description: "生成一份本地诊断包，发给我们排查。" },
];

/** 宽于这个值（容器宽，约 720px）就用双栏。 */
const SPLIT_MIN_WIDTH = 720;

const pushVariants = {
  enter: (direction: number) => ({ x: direction > 0 ? "18%" : "-10%", opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (direction: number) => ({ x: direction > 0 ? "-10%" : "18%", opacity: 0 }),
};
const pushTransition = { x: { type: "spring", stiffness: 380, damping: 38, mass: 0.9 }, opacity: { duration: 0.2 } } as const;

/** 目录里「数据」那一行的状态值：云同步连没连上。 */
function useSyncSummary() {
  const [summary, setSummary] = useState("备份、同步与导出");
  useEffect(() => {
    let cancelled = false;
    syncApi().status().then((status) => {
      if (cancelled) return;
      setSummary(status.last_error ? "云同步出错" : status.configured ? "云同步已连接" : "未开启云同步");
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  return summary;
}

/** 目录里「邮箱」那一行的状态值。 */
function useMailSummary() {
  const [summary, setSummary] = useState<string | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    mailApi.status().then((status) => {
      if (!cancelled) setSummary(status.account ? status.account.address : "未连接");
    }).catch((cause) => {
      if (!cancelled && isMailUnsupported(cause)) setSummary("仅桌面版");
    });
    return () => { cancelled = true; };
  }, []);
  return summary;
}

interface ProviderPreset {
  id: string;
  name: string;
  description?: string;
  api_format?: string;
}

interface LlmApiConfig {
  id: string;
  provider_id: string;
  service_name: string;
  model: string;
  base_url: string;
  api_key: string;
  is_active: boolean;
  extra_params?: Record<string, string>;
  api_format?: string;
  credential_ref?: string;
  models?: Record<string, string>;
  default_headers?: Record<string, string>;
  supports_json_mode?: boolean;
  icon?: string;
  website_url?: string;
  notes?: string;
}

interface SettingsConfigPayload {
  llm_provider?: string;
  llm_model?: string;
  deepseek_api_key?: string;
  openai_api_key?: string;
  qwen_api_key?: string;
  siliconflow_api_key?: string;
  gemini_api_key?: string;
  zhipu_api_key?: string;
  ollama_base_url?: string;

  llm_api_configs?: LlmApiConfig[];
  active_llm_config_id?: string;
  disabled_llm_providers?: string[];
  max_concurrent_agent_runs?: number;
  llm_fallback_to_agent?: boolean;
  provider_presets?: ProviderPreset[];

  active_llm_summary?: {
    provider_id: string;
    service_name: string;
    model: string;
    base_url: string;
    source: "active_config" | "legacy_env" | "ollama";
  };


  vault_status?: {
    available: boolean;
    error: string;
  };
}

function AgentConcurrencySetting({ value, onSave }: { value: number; onSave: (next: number) => Promise<void> }) {
  const [draft, setDraft] = useState(String(value));
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  useEffect(() => setDraft(String(value)), [value]);
  const parsed = Number(draft);
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= 10;
  const save = async () => {
    setSaving(true);
    setStatus("");
    try {
      await onSave(parsed);
      setStatus("已保存，新任务立即生效");
    } catch (error) {
      setStatus(safeClientErrorMessage(error, "保存失败，请稍后重试"));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div data-testid="agent-concurrency-setting">
      <SettingsItem label="Agent 最大并发数" htmlFor="agent-max-concurrency" description="同时运行的助手任务上限，过高可能触发模型限流">
        <Input
          id="agent-max-concurrency"
          type="number"
          inputMode="numeric"
          min={1}
          max={10}
          step={1}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          aria-invalid={!valid}
          className="ou-settings-number"
        />
        {valid && parsed !== value && (
          <button type="button" disabled={saving} onClick={() => void save()} className="ou-text-button">
            {saving ? "保存中…" : "保存"}
          </button>
        )}
      </SettingsItem>
      {!valid && <p role="alert" className="ou-settings-error px-4 pb-3">请输入 1 到 10 的整数</p>}
      {status && <p role="status" className="ou-settings-status px-4 pb-3">{status}</p>}
    </div>
  );
}

function AgentFallbackSetting({ enabled, onSave }: { enabled: boolean; onSave: (next: boolean) => Promise<void> }) {
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const toggle = async () => {
    setSaving(true);
    setStatus("");
    try {
      await onSave(!enabled);
      setStatus(enabled ? "已关闭" : "已开启，没配模型时由你的 Agent 代答");
    } catch (error) {
      setStatus(safeClientErrorMessage(error, "保存失败，请稍后重试"));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div data-testid="agent-fallback-setting">
      <SettingsItem label="没配模型时交给本机 Agent" htmlFor="agent-fallback-toggle" description="简历、邮件等内容会经本机 Agent 的 CLI 发到它自己的云端；配了内置模型时不生效">
        <Switch id="agent-fallback-toggle" checked={enabled} disabled={saving} onCheckedChange={() => void toggle()} aria-label="没配模型时交给本机 Agent" />
      </SettingsItem>
      {status && <p role="status" className="ou-settings-status px-4 pb-3">{status}</p>}
    </div>
  );
}

function normalizeProviderId(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "custom";
}

function createConfigId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed;
}

function isLocalEndpoint(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/[\[\]]/g, "").replace(/\.$/, "");
    if (hostname === "localhost" || hostname === "::1") return true;
    const octets = hostname.split(".");
    return octets.length === 4 && octets.every((octet) => /^\d+$/.test(octet) && Number(octet) >= 0 && Number(octet) <= 255) && Number(octets[0]) === 127;
  } catch {
    return false;
  }
}

function displayMaskedKey(value: string): string {
  if (!value) return "";
  if (value.includes("*")) return value;
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 4)}${"*".repeat(value.length - 8)}${value.slice(-4)}`;
}

function toLegacyOllamaBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/v1")) {
    return trimmed.slice(0, -3);
  }
  return trimmed;
}

function normalizeApiConfigsForSave(apiConfigs: LlmApiConfig[]) {
  let normalizedConfigs = apiConfigs.map((item) => {
    const providerId = normalizeProviderId(item.provider_id || item.service_name);
    return {
      ...item,
      provider_id: providerId,
      service_name: item.service_name.trim(),
      model: item.model.trim(),
      base_url: normalizeBaseUrl(item.base_url),
      api_key: item.api_key.trim(),
      extra_params: item.extra_params || {},
      api_format: String(item.api_format || ""),
      credential_ref: item.credential_ref || "",
      models: item.models || {},
      default_headers: item.default_headers || {},
      supports_json_mode: item.supports_json_mode !== false,
      icon: item.icon || "",
      website_url: item.website_url || "",
      notes: item.notes || "",
    };
  });

  const activeConfig = normalizedConfigs.find((item) => item.is_active) || normalizedConfigs[0] || null;
  if (activeConfig) {
    normalizedConfigs = normalizedConfigs.map((item) => ({
      ...item,
      is_active: item.id === activeConfig.id,
    }));
  }

  return {
    normalizedConfigs,
    activeConfig,
  };
}

function TestLlmButton() {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);

  const testConnection = async () => {
    setTesting(true);
    setResult(null);
    try {
      const API_BASE = resolveApiBase();
      const res = await fetch(`${API_BASE}/api/config/test-llm`, {
        method: "POST",
        redirect: "error",
      });
      // 非 2xx 时后端返回 {detail} 而不是 {success,message}，
      // 不校验会把失败显示成"模型连接测试完成"。
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setResult({ success: data.success, message: safeClientErrorMessage(data.message, "模型连接测试完成") });
    } catch (err: any) {
      setResult({ success: false, message: `请求失败: ${safeClientErrorMessage(err, "请稍后重试")}` });
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      {result && (
        <span role="status" className={result.success ? "ou-settings-status" : "ou-settings-error"}>
          {result.message}
        </span>
      )}
      <button type="button" className="ou-text-button" onClick={() => void testConnection()} disabled={testing}>
        {testing ? "测试中…" : "测试连接"}
      </button>
    </>
  );
}

function LocalDataSafetyCard() {
  const [exporting, setExporting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<"" | "integrity" | "backup" | "restore" | "cancel" | "reset_demo" | "privacy_scrub" | "privacy_purge_synthetic">("");
  const [status, setStatus] = useState<DataSafetyStatus | null>(null);
  const [integrity, setIntegrity] = useState<DataIntegrityReport | null>(null);
  const [backups, setBackups] = useState<DataBackupItem[]>([]);
  const [invalidBackups, setInvalidBackups] = useState(0);
  const [selectedBackup, setSelectedBackup] = useState<DataBackupItem | null>(null);
  const [confirmationText, setConfirmationText] = useState("");
  const [demoDataOpen, setDemoDataOpen] = useState(false);
  const [demoBridgeOpen, setDemoBridgeOpen] = useState(false);
  const [demoResetOpen, setDemoResetOpen] = useState(false);
  const [demoConfirmationText, setDemoConfirmationText] = useState("");
  const [privacyHygiene, setPrivacyHygiene] = useState<PrivacyHygieneStatus | null>(null);
  const [privacyScrubOpen, setPrivacyScrubOpen] = useState(false);
  const [privacyConfirmationText, setPrivacyConfirmationText] = useState("");
  const [syntheticPurgeOpen, setSyntheticPurgeOpen] = useState(false);
  const [syntheticConfirmationText, setSyntheticConfirmationText] = useState("");
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [isOpen, setRestoreOpen] = useState(false);
  const onOpen = () => setRestoreOpen(true);
  const onClose = () => setRestoreOpen(false);

  const load = async () => {
    setLoading(true);
    try {
      const [nextStatus, nextBackups, nextPrivacyHygiene] = await Promise.all([
        dataSafetyApi.status(),
        dataSafetyApi.listBackups(),
        SHOWCASE ? Promise.resolve<PrivacyHygieneStatus | null>(null) : dataSafetyApi.privacyHygieneStatus(),
      ]);
      setStatus(nextStatus);
      setBackups(nextBackups.items || []);
      setInvalidBackups((nextBackups.invalid || []).length);
      setPrivacyHygiene(nextPrivacyHygiene);
    } catch (cause) {
      setFeedback({ type: "error", message: safeClientErrorMessage(cause, "数据安全状态读取失败") });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const formatBytes = (size: number) => {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
  };

  const checkIntegrity = async () => {
    setAction("integrity");
    setFeedback(null);
    try {
      const report = await dataSafetyApi.checkIntegrity();
      setIntegrity(report);
      setFeedback({
        type: report.status === "ok" ? "success" : "error",
        message: report.status === "ok" ? "数据库与外键完整性检查通过。" : "数据库完整性检查未通过，请先不要恢复或升级。",
      });
    } catch (cause) {
      setFeedback({ type: "error", message: safeClientErrorMessage(cause, "完整性检查失败") });
    } finally {
      setAction("");
    }
  };

  const createBackup = async () => {
    setAction("backup");
    setFeedback(null);
    try {
      await dataSafetyApi.createBackup();
      setFeedback({ type: "success", message: "一致性备份已创建，并通过 manifest 与完整性校验。" });
      await load();
    } catch (cause) {
      setFeedback({ type: "error", message: safeClientErrorMessage(cause, "备份创建失败") });
    } finally {
      setAction("");
    }
  };

  const openRestore = (backup: DataBackupItem) => {
    setSelectedBackup(backup);
    setConfirmationText("");
    setFeedback(null);
    onOpen();
  };

  const stageRestore = async () => {
    if (!selectedBackup || confirmationText !== "恢复") return;
    setAction("restore");
    try {
      await dataSafetyApi.stageRestore(selectedBackup.backup_id);
      onClose();
      setFeedback({ type: "success", message: "恢复已安全暂存。请关闭并重新打开 OfferU；启动前会再次校验并保留 pre-restore 备份。" });
      await load();
    } catch (cause) {
      setFeedback({ type: "error", message: safeClientErrorMessage(cause, "恢复暂存失败") });
    } finally {
      setAction("");
    }
  };

  const cancelRestore = async () => {
    setAction("cancel");
    setFeedback(null);
    try {
      await dataSafetyApi.cancelRestore();
      setFeedback({ type: "success", message: "待恢复任务已取消，原备份仍然保留。" });
      await load();
    } catch (cause) {
      setFeedback({ type: "error", message: safeClientErrorMessage(cause, "取消恢复失败") });
    } finally {
      setAction("");
    }
  };

  const handleExport = async () => {
    setExporting(true);
    setFeedback(null);
    try {
      const total = await downloadUserDataExport();
      setFeedback({ type: "success", message: `已导出 ${total} 条本地职业数据。` });
    } catch (cause) {
      setFeedback({ type: "error", message: safeClientErrorMessage(cause, "数据导出失败，请稍后重试") });
    } finally {
      setExporting(false);
    }
  };

  const resetDemo = async () => {
    if (demoConfirmationText !== "重置 Demo") return;
    setAction("reset_demo");
    setFeedback(null);
    try {
      const result = await dataSafetyApi.resetDemoData();
      setDemoResetOpen(false);
      setDemoConfirmationText("");
      const cleared = Object.values(result.deleted || {}).reduce((sum, count) => sum + Number(count || 0), 0);
      setFeedback({
        type: "success",
        message: result.reset
          ? `Demo 数据已重置，清除了 ${cleared} 条明确标记的合成数据。真实用户数据未改动。`
          : "当前没有明确标记的 Demo 数据，未改动任何真实数据。",
      });
      await load();
    } catch (cause) {
      setFeedback({ type: "error", message: safeClientErrorMessage(cause, "Demo 数据重置失败，请稍后重试") });
    } finally {
      setAction("");
    }
  };

  const scrubLegacyEmailBodies = async () => {
    if (privacyConfirmationText !== "清理旧正文") return;
    setAction("privacy_scrub");
    setFeedback(null);
    try {
      const result = await dataSafetyApi.scrubLegacyEmailBodies();
      setPrivacyScrubOpen(false);
      setPrivacyConfirmationText("");
      setPrivacyHygiene(result.status);
      setFeedback({
        type: "success",
        message: `已清理 ${result.scrubbed_records} 条冗余旧邮件正文；结构化面试通知记录仍保留。`,
      });
    } catch (cause) {
      setFeedback({ type: "error", message: safeClientErrorMessage(cause, "旧邮件正文清理失败，请稍后重试") });
    } finally {
      setAction("");
    }
  };

  const purgeSyntheticEmailTestData = async () => {
    if (syntheticConfirmationText !== "清理合成邮箱") return;
    setAction("privacy_purge_synthetic");
    setFeedback(null);
    try {
      const result = await dataSafetyApi.purgeSyntheticEmailTestData();
      setSyntheticPurgeOpen(false);
      setSyntheticConfirmationText("");
      setPrivacyHygiene((current) => current ? { ...current, synthetic_email_test_data: result.status } : current);
      const purged = Object.values(result.purged).reduce((sum, count) => sum + Number(count || 0), 0);
      setFeedback({
        type: "success",
        message: `已清理 ${purged} 条严格限定的合成邮箱测试数据；真实邮箱、岗位和投递状态未改动。`,
      });
    } catch (cause) {
      setFeedback({ type: "error", message: safeClientErrorMessage(cause, "合成邮箱测试数据清理失败，请稍后重试") });
    } finally {
      setAction("");
    }
  };

  const legacyEmailBodyCount = privacyHygiene?.legacy_email_notification_bodies.records ?? 0;
  const legacyEmailBodyCharacters = privacyHygiene?.legacy_email_notification_bodies.characters ?? 0;
  const syntheticEmailDataCount = privacyHygiene
    ? Object.values(privacyHygiene.synthetic_email_test_data).reduce((sum, count) => sum + Number(count || 0), 0)
    : 0;

  const backupReason = (reason: string) =>
    reason === "pre_restore" ? "恢复前自动备份" : reason === "pre_migration" ? "迁移前自动备份" : reason === "pre_reset" ? "全清前自动备份" : "手动备份";

  return (
    <>
      <SettingsGroup
        label="备份与恢复"
        testId="local-data-safety"
        note="一致性备份包含 SQLite、上传文件和受管产物；恢复只会先暂存，下次启动前校验并替换。导出的 JSON 不含 Provider 密钥、邮箱凭据或浏览器会话。"
        action={
          <button type="button" className="ou-text-button" onClick={() => void load()} disabled={loading}>
            {loading ? "读取中…" : "刷新"}
          </button>
        }
      >
        <SettingsItem icon={<Database size={16} />} label="数据库" description={status?.database.filename || "读取中…"}>
          <span className="ou-settings-item-value">{status ? `${status.backup_count} 份备份` : "—"}</span>
          <Pill tone={status?.pending_restore ? "yellow" : "green"}>{status?.pending_restore ? "等待重启恢复" : "无待恢复任务"}</Pill>
        </SettingsItem>

        {status?.pending_restore && (
          <div role="status" className="ou-settings-callout mx-4 mb-3 flex flex-wrap items-center justify-between gap-2" data-tone="yellow">
            <span>备份 {status.pending_restore.backup_id.slice(0, 8)}… 已暂存，关闭并重新打开 OfferU 后恢复。</span>
            <button type="button" className="ou-text-button" disabled={action === "cancel"} onClick={() => void cancelRestore()}>
              取消待恢复
            </button>
          </div>
        )}

        <div className="ou-settings-actions px-4 pb-3">
          <Button onClick={() => void createBackup()} disabled={SHOWCASE || action === "backup"}>
            <ShieldCheck size={14} aria-hidden="true" /> {action === "backup" ? "备份中…" : "创建一致性备份"}
          </Button>
          <button type="button" className="ou-text-button" onClick={() => void checkIntegrity()} disabled={action === "integrity"}>
            {action === "integrity" ? "检查中…" : "检查完整性"}
          </button>
          <button type="button" className="ou-text-button" onClick={() => void handleExport()} disabled={exporting}>
            <Download size={14} aria-hidden="true" /> {exporting ? "导出中…" : "导出 JSON"}
          </button>
        </div>
        {SHOWCASE && <p className="ou-settings-hint px-4 pb-3">Showcase 使用独立 IndexedDB；这里只提供 JSON 导出、完整性说明和 Demo 重置，不伪装成 SQLite 备份。</p>}

        {integrity && (
          <p className="ou-settings-callout mx-4 mb-3" data-tone={integrity.status === "ok" ? "green" : "red"}>
            {integrity.status === "ok" ? "Integrity OK" : "Integrity Failed"} · schema {integrity.schema.schema_version} · 外键异常 {integrity.foreign_key_violations.length}
          </p>
        )}

        {(backups.length > 0 || invalidBackups > 0 || !loading) && (
          <div className="flex flex-col">
            <div className="flex items-center justify-between gap-2 px-4 pt-1">
              <span className="ou-settings-sublabel">最近备份</span>
              {invalidBackups > 0 && <Pill tone="red">{invalidBackups} 个无效归档</Pill>}
            </div>
            {!loading && backups.length === 0 && <p className="ou-settings-hint px-4 py-3">还没有备份。创建第一份一致性备份后，可以从这里选择恢复。</p>}
            {backups.slice(0, 5).map((backup) => (
              <div key={backup.backup_id} data-testid={`data-backup-${backup.backup_id}`}>
                <SettingsItem
                  label={`${backupReason(backup.reason)} · ${backup.backup_id.slice(0, 8)}`}
                  description={`${new Date(backup.created_at).toLocaleString()} · ${formatBytes(backup.size_bytes)} · v${backup.version}`}
                >
                  <button type="button" className="ou-text-button" disabled={Boolean(status?.pending_restore)} onClick={() => openRestore(backup)}>
                    <RotateCcw size={14} aria-hidden="true" /> 恢复
                  </button>
                </SettingsItem>
              </div>
            ))}
          </div>
        )}

        {feedback && (
          <p role={feedback.type === "error" ? "alert" : "status"} className="ou-settings-callout mx-4 mb-3" data-tone={feedback.type === "error" ? "red" : "green"}>
            {feedback.message}
          </p>
        )}
      </SettingsGroup>

      <SettingsGroup label="演示数据" testId="demo-data-safety"
        note={SHOWCASE
          ? "当前为独立 Showcase IndexedDB。重置会清除这个虚构展示工作区，下一次读取会回到内置演示数据。"
          : "只清除 source=offeru-demo 且 batch_id=offeru-demo-v1 的明确合成数据；不会删除 Profile、真实岗位、简历、备份或连接信息。"}
      >
        <SettingsItem icon={<FlaskConical size={16} />} label="重置 Demo 数据" description="重置演示数据与删除真实数据是两件事">
          <button
            type="button"
            className="ou-text-button"
            data-testid="reset-demo"
            disabled={action === "reset_demo"}
            onClick={() => {
              setDemoConfirmationText("");
              setDemoResetOpen(true);
            }}
          >
            重置…
          </button>
        </SettingsItem>
        {SHOWCASE && (
          <div data-testid="demo-data-sync">
            <SettingsItem label="数据包、备份与多设备同步" description="导出 JSON 数据包，或通过 WebDAV 整包上传 / 下载；导入和同步都会整包覆盖，不自动合并。">
              <button type="button" className="ou-text-button" onClick={() => setDemoDataOpen(true)}>数据包 / 同步</button>
              <button type="button" className="ou-text-button" onClick={() => setDemoBridgeOpen(true)}>连接本机 OfferU</button>
            </SettingsItem>
          </div>
        )}
      </SettingsGroup>

      {!SHOWCASE && privacyHygiene && (
        <SettingsGroup label="隐私卫生" testId="privacy-hygiene"
          note="这里只显示计数，不会读取或展示邮件正文。清理只移除已完成结构化解析的冗余正文，保留面试通知的结构化字段；不可恢复。"
        >
          <SettingsItem
            icon={<ShieldCheck size={16} />}
            label={legacyEmailBodyCount ? `有 ${legacyEmailBodyCount} 条历史邮件正文待处理` : "没有待清理的历史邮件正文"}
            description={[
              legacyEmailBodyCount ? `共 ${legacyEmailBodyCharacters} 个字符` : "",
              syntheticEmailDataCount ? `另有 ${syntheticEmailDataCount} 条合成邮箱测试数据可单独清理` : "",
            ].filter(Boolean).join("；") || undefined}
          >
            {!legacyEmailBodyCount && !syntheticEmailDataCount && <Pill tone="green">干净</Pill>}
            {legacyEmailBodyCount > 0 && (
              <button
                type="button"
                className="ou-text-button"
                data-tone="danger"
                data-testid="scrub-legacy-email-bodies"
                disabled={action === "privacy_scrub"}
                onClick={() => {
                  setPrivacyConfirmationText("");
                  setPrivacyScrubOpen(true);
                }}
              >
                清理旧邮件正文
              </button>
            )}
            {syntheticEmailDataCount > 0 && (
              <button
                type="button"
                className="ou-text-button"
                data-tone="danger"
                data-testid="purge-synthetic-email-data"
                disabled={action === "privacy_purge_synthetic"}
                onClick={() => {
                  setSyntheticConfirmationText("");
                  setSyntheticPurgeOpen(true);
                }}
              >
                清理合成邮箱数据
              </button>
            )}
          </SettingsItem>
        </SettingsGroup>
      )}

      <ConfirmDialog
        open={isOpen}
        onClose={onClose}
        title="确认恢复本地数据"
        warning="当前运行中的数据不会立刻改变。OfferU 会校验并暂存备份；下次启动前先创建恢复前备份，再替换 SQLite 与受管资产。恢复失败会自动回滚并停止启动。"
        detail={`备份：${selectedBackup?.backup_id ?? ""}`}
        phrase="恢复"
        value={confirmationText}
        onValueChange={setConfirmationText}
        busy={action === "restore"}
        confirmLabel="暂存并在重启时恢复"
        onConfirm={() => void stageRestore()}
      />

      <ConfirmDialog
        open={demoResetOpen}
        onClose={() => setDemoResetOpen(false)}
        title="确认重置 Demo 工作区"
        warning="只处理明确标记的合成数据。不会调用真实岗位删除接口，也不会删除你的 Profile、真实岗位、简历、备份或连接凭据。展示模式只清除独立的 Showcase IndexedDB。"
        phrase="重置 Demo"
        value={demoConfirmationText}
        onValueChange={setDemoConfirmationText}
        busy={action === "reset_demo"}
        confirmLabel="确认重置 Demo"
        confirmTestId="confirm-reset-demo"
        onConfirm={() => void resetDemo()}
      />

      <DemoDataDialog open={demoDataOpen} onClose={() => setDemoDataOpen(false)} />
      <DemoBridgeDialog open={demoBridgeOpen} onClose={() => setDemoBridgeOpen(false)} />

      <ConfirmDialog
        open={privacyScrubOpen}
        onClose={() => setPrivacyScrubOpen(false)}
        title="确认清理历史邮件正文"
        warning="这会清空已完成结构化解析的旧面试通知正文，但保留通知时间、岗位关联和结构化状态。正文不会进入备份恢复，也不能在清理后恢复。OfferU 不会展示待清理正文内容。"
        detail={`待处理：${legacyEmailBodyCount} 条记录 · ${legacyEmailBodyCharacters} 个字符`}
        phrase="清理旧正文"
        value={privacyConfirmationText}
        onValueChange={setPrivacyConfirmationText}
        busy={action === "privacy_scrub"}
        confirmLabel="确认清理"
        onConfirm={() => void scrubLegacyEmailBodies()}
      />

      <ConfirmDialog
        open={syntheticPurgeOpen}
        onClose={() => setSyntheticPurgeOpen(false)}
        title="确认清理合成邮箱测试数据"
        warning="只会处理 OfferU 保留的合成邮箱测试账号、同步运行、信号、候选和本机凭据引用。若它们已经关联正式时间线，系统会拒绝清理；真实邮箱、岗位和投递状态不会被处理。"
        detail={`待处理：${syntheticEmailDataCount} 条合成邮箱测试数据`}
        phrase="清理合成邮箱"
        value={syntheticConfirmationText}
        onValueChange={setSyntheticConfirmationText}
        busy={action === "privacy_purge_synthetic"}
        confirmLabel="确认清理"
        onConfirm={() => void purgeSyntheticEmailTestData()}
      />
    </>
  );
}

/** 不可撤销操作的确认：一段说明 + 输入确认词，确认按钮是浅红底，不是墨黑主按钮。 */
function ConfirmDialog({
  open,
  onClose,
  title,
  warning,
  detail,
  phrase,
  value,
  onValueChange,
  busy,
  confirmLabel,
  confirmTestId,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  warning: string;
  detail?: string;
  phrase: string;
  value: string;
  onValueChange: (value: string) => void;
  busy: boolean;
  confirmLabel: string;
  confirmTestId?: string;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button className="ou-settings-danger" data-testid={confirmTestId} disabled={value !== phrase || busy} onClick={onConfirm}>
            {busy ? "处理中…" : confirmLabel}
          </Button>
        </>
      }
    >
      <div className="mt-4 flex flex-col gap-4">
        <p className="ou-settings-callout" data-tone="yellow">{warning}</p>
        {detail && <p className="ou-settings-status">{detail}</p>}
        <Field label={`输入“${phrase}”以继续`}>
          {(id) => <Input id={id} value={value} onChange={(event) => onValueChange(event.target.value)} autoFocus autoComplete="off" />}
        </Field>
      </div>
    </Dialog>
  );
}

function LocalFeedbackCard() {
  const [note, setNote] = useState("");
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    const trimmed = note.trim();
    if (!trimmed) {
      setFeedback({ type: "error", message: "请先描述遇到的问题。" });
      return;
    }
    setExporting(true);
    setFeedback(null);
    try {
      let backendDiagnostics: Awaited<ReturnType<typeof diagnosticsApi.bundle>> | null = null;
      let backendDiagnosticsStatus: "included" | "showcase" | "unavailable" = SHOWCASE ? "showcase" : "unavailable";
      let backendErrorId = "";
      if (!SHOWCASE) {
        try {
          backendDiagnostics = await diagnosticsApi.bundle();
          backendDiagnosticsStatus = "included";
        } catch (error) {
          const errorId = safeClientErrorMessage(error, "").match(/err_[a-f0-9]{16}/)?.[0];
          backendErrorId = errorId || "";
        }
      }
      const safeNote = redactFeedbackText(trimmed);
      const payload = {
        schema_version: "offeru.internal-beta.feedback.v2",
        created_at: new Date().toISOString(),
        current_page: window.location.hash || "#/",
        app_version: `frontend@${import.meta.env.VITE_APP_VERSION || "unknown"}`,
        build_mode: import.meta.env.MODE || "unknown",
        runtime_mode: import.meta.env.VITE_SHOWCASE === "true" ? "showcase" : "local",
        user_note: safeNote,
        note_redacted: safeNote !== trimmed,
        diagnostics: {
          user_agent: navigator.userAgent,
          language: navigator.language,
          viewport: `${window.innerWidth}x${window.innerHeight}`,
        },
        backend_diagnostics_status: backendDiagnosticsStatus,
        backend_error_id: backendErrorId || undefined,
        backend: backendDiagnostics,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const stamp = new Date().toISOString().replace(/[T:.Z]/g, "-").replace(/-+$/, "");
      anchor.href = url;
      anchor.download = `offeru-feedback-${stamp}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
      setFeedback({ type: "success", message: "诊断包已下载。请确认其中没有你不想分享的文字后再发送。" });
    } finally {
      setExporting(false);
    }
  };

  return (
    <SettingsGroup
      testId="local-feedback"
      note="只生成本地诊断包：当前页面、版本、构建模式、你的描述和最近的脱敏错误关联信息。不会自动上传，也不附带 Profile、岗位正文或 Provider 密钥。"
    >
      <div className="ou-settings-item-body p-4">
        <Field label="问题描述">
          {(id) => (
            <textarea
              id={id}
              className="ou-input ou-settings-textarea"
              placeholder="例如：保存岗位后，Today 没有出现岗位情报。"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={4}
              data-testid="feedback-note"
            />
          )}
        </Field>
        <div className="ou-sync-footer">
          {feedback && (
            <p role={feedback.type === "error" ? "alert" : "status"} className={feedback.type === "error" ? "ou-settings-error mr-auto" : "ou-settings-status mr-auto"}>
              {feedback.message}
            </p>
          )}
          <Button variant="primary" onClick={() => void handleExport()} disabled={exporting}>
            <MessageSquare size={14} aria-hidden="true" /> {exporting ? "生成中…" : "下载问题诊断包"}
          </Button>
        </div>
      </div>
    </SettingsGroup>
  );
}

function redactFeedbackText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(\b(?:api[_-]?(?:key|token)|auth[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret|credential|cookie|authorization|token)\b\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}\]]+)/gi, "$1[redacted]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted email]")
    .replace(/(?<![\w])(?:\+?\d[\d\s().-]{7,}\d)(?![\w])/g, "[redacted phone]");
}

export default function SettingsPage() {
  const { data, mutate } = useConfig();
  const config = data as SettingsConfigPayload | undefined;
  const searchParams = useSearchParams();
  const router = useRouter();
  const rootRef = useRef<HTMLDivElement>(null);
  const wide = useContainerWide(rootRef, SPLIT_MIN_WIDTH);
  const sections = SECTIONS.filter((item) => !(SHOWCASE && item.key === "collect"));
  const requested = sections.find((item) => item.key === searchParams.get("section"))?.key ?? null;
  // 宽屏总有一项在右侧打开（默认第一项）；窄屏没有选中就是目录。
  const active: SectionKey | null = requested ?? (wide ? sections[0].key : null);
  const pushed = useRef(false);
  const openSection = (key: SectionKey) => {
    if (wide) {
      router.replace("/settings?section=" + key);
    } else {
      pushed.current = true;
      router.push("/settings?section=" + key);
    }
  };
  const closeSection = () => {
    if (pushed.current) {
      pushed.current = false;
      router.back();
    } else {
      router.replace("/settings");
    }
  };
  useEffect(() => {
    if (!wide) rootRef.current?.closest("main")?.scrollTo({ top: 0 });
  }, [active, wide]);
  const syncSummary = useSyncSummary();
  const mailSummary = useMailSummary();
  const agentState = useAgentConnection();
  const agentStatus = agentState.connection?.connection_verified && agentState.connection.status === "ready"
    ? agentState.connection.name + " · 已验证"
    : "未连接";
  const llmTransport = useLlmTransportMode(LOCAL_WEB);
  const modelStatus = config?.active_llm_summary?.model
    ? [config.active_llm_summary.service_name, config.active_llm_summary.model].filter(Boolean).join(" · ")
    : "未配置";

  const [apiSaving, setApiSaving] = useState(false);
  const [apiSaved, setApiSaved] = useState(false);
  const [apiSaveError, setApiSaveError] = useState("");
  const [apiDirty, setApiDirty] = useState(false);


  const [providerPresets, setProviderPresets] = useState<ProviderPreset[]>([]);
  const [providerPresetError, setProviderPresetError] = useState("");
  const [apiConfigs, setApiConfigs] = useState<LlmApiConfig[]>([]);
  const [disabledProviders, setDisabledProviders] = useState<string[]>([]);
  const [selectedConfigId, setSelectedConfigId] = useState("");
  const [listFeedback, setListFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const [isEditorOpen, setEditorOpen] = useState(false);
  const onEditorOpen = () => setEditorOpen(true);
  const onEditorClose = () => setEditorOpen(false);
  const [isDeleteOpen, setDeleteOpen] = useState(false);
  const onDeleteOpen = () => setDeleteOpen(true);
  const onDeleteClose = () => setDeleteOpen(false);

  const [editingConfigId, setEditingConfigId] = useState<string | null>(null);
  const [formProviderChoice, setFormProviderChoice] = useState<string>("");
  const [formCustomServiceName, setFormCustomServiceName] = useState("");
  const [formCustomModel, setFormCustomModel] = useState("");
  const [formBaseUrl, setFormBaseUrl] = useState("");
  const [formApiKey, setFormApiKey] = useState("");
  const [formIsActive, setFormIsActive] = useState<boolean>(false);
  const [showFormApiKey, setShowFormApiKey] = useState(false);
  const [editorAdvanced, setEditorAdvanced] = useState(false);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  const selectedConfig = useMemo(
    () => apiConfigs.find((item) => item.id === selectedConfigId) || null,
    [apiConfigs, selectedConfigId]
  );

  const currentFormPreset = useMemo(
    () => providerPresets.find((preset) => preset.id === formProviderChoice),
    [providerPresets, formProviderChoice]
  );

  const resolvedFormServiceName = useMemo(() => {
    if (formCustomServiceName.trim()) return formCustomServiceName.trim();
    try { return new URL(formBaseUrl).hostname; } catch { return ""; }
  }, [formCustomServiceName, formBaseUrl]);

  const resolvedFormProviderId = useMemo(() => {
    return normalizeProviderId(resolvedFormServiceName || "custom");
  }, [resolvedFormServiceName]);

  const resolvedFormModel = useMemo(() => formCustomModel.trim(), [formCustomModel]);

  const resolvedFormBaseUrl = useMemo(() => formBaseUrl.trim(), [formBaseUrl]);

  const validateEditorForm = (): Record<string, string> => {
    const errors: Record<string, string> = {};
    if (!currentFormPreset || !["openai", "anthropic"].includes(currentFormPreset.api_format || "")) {
      errors.api_format = "请选择有效的接口协议";
    }
    if (!resolvedFormServiceName) {
      errors.service_name = "服务名称不能为空";
    }

    if (!resolvedFormModel) {
      errors.model = "模型名称不能为空";
    }

    if (!resolvedFormBaseUrl) {
      errors.base_url = "接口地址不能为空";
    } else if (!/^https?:\/\//i.test(resolvedFormBaseUrl)) {
      errors.base_url = "接口地址需以 http:// 或 https:// 开头";
    }

    if (!isLocalEndpoint(resolvedFormBaseUrl)) {
      if (!formApiKey.trim()) {
        errors.api_key = "访问密钥不能为空";
      }

      if (!editingConfigId && formApiKey.includes("*")) {
        errors.api_key = "新增配置时不能使用脱敏密钥";
      }

    }

    return errors;
  };

  useEffect(() => {
    if (!isEditorOpen || Object.keys(formErrors).length === 0) return;
    setFormErrors(validateEditorForm());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isEditorOpen,
    formProviderChoice,
    formCustomServiceName,
    formCustomModel,
    formBaseUrl,
    formApiKey,
    formIsActive,
  ]);

  useEffect(() => {
    if (!config) return;

    const presets = Array.isArray(config.provider_presets) ? config.provider_presets : [];
    setProviderPresets(presets);
    setProviderPresetError(presets.length ? "" : "后端未返回可用的模型配置模板，请检查本地后端并重试。 ");

    const incoming = Array.isArray(config.llm_api_configs) ? config.llm_api_configs : [];
    const normalized = incoming
      .map((item) => ({
        id: item.id || createConfigId(),
        provider_id: normalizeProviderId(item.provider_id || item.service_name || "custom"),
        service_name: (item.service_name || item.provider_id || "Custom").trim(),
        model: (item.model || "").trim(),
        base_url: normalizeBaseUrl(item.base_url || ""),
        api_key: item.api_key || "",
        is_active: Boolean(item.is_active),
        extra_params: item.extra_params || {},
        api_format: String(item.api_format || ""),
        credential_ref: item.credential_ref || "",
        models: item.models || {},
        default_headers: item.default_headers || {},
        supports_json_mode: item.supports_json_mode !== false,
        icon: item.icon || "",
        website_url: item.website_url || "",
        notes: item.notes || "",
      }))
      .filter((item) => item.service_name && item.model && item.base_url);

    setApiConfigs(normalized);

    setDisabledProviders(
      Array.isArray(config.disabled_llm_providers) ? config.disabled_llm_providers : []
    );

    const activeIdFromServer = config.active_llm_config_id || "";
    const fallbackSelected = normalized.find((item) => item.is_active)?.id || normalized[0]?.id || "";
    setSelectedConfigId(activeIdFromServer || fallbackSelected);

    setApiDirty(false);
    setApiSaved(false);
    setApiSaveError("");
  }, [config]);

  const markApiDirty = () => {
    setApiDirty(true);
    setApiSaved(false);
    setApiSaveError("");
  };

  const openCreateEditor = () => {
    const defaultPreset = providerPresets[0];
    if (!defaultPreset) return;

    setEditingConfigId(null);
    setFormProviderChoice(defaultPreset.id);
    setFormCustomServiceName("");
    setFormCustomModel("");
    setFormBaseUrl("");
    setFormApiKey("");
    setFormIsActive(apiConfigs.length === 0);
    setShowFormApiKey(false);
    setFormErrors({});
    setListFeedback(null);
    onEditorOpen();
  };

  const openEditEditor = (configItem: LlmApiConfig) => {
    setEditingConfigId(configItem.id);
    setFormProviderChoice(
      configItem.api_format === "anthropic"
        ? "anthropic-compatible"
        : configItem.api_format === "openai"
          ? "openai-compatible"
          : configItem.api_format || ""
    );
    setFormCustomServiceName(configItem.service_name);

    setFormCustomModel(configItem.model);
    setFormBaseUrl(configItem.base_url);
    setFormApiKey(configItem.api_key);
    setFormIsActive(configItem.is_active);
    setShowFormApiKey(false);
    setFormErrors({});
    setListFeedback(null);
    onEditorOpen();
  };

  const handleActivateConfig = (targetId: string) => {
    setApiConfigs((prev) => prev.map((item) => ({ ...item, is_active: item.id === targetId })));
    setSelectedConfigId(targetId);
    markApiDirty();
    setListFeedback({ type: "success", message: "已切换激活配置，请点击“保存模型配置”提交" });
  };

  const handleSubmitEditor = async () => {
    const errors = validateEditorForm();
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) {
      setListFeedback({ type: "error", message: "请先修正表单错误后再保存" });
      return;
    }

    const previous = editingConfigId ? apiConfigs.find((item) => item.id === editingConfigId) : null;
    const nextProviderId = previous?.provider_id || resolvedFormProviderId;
    const nextConfig: LlmApiConfig = {
      ...(previous || {}),
      id: editingConfigId || createConfigId(),
      provider_id: nextProviderId,
      service_name: resolvedFormServiceName,
      model: resolvedFormModel,
      base_url: normalizeBaseUrl(resolvedFormBaseUrl),
      api_key: formApiKey.trim(),
      is_active: formIsActive,
      extra_params: previous?.extra_params || {},
      api_format: currentFormPreset?.api_format || previous?.api_format || "",
      credential_ref: previous?.credential_ref || "",
      models: previous?.models || {},
      default_headers: previous?.default_headers || {},
      supports_json_mode: previous?.supports_json_mode !== false,
      icon: previous?.icon || "",
      website_url: previous?.website_url || "",
      notes: previous?.notes || "",
    };

    let next = editingConfigId
      ? apiConfigs.map((item) => item.id === editingConfigId ? nextConfig : item)
      : [...apiConfigs, nextConfig];
    if (nextConfig.is_active || !next.some((item) => item.is_active)) {
      next = next.map((item) => ({ ...item, is_active: item.id === nextConfig.id }));
    }
    if (await handleSaveApiSettings(next)) onEditorClose();
  };

  const handleDeleteConfig = () => {
    if (!selectedConfig) return;

    setApiConfigs((prev) => {
      const filtered = prev.filter((item) => item.id !== selectedConfig.id);
      if (filtered.length === 0) {
        setSelectedConfigId("");
        return filtered;
      }

      if (!filtered.some((item) => item.is_active)) {
        filtered[0] = { ...filtered[0], is_active: true };
      }
      setSelectedConfigId(filtered[0].id);
      return filtered;
    });

    onDeleteClose();
    markApiDirty();
    setListFeedback({ type: "success", message: "配置已删除，请点击“保存模型配置”提交" });
  };

  const handleSaveApiSettings = async (configs = apiConfigs) => {
    setApiSaving(true);
    setApiSaveError("");
    setListFeedback(null);

    const { normalizedConfigs, activeConfig } = normalizeApiConfigsForSave(configs);

    const getProviderConfig = (providerId: string) =>
      normalizedConfigs.find((item) => item.provider_id === providerId) || null;

    const deepseekConfig = getProviderConfig("deepseek");
    const openaiConfig = getProviderConfig("openai");
    const qwenConfig = getProviderConfig("qwen");
    const siliconflowConfig = getProviderConfig("siliconflow");
    const geminiConfig = getProviderConfig("gemini");
    const zhipuConfig = getProviderConfig("zhipu");
    const ollamaConfig = getProviderConfig("ollama");

    try {
      await updateConfig({
        llm_api_configs: normalizedConfigs,
        active_llm_config_id: activeConfig?.id || "",
        disabled_llm_providers: disabledProviders,
        llm_provider: activeConfig?.provider_id || "",
        llm_model: activeConfig?.model || "",
        active_llm_base_url: activeConfig?.base_url || "",
        active_llm_api_key: activeConfig?.api_key || "",

        deepseek_api_key: deepseekConfig?.api_key || "",
        openai_api_key: openaiConfig?.api_key || "",
        qwen_api_key: qwenConfig?.api_key || "",
        siliconflow_api_key: siliconflowConfig?.api_key || "",
        gemini_api_key: geminiConfig?.api_key || "",
        zhipu_api_key: zhipuConfig?.api_key || "",
        ollama_base_url: toLegacyOllamaBaseUrl(ollamaConfig?.base_url || "http://localhost:11434/v1"),
      });

      await mutate();
      setApiConfigs(normalizedConfigs);
      setSelectedConfigId(activeConfig?.id || "");
      setApiSaved(true);
      setApiDirty(false);
      setTimeout(() => setApiSaved(false), 2000);
      setListFeedback({
        type: "success",
        message: normalizedConfigs.length > 0 ? "模型配置已保存" : "模型配置已清空并保存",
      });
      return true;
    } catch (error) {
      setApiSaveError(safeClientErrorMessage(error, "模型配置保存失败，请稍后重试"));
      return false;
    } finally {
      setApiSaving(false);
    }
  };

  const statusOf: Record<SectionKey, string | undefined> = {
    agent: agentStatus,
    models: modelStatus,
    mail: mailSummary,
    accounts: SHOWCASE ? "求职来源" : "BOSS 与求职来源",
    collect: "风险说明与同意",
    data: syncSummary,
    about: `v${import.meta.env.VITE_APP_VERSION || "—"}`,
    feedback: undefined,
  };
  const groups = sections.reduce<Array<{ name: string; items: typeof sections }>>((all, item) => {
    const last = all[all.length - 1];
    if (last && last.name === item.group) last.items.push(item);
    else all.push({ name: item.group, items: [item] });
    return all;
  }, []);

  const modelSection = (
    <>
      <SettingsGroup
        label="模型连接"
        testId="embedded-model-settings"
        note={
          <>
            {apiDirty ? "配置有未保存的修改。" : "密钥只保存在系统钥匙串。"}
            {LOCAL_WEB && (
              <span data-testid="llm-transport-mode" title={llmTransport === "extension" ? "不支持跨域的模型服务由 OfferU 浏览器扩展直接请求" : "不支持跨域的模型服务经 OfferU 服务器转发（不保存内容）；安装 OfferU 浏览器扩展可直连"}>
                {" "}跨域通道：{llmTransport === "extension" ? "直连（扩展）" : "代理"}
              </span>
            )}
          </>
        }
      >
        {providerPresetError && <p role="alert" className="ou-settings-callout mx-4 my-3" data-tone="red">{providerPresetError}</p>}
        {config?.vault_status && !config.vault_status.available && <p role="alert" className="ou-settings-callout mx-4 my-3" data-tone="red">系统钥匙串不可用，密钥无法保存：{config.vault_status.error}</p>}
        {apiConfigs.length === 0 ? (
          <SettingsItem icon={<Cpu size={16} />} label="还没有连接模型服务" description="添加接口地址和密钥后，会自动获取模型列表。" />
        ) : apiConfigs.map((item) => (
          <SettingsItem
            key={item.id}
            icon={<Cpu size={16} />}
            label={
              <span className="flex flex-wrap items-center gap-2">
                {item.service_name}
                {item.is_active && <Pill tone="green">当前使用</Pill>}
                {disabledProviders.includes(item.provider_id) && <Pill tone="red">已禁用</Pill>}
              </span>
            }
            description={<span className="break-all">{item.model} · {item.base_url}</span>}
          >
            {!item.is_active && <button type="button" className="ou-text-button" onClick={() => handleActivateConfig(item.id)}>使用</button>}
            <button type="button" className="ou-text-button" onClick={() => openEditEditor(item)}>编辑</button>
            <button type="button" className="ou-text-button" data-tone="danger" onClick={() => { setSelectedConfigId(item.id); onDeleteOpen(); }}>删除</button>
          </SettingsItem>
        ))}
        {config?.active_llm_summary?.model && (
          <SettingsItem label="已保存" description={`${config.active_llm_summary.service_name} · ${config.active_llm_summary.model}`}>
            <TestLlmButton />
          </SettingsItem>
        )}
        <div className="ou-settings-actions ou-settings-actions--end px-4 pb-3 pt-1">
          {listFeedback && <p role="status" className={`mr-auto ${listFeedback.type === "error" ? "ou-settings-error" : "ou-settings-status"}`}>{listFeedback.message}</p>}
          {apiDirty ? (
            <>
              <button type="button" className="ou-text-button" onClick={openCreateEditor} disabled={!providerPresets.length}>
                <Plus size={14} aria-hidden="true" /> 添加
              </button>
              <Button variant="primary" disabled={apiSaving} onClick={() => void handleSaveApiSettings()}>
                {apiSaving ? "保存中…" : "保存模型配置"}
              </Button>
            </>
          ) : (
            <Button variant="primary" onClick={openCreateEditor} disabled={!providerPresets.length}>
              <Plus size={14} aria-hidden="true" /> 添加模型服务
            </Button>
          )}
        </div>
        {apiSaveError && !isEditorOpen && <p role="alert" className="ou-settings-error px-4 pb-3">{apiSaveError}</p>}
      </SettingsGroup>

      <SettingsGroup label="运行">
        <AgentConcurrencySetting
          value={config?.max_concurrent_agent_runs ?? 3}
          onSave={async (next) => {
            await updateConfig({ max_concurrent_agent_runs: next });
            await mutate();
          }}
        />
        <AgentFallbackSetting
          enabled={config?.llm_fallback_to_agent ?? false}
          onSave={async (next) => {
            await updateConfig({ llm_fallback_to_agent: next });
            await mutate();
          }}
        />
      </SettingsGroup>
    </>
  );

  const renderDetail = (key: SectionKey): ReactNode => {
    switch (key) {
      case "agent":
        return <AgentConnectionPanel embedded />;
      case "models":
        return modelSection;
      case "mail":
        return <MailSettingsPanel />;
      case "accounts":
        return (
          <>
            {!SHOWCASE && <BossLoginCard />}
            <JobSourceConnectionsCard />
          </>
        );
      case "collect":
        return <PlatformConsentCard />;
      case "data":
        return (
          <>
            {(LOCAL_WEB || SHOWCASE) && <StoragePersistenceCard />}
            <SyncSettingsPanel />
            <LocalDataSafetyCard />
            {!SHOWCASE && <DangerZone />}
          </>
        );
      case "about":
        return (
          <>
            <BuildIdentityPanel />
            <HintsSetting />
          </>
        );
      case "feedback":
        return <LocalFeedbackCard />;
    }
  };

  const meta = active ? sections.find((item) => item.key === active) : undefined;

  const detail = meta && (
    <>
      {wide ? (
        <header className="ou-settings-detail-head">
          <h2 className="ou-settings-detail-title">{meta.title}</h2>
          <p className="ou-settings-detail-desc">{meta.description}</p>
        </header>
      ) : (
        <>
          <div className="ou-settings-topbar">
            <button type="button" className="ou-settings-back" onClick={closeSection} data-testid="settings-back">
              <ChevronLeft size={20} aria-hidden="true" /> 设置
            </button>
            <h2 className="ou-settings-topbar-title">{meta.title}</h2>
            <span aria-hidden="true" />
          </div>
          <p className="ou-settings-detail-desc px-4 pb-4">{meta.description}</p>
        </>
      )}
      <div className="ou-settings-detail-body" data-testid={`settings-detail-${meta.key}`}>{renderDetail(meta.key)}</div>
    </>
  );

  const description = SHOWCASE ? "展示版默认用示例数据；在「数据」里导出、同步或连接本机 OfferU。" : "Agent 连接、模型服务和数据安全。";

  return (
    <div ref={rootRef} className="ou-settings">
      {wide ? (
        <>
          <PageHeader title="设置" description={description} />
          <div className="ou-settings-split mt-6">
            <nav className="ou-settings-nav" aria-label="设置分类">
              <LayoutGroup id="settings-nav">
                {groups.map((group) => (
                  <SettingsGroup key={group.name} label={group.name}>
                    {group.items.map((item) => (
                      <SettingsRow key={item.key} rowKey={item.key} variant="nav" title={item.title} status={statusOf[item.key]} icon={item.icon} selected={item.key === active} onOpen={() => openSection(item.key)} />
                    ))}
                  </SettingsGroup>
                ))}
              </LayoutGroup>
            </nav>
            <div className="ou-settings-detail ou-settings-stage">
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.div
                  key={active}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ y: { type: "spring", stiffness: 420, damping: 40 }, opacity: { duration: 0.18 } }}
                >
                  {detail}
                </motion.div>
              </AnimatePresence>
            </div>
          </div>
        </>
      ) : (
        <div className="ou-settings-stage">
          <AnimatePresence mode="popLayout" initial={false} custom={active ? 1 : -1}>
            {active ? (
              <motion.div key={`detail-${active}`} custom={1} variants={pushVariants} initial="enter" animate="center" exit="exit" transition={pushTransition}>
                {detail}
              </motion.div>
            ) : (
              <motion.div key="index" custom={-1} variants={pushVariants} initial="enter" animate="center" exit="exit" transition={pushTransition} className="flex flex-col gap-6">
                <PageHeader title="设置" description={description} />
                {groups.map((group) => (
                  <SettingsGroup key={group.name} label={group.name}>
                    {group.items.map((item) => (
                      <SettingsRow key={item.key} rowKey={item.key} title={item.title} status={statusOf[item.key]} icon={item.icon} onOpen={() => openSection(item.key)} />
                    ))}
                  </SettingsGroup>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      <Dialog
        open={isEditorOpen}
        onOpenChange={(next) => { if (!next) onEditorClose(); }}
        title={editingConfigId ? "编辑模型配置" : "新增模型配置"}
        description="填写接口地址和密钥后，选择自动获取的模型；服务不提供列表时，可手动填写模型 ID。"
        className="ou-settings-editor"
        footer={
          <>
            <Button variant="ghost" onClick={onEditorClose}>取消</Button>
            <Button variant="primary" disabled={apiSaving} onClick={() => void handleSubmitEditor()}>
              {apiSaving ? "连接中…" : "保存并连接"}
            </Button>
          </>
        }
      >
        <div className="mt-5 flex flex-col gap-4">
          <Field label="接口地址" error={formErrors.base_url}>
            {(id) => <Input id={id} value={formBaseUrl} onChange={(event) => setFormBaseUrl(event.target.value)} placeholder="https://你的服务地址/v1" type="url" autoComplete="off" spellCheck={false} aria-invalid={Boolean(formErrors.base_url)} />}
          </Field>
          <Field label="API 密钥" error={formErrors.api_key}>
            {(id) => (
              <div className="flex items-center gap-2">
                <Input
                  id={id}
                  autoComplete="off"
                  spellCheck={false}
                  value={formApiKey}
                  onChange={(event) => setFormApiKey(event.target.value)}
                  placeholder={isLocalEndpoint(formBaseUrl) ? "本地端点可留空" : "API key 或 env:VAR_NAME"}
                  type={showFormApiKey ? "text" : "password"}
                  aria-invalid={Boolean(formErrors.api_key)}
                />
                <button
                  type="button"
                  onClick={() => setShowFormApiKey((prev) => !prev)}
                  className="ou-icon-button"
                  aria-label={showFormApiKey ? "隐藏访问密钥" : "显示访问密钥"}
                  aria-pressed={showFormApiKey}
                >
                  {showFormApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            )}
          </Field>

          <ModelPicker key={editingConfigId || "new"} baseUrl={formBaseUrl} apiKey={formApiKey} apiFormat={currentFormPreset?.api_format || ""} configId={editingConfigId || ""} value={formCustomModel} onChange={setFormCustomModel} error={formErrors.model} />

          <div>
            <button
              type="button"
              className="ou-text-button ou-disclosure-trigger -ml-2"
              aria-expanded={editorAdvanced || Boolean(formErrors.api_format || formErrors.service_name)}
              onClick={() => setEditorAdvanced((value) => !value)}
            >
              接口协议与显示名称
              <ChevronRight size={14} aria-hidden="true" className="ou-disclosure-chevron" />
            </button>
            <DisclosurePanel open={editorAdvanced || Boolean(formErrors.api_format || formErrors.service_name)}>
              <div className="ou-sync-advanced mt-2">
                <Field label="接口协议" error={formErrors.api_format}>
                  {(id) => <UiSelect id={id} value={formProviderChoice} onValueChange={setFormProviderChoice}
                    options={providerPresets.map((preset) => ({ value: preset.id, label: preset.name }))} />}
                </Field>
                <Field label="显示名称（可选）" hint="默认使用接口的域名" error={formErrors.service_name}>
                  {(id) => <Input id={id} value={formCustomServiceName} onChange={(event) => setFormCustomServiceName(event.target.value)} />}
                </Field>
              </div>
            </DisclosurePanel>
          </div>

          <label className="ou-sync-pathstyle">
            <span className="text-[var(--ou-text-primary)]">设为当前激活配置</span>
            <Switch checked={formIsActive} onCheckedChange={setFormIsActive} aria-label="设为当前激活配置" />
          </label>
          {apiSaveError && <p role="alert" className="ou-settings-error">{apiSaveError}</p>}
        </div>
      </Dialog>

      <Dialog
        open={isDeleteOpen}
        onOpenChange={(next) => { if (!next) onDeleteClose(); }}
        title="删除模型配置"
        description={`确定删除“${selectedConfig?.service_name || "未命名配置"}”吗？删除后需要点「保存模型配置」才会生效。`}
        footer={
          <>
            <Button variant="ghost" onClick={onDeleteClose}>取消</Button>
            <Button className="ou-settings-danger" onClick={handleDeleteConfig}>删除</Button>
          </>
        }
      />
    </div>
  );
}

/** 关于 › 界面提示：标题旁的「?」显示与否。 */
function HintsSetting() {
  const [enabled, setEnabled] = useHintsEnabled();
  return (
    <SettingsGroup label="界面" testId="hints-toggle">
      <SettingsItem icon={<Info size={16} />} label="显示界面提示" htmlFor="settings-hints" description="标题旁的小「?」只在你需要时展开，熟悉之后可以全部隐藏。">
        <Switch id="settings-hints" checked={enabled} onCheckedChange={setEnabled} aria-label="显示界面提示" />
      </SettingsItem>
    </SettingsGroup>
  );
}

/** 数据 › 危险操作：默认收起，展开后才是全清面板。 */
function DangerZone() {
  const [open, setOpen] = useState(false);
  return (
    <SettingsGroup label="危险操作">
      <div className="ou-settings-item">
        <span className="ou-tile" aria-hidden="true"><TriangleAlert size={16} /></span>
        <div className="ou-settings-item-text">
          <span className="ou-settings-item-label">全清并重新开始</span>
          <span className="ou-settings-item-desc">先自动备份，再清空职业工作区，回到空白首次建档。</span>
        </div>
        <div className="ou-settings-item-control">
          <button type="button" className="ou-text-button ou-disclosure-trigger" data-tone="danger" aria-expanded={open} aria-controls="fresh-reset" onClick={() => setOpen((value) => !value)}>
            {open ? "收起" : "展开"}
            <ChevronRight size={14} aria-hidden="true" className="ou-disclosure-chevron" />
          </button>
        </div>
      </div>
      <DisclosurePanel open={open} id="fresh-reset">
        <FreshResetPanel />
      </DisclosurePanel>
    </SettingsGroup>
  );
}
