"use client";

// 输入框底栏：模型胶囊（服务 › 模型 › 思考强度 三级级联）+ 模式胶囊。
// 级联与强度判定移植自 avabbbb/Flovart@28c79bf:components/agent/AgentModelPicker.tsx（MIT）的
// ThinkingSubmenu / supportedThinkingLevels；OfferU 里强度档位由后端
// GET /api/agent/runtime/models 按服务 / 模型给出（packages/core/src/llm-reasoning.ts），这里不写死。
// 外观沿用 OfferU 的 Menu（浅色玻璃、Radix 键盘：↑↓ 移动、→/Enter 展开、←/Esc 收回）。

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Hand, Settings, Sparkles, Zap } from "lucide-react";
import { Menu, type MenuItem } from "@/components/ui";
import { agentRuntimeApi, type AgentModelService } from "@/lib/api";
import { MODEL_SETTINGS_ROUTE } from "@/lib/agentRecovery";

export type ReasoningEffort = "" | "minimal" | "low" | "medium" | "high";
export type ApprovalMode = "auto" | "ask";

export interface ComposerOptions {
  llmConfigId: string;
  /** Model id inside the chosen service; "" = the service's configured model. */
  model: string;
  reasoningEffort: ReasoningEffort;
  approvalMode: ApprovalMode;
}

const STORAGE_KEY = "offeru.agent.composer";
const DEFAULT_OPTIONS: ComposerOptions = { llmConfigId: "", model: "", reasoningEffort: "", approvalMode: "auto" };

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

/** Services → models → efforts, re-read whenever the menu opens (settings may have changed). */
export function useModelCatalog(refreshKey: unknown) {
  const [services, setServices] = useState<AgentModelService[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    agentRuntimeApi
      .models()
      .then((result) => { if (!cancelled) setServices(result.services || []); })
      .catch(() => { if (!cancelled) setServices([]); });
    return () => { cancelled = true; };
  }, [refreshKey]);
  return services;
}

/** What the next run actually uses: the chosen service / model, and an effort only if that model offers it. */
export function resolveComposerChoice(services: AgentModelService[] | null, options: ComposerOptions) {
  const list = services || [];
  const service = list.find((item) => item.config_id === options.llmConfigId) || list.find((item) => item.active) || list[0];
  const modelId = (service && options.llmConfigId === service.config_id && options.model) || service?.default_model || "";
  const model = service?.models.find((item) => item.id === modelId);
  const effort = model?.efforts.find((item) => item.id === options.reasoningEffort);
  return { service, modelId, model, effort, reasoningEffort: (effort?.id || "") as ReasoningEffort };
}

/** The menu tree: service › model › effort (a model with no efforts is a leaf). */
export function modelMenuItems(
  services: AgentModelService[],
  options: ComposerOptions,
  onChange: (patch: Partial<ComposerOptions>) => void,
  toSettings: () => void,
): MenuItem[] {
  const current = resolveComposerChoice(services, options);
  if (!services.length) {
    return [{ label: "还没有模型", description: "去设置里添加一个", icon: <Settings size={16} strokeWidth={1.75} />, onSelect: toSettings }];
  }
  const pick = (configId: string, model: string, reasoningEffort: ReasoningEffort) => onChange({ llmConfigId: configId, model, reasoningEffort });
  return [
    { heading: "服务" },
    ...services.map((service): MenuItem => {
      const serviceChosen = service.config_id === current.service?.config_id;
      return {
        label: service.service_name,
        description: serviceChosen ? current.model?.name || current.modelId : service.default_model,
        checked: serviceChosen,
        testId: `agent-model-service-${service.config_id}`,
        items: [
          { heading: "模型" },
          ...service.models.map((model): MenuItem => {
            const modelChosen = serviceChosen && model.id === current.modelId;
            const description = model.name !== model.id ? model.id : undefined;
            if (!model.efforts.length) {
              return { label: model.name, description, checked: modelChosen, onSelect: () => pick(service.config_id, model.id, "") };
            }
            return {
              label: model.name,
              description: modelChosen && current.effort ? `思考 · ${current.effort.label}` : description,
              checked: modelChosen,
              testId: `agent-model-${model.id}`,
              items: [
                { heading: "思考强度" },
                { label: "默认", description: "不指定，由服务决定", checked: modelChosen && !current.effort, onSelect: () => pick(service.config_id, model.id, "") },
                ...model.efforts.map((level): MenuItem => ({
                  label: `${level.label} · ${level.hint}`,
                  checked: modelChosen && current.effort?.id === level.id,
                  onSelect: () => pick(service.config_id, model.id, level.id),
                })),
              ],
            };
          }),
        ],
      };
    }),
    "separator",
    { label: "管理模型", icon: <Settings size={16} strokeWidth={1.75} />, onSelect: toSettings },
  ];
}

export function AgentComposerControls({
  options,
  onChange,
  services,
  modelOpen,
  onModelOpenChange,
}: {
  options: ComposerOptions;
  onChange: (patch: Partial<ComposerOptions>) => void;
  services: AgentModelService[] | null;
  modelOpen: boolean;
  onModelOpenChange: (open: boolean) => void;
}) {
  // 模型 / 模式两个胶囊都是 components/ui 的 Menu（浅色玻璃、键盘、Esc、焦点归还交给 Radix），在输入框上方弹出。
  const router = useRouter();
  const toSettings = () => router.push(MODEL_SETTINGS_ROUTE);
  const current = resolveComposerChoice(services, options);
  const mode = MODES.find((item) => item.id === options.approvalMode) || MODES[1];
  const ModeIcon = mode.id === "ask" ? Hand : Zap;

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
      <Menu label="服务、模型和思考强度" side="top" align="start" open={modelOpen} onOpenChange={onModelOpenChange}
        items={modelMenuItems(services || [], options, onChange, toSettings)} trigger={
          <button type="button" className="agent-composer-tool" title="服务、模型和思考强度" data-testid="agent-model-trigger">
            <Sparkles size={15} strokeWidth={1.75} />
            <span className="truncate">{current.model?.name || current.modelId || "模型"}</span>
            {current.effort && <span className="agent-composer-tool-sub">{current.effort.label}</span>}
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
