"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Hand, Settings, Sparkles, Zap } from "lucide-react";
import { Menu, type MenuItem } from "@/components/ui";
import { configApi } from "@/lib/api";
import { MODEL_SETTINGS_ROUTE } from "@/lib/agentRecovery";

export type ReasoningEffort = "" | "low" | "medium" | "high";
export type ApprovalMode = "auto" | "ask";

export interface ComposerOptions {
  llmConfigId: string;
  reasoningEffort: ReasoningEffort;
  approvalMode: ApprovalMode;
}

interface ModelOption {
  id: string;
  label: string;
  model: string;
  active: boolean;
}

/** One entry of llm_api_configs in the /api/config/ response. */
interface LlmConfigItem {
  id: string;
  provider_id?: string;
  service_name?: string;
  model?: string;
  is_active?: boolean;
}

function isLlmConfig(value: unknown): value is LlmConfigItem {
  return typeof value === "object" && value !== null && "id" in value && typeof value.id === "string";
}

const STORAGE_KEY = "offeru.agent.composer";
const DEFAULT_OPTIONS: ComposerOptions = { llmConfigId: "", reasoningEffort: "", approvalMode: "auto" };

const EFFORTS: Array<{ id: ReasoningEffort; label: string; short: string }> = [
  { id: "", label: "默认", short: "" },
  { id: "low", label: "低", short: "更快" },
  { id: "medium", label: "中", short: "多数任务" },
  { id: "high", label: "高", short: "想得更深" },
];

const MODES: Array<{ id: ApprovalMode; label: string; hint: string }> = [
  { id: "ask", label: "询问", hint: "每一步写入都先问你" },
  { id: "auto", label: "自动", hint: "可撤销的直接做，不可撤销的才问你" },
];

/** The composer's model / effort / mode choice, kept across reloads. */
export function useComposerOptions() {
  const [options, setOptions] = useState<ComposerOptions>(DEFAULT_OPTIONS);
  useEffect(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "null");
      if (stored) setOptions({ ...DEFAULT_OPTIONS, ...stored });
    } catch {
      // 读不到就用默认值。
    }
  }, []);
  const update = (patch: Partial<ComposerOptions>) => {
    setOptions((current) => {
      const next = { ...current, ...patch };
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // 隐私模式写不进去只影响下次默认值。
      }
      return next;
    });
  };
  return [options, update] as const;
}

function useModelOptions(refreshKey: boolean) {
  const [models, setModels] = useState<ModelOption[]>([]);
  useEffect(() => {
    let cancelled = false;
    configApi
      .get()
      .then((config: unknown) => {
        if (cancelled) return;
        const record = typeof config === "object" && config !== null ? config : {};
        const configs = "llm_api_configs" in record && Array.isArray(record.llm_api_configs) ? record.llm_api_configs : [];
        const activeId = "active_llm_config_id" in record ? String(record.active_llm_config_id ?? "") : "";
        setModels(
          configs.filter(isLlmConfig).map((item) => ({
            id: item.id,
            label: item.service_name || item.provider_id || "模型",
            model: item.model || "",
            active: item.id === activeId || Boolean(item.is_active),
          })),
        );
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);
  return models;
}

export function AgentComposerControls({
  options,
  onChange,
}: {
  options: ComposerOptions;
  onChange: (patch: Partial<ComposerOptions>) => void;
}) {
  // 模型 / 模式两个胶囊都是 components/ui 的 Menu（浅色玻璃、键盘、Esc、焦点归还交给 Radix），在输入框上方弹出。
  const [modelOpen, setModelOpen] = useState(false);
  const router = useRouter();
  const models = useModelOptions(modelOpen);

  const current = models.find((model) => model.id === options.llmConfigId) || models.find((model) => model.active) || models[0];
  const effort = EFFORTS.find((item) => item.id === options.reasoningEffort);
  const mode = MODES.find((item) => item.id === options.approvalMode) || MODES[1];
  const ModeIcon = mode.id === "ask" ? Hand : Zap;
  const toSettings = () => router.push(MODEL_SETTINGS_ROUTE);

  const modelItems: MenuItem[] = models.length
    ? [
        { heading: "模型" },
        ...models.map((model): MenuItem => ({
          label: model.model || model.label,
          description: model.label,
          checked: model.id === current?.id,
          onSelect: () => onChange({ llmConfigId: model.id }),
        })),
        "separator",
        { heading: "思考强度" },
        // 思考强度一行一个字 + 短说明，不放第二行，免得菜单太长。
        ...EFFORTS.map((item): MenuItem => ({
          label: item.short ? `${item.label} · ${item.short}` : item.label,
          checked: options.reasoningEffort === item.id,
          onSelect: () => onChange({ llmConfigId: current?.id ?? "", reasoningEffort: item.id }),
        })),
        "separator",
        { label: "管理模型", icon: <Settings size={16} strokeWidth={1.75} />, onSelect: toSettings },
      ]
    : [{ label: "还没有模型", description: "去设置里添加一个", icon: <Settings size={16} strokeWidth={1.75} />, onSelect: toSettings }];

  const modeItems: MenuItem[] = MODES.map((item) => {
    const Icon = item.id === "ask" ? Hand : Zap;
    return {
      label: item.label,
      description: item.hint,
      icon: <Icon size={16} strokeWidth={1.75} />,
      checked: item.id === mode.id,
      onSelect: () => onChange({ approvalMode: item.id }),
    };
  });

  return (
    <div className="agent-composer-tools">
      <Menu label="模型和思考强度" side="top" align="start" open={modelOpen} onOpenChange={setModelOpen} items={modelItems} trigger={
        <button type="button" className="agent-composer-tool" title="模型和思考强度">
          <Sparkles size={15} strokeWidth={1.75} />
          <span className="truncate">{current ? current.model || current.label : "模型"}</span>
          {options.reasoningEffort && <span className="agent-composer-tool-sub">{effort?.label}</span>}
          <ChevronDown size={12} strokeWidth={2} />
        </button>
      } />
      <Menu label="模式" side="top" align="start" items={modeItems} trigger={
        <button type="button" className="agent-composer-tool" title={mode.hint}>
          <ModeIcon size={15} strokeWidth={1.75} />
          <span>{mode.label}</span>
          <ChevronDown size={12} strokeWidth={2} />
        </button>
      } />
    </div>
  );
}
