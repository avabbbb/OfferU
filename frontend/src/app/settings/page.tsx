"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  Autocomplete,
  AutocompleteItem,
  Button,
  Card,
  CardBody,
  Checkbox,
  Chip,
  Divider,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Switch,
  Textarea,
  useDisclosure,
} from "@nextui-org/react";
import {
  AlertCircle,
  Check,
  Cookie,
  Database,
  Download,
  Eye,
  EyeOff,
  Key,
  MessageSquare,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  ShieldCheck,
  SquarePen,
  Trash2,
} from "lucide-react";
import {
  agentRuntimeApi,
  dataSafetyApi,
  diagnosticsApi,
  type AgentProviderHealth,
  type DataBackupItem,
  type DataIntegrityReport,
  type DataSafetyStatus,
} from "@/lib/api";
import { SHOWCASE } from "@/lib/showcase/router";
import { useConfig, updateConfig } from "@/lib/hooks";

interface ProviderModelPreset {
  id: string;
  name: string;
  description?: string;
}

interface ProviderPreset {
  id: string;
  name: string;
  description?: string;
  default_base_url: string;
  models: ProviderModelPreset[];
  key_prefix?: string;
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
}

interface SelectOption {
  id: string;
  label: string;
  description?: string;
}

interface SettingsConfigPayload {
  search_keywords?: string[];
  search_locations?: string[];
  banned_keywords?: string[];
  top_n?: number;
  email_to?: string;
  sources_enabled?: string[];
  profile_source_sync_enabled?: boolean;

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
  provider_presets?: ProviderPreset[];

  active_llm_summary?: {
    provider_id: string;
    service_name: string;
    model: string;
    base_url: string;
    source: "active_config" | "legacy_env" | "ollama";
  };

  boss_cookie?: string;
  zhilian_cookie?: string;
}

const CUSTOM_OPTION = "__custom__";

const dataSources = [
  { name: "shixiseng", label: "实习僧", available: true },
  { name: "boss", label: "BOSS直聘", available: true },
  { name: "zhilian", label: "智联招聘", available: true },
  { name: "linkedin", label: "LinkedIn", available: true },
  { name: "jobspy", label: "JobSpy 聚合", available: true },
  { name: "bytedance", label: "字节跳动", available: false },
  { name: "alibaba", label: "阿里巴巴", available: false },
  { name: "tencent", label: "腾讯", available: false },
  { name: "maimai", label: "脉脉", available: false },
];

const FALLBACK_PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    description: "Mainstream global provider",
    default_base_url: "https://api.openai.com/v1",
    models: [
      { id: "gpt-4.1-mini", name: "GPT-4.1 Mini" },
      { id: "gpt-4o-mini", name: "GPT-4o Mini" },
      { id: "gpt-4.1", name: "GPT-4.1" },
    ],
    key_prefix: "sk-",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    description: "Cost-effective Chinese model",
    default_base_url: "https://api.deepseek.com",
    models: [
      { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
      { id: "deepseek-chat", name: "DeepSeek Chat (deprecated 2026-07-24)" },
      { id: "deepseek-reasoner", name: "DeepSeek Reasoner (deprecated 2026-07-24)" },
    ],
    key_prefix: "sk-",
  },
  {
    id: "qwen",
    name: "通义千问",
    description: "Alibaba DashScope",
    default_base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: [
      { id: "qwen-plus", name: "Qwen Plus" },
      { id: "qwen-turbo", name: "Qwen Turbo" },
      { id: "qwen-max", name: "Qwen Max" },
    ],
    key_prefix: "sk-",
  },
  {
    id: "siliconflow",
    name: "硅基流动",
    description: "Model aggregation provider",
    default_base_url: "https://api.siliconflow.com/v1",
    models: [
      { id: "deepseek-ai/DeepSeek-V3.2", name: "DeepSeek-V3.2" },
      { id: "Qwen/Qwen3-32B", name: "Qwen3-32B" },
    ],
    key_prefix: "sk-",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    description: "Gemini OpenAI-compatible endpoint",
    default_base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: [
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    ],
    key_prefix: "",
  },
  {
    id: "zhipu",
    name: "智谱",
    description: "BigModel Open Platform",
    default_base_url: "https://open.bigmodel.cn/api/paas/v4",
    models: [
      { id: "glm-5.1", name: "GLM-5.1" },
      { id: "glm-4.6", name: "GLM-4.6" },
    ],
    key_prefix: "",
  },
  {
    id: "ollama",
    name: "Ollama",
    description: "Local inference",
    default_base_url: "http://localhost:11434/v1",
    models: [
      { id: "qwen2.5:7b", name: "Qwen2.5 7B" },
      { id: "llama3.1:8b", name: "Llama 3.1 8B" },
    ],
    key_prefix: "",
  },
];

const bauhausFieldClassNames = {
  inputWrapper:
    "border border-[var(--border-strong)] bg-white shadow-[2px_2px_0_0_rgba(18,18,18,0.3)] group-data-[focus=true]:border-[var(--border-strong)] hover:-translate-y-[1px]",
  input: "font-medium text-[var(--foreground)] placeholder:text-[var(--foreground-muted)]",
  label: "font-semibold tracking-[0.06em] text-[11px] text-[var(--foreground-muted)]",
  description: "text-[var(--foreground-muted)]",
  errorMessage: "font-medium text-[#D02020]",
};

const bauhausModalContentClassName =
  "max-h-[88vh] border border-[var(--border-strong)] bg-[var(--surface-muted)] text-[var(--foreground)] shadow-[4px_4px_0_0_rgba(18,18,18,0.45)]";

const bauhausAutocompleteInputClassNames = {
  ...bauhausFieldClassNames,
  inputWrapper:
    "border border-[var(--border-strong)] bg-white shadow-[2px_2px_0_0_rgba(18,18,18,0.3)] group-data-[focus=true]:border-[var(--border-strong)]",
};

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

function normalizeBaseUrl(value: string, providerId: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (providerId === "ollama" && !trimmed.endsWith("/v1")) {
    return `${trimmed}/v1`;
  }
  return trimmed;
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
      base_url: normalizeBaseUrl(item.base_url, providerId),
      api_key: providerId === "ollama" ? "" : item.api_key.trim(),
      extra_params: item.extra_params || {},
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
      const API_BASE =
        process.env.NEXT_PUBLIC_API_URL ||
        (typeof window !== "undefined"
          ? `${window.location.protocol}//${window.location.hostname}:8765`
          : "http://127.0.0.1:8765");
      const res = await fetch(`${API_BASE}/api/config/test-llm`, { method: "POST" });
      const data = await res.json();
      setResult({ success: data.success, message: data.message });
    } catch (err: any) {
      setResult({ success: false, message: `请求失败: ${err.message}` });
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <Button
        size="sm"
        className="border-2 border-white/30 bg-white/10 text-white hover:bg-white/20"
        onPress={testConnection}
        isLoading={testing}
      >
        测试连接
      </Button>
      {result && (
        <span className={`text-xs ${result.success ? "text-green-300" : "text-red-300"}`}>
          {result.message}
        </span>
      )}
    </>
  );
}

const AGENT_PROVIDER_LABELS: Record<string, string> = {
  pi: "Pi",
  replay: "Replay",
  codex: "Codex",
  "deepseek-harness": "DeepSeek Harness",
};

function providerStatusLabel(status: string) {
  return {
    ready: "就绪",
    blocked: "已阻塞",
    auth_required: "需要认证",
    unavailable: "不可用",
    unprobed: "未验证",
  }[status] || status;
}

function AgentProviderHealthCard() {
  const [providers, setProviders] = useState<AgentProviderHealth[]>([]);
  const [runtime, setRuntime] = useState<Record<string, any> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const [health, runtimeStatus] = await Promise.all([
        agentRuntimeApi.providerHealth(),
        agentRuntimeApi.runtime(),
      ]);
      setProviders(health.providers || []);
      setRuntime(runtimeStatus);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Agent Runtime 健康状态读取失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const byId = useMemo(() => new Map(providers.map((item) => [item.provider_id, item])), [providers]);
  const items = ["pi", "replay", "codex", "deepseek-harness"].map((providerId) => {
    const saved = byId.get(providerId);
    if (providerId === "pi" && runtime?.available) {
      return { ...(saved || {}), provider_id: providerId, status: "ready", last_error: "" } as AgentProviderHealth;
    }
    if (providerId === "replay") {
      return { ...(saved || {}), provider_id: providerId, status: "ready", available: true, last_error: "" } as AgentProviderHealth;
    }
    return saved || {
      provider_id: providerId,
      available: false,
      authenticated: null,
      blocked: false,
      status: "unprobed",
      version: "",
      auth_mode: "unknown",
      protocol_version: "",
      capabilities: {},
      last_error: "",
    };
  });

  return (
    <Card className="bauhaus-panel overflow-hidden rounded-none bg-white shadow-none" data-testid="agent-provider-health">
      <CardBody className="space-y-4 p-5 md:p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="bauhaus-label text-[var(--foreground-muted)]">Agent Runtime</p>
            <h3 className="mt-2 text-2xl font-bold text-[var(--foreground)]">运行时健康状态</h3>
            <p className="mt-2 max-w-2xl text-sm font-medium leading-relaxed text-[var(--foreground-muted)]">
              Replay 是本地内测路径；Codex、DeepSeek Harness 等外部能力不可用时，不会阻塞核心 Career OS。
            </p>
          </div>
          <Button
            size="sm"
            variant="light"
            onPress={() => void load()}
            isLoading={loading}
            className="border border-[var(--border)] bg-[var(--surface-muted)] font-bold text-[var(--foreground)]"
          >
            刷新
          </Button>
        </div>
        {error && (
          <div role="alert" className="bauhaus-panel-sm border-[var(--primary-red)] bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">
            {error}
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          {items.map((item) => (
            <div key={item.provider_id} className="bauhaus-panel-sm flex items-start justify-between gap-3 bg-[var(--surface-muted)] p-4">
              <div>
                <p className="text-sm font-black text-[var(--foreground)]">{AGENT_PROVIDER_LABELS[item.provider_id] || item.provider_id}</p>
                <p className="mt-1 text-xs font-medium text-[var(--foreground-muted)]">
                  {item.last_error || (item.provider_id === "deepseek-harness" ? "实验性 Provider，需单独验收" : "")}
                </p>
              </div>
              <Chip
                size="sm"
                variant="flat"
                className={`border font-black ${
                  item.status === "ready"
                    ? "border-emerald-600 bg-emerald-50 text-emerald-800"
                    : item.status === "blocked" || item.status === "auth_required"
                      ? "border-[var(--primary-red)] bg-red-50 text-red-800"
                      : "border-amber-500 bg-amber-50 text-amber-900"
                }`}
              >
                {providerStatusLabel(item.status)}
              </Chip>
            </div>
          ))}
        </div>
      </CardBody>
    </Card>
  );
}

function LocalDataSafetyCard() {
  const [exporting, setExporting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<"" | "integrity" | "backup" | "restore" | "cancel" | "reset_demo">("");
  const [status, setStatus] = useState<DataSafetyStatus | null>(null);
  const [integrity, setIntegrity] = useState<DataIntegrityReport | null>(null);
  const [backups, setBackups] = useState<DataBackupItem[]>([]);
  const [invalidBackups, setInvalidBackups] = useState(0);
  const [selectedBackup, setSelectedBackup] = useState<DataBackupItem | null>(null);
  const [confirmationText, setConfirmationText] = useState("");
  const [demoResetOpen, setDemoResetOpen] = useState(false);
  const [demoConfirmationText, setDemoConfirmationText] = useState("");
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const { isOpen, onOpen, onClose } = useDisclosure();

  const load = async () => {
    setLoading(true);
    try {
      const [nextStatus, nextBackups] = await Promise.all([
        dataSafetyApi.status(),
        dataSafetyApi.listBackups(),
      ]);
      setStatus(nextStatus);
      setBackups(nextBackups.items || []);
      setInvalidBackups((nextBackups.invalid || []).length);
    } catch (cause) {
      setFeedback({ type: "error", message: cause instanceof Error ? cause.message : "数据安全状态读取失败" });
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
      setFeedback({ type: "error", message: cause instanceof Error ? cause.message : "完整性检查失败" });
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
      setFeedback({ type: "error", message: cause instanceof Error ? cause.message : "备份创建失败" });
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
      await dataSafetyApi.stageRestore(selectedBackup.backup_id, true);
      onClose();
      setFeedback({ type: "success", message: "恢复已安全暂存。请关闭并重新打开 OfferU；启动前会再次校验并保留 pre-restore 备份。" });
      await load();
    } catch (cause) {
      setFeedback({ type: "error", message: cause instanceof Error ? cause.message : "恢复暂存失败" });
    } finally {
      setAction("");
    }
  };

  const cancelRestore = async () => {
    setAction("cancel");
    setFeedback(null);
    try {
      await dataSafetyApi.cancelRestore(true);
      setFeedback({ type: "success", message: "待恢复任务已取消，原备份仍然保留。" });
      await load();
    } catch (cause) {
      setFeedback({ type: "error", message: cause instanceof Error ? cause.message : "取消恢复失败" });
    } finally {
      setAction("");
    }
  };

  const handleExport = async () => {
    setExporting(true);
    setFeedback(null);
    try {
      const payload = await dataSafetyApi.exportUserData();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const stamp = new Date().toISOString().replace(/[T:.Z]/g, "-").replace(/-+$/, "");
      anchor.href = url;
      anchor.download = `offeru-data-${stamp}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
      const total = Object.values(payload.counts || {}).reduce((sum, count) => sum + Number(count || 0), 0);
      setFeedback({ type: "success", message: `已导出 ${total} 条本地职业数据。` });
    } catch (cause) {
      setFeedback({ type: "error", message: cause instanceof Error ? cause.message : "数据导出失败，请稍后重试" });
    } finally {
      setExporting(false);
    }
  };

  const resetDemo = async () => {
    if (demoConfirmationText !== "重置 Demo") return;
    setAction("reset_demo");
    setFeedback(null);
    try {
      const result = await dataSafetyApi.resetDemoData(true);
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
      setFeedback({ type: "error", message: cause instanceof Error ? cause.message : "Demo 数据重置失败，请稍后重试" });
    } finally {
      setAction("");
    }
  };

  return (
    <>
      <Card className="bauhaus-panel overflow-hidden rounded-none bg-white shadow-none" data-testid="local-data-safety">
        <CardBody className="space-y-5 p-5 md:p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="bauhaus-label text-[var(--foreground-muted)]">本地数据安全</p>
            <h3 className="mt-2 text-2xl font-bold text-[var(--foreground)]">备份、恢复与数据导出</h3>
            <p className="mt-2 max-w-2xl text-sm font-medium leading-relaxed text-[var(--foreground-muted)]">
              一致性备份包含 SQLite、上传文件和受管产物；恢复只会先暂存，下次启动前校验并替换。JSON 导出不包含 Provider 密钥、邮箱凭据或浏览器会话。
            </p>
          </div>
          <Button size="sm" variant="light" onPress={() => void load()} isLoading={loading} startContent={!loading ? <RefreshCw size={14} /> : undefined}>
            刷新
          </Button>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="bauhaus-panel-sm bg-[var(--surface-muted)] p-4">
            <p className="bauhaus-label text-[var(--foreground-muted)]">数据库</p>
            <p className="mt-2 flex items-center gap-2 text-sm font-black"><Database size={16} />{status?.database.filename || "读取中"}</p>
          </div>
          <div className="bauhaus-panel-sm bg-[var(--surface-muted)] p-4">
            <p className="bauhaus-label text-[var(--foreground-muted)]">可恢复备份</p>
            <p className="mt-2 text-3xl font-black">{status?.backup_count ?? "—"}</p>
          </div>
          <div className={`bauhaus-panel-sm p-4 ${status?.pending_restore ? "bg-amber-50" : "bg-emerald-50"}`}>
            <p className="bauhaus-label text-[var(--foreground-muted)]">恢复状态</p>
            <p className="mt-2 flex items-center gap-2 text-sm font-black">
              {status?.pending_restore ? <RotateCcw size={16} /> : <ShieldCheck size={16} />}
              {status?.pending_restore ? "等待重启" : "无待恢复任务"}
            </p>
          </div>
        </div>

        {status?.pending_restore && (
          <div role="status" className="bauhaus-panel-sm flex flex-wrap items-center justify-between gap-3 border-amber-500 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-950">
            <span>备份 {status.pending_restore.backup_id.slice(0, 8)}… 已暂存。关闭并重新打开 OfferU 后恢复。</span>
            <Button size="sm" variant="light" color="warning" isLoading={action === "cancel"} onPress={() => void cancelRestore()}>
              取消待恢复
            </Button>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button className="bauhaus-button bauhaus-button-blue !px-4 !py-3 !text-[11px]" onPress={() => void createBackup()} isDisabled={SHOWCASE} isLoading={action === "backup"} startContent={action !== "backup" ? <ShieldCheck size={15} /> : undefined}>
            创建一致性备份
          </Button>
          <Button variant="bordered" onPress={() => void checkIntegrity()} isLoading={action === "integrity"}>
            检查数据库完整性
          </Button>
          <Button variant="bordered" onPress={() => void handleExport()} isLoading={exporting} startContent={!exporting ? <Download size={15} /> : undefined}>
            导出 JSON
          </Button>
        </div>
        {SHOWCASE && <p className="text-xs font-semibold text-[var(--foreground-muted)]">Showcase 使用独立 IndexedDB；此处只提供 JSON 导出、完整性说明和 Demo 重置，不伪装成 SQLite 备份。</p>}

        <div className="bauhaus-panel-sm border-amber-500 bg-amber-50 p-4" data-testid="demo-data-safety">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-3xl">
              <p className="bauhaus-label text-amber-800">Demo / Fixture 工作区</p>
              <p className="mt-2 text-sm font-black text-amber-950">重置演示数据与删除真实数据是两件事</p>
              <p className="mt-2 text-sm font-medium leading-relaxed text-amber-900">
                {SHOWCASE
                  ? "当前为独立 Showcase IndexedDB。重置会清除这个虚构展示工作区，下一次读取会回到内置演示数据。"
                  : "本地模式只会清除 source=offeru-demo 且 batch_id=offeru-demo-v1 的明确合成数据；不会删除 Profile、真实岗位、真实简历、备份或连接信息。这里没有删除真实用户数据的入口。"}
              </p>
            </div>
            <Button
              color="warning"
              variant="flat"
              data-testid="reset-demo"
              onPress={() => {
                setDemoConfirmationText("");
                setDemoResetOpen(true);
              }}
              isLoading={action === "reset_demo"}
            >
              重置 Demo 数据
            </Button>
          </div>
        </div>

        {integrity && (
          <div className={`bauhaus-panel-sm px-4 py-3 text-sm font-semibold ${integrity.status === "ok" ? "border-emerald-600 bg-emerald-50 text-emerald-900" : "border-[var(--primary-red)] bg-red-50 text-red-800"}`}>
            {integrity.status === "ok" ? "Integrity OK" : "Integrity Failed"} · schema {integrity.schema.schema_version} · 外键异常 {integrity.foreign_key_violations.length}
          </div>
        )}

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-black text-[var(--foreground)]">最近备份</p>
            {invalidBackups > 0 && <Chip color="danger" size="sm">{invalidBackups} 个无效归档</Chip>}
          </div>
          {!loading && backups.length === 0 && <p className="text-sm font-medium text-[var(--foreground-muted)]">还没有备份。创建第一份一致性备份后，可以从这里选择恢复。</p>}
          {backups.slice(0, 5).map((backup) => (
            <div key={backup.backup_id} className="bauhaus-panel-sm flex flex-wrap items-center justify-between gap-3 bg-[var(--surface-muted)] p-3" data-testid={`data-backup-${backup.backup_id}`}>
              <div>
                <p className="text-sm font-black">
                  {backup.reason === "pre_restore" ? "恢复前自动备份" : backup.reason === "pre_migration" ? "迁移前自动备份" : "手动备份"} · {backup.backup_id.slice(0, 8)}
                </p>
                <p className="mt-1 text-xs font-medium text-[var(--foreground-muted)]">{new Date(backup.created_at).toLocaleString()} · {formatBytes(backup.size_bytes)} · v{backup.version}</p>
              </div>
              <Button size="sm" variant="bordered" isDisabled={Boolean(status?.pending_restore)} onPress={() => openRestore(backup)}>
                恢复此备份
              </Button>
            </div>
          ))}
        </div>

        {feedback && (
          <div
            role={feedback.type === "error" ? "alert" : "status"}
            className={`bauhaus-panel-sm px-4 py-3 text-sm font-semibold ${
              feedback.type === "error"
                ? "border-[var(--primary-red)] bg-red-50 text-red-800"
                : "border-emerald-600 bg-emerald-50 text-emerald-800"
            }`}
          >
            {feedback.message}
          </div>
        )}
        </CardBody>
      </Card>

      <Modal isOpen={isOpen} onClose={onClose} size="lg" placement="center">
        <ModalContent className={bauhausModalContentClassName}>
          <ModalHeader className="border-b-2 border-[var(--border-strong)] px-6 py-5 text-xl font-black">确认恢复本地数据</ModalHeader>
          <ModalBody className="space-y-4 px-6 py-6">
            <div className="bauhaus-panel-sm border-amber-500 bg-amber-50 p-4 text-sm font-semibold leading-relaxed text-amber-950">
              当前运行中的数据不会立刻改变。OfferU 会校验并暂存备份；下次启动前先创建恢复前备份，再替换 SQLite 与受管资产。恢复失败会自动回滚并停止启动。
            </div>
            <p className="text-sm font-bold">备份：{selectedBackup?.backup_id}</p>
            <Input label="输入“恢复”以继续" value={confirmationText} onValueChange={setConfirmationText} autoFocus classNames={bauhausFieldClassNames} />
          </ModalBody>
          <ModalFooter className="border-t-2 border-[var(--border-strong)] px-6 py-5">
            <Button variant="light" onPress={onClose}>取消</Button>
            <Button color="danger" isDisabled={confirmationText !== "恢复"} isLoading={action === "restore"} onPress={() => void stageRestore()} startContent={action !== "restore" ? <RotateCcw size={15} /> : undefined}>
              暂存并在重启时恢复
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal isOpen={demoResetOpen} onClose={() => setDemoResetOpen(false)} size="lg" placement="center">
        <ModalContent className={bauhausModalContentClassName}>
          <ModalHeader className="border-b-2 border-[var(--border-strong)] px-6 py-5 text-xl font-black">确认重置 Demo 工作区</ModalHeader>
          <ModalBody className="space-y-4 px-6 py-6">
            <div className="bauhaus-panel-sm border-amber-500 bg-amber-50 p-4 text-sm font-semibold leading-relaxed text-amber-950">
              只处理明确标记的合成数据。不会调用真实岗位删除接口，也不会删除你的 Profile、真实岗位、简历、备份或连接凭据。展示模式只清除独立的 Showcase IndexedDB。
            </div>
            <Input label="输入“重置 Demo”以继续" value={demoConfirmationText} onValueChange={setDemoConfirmationText} autoFocus classNames={bauhausFieldClassNames} />
          </ModalBody>
          <ModalFooter className="border-t-2 border-[var(--border-strong)] px-6 py-5">
            <Button variant="light" onPress={() => setDemoResetOpen(false)}>取消</Button>
            <Button color="warning" data-testid="confirm-reset-demo" isDisabled={demoConfirmationText !== "重置 Demo"} isLoading={action === "reset_demo"} onPress={() => void resetDemo()}>
              确认重置 Demo
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
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
          const errorId = String(error instanceof Error ? error.message : "").match(/err_[a-f0-9]{16}/)?.[0];
          backendErrorId = errorId || "";
        }
      }
      const safeNote = redactFeedbackText(trimmed);
      const payload = {
        schema_version: "offeru.internal-beta.feedback.v2",
        created_at: new Date().toISOString(),
        current_page: window.location.hash || "#/",
        app_version: "frontend@0.1.0",
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
    <Card className="bauhaus-panel overflow-hidden rounded-none bg-white shadow-none" data-testid="local-feedback">
      <CardBody className="space-y-4 p-5 md:p-6">
        <div className="flex items-start gap-3">
          <div className="bauhaus-panel-sm flex h-11 w-11 shrink-0 items-center justify-center bg-[var(--surface-muted)] text-[var(--foreground)]">
            <MessageSquare size={18} />
          </div>
          <div>
            <p className="bauhaus-label text-[var(--foreground-muted)]">内测反馈</p>
            <h3 className="mt-2 text-2xl font-bold text-[var(--foreground)]">报告一个问题</h3>
            <p className="mt-2 text-sm font-medium leading-relaxed text-[var(--foreground-muted)]">
              只生成本地诊断包，包含当前页面、版本、构建模式和你的描述；不会自动上传，也不会附带 Profile 或 Provider 密钥。
            </p>
          </div>
        </div>
        <Textarea
          label="问题描述"
          placeholder="例如：保存岗位后，Today 没有出现岗位情报。"
          value={note}
          onValueChange={setNote}
          minRows={3}
          data-testid="feedback-note"
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button
            className="bauhaus-button bauhaus-button-outline !px-4 !py-3 !text-[11px]"
            onPress={() => void handleExport()}
            isLoading={exporting}
            startContent={<MessageSquare size={15} />}
          >
            下载问题诊断包
          </Button>
          {feedback && (
            <span
              role={feedback.type === "error" ? "alert" : "status"}
              className={`text-sm font-semibold ${feedback.type === "error" ? "text-red-700" : "text-emerald-700"}`}
            >
              {feedback.message}
            </span>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

function redactFeedbackText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(\b(?:api[_-]?(?:key|token)|auth[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret|credential|cookie|authorization|token)\b\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}\]]+)/gi, "$1[redacted]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted email]")
    .replace(/(?<![\w])(?:\+?\d[\d\s().-]{7,}\d)(?![\w])/g, "[redacted phone]");
}

interface FetchModelsButtonProps {
  baseUrl: string;
  apiKey: string;
  onModelsFetched: (models: { id: string; name: string; owned_by?: string }[]) => void;
}

function FetchModelsButton({ baseUrl, apiKey, onModelsFetched }: FetchModelsButtonProps) {
  const [fetching, setFetching] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const fetchModels = async () => {
    if (!baseUrl.trim()) {
      setMessage("请先填写接口地址");
      return;
    }
    setFetching(true);
    setMessage(null);
    try {
      const API_BASE =
        process.env.NEXT_PUBLIC_API_URL ||
        (typeof window !== "undefined"
          ? `${window.location.protocol}//${window.location.hostname}:8765`
          : "http://127.0.0.1:8765");
      const res = await fetch(`${API_BASE}/api/config/fetch-models`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ base_url: baseUrl, api_key: apiKey }),
      });
      const data = await res.json();
      if (data.success && data.models?.length > 0) {
        setMessage(`获取到 ${data.models.length} 个模型`);
        onModelsFetched(data.models);
      } else {
        setMessage(data.message || "未获取到模型");
      }
    } catch (err: any) {
      setMessage(`请求失败: ${err.message}`);
    } finally {
      setFetching(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        className="bauhaus-button bauhaus-button-outline !px-3 !py-2 !text-[11px]"
        onPress={fetchModels}
        isLoading={fetching}
        isDisabled={!baseUrl.trim()}
        startContent={!fetching ? <Search size={14} /> : undefined}
      >
        获取模型列表
      </Button>
      {message && (
        <span className="text-xs font-medium text-[var(--foreground-muted)]">{message}</span>
      )}
    </div>
  );
}

export default function SettingsPage() {
  const { data, mutate } = useConfig();
  const config = data as SettingsConfigPayload | undefined;

  const [apiSaving, setApiSaving] = useState(false);
  const [apiSaved, setApiSaved] = useState(false);
  const [apiSaveError, setApiSaveError] = useState("");
  const [apiDirty, setApiDirty] = useState(false);

  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [settingsSaveError, setSettingsSaveError] = useState("");
  const [settingsDirty, setSettingsDirty] = useState(false);

  const [searchKeywords, setSearchKeywords] = useState("");
  const [searchLocations, setSearchLocations] = useState("");
  const [bannedKeywords, setBannedKeywords] = useState("");
  const [topN, setTopN] = useState("15");
  const [emailTo, setEmailTo] = useState("");
  const [sourcesEnabled, setSourcesEnabled] = useState<string[]>(["linkedin"]);
  const [profileSourceSyncEnabled, setProfileSourceSyncEnabled] = useState(false);

  const [bossCookie, setBossCookie] = useState("");
  const [zhilianCookie, setZhilianCookie] = useState("");
  const [showBossCookie, setShowBossCookie] = useState(false);
  const [showZhilianCookie, setShowZhilianCookie] = useState(false);

  const [providerPresets, setProviderPresets] = useState<ProviderPreset[]>(FALLBACK_PROVIDER_PRESETS);
  const [apiConfigs, setApiConfigs] = useState<LlmApiConfig[]>([]);
  const [disabledProviders, setDisabledProviders] = useState<string[]>([]);
  const [selectedConfigId, setSelectedConfigId] = useState("");
  const [listFeedback, setListFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const {
    isOpen: isEditorOpen,
    onOpen: onEditorOpen,
    onClose: onEditorClose,
  } = useDisclosure();
  const {
    isOpen: isDeleteOpen,
    onOpen: onDeleteOpen,
    onClose: onDeleteClose,
  } = useDisclosure();

  const [editingConfigId, setEditingConfigId] = useState<string | null>(null);
  const [formProviderChoice, setFormProviderChoice] = useState<string>("deepseek");
  const [formCustomServiceName, setFormCustomServiceName] = useState("");
  const [formModelChoice, setFormModelChoice] = useState<string>("");
  const [formCustomModel, setFormCustomModel] = useState("");
  const [fetchedModelOptions, setFetchedModelOptions] = useState<SelectOption[]>([]);
  const [formUrlChoice, setFormUrlChoice] = useState<string>("");
  const [formBaseUrl, setFormBaseUrl] = useState("");
  const [formApiKey, setFormApiKey] = useState("");
  const [formIsActive, setFormIsActive] = useState<boolean>(false);
  const [showFormApiKey, setShowFormApiKey] = useState(false);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const providerSelectionRef = useRef(false);
  const modelSelectionRef = useRef(false);
  const urlSelectionRef = useRef(false);

  const selectedConfig = useMemo(
    () => apiConfigs.find((item) => item.id === selectedConfigId) || null,
    [apiConfigs, selectedConfigId]
  );

  const currentFormPreset = useMemo(
    () => providerPresets.find((preset) => preset.id === formProviderChoice),
    [providerPresets, formProviderChoice]
  );

  const formModelOptions = useMemo(
    () => currentFormPreset?.models || [],
    [currentFormPreset]
  );

  const resolvedFormServiceName = useMemo(() => {
    if (formProviderChoice === CUSTOM_OPTION) {
      return formCustomServiceName.trim();
    }
    return currentFormPreset?.name || "";
  }, [currentFormPreset, formCustomServiceName, formProviderChoice]);

  const resolvedFormProviderId = useMemo(() => {
    if (formProviderChoice === CUSTOM_OPTION) {
      return normalizeProviderId(formCustomServiceName);
    }
    return formProviderChoice;
  }, [formCustomServiceName, formProviderChoice]);

  const resolvedFormModel = useMemo(() => {
    if (formModelChoice === CUSTOM_OPTION) {
      return formCustomModel.trim();
    }
    return formModelChoice;
  }, [formCustomModel, formModelChoice]);

  const resolvedFormBaseUrl = useMemo(() => {
    if (formUrlChoice === CUSTOM_OPTION) {
      return formBaseUrl.trim();
    }
    return formUrlChoice.trim();
  }, [formBaseUrl, formUrlChoice]);

  const providerSelectOptions = useMemo<SelectOption[]>(() => {
    return providerPresets.map((preset) => ({
      id: preset.id,
      label: preset.name,
      description: preset.description || "",
    }));
  }, [providerPresets]);

  const modelSelectOptions = useMemo<SelectOption[]>(() => {
    const preset = formModelOptions.map((model) => ({
      id: model.id,
      label: model.name,
      description: model.description || "",
    }));
    const existingIds = new Set(preset.map((o) => o.id));
    const fetched = fetchedModelOptions.filter((o) => !existingIds.has(o.id));
    return [...preset, ...fetched];
  }, [formModelOptions, fetchedModelOptions]);

  const urlSelectOptions = useMemo<SelectOption[]>(() => {
    const list: SelectOption[] = [];
    if (currentFormPreset?.default_base_url) {
      list.push({
        id: currentFormPreset.default_base_url,
        label: `默认 URL（${currentFormPreset.default_base_url}）`,
      });
    }
    return list;
  }, [currentFormPreset]);

  const validateEditorForm = (): Record<string, string> => {
    const errors: Record<string, string> = {};
    const providerId = resolvedFormProviderId;

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

    if (providerId !== "ollama") {
      if (!formApiKey.trim()) {
        errors.api_key = "访问密钥不能为空";
      }

      if (!editingConfigId && formApiKey.includes("*")) {
        errors.api_key = "新增配置时不能使用脱敏密钥";
      }

      const prefix = currentFormPreset?.key_prefix || "";
      if (prefix && formApiKey.trim() && !formApiKey.includes("*") && !formApiKey.trim().startsWith(prefix)) {
        errors.api_key = `该服务密钥通常以 ${prefix} 开头`;
      }
    }

    return errors;
  };

  useEffect(() => {
    if (!isEditorOpen) return;
    setFormErrors(validateEditorForm());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isEditorOpen,
    formProviderChoice,
    formCustomServiceName,
    formModelChoice,
    formCustomModel,
    formUrlChoice,
    formBaseUrl,
    formApiKey,
    formIsActive,
  ]);

  useEffect(() => {
    if (!config) return;

    setSearchKeywords((config.search_keywords || []).join("\n"));
    setSearchLocations((config.search_locations || []).join("\n"));
    setBannedKeywords((config.banned_keywords || []).join("\n"));
    setTopN(String(config.top_n || 15));
    setEmailTo(config.email_to || "");
    setSourcesEnabled(config.sources_enabled || ["linkedin"]);
    setProfileSourceSyncEnabled(Boolean(config.profile_source_sync_enabled));
    setBossCookie(config.boss_cookie || "");
    setZhilianCookie(config.zhilian_cookie || "");

    const presets = Array.isArray(config.provider_presets) && config.provider_presets.length > 0
      ? config.provider_presets
      : FALLBACK_PROVIDER_PRESETS;
    setProviderPresets(presets);

    const incoming = Array.isArray(config.llm_api_configs) ? config.llm_api_configs : [];
    const normalized = incoming
      .map((item) => ({
        id: item.id || createConfigId(),
        provider_id: normalizeProviderId(item.provider_id || item.service_name || "custom"),
        service_name: (item.service_name || item.provider_id || "Custom").trim(),
        model: (item.model || "").trim(),
        base_url: normalizeBaseUrl(item.base_url || "", normalizeProviderId(item.provider_id || "")),
        api_key: item.api_key || "",
        is_active: Boolean(item.is_active),
        extra_params: item.extra_params || {},
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
    setSettingsDirty(false);
    setSettingsSaved(false);
    setSettingsSaveError("");
  }, [config]);

  const markApiDirty = () => {
    setApiDirty(true);
    setApiSaved(false);
    setApiSaveError("");
  };

  const markSettingsDirty = () => {
    setSettingsDirty(true);
    setSettingsSaved(false);
    setSettingsSaveError("");
  };

  const handleSearchKeywordsChange = (value: string) => {
    setSearchKeywords(value);
    markSettingsDirty();
  };

  const handleSearchLocationsChange = (value: string) => {
    setSearchLocations(value);
    markSettingsDirty();
  };

  const handleBannedKeywordsChange = (value: string) => {
    setBannedKeywords(value);
    markSettingsDirty();
  };

  const handleTopNChange = (value: string) => {
    setTopN(value);
    markSettingsDirty();
  };

  const handleEmailToChange = (value: string) => {
    setEmailTo(value);
    markSettingsDirty();
  };

  const handleBossCookieChange = (value: string) => {
    setBossCookie(value);
    markSettingsDirty();
  };

  const handleZhilianCookieChange = (value: string) => {
    setZhilianCookie(value);
    markSettingsDirty();
  };

  const toggleSource = (name: string) => {
    setSourcesEnabled((prev) => {
      const next = prev.includes(name) ? prev.filter((item) => item !== name) : [...prev, name];
      return next;
    });
    markSettingsDirty();
  };

  const handleProfileSourceSyncChange = (enabled: boolean) => {
    setProfileSourceSyncEnabled(enabled);
    markSettingsDirty();
  };

  const openCreateEditor = () => {
    const defaultPreset = providerPresets.find((preset) => preset.id === "deepseek") || providerPresets[0];
    if (!defaultPreset) return;

    setEditingConfigId(null);
    setFormProviderChoice(defaultPreset.id);
    setFormCustomServiceName("");
    setFormModelChoice(defaultPreset.models[0]?.id || CUSTOM_OPTION);
    setFormCustomModel("");
    setFormUrlChoice(defaultPreset.default_base_url);
    setFormBaseUrl(defaultPreset.default_base_url);
    setFormApiKey("");
    setFormIsActive(apiConfigs.length === 0);
    setShowFormApiKey(false);
    setFormErrors({});
    setListFeedback(null);
    onEditorOpen();
  };

  const openEditEditor = (configItem: LlmApiConfig) => {
    const matchedPreset = providerPresets.find((preset) => preset.id === configItem.provider_id);

    setEditingConfigId(configItem.id);
    setFormProviderChoice(matchedPreset ? matchedPreset.id : CUSTOM_OPTION);
    setFormCustomServiceName(matchedPreset ? "" : configItem.service_name);

    if (matchedPreset?.models.some((model) => model.id === configItem.model)) {
      setFormModelChoice(configItem.model);
      setFormCustomModel("");
    } else {
      setFormModelChoice(CUSTOM_OPTION);
      setFormCustomModel(configItem.model);
    }

    if (matchedPreset && normalizeBaseUrl(matchedPreset.default_base_url, matchedPreset.id) === normalizeBaseUrl(configItem.base_url, configItem.provider_id)) {
      setFormUrlChoice(matchedPreset.default_base_url);
    } else {
      setFormUrlChoice(CUSTOM_OPTION);
    }
    setFormBaseUrl(configItem.base_url);
    setFormApiKey(configItem.api_key);
    setFormIsActive(configItem.is_active);
    setShowFormApiKey(false);
    setFormErrors({});
    setListFeedback(null);
    onEditorOpen();
  };

  const handleProviderChoiceChange = (value: string) => {
    setFormProviderChoice(value);
    setFetchedModelOptions([]);
    if (value === CUSTOM_OPTION) {
      setFormCustomServiceName(resolvedFormServiceName);
      setFormModelChoice(CUSTOM_OPTION);
      setFormCustomModel(resolvedFormModel);
      setFormUrlChoice(CUSTOM_OPTION);
      setFormBaseUrl(resolvedFormBaseUrl);
      return;
    }

    const preset = providerPresets.find((item) => item.id === value);
    if (!preset) return;

    setFormCustomServiceName("");
    setFormModelChoice(preset.models[0]?.id || CUSTOM_OPTION);
    setFormCustomModel("");
    setFormUrlChoice(preset.default_base_url);
    setFormBaseUrl(preset.default_base_url);

    if (preset.id === "ollama") {
      setFormApiKey("");
    }
  };

  const enableCustomServiceEdit = () => {
    if (formProviderChoice !== CUSTOM_OPTION) {
      setFormCustomServiceName(resolvedFormServiceName);
      setFormProviderChoice(CUSTOM_OPTION);
      setFormModelChoice(CUSTOM_OPTION);
      setFormCustomModel(resolvedFormModel);
      setFormUrlChoice(CUSTOM_OPTION);
      setFormBaseUrl(resolvedFormBaseUrl);
    }
  };

  const handleServiceInputChange = (value: string) => {
    if (formProviderChoice !== CUSTOM_OPTION) {
      enableCustomServiceEdit();
    }
    setFormCustomServiceName(value);
  };

  const enableCustomModelEdit = () => {
    if (formModelChoice !== CUSTOM_OPTION) {
      setFormCustomModel(resolvedFormModel);
      setFormModelChoice(CUSTOM_OPTION);
    }
  };

  const handleModelInputChange = (value: string) => {
    if (formModelChoice !== CUSTOM_OPTION) {
      enableCustomModelEdit();
    }
    setFormCustomModel(value);
  };

  const enableCustomUrlEdit = () => {
    if (formUrlChoice !== CUSTOM_OPTION) {
      setFormBaseUrl(resolvedFormBaseUrl);
      setFormUrlChoice(CUSTOM_OPTION);
    }
  };

  const handleUrlInputChange = (value: string) => {
    if (formUrlChoice !== CUSTOM_OPTION) {
      enableCustomUrlEdit();
    }
    setFormBaseUrl(value);
  };

  const handleActivateConfig = (targetId: string) => {
    setApiConfigs((prev) => prev.map((item) => ({ ...item, is_active: item.id === targetId })));
    setSelectedConfigId(targetId);
    markApiDirty();
    setListFeedback({ type: "success", message: "已切换激活配置，请点击“保存模型配置”提交" });
  };

  const handleRowClick = (targetId: string) => {
    if (selectedConfigId === targetId) {
      const target = apiConfigs.find((item) => item.id === targetId);
      if (target) openEditEditor(target);
      return;
    }
    setSelectedConfigId(targetId);
  };

  const handleSubmitEditor = () => {
    const errors = validateEditorForm();
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) {
      setListFeedback({ type: "error", message: "请先修正表单错误后再保存" });
      return;
    }

    const nextProviderId = resolvedFormProviderId;
    const nextConfig: LlmApiConfig = {
      id: editingConfigId || createConfigId(),
      provider_id: nextProviderId,
      service_name: resolvedFormServiceName,
      model: resolvedFormModel,
      base_url: normalizeBaseUrl(resolvedFormBaseUrl, nextProviderId),
      api_key: nextProviderId === "ollama" ? "" : formApiKey.trim(),
      is_active: formIsActive,
      extra_params: {},
    };

    setApiConfigs((prev) => {
      let next = editingConfigId
        ? prev.map((item) => (item.id === editingConfigId ? nextConfig : item))
        : [...prev, nextConfig];

      const shouldForceOneActive = !next.some((item) => item.is_active);
      if (nextConfig.is_active || shouldForceOneActive) {
        next = next.map((item) => ({ ...item, is_active: item.id === nextConfig.id }));
      }
      return next;
    });

    setSelectedConfigId(nextConfig.id);
    onEditorClose();
    markApiDirty();
    setListFeedback({
      type: "success",
      message: `${editingConfigId ? "配置已更新" : "配置已新增"}，请点击“保存模型配置”提交`,
    });
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

  const handleSaveApiSettings = async () => {
    setApiSaving(true);
    setApiSaveError("");
    setListFeedback(null);

    const { normalizedConfigs, activeConfig } = normalizeApiConfigsForSave(apiConfigs);

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
    } catch (error) {
      setApiSaveError(error instanceof Error ? error.message : "模型配置保存失败，请稍后重试");
    } finally {
      setApiSaving(false);
    }
  };

  const handleSaveSettings = async () => {
    setSettingsSaving(true);
    setSettingsSaveError("");

    try {
      await updateConfig({
        search_keywords: searchKeywords.split("\n").map((item) => item.trim()).filter(Boolean),
        search_locations: searchLocations.split("\n").map((item) => item.trim()).filter(Boolean),
        banned_keywords: bannedKeywords.split("\n").map((item) => item.trim()).filter(Boolean),
        top_n: parseInt(topN, 10) || 15,
        email_to: emailTo.trim(),
        sources_enabled: sourcesEnabled,
        profile_source_sync_enabled: profileSourceSyncEnabled,
        boss_cookie: bossCookie.trim(),
        zhilian_cookie: zhilianCookie.trim(),
      });

      await mutate();
      setSettingsSaved(true);
      setSettingsDirty(false);
      setTimeout(() => setSettingsSaved(false), 2000);
    } catch (error) {
      setSettingsSaveError(error instanceof Error ? error.message : "其他设置保存失败，请稍后重试");
    } finally {
      setSettingsSaving(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", damping: 15 }}
      className="space-y-6"
    >
      <section className="bauhaus-panel overflow-hidden bg-[var(--surface)]">
        <div className="grid gap-6 border-b border-[var(--border-strong)]/12 p-6 md:p-8 xl:grid-cols-[1.05fr_0.95fr]">
          <div className="space-y-4">
            <span className="bauhaus-chip bg-[var(--surface-muted)] text-[var(--foreground)]">系统配置</span>
            <div>
              <p className="bauhaus-label text-[var(--foreground-muted)]">搜索、来源与模型</p>
              <h1 className="mt-2 text-4xl font-bold leading-tight md:text-5xl">统一配置工作台</h1>
              <p className="mt-3 max-w-2xl text-sm font-medium leading-relaxed text-[var(--foreground-muted)] md:text-base">
                在这里配置模型供应商、搜索规则、数据源和同步策略。所有模块延续同一套 Bauhaus 视觉规范，但保持原有配置逻辑不变。
              </p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3 xl:grid-cols-1">
            <div className="bauhaus-panel-sm bg-[var(--surface-muted)] p-4 text-[var(--foreground)]">
              <p className="bauhaus-label text-[var(--foreground-muted)]">模型配置数</p>
              <p className="mt-2 text-4xl font-bold">{apiConfigs.length}</p>
              <p className="mt-2 text-sm font-medium text-[var(--foreground-muted)]">当前已维护的模型供应商配置数量。</p>
            </div>
            <div className="bauhaus-panel-sm bg-[var(--surface-muted)] p-4 text-[var(--foreground)]">
              <p className="bauhaus-label text-[var(--foreground-muted)]">启用来源</p>
              <p className="mt-2 text-4xl font-bold">{sourcesEnabled.length}</p>
              <p className="mt-2 text-sm font-medium text-[var(--foreground-muted)]">当前启用的数据抓取来源数。</p>
            </div>
            <div className="bauhaus-panel-sm bg-[var(--status-blush)] p-4 text-[var(--foreground)]">
              <p className="bauhaus-label text-[var(--foreground-muted)]">待保存</p>
              <p className="mt-2 text-4xl font-bold">
                {Number(apiDirty) + Number(settingsDirty)}
              </p>
              <p className="mt-2 text-sm font-medium text-[var(--foreground-muted)]">需要提交到本地配置文件的待保存模块数。</p>
            </div>
          </div>
        </div>
      </section>

      <AgentProviderHealthCard />

      <LocalDataSafetyCard />

      <LocalFeedbackCard />

      <Card className="bauhaus-panel overflow-hidden rounded-none bg-white shadow-none">
        <CardBody className="space-y-5 p-5 md:p-6">
          <div className="flex items-center gap-3">
            <div className="bauhaus-panel-sm flex h-11 w-11 items-center justify-center bg-[var(--primary-blue)] text-white">
              <Key size={18} />
            </div>
            <div>
              <p className="bauhaus-label text-[var(--foreground-muted)]">模型供应商</p>
              <h3 className="text-2xl font-bold text-[var(--foreground)]">大模型接口管理</h3>
            </div>
          </div>
          <p className="text-sm font-medium leading-relaxed text-[var(--foreground-muted)]">
            请在此处配置模型接口信息。新增、删除、编辑后，仍需点击本模块底部的“保存模型配置”完成提交。
          </p>

          {/* 当前生效配置摘要 (PRD §7.1 Req 4) */}
          {config?.active_llm_summary && (
            <div className="bauhaus-panel-sm bg-[var(--primary-blue)] px-4 py-4 text-sm text-white">
              <div className="mb-1 flex items-center gap-2">
                <div className={`h-2 w-2 rounded-full ${
                  config.active_llm_summary.source === "active_config" ? "bg-green-400" :
                  config.active_llm_summary.source === "ollama" ? "bg-yellow-400" : "bg-orange-400"
                }`} />
                <span className="font-medium text-white/90">当前生效配置</span>
                <Chip
                  size="sm"
                  variant="flat"
                  className="border border-[var(--border-strong)] bg-white text-[var(--foreground)]"
                  color={
                  config.active_llm_summary.source === "active_config" ? "success" :
                  config.active_llm_summary.source === "ollama" ? "warning" : "danger"
                }
                >
                  {config.active_llm_summary.source === "active_config" ? "已激活配置" :
                   config.active_llm_summary.source === "ollama" ? "本地 Ollama" : "旧配置回退"}
                </Chip>
              </div>
              <div className="ml-4 grid grid-cols-1 gap-x-6 gap-y-1 text-white/70 sm:grid-cols-3">
                <span>服务商: <span className="text-white">{config.active_llm_summary.service_name}</span></span>
                <span>模型: <span className="text-white">{config.active_llm_summary.model}</span></span>
                <span className="truncate">地址: <span className="text-white">{config.active_llm_summary.base_url}</span></span>
              </div>
              <div className="mt-3 ml-4 flex items-center gap-3">
                <TestLlmButton />
              </div>
            </div>
          )}

          <div className="bauhaus-panel-sm overflow-x-auto bg-[var(--surface-muted)]">
            <table className="w-full min-w-[780px] text-sm">
              <thead className="bg-[var(--foreground)] text-white">
                <tr>
                  <th className="px-3 py-3 text-left font-semibold tracking-[0.06em]">服务商</th>
                  <th className="px-3 py-3 text-left font-semibold tracking-[0.04em]">模型名称</th>
                  <th className="px-3 py-3 text-left font-semibold tracking-[0.04em]">接口地址</th>
                  <th className="px-3 py-3 text-left font-semibold tracking-[0.04em]">密钥状态</th>
                  <th className="px-3 py-3 text-center font-semibold tracking-[0.06em]">禁用</th>
                  <th className="px-3 py-3 text-center font-semibold tracking-[0.06em]">是否激活</th>
                </tr>
              </thead>
              <tbody>
                {apiConfigs.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-8 text-center font-medium text-[var(--foreground-muted)]">
                      暂无配置，请点击“新增”创建第一条配置
                    </td>
                  </tr>
                )}
                {apiConfigs.map((item) => {
                  const isSelected = selectedConfigId === item.id;
                  return (
                    <tr
                      key={item.id}
                      className={`cursor-pointer border-t-2 border-[var(--border-strong)]/10 transition-colors ${
                        isSelected ? "bg-[#F0C020]" : "bg-white hover:bg-[var(--surface-muted)]"
                      }`}
                      onClick={() => handleRowClick(item.id)}
                    >
                      <td className="px-3 py-3">
                        <div className="font-bold text-[var(--foreground)]">{item.service_name}</div>
                        <div className="text-[11px] font-medium tracking-[0.04em] text-[var(--foreground-muted)]">{item.provider_id}</div>
                      </td>
                      <td className="px-3 py-3 text-[var(--foreground-muted)]">{item.model}</td>
                      <td className="px-3 py-3 break-all text-[var(--foreground-muted)]">{item.base_url}</td>
                      <td className="px-3 py-3 text-[var(--foreground-muted)]">{displayMaskedKey(item.api_key)}</td>
                      <td className="px-3 py-3 text-center">
                        <input
                          type="checkbox"
                          checked={disabledProviders.includes(item.provider_id)}
                          onChange={() => {
                            setDisabledProviders((prev) =>
                              prev.includes(item.provider_id)
                                ? prev.filter((pid) => pid !== item.provider_id)
                                : [...prev, item.provider_id]
                            );
                            markApiDirty();
                          }}
                          onClick={(event) => event.stopPropagation()}
                          className="h-4 w-4 cursor-pointer"
                          aria-label={`禁用 ${item.service_name}`}
                        />
                      </td>
                      <td className="px-3 py-3 text-center">
                        <input
                          type="radio"
                          name="active-llm-config"
                          checked={item.is_active}
                          onChange={() => handleActivateConfig(item.id)}
                          onClick={(event) => event.stopPropagation()}
                          className="h-4 w-4 cursor-pointer"
                          aria-label={`激活 ${item.service_name}`}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                startContent={<Plus size={14} />}
                onPress={openCreateEditor}
                className="bauhaus-button bauhaus-button-blue !px-4 !py-3 !text-[11px]"
              >
                新增
              </Button>
              <Button
                size="sm"
                startContent={<Trash2 size={14} />}
                isDisabled={!selectedConfig}
                onPress={onDeleteOpen}
                className="bauhaus-button bauhaus-button-red !px-4 !py-3 !text-[11px]"
              >
                删除
              </Button>
              <Button
                size="sm"
                startContent={<SquarePen size={14} />}
                isDisabled={!selectedConfig}
                onPress={() => {
                  if (selectedConfig) openEditEditor(selectedConfig);
                }}
                className="bauhaus-button bauhaus-button-outline !px-4 !py-3 !text-[11px]"
              >
                编辑
              </Button>
            </div>

            <div className="flex items-center gap-2 self-start md:self-auto">
              <Chip
                size="sm"
                variant="flat"
                className={
                  apiDirty
                    ? "border border-[var(--border-strong)] bg-[#F0C020] text-[var(--foreground)]"
                    : "border border-[var(--border-strong)] bg-white text-[var(--foreground-muted)]"
                }
              >
                {apiDirty ? "有未保存改动" : "已同步"}
              </Chip>
              <Button
                size="sm"
                startContent={apiSaved ? <Check size={14} /> : <Save size={14} />}
                isLoading={apiSaving}
                onPress={handleSaveApiSettings}
                className={`bauhaus-button !px-4 !py-3 !text-[11px] ${
                  apiSaved ? "bauhaus-button-yellow" : "bauhaus-button-red"
                }`}
              >
                {apiSaved ? "已保存" : "保存模型配置"}
              </Button>
            </div>
          </div>

          {listFeedback && (
            <div
              className={`bauhaus-panel-sm px-3 py-3 text-xs font-medium ${
                listFeedback.type === "success"
                  ? "bg-[#F0C020] text-[var(--foreground)]"
                  : "bg-[var(--primary-red)] text-white"
              }`}
            >
              {listFeedback.message}
            </div>
          )}

          {apiSaveError && (
            <div className="bauhaus-panel-sm flex items-center gap-2 bg-[var(--primary-red)] px-3 py-3 text-xs font-medium text-white">
              <AlertCircle size={14} />
              <span>{apiSaveError}</span>
            </div>
          )}
        </CardBody>
      </Card>

      <Card className="bauhaus-panel overflow-hidden rounded-none bg-white shadow-none">
        <CardBody className="space-y-4 p-5 md:p-6">
          <div>
            <p className="bauhaus-label text-[var(--foreground-muted)]">搜索规则</p>
            <h3 className="mt-2 text-2xl font-bold text-[var(--foreground)]">搜索配置</h3>
          </div>
          <Textarea
            label="搜索关键词（每行一个）"
            variant="bordered"
            placeholder={"Data Scientist\nPython Developer\nBioinformatics"}
            value={searchKeywords}
            onValueChange={handleSearchKeywordsChange}
            classNames={bauhausFieldClassNames}
          />
          <Textarea
            label="搜索地区（每行一个）"
            variant="bordered"
            placeholder={"北京\n上海\n深圳"}
            value={searchLocations}
            onValueChange={handleSearchLocationsChange}
            classNames={bauhausFieldClassNames}
          />
          <Textarea
            label="过滤关键词（每行一个）"
            variant="bordered"
            placeholder={"实习\nstudent\n临时"}
            value={bannedKeywords}
            onValueChange={handleBannedKeywordsChange}
            classNames={bauhausFieldClassNames}
          />
          <Input
            label="每日推送数量"
            variant="bordered"
            type="number"
            value={topN}
            onValueChange={handleTopNChange}
            classNames={bauhausFieldClassNames}
          />
        </CardBody>
      </Card>

      <Card className="bauhaus-panel overflow-hidden rounded-none bg-white shadow-none">
        <CardBody className="space-y-4 p-5 md:p-6">
          <div>
            <p className="bauhaus-label text-[var(--foreground-muted)]">来源开关</p>
            <h3 className="mt-2 text-2xl font-bold text-[var(--foreground)]">数据源</h3>
          </div>
          {dataSources.map((source) => (
            <div key={source.name} className="bauhaus-panel-sm flex items-center justify-between gap-4 bg-[var(--surface-muted)] px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-[var(--foreground)]">{source.label}</span>
                {!source.available && (
                  <Chip size="sm" variant="flat" className="border border-[var(--border-strong)] bg-white text-[10px] text-[var(--foreground-muted)]">
                    即将开放
                  </Chip>
                )}
              </div>
              <Switch
                size="sm"
                isSelected={sourcesEnabled.includes(source.name)}
                isDisabled={!source.available}
                onValueChange={() => toggleSource(source.name)}
                classNames={{ wrapper: "bg-black/10" }}
              />
            </div>
          ))}
        </CardBody>
      </Card>

      <Card className="bauhaus-panel overflow-hidden rounded-none bg-white shadow-none">
        <CardBody className="space-y-4 p-5 md:p-6">
          <div>
            <p className="bauhaus-label text-[var(--foreground-muted)]">档案同步</p>
            <h3 className="mt-2 text-2xl font-bold text-[var(--foreground)]">档案同步</h3>
          </div>
          <div className="bauhaus-panel-sm flex items-start justify-between gap-4 bg-[var(--surface-muted)] px-4 py-4">
            <div className="space-y-1">
              <p className="text-sm font-medium text-[var(--foreground)]">档案源数据更新时，同步更新简历中已导入的对应条目</p>
              <p className="text-xs font-medium leading-relaxed text-[var(--foreground-muted)]">
                默认关闭。开启后当档案条目被编辑时，简历编辑页会提示你手动确认是否同步；档案删除永不删除简历内容。
              </p>
            </div>
            <Switch
              size="sm"
              isSelected={profileSourceSyncEnabled}
              onValueChange={handleProfileSourceSyncChange}
              classNames={{ wrapper: "bg-black/10" }}
            />
          </div>
        </CardBody>
      </Card>

      <Card className="bauhaus-panel overflow-hidden rounded-none bg-white shadow-none">
        <CardBody className="space-y-4 p-5 md:p-6">
          <div>
            <p className="bauhaus-label text-[var(--foreground-muted)]">投递通知</p>
            <h3 className="mt-2 text-2xl font-bold text-[var(--foreground)]">邮箱推送</h3>
          </div>
          <Input
            label="接收邮箱"
            variant="bordered"
            type="email"
            value={emailTo}
            onValueChange={handleEmailToChange}
            classNames={bauhausFieldClassNames}
          />
        </CardBody>
      </Card>

      <Card className="bauhaus-panel overflow-hidden rounded-none bg-white shadow-none">
        <CardBody className="space-y-4 p-5 md:p-6">
          <div className="flex items-center gap-3">
            <div className="bauhaus-panel-sm flex h-11 w-11 items-center justify-center bg-[#F0C020] text-[var(--foreground)]">
              <Cookie size={18} />
            </div>
            <div>
              <p className="bauhaus-label text-[var(--foreground-muted)]">爬虫权限</p>
              <h3 className="text-2xl font-bold text-[var(--foreground)]">爬虫认证配置</h3>
            </div>
          </div>
          <p className="text-xs font-medium leading-relaxed text-[var(--foreground-muted)]">
            部分招聘平台需要登录后的 Cookie 才能获取数据。在浏览器登录后，
            按 F12 - Network - 复制任意请求的 Cookie 字段粘贴到这里。Cookie 仅保存在本地。
          </p>

          <Input
            label="BOSS直聘 Cookie"
            variant="bordered"
            placeholder="wt2=...; zp_token=...; ..."
            description={
              bossCookie && bossCookie !== "***已配置***" && !bossCookie.includes("wt2")
                ? "Cookie 应包含 wt2 字段"
                : bossCookie === "***已配置***"
                ? "已配置，输入新值将覆盖"
                : undefined
            }
            color={
              bossCookie && bossCookie !== "***已配置***" && !bossCookie.includes("wt2")
                ? "warning"
                : undefined
            }
            value={bossCookie}
            onValueChange={handleBossCookieChange}
            type={showBossCookie ? "text" : "password"}
            endContent={
              <button
                type="button"
                onClick={() => setShowBossCookie((prev) => !prev)}
                className="text-[var(--foreground-muted)] hover:text-[var(--foreground-muted)]"
                aria-label={showBossCookie ? "隐藏 Cookie" : "显示 Cookie"}
                aria-pressed={showBossCookie}
              >
                {showBossCookie ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            }
            classNames={bauhausFieldClassNames}
          />

          <Input
            label="智联招聘 Cookie（可选）"
            variant="bordered"
            placeholder="登录 zhaopin.com 后复制 Cookie..."
            description={
              zhilianCookie === "***已配置***"
                ? "已配置，输入新值将覆盖"
                : "无 Cookie 时会尝试匿名访问"
            }
            value={zhilianCookie}
            onValueChange={handleZhilianCookieChange}
            type={showZhilianCookie ? "text" : "password"}
            endContent={
              <button
                type="button"
                onClick={() => setShowZhilianCookie((prev) => !prev)}
                className="text-[var(--foreground-muted)] hover:text-[var(--foreground-muted)]"
                aria-label={showZhilianCookie ? "隐藏 Cookie" : "显示 Cookie"}
                aria-pressed={showZhilianCookie}
              >
                {showZhilianCookie ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            }
            classNames={bauhausFieldClassNames}
          />
        </CardBody>
      </Card>

      {settingsSaveError && (
        <div className="bauhaus-panel-sm flex items-center gap-2 bg-[var(--primary-red)] px-3 py-3 text-sm font-medium text-white">
          <AlertCircle size={16} />
          <span>{settingsSaveError}</span>
        </div>
      )}

      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <p className="text-xs font-medium text-[var(--foreground-muted)]">
          此按钮仅保存搜索配置、数据源、邮箱推送与爬虫认证配置。
        </p>
        <div className="flex items-center gap-2 self-start md:self-auto">
          <Chip
            size="sm"
            variant="flat"
            className={
              settingsDirty
                ? "border border-[var(--border-strong)] bg-[#F0C020] text-[var(--foreground)]"
                : "border border-[var(--border-strong)] bg-white text-[var(--foreground-muted)]"
            }
          >
            {settingsDirty ? "有未保存改动" : "已同步"}
          </Chip>
          <Button
            startContent={settingsSaved ? <Check size={16} /> : <Save size={16} />}
            isLoading={settingsSaving}
            onPress={handleSaveSettings}
            className={`bauhaus-button !px-4 !py-3 !text-[11px] ${
              settingsSaved ? "bauhaus-button-yellow" : "bauhaus-button-blue"
            }`}
          >
            {settingsSaved ? "已保存" : "保存其他设置"}
          </Button>
        </div>
      </div>

      <Modal isOpen={isEditorOpen} onClose={onEditorClose} size="3xl" placement="center" scrollBehavior="inside">
        <ModalContent className={bauhausModalContentClassName}>
          <ModalHeader className="border-b-2 border-[var(--border-strong)] px-6 py-5 text-xl font-black tracking-[-0.06em]">
            {editingConfigId ? "编辑模型配置" : "新增模型配置"}
          </ModalHeader>
          <ModalBody className="grid grid-cols-1 gap-4 overflow-y-auto px-6 py-6 md:grid-cols-2">
            <Autocomplete
              label="服务选择"
              variant="bordered"
              allowsCustomValue
              menuTrigger="manual"
              selectedKey={formProviderChoice === CUSTOM_OPTION ? null : formProviderChoice}
              value={formProviderChoice === CUSTOM_OPTION ? formCustomServiceName : resolvedFormServiceName}
              onInputChange={(value) => {
                if (providerSelectionRef.current) {
                  providerSelectionRef.current = false;
                  return;
                }
                handleServiceInputChange(value);
              }}
              onSelectionChange={(key) => {
                if (!key) return;
                providerSelectionRef.current = true;
                handleProviderChoiceChange(String(key));
              }}
              description={
                formProviderChoice === CUSTOM_OPTION
                  ? "当前为自定义服务，可直接编辑"
                  : "左侧可直接输入，右侧可展开预设服务列表"
              }
              isInvalid={Boolean(formErrors.service_name)}
              errorMessage={formErrors.service_name}
              placeholder="例如：DeepSeek"
              selectorButtonProps={{
                size: "sm",
                variant: "flat",
                className: "min-h-10 h-10 w-10 min-w-10 border border-[var(--border-strong)] bg-[#F0C020] text-[var(--foreground)]",
              }}
              inputProps={{
                classNames: bauhausAutocompleteInputClassNames,
              }}
              classNames={{
                base: "w-full",
                listboxWrapper: "max-h-56",
              }}
              listboxProps={{
                emptyContent: "暂无预设服务",
              }}
            >
              {providerSelectOptions.map((item) => (
                <AutocompleteItem key={item.id} textValue={item.label}>
                  <div className="flex flex-col">
                    <span className="font-medium text-[var(--foreground)]">{item.label}</span>
                    {item.description && <span className="text-xs text-[var(--foreground-muted)]">{item.description}</span>}
                  </div>
                </AutocompleteItem>
              ))}
            </Autocomplete>

            <Autocomplete
              label="模型选择"
              variant="bordered"
              allowsCustomValue
              menuTrigger="manual"
              selectedKey={formModelChoice === CUSTOM_OPTION ? null : formModelChoice}
              value={formModelChoice === CUSTOM_OPTION ? formCustomModel : resolvedFormModel}
              onInputChange={(value) => {
                if (modelSelectionRef.current) {
                  modelSelectionRef.current = false;
                  return;
                }
                handleModelInputChange(value);
              }}
              onSelectionChange={(key) => {
                if (!key) return;
                modelSelectionRef.current = true;
                setFormModelChoice(String(key));
                setFormCustomModel("");
              }}
              description={
                formModelChoice === CUSTOM_OPTION
                  ? "当前为自定义模型，可直接编辑"
                  : "左侧可直接输入，右侧可展开预设模型列表"
              }
              isInvalid={Boolean(formErrors.model)}
              errorMessage={formErrors.model}
              placeholder="例如：deepseek-v4-flash"
              selectorButtonProps={{
                size: "sm",
                variant: "flat",
                className: "min-h-10 h-10 w-10 min-w-10 border border-[var(--border-strong)] bg-[#F0C020] text-[var(--foreground)]",
              }}
              inputProps={{
                classNames: bauhausAutocompleteInputClassNames,
              }}
              classNames={{
                base: "w-full",
                listboxWrapper: "max-h-56",
              }}
              listboxProps={{
                emptyContent: "暂无预设模型",
              }}
            >
              {modelSelectOptions.map((item) => (
                <AutocompleteItem key={item.id} textValue={item.label}>
                  <div className="flex flex-col">
                    <span className="font-medium text-[var(--foreground)]">{item.label}</span>
                    {item.description && <span className="text-xs text-[var(--foreground-muted)]">{item.description}</span>}
                  </div>
                </AutocompleteItem>
              ))}
            </Autocomplete>

            <div className="flex items-center gap-2 md:col-span-2">
              <FetchModelsButton
                baseUrl={formUrlChoice === CUSTOM_OPTION ? formBaseUrl : resolvedFormBaseUrl}
                apiKey={formApiKey}
                onModelsFetched={(models) => {
                  if (models.length > 0) {
                    const options: SelectOption[] = models.map((m) => ({
                      id: m.id,
                      label: m.name || m.id,
                      description: m.owned_by || "",
                    }));
                    setFetchedModelOptions(options);
                    setFormModelChoice(models[0].id);
                    setFormCustomModel("");
                  }
                }}
              />
              <span className="text-xs text-[var(--foreground-muted)]">根据接口地址和密钥获取可用模型列表</span>
            </div>

            <Autocomplete
              label="接口地址选择"
              variant="bordered"
              allowsCustomValue
              menuTrigger="manual"
              selectedKey={formUrlChoice === CUSTOM_OPTION ? null : formUrlChoice}
              value={formUrlChoice === CUSTOM_OPTION ? formBaseUrl : resolvedFormBaseUrl}
              onInputChange={(value) => {
                if (urlSelectionRef.current) {
                  urlSelectionRef.current = false;
                  return;
                }
                handleUrlInputChange(value);
              }}
              onSelectionChange={(key) => {
                if (!key) return;
                urlSelectionRef.current = true;
                const value = String(key);
                setFormUrlChoice(value);
                setFormBaseUrl(value);
              }}
              description={
                formUrlChoice === CUSTOM_OPTION
                  ? "当前为自定义 URL，可直接编辑"
                  : "左侧可直接输入，右侧可展开预设 URL 列表"
              }
              isInvalid={Boolean(formErrors.base_url)}
              errorMessage={formErrors.base_url}
              placeholder="https://..."
              selectorButtonProps={{
                size: "sm",
                variant: "flat",
                className: "min-h-10 h-10 w-10 min-w-10 border border-[var(--border-strong)] bg-[#F0C020] text-[var(--foreground)]",
              }}
              inputProps={{
                classNames: bauhausAutocompleteInputClassNames,
              }}
              classNames={{
                base: "w-full",
                listboxWrapper: "max-h-56",
              }}
              listboxProps={{
                emptyContent: "暂无预设 URL",
              }}
            >
              {urlSelectOptions.map((item) => (
                <AutocompleteItem key={item.id} textValue={item.label}>
                  <div className="flex flex-col">
                    <span className="font-medium text-[var(--foreground)]">{item.label}</span>
                    {item.description && <span className="text-xs text-[var(--foreground-muted)]">{item.description}</span>}
                  </div>
                </AutocompleteItem>
              ))}
            </Autocomplete>

            <Input
              label="API 密钥"
              variant="bordered"
              value={formApiKey}
              onValueChange={setFormApiKey}
              placeholder={resolvedFormProviderId === "ollama" ? "Ollama 无需密钥" : "sk-... 或 env:MY_API_KEY"}
              type={showFormApiKey ? "text" : "password"}
              isDisabled={resolvedFormProviderId === "ollama"}
              isInvalid={Boolean(formErrors.api_key)}
              errorMessage={formErrors.api_key}
              classNames={bauhausFieldClassNames}
              endContent={
                <button
                  type="button"
                  onClick={() => setShowFormApiKey((prev) => !prev)}
                  className="text-[var(--foreground-muted)] hover:text-[var(--foreground-muted)]"
                  aria-label={showFormApiKey ? "隐藏访问密钥" : "显示访问密钥"}
                  aria-pressed={showFormApiKey}
                >
                  {showFormApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              }
            />

            <Checkbox isSelected={formIsActive} onValueChange={setFormIsActive} className="md:col-span-2">
              设为当前激活配置
            </Checkbox>

            <Divider className="my-1 border-[var(--border-strong)]/10 md:col-span-2" />
            <p className="text-xs font-medium text-[var(--foreground-muted)] md:col-span-2">
              所有字段均必填。服务名称、模型名称、接口地址均支持预设选择和手动输入。
            </p>
          </ModalBody>
          <ModalFooter className="border-t-2 border-[var(--border-strong)] px-6 py-5">
            <Button
              variant="light"
              className="bauhaus-button bauhaus-button-outline !px-4 !py-3 !text-[11px]"
              onPress={onEditorClose}
            >
              取消
            </Button>
            <Button
              className="bauhaus-button bauhaus-button-blue !px-4 !py-3 !text-[11px]"
              onPress={handleSubmitEditor}
            >
              保存
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal isOpen={isDeleteOpen} onClose={onDeleteClose} size="sm" placement="center">
        <ModalContent className={bauhausModalContentClassName}>
          <ModalHeader className="border-b-2 border-[var(--border-strong)] bg-[#F0C020] px-6 py-5 text-xl font-black tracking-[-0.06em]">
            确认删除
          </ModalHeader>
          <ModalBody className="px-6 py-6">
            <p className="text-sm font-medium leading-relaxed text-[var(--foreground-muted)]">
              确定删除当前配置“{selectedConfig?.service_name || "未命名配置"}”吗？此操作不可撤销。
            </p>
          </ModalBody>
          <ModalFooter className="border-t-2 border-[var(--border-strong)] px-6 py-5">
            <Button
              variant="light"
              className="bauhaus-button bauhaus-button-outline !px-4 !py-3 !text-[11px]"
              onPress={onDeleteClose}
            >
              取消
            </Button>
            <Button
              className="bauhaus-button bauhaus-button-red !px-4 !py-3 !text-[11px]"
              onPress={handleDeleteConfig}
            >
              删除
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </motion.div>
  );
}
