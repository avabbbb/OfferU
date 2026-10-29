"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check, ChevronDown, ChevronRight, Hand, Sparkles, Zap } from "lucide-react";
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

const EFFORTS: Array<{ id: ReasoningEffort; label: string; hint: string }> = [
  { id: "", label: "默认", hint: "不指定，按模型自己的设置" },
  { id: "low", label: "低", hint: "快，适合简单问题" },
  { id: "medium", label: "中", hint: "大多数任务" },
  { id: "high", label: "高", hint: "慢，想得更深" },
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
  const [menu, setMenu] = useState<"" | "model" | "mode">("");
  const [effortFor, setEffortFor] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const models = useModelOptions(menu === "model");

  useEffect(() => {
    if (!menu) return;
    const closeOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenu("");
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setMenu("");
    };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menu]);

  const current = models.find((model) => model.id === options.llmConfigId) || models.find((model) => model.active) || models[0];
  const effort = EFFORTS.find((item) => item.id === options.reasoningEffort);
  const mode = MODES.find((item) => item.id === options.approvalMode) || MODES[1];
  const toggle = (next: "model" | "mode") => {
    setEffortFor(current?.id || "");
    setMenu((value) => (value === next ? "" : next));
  };
  const ModeIcon = mode.id === "ask" ? Hand : Zap;

  return (
    <div ref={rootRef} className="agent-composer-tools">
      <div className="agent-composer-menu-anchor">
        <button
          type="button"
          className="agent-composer-tool"
          aria-haspopup="menu"
          aria-expanded={menu === "model"}
          title="模型和思考强度"
          onClick={() => toggle("model")}
        >
          <Sparkles size={15} strokeWidth={1.75} />
          <span className="truncate">{current ? current.model || current.label : "模型"}</span>
          {options.reasoningEffort && <span className="agent-composer-tool-sub">{effort?.label}</span>}
          <ChevronDown size={12} strokeWidth={2} />
        </button>
        {menu === "model" && (
          <div className="agent-composer-menu" role="menu" aria-label="模型">
            {models.length === 0 && (
              <Link href={MODEL_SETTINGS_ROUTE} role="menuitem" className="agent-composer-menu-item">
                <span className="agent-composer-menu-text">
                  <strong>还没有模型</strong>
                  <small>去设置里添加一个</small>
                </span>
              </Link>
            )}
            {models.map((model) => {
              const selected = model.id === current?.id;
              const expanded = effortFor === model.id;
              return (
                <div key={model.id}>
                  <button
                    type="button"
                    role="menuitem"
                    aria-expanded={expanded}
                    className="agent-composer-menu-item"
                    onClick={() => setEffortFor(expanded ? "" : model.id)}
                  >
                    <span className="agent-composer-menu-text">
                      <strong>{model.model || model.label}</strong>
                      <small>{model.label}</small>
                    </span>
                    {selected && <Check size={14} />}
                    <ChevronRight size={13} className={"agent-composer-chevron" + (expanded ? " is-open" : "")} />
                  </button>
                  {expanded && (
                    <div className="agent-composer-effort" role="group" aria-label="思考强度">
                      {EFFORTS.map((item) => {
                        const on = selected && options.reasoningEffort === item.id;
                        return (
                          <button
                            key={item.id || "default"}
                            type="button"
                            role="menuitemradio"
                            aria-checked={on}
                            title={item.hint}
                            className={"agent-composer-effort-option" + (on ? " is-on" : "")}
                            onClick={() => {
                              onChange({ llmConfigId: model.id, reasoningEffort: item.id });
                              setMenu("");
                            }}
                          >
                            {item.label}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
            <Link href={MODEL_SETTINGS_ROUTE} className="agent-composer-menu-foot">
              管理模型
            </Link>
          </div>
        )}
      </div>
      <div className="agent-composer-menu-anchor">
        <button
          type="button"
          className="agent-composer-tool"
          aria-haspopup="menu"
          aria-expanded={menu === "mode"}
          title={mode.hint}
          onClick={() => toggle("mode")}
        >
          <ModeIcon size={15} strokeWidth={1.75} />
          <span>{mode.label}</span>
          <ChevronDown size={12} strokeWidth={2} />
        </button>
        {menu === "mode" && (
          <div className="agent-composer-menu" role="menu" aria-label="模式">
            {MODES.map((item) => {
              const Icon = item.id === "ask" ? Hand : Zap;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={item.id === mode.id}
                  className="agent-composer-menu-item"
                  onClick={() => {
                    onChange({ approvalMode: item.id });
                    setMenu("");
                  }}
                >
                  <Icon size={16} strokeWidth={1.75} />
                  <span className="agent-composer-menu-text">
                    <strong>{item.label}</strong>
                    <small>{item.hint}</small>
                  </span>
                  {item.id === mode.id && <Check size={14} />}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
