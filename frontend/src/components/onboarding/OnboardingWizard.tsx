"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  Autocomplete,
  AutocompleteItem,
  Button,
  Chip,
  Input,
  Card,
  CardBody,
  Textarea,
} from "@nextui-org/react";
import {
  Sparkles,
  Key,
  Briefcase,
  ArrowRight,
  ArrowLeft,
  Upload,
  X,
  Eye,
  EyeOff,
  PenTool,
  CheckCircle2,
} from "lucide-react";
import { bauhausFieldClassNames } from "@/lib/bauhaus";
import {
  createResume,
  createProfileSection,
  importProfileResume,
  updateConfig,
  useConfig,
  type ProfileImportResult,
} from "@/lib/hooks";
import { profileApi, resumeApi } from "@/lib/api";
import { AI_IMPORT_PROMPT, parseAiImportJson } from "@/app/profile/components/AIImportModal";
import {
  groupProfileCandidatesForResume,
  normalizeProfileCategoryKey,
  resolveProfileCategoryLabel,
} from "@/lib/profileSchema";

interface OnboardingWizardProps {
  onComplete: () => void;
  onSkip: () => void;
}

const TOTAL_STEPS = 4;
const CUSTOM_OPTION = "__custom__";

type StarterQuizOption = {
  value: string;
  label: string;
  description: string;
  traits: string[];
  roles: string[];
  proofAngles: string[];
};

type StarterQuizQuestion = {
  id: string;
  title: string;
  prompt: string;
  options: StarterQuizOption[];
};

const STARTER_QUIZ_QUESTIONS: StarterQuizQuestion[] = [
  {
    id: "work_style",
    title: "遇到一件新任务，你更像哪一种？",
    prompt: "选更像你的那边，不需要想标准答案。",
    options: [
      {
        value: "organizer",
        label: "先拆目标和节奏",
        description: "我会把任务、人和时间排清楚。",
        traits: ["组织推进型", "执行闭环"],
        roles: ["运营", "项目助理", "产品运营"],
        proofAngles: ["流程推进", "跨方协作", "交付结果"],
      },
      {
        value: "researcher",
        label: "先找真实需求",
        description: "我会先问用户、同学或业务方卡在哪。",
        traits: ["用户洞察型", "问题拆解"],
        roles: ["用户研究", "产品助理", "市场洞察"],
        proofAngles: ["用户反馈", "需求分析", "问题定义"],
      },
    ],
  },
  {
    id: "output_style",
    title: "哪种产出更像你的强项？",
    prompt: "这会影响简历后面突出内容、数据还是产品感。",
    options: [
      {
        value: "content",
        label: "能被看见的内容",
        description: "文章、视频、活动文案、账号内容都算。",
        traits: ["内容表达型", "传播敏感"],
        roles: ["内容运营", "品牌市场", "新媒体运营"],
        proofAngles: ["内容作品", "传播数据", "受众反馈"],
      },
      {
        value: "data",
        label: "能说清问题的数据",
        description: "我喜欢用表格、对比和指标找下一步。",
        traits: ["数据分析型", "理性归因"],
        roles: ["商业分析", "数据运营", "产品运营"],
        proofAngles: ["数据分析", "指标变化", "决策依据"],
      },
    ],
  },
  {
    id: "team_role",
    title: "团队里你常常承担什么角色？",
    prompt: "Agent 后续会按这个方向追问你的经历证据。",
    options: [
      {
        value: "connector",
        label: "把资源和人拉起来",
        description: "我会沟通、协调、推进合作。",
        traits: ["资源整合型", "沟通协调"],
        roles: ["BD", "活动运营", "校园招聘"],
        proofAngles: ["资源拓展", "合作对象", "活动规模"],
      },
      {
        value: "builder",
        label: "把方案和作品做扎实",
        description: "我愿意沉下去打磨方案、产品或研究。",
        traits: ["方案打磨型", "作品导向"],
        roles: ["产品助理", "行业研究", "策划"],
        proofAngles: ["方案产出", "作品链接", "方法论"],
      },
    ],
  },
  {
    id: "proof_style",
    title: "你更容易拿出哪种证明？",
    prompt: "简历里最缺的通常就是这些 proof points。",
    options: [
      {
        value: "numbers",
        label: "数字结果",
        description: "人数、金额、增长、排名、周期、覆盖范围。",
        traits: ["结果证明型", "指标意识"],
        roles: ["增长运营", "数据运营", "商业分析"],
        proofAngles: ["人数/金额", "增长比例", "排名/周期"],
      },
      {
        value: "portfolio",
        label: "作品案例",
        description: "文章、报告、Demo、原型、活动物料。",
        traits: ["作品证明型", "案例表达"],
        roles: ["内容策划", "产品助理", "市场策划"],
        proofAngles: ["作品案例", "方案文档", "展示链接"],
      },
    ],
  },
  {
    id: "job_strategy",
    title: "你现在更想怎么投？",
    prompt: "这会影响推荐方向是稳入口还是冲成长。",
    options: [
      {
        value: "stable",
        label: "先拿稳入口",
        description: "希望方向清楚、门槛匹配、能尽快投起来。",
        traits: ["稳健求职型", "匹配优先"],
        roles: ["运营", "HR", "市场助理"],
        proofAngles: ["岗位匹配点", "基础能力", "可迁移经验"],
      },
      {
        value: "growth",
        label: "愿意冲成长方向",
        description: "可以接受学习曲线，想往 AI、产品、增长靠。",
        traits: ["成长探索型", "高潜迁移"],
        roles: ["AI 产品运营", "产品助理", "增长运营"],
        proofAngles: ["学习速度", "迁移能力", "AI 工具使用"],
      },
    ],
  },
];

function rankStarterItems(items: string[], limit: number) {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) || 0) + 1);
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([item]) => item)
    .slice(0, limit);
}

function buildStarterCareerProfile(options: StarterQuizOption[]) {
  const traits = rankStarterItems(options.flatMap((option) => option.traits), 4);
  const suggestedRoles = rankStarterItems(options.flatMap((option) => option.roles), 5);
  const proofAngles = Array.from(new Set(options.flatMap((option) => option.proofAngles))).slice(0, 6);
  const archetype = traits.length >= 2 ? `${traits[0]} + ${traits[1]}` : traits[0] || "探索型";
  return {
    archetype,
    traits,
    suggestedRoles,
    proofAngles,
    summary:
      traits.length > 0
        ? `你的简历更适合围绕「${traits.slice(0, 2).join(" / ")}」来讲，后面优先补 ${proofAngles.slice(0, 3).join("、") || "可验证成果"}。`
        : "先完成这组选择，我会把答案转成岗位方向和经历追问线索。",
  };
}

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

const FALLBACK_PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    description: "国际主流服务",
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
    description: "成本友好的中文模型",
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
    description: "阿里云百炼",
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
    description: "聚合模型服务",
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
    description: "Gemini 兼容接口",
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
    description: "智谱开放平台",
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
    description: "本地推理服务",
    default_base_url: "http://localhost:11434/v1",
    models: [
      { id: "qwen2.5:7b", name: "Qwen2.5 7B" },
      { id: "llama3.1:8b", name: "Llama 3.1 8B" },
    ],
    key_prefix: "",
  },
];

const DEFAULT_PROVIDER_PRESET =
  FALLBACK_PROVIDER_PRESETS.find((preset) => preset.id === "deepseek") || FALLBACK_PROVIDER_PRESETS[0];

const RESUME_TEMPLATES = [
  { id: "tech", label: "技术求职" },
  { id: "business", label: "商科求职" },
  { id: "general", label: "通用模板" },
];

const bauhausAutocompleteClassNames = {
  popoverContent:
    "rounded-none border border-black/20 bg-[var(--surface)] text-black shadow-[0_10px_24px_rgba(18,18,18,0.08)]",
  listboxWrapper: "max-h-56 bg-[#F0F0F0] p-1",
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

function toLegacyOllamaBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/v1")) {
    return trimmed.slice(0, -3);
  }
  return trimmed;
}

export function OnboardingWizard({ onComplete, onSkip }: OnboardingWizardProps) {
  const router = useRouter();
  const { data: configData } = useConfig();
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState(1);

  const [providerPresets, setProviderPresets] = useState<ProviderPreset[]>(FALLBACK_PROVIDER_PRESETS);
  const [formProviderChoice, setFormProviderChoice] = useState<string>(DEFAULT_PROVIDER_PRESET.id);
  const [formCustomServiceName, setFormCustomServiceName] = useState("");
  const [formModelChoice, setFormModelChoice] = useState<string>(DEFAULT_PROVIDER_PRESET.models[0]?.id || "");
  const [formCustomModel, setFormCustomModel] = useState("");
  const [formUrlChoice, setFormUrlChoice] = useState<string>(DEFAULT_PROVIDER_PRESET.default_base_url);
  const [formBaseUrl, setFormBaseUrl] = useState(DEFAULT_PROVIDER_PRESET.default_base_url);
  const [formApiKey, setFormApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [configSaved, setConfigSaved] = useState(false);
  const [configSaveError, setConfigSaveError] = useState("");
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const providerSelectionRef = useRef(false);
  const modelSelectionRef = useRef(false);
  const urlSelectionRef = useRef(false);

  const [quizAnswers, setQuizAnswers] = useState<Record<string, string>>({});
  const [resumeMode, setResumeMode] = useState<"choose" | "create" | "upload">("choose");
  const [userName, setUserName] = useState("");
  const [school, setSchool] = useState("");
  const [major, setMajor] = useState("");
  const [targetRole, setTargetRole] = useState("");
  const [experienceNotes, setExperienceNotes] = useState(["", "", ""]);
  const [selectedTemplate, setSelectedTemplate] = useState("general");
  const [creatingResume, setCreatingResume] = useState(false);
  const [resumeCreated, setResumeCreated] = useState(false);
  const [resumeCreateError, setResumeCreateError] = useState("");
  const [uploadingFile, setUploadingFile] = useState(false);
  const [uploadResult, setUploadResult] = useState<string | null>(null);
  const [resumeImportResult, setResumeImportResult] = useState<ProfileImportResult | null>(null);
  const [selectedImportCandidates, setSelectedImportCandidates] = useState<number[]>([]);
  const [aiImportStep, setAiImportStep] = useState(0);
  const [aiImportCopied, setAiImportCopied] = useState(false);
  const [aiImportJsonText, setAiImportJsonText] = useState("");
  const [aiImportError, setAiImportError] = useState("");
  const [aiImportParsing, setAiImportParsing] = useState(false);

  const goNext = () => {
    setDirection(1);
    setStep((value) => Math.min(value + 1, TOTAL_STEPS - 1));
  };

  const goBack = () => {
    setDirection(-1);
    setStep((value) => Math.max(value - 1, 0));
  };

  const handleQuizNext = () => {
    const firstRole = careerProfile.suggestedRoles[0] || "";
    if (!targetRole && firstRole) {
      setTargetRole(firstRole);
    }
    goNext();
  };

  const currentFormPreset = useMemo(
    () => providerPresets.find((preset) => preset.id === formProviderChoice),
    [providerPresets, formProviderChoice]
  );

  const formModelOptions = useMemo(() => currentFormPreset?.models || [], [currentFormPreset]);
  const providerOptions = useMemo(
    () => providerPresets.map((preset) => ({ id: preset.id, name: preset.name, description: preset.description || "" })),
    [providerPresets]
  );
  const modelOptions = useMemo(
    () => formModelOptions.map((model) => ({ id: model.id, name: model.name, description: model.description || "" })),
    [formModelOptions]
  );
  const urlOptions = useMemo(() => {
    if (!currentFormPreset?.default_base_url) {
      return [] as { id: string; name: string }[];
    }
    return [{ id: currentFormPreset.default_base_url, name: `默认地址 · ${currentFormPreset.default_base_url}` }];
  }, [currentFormPreset]);

  const selectedQuizOptions = useMemo(
    () =>
      STARTER_QUIZ_QUESTIONS.flatMap((question) => {
        const option = question.options.find((item) => item.value === quizAnswers[question.id]);
        return option ? [{ question, option }] : [];
      }),
    [quizAnswers]
  );
  const careerProfile = useMemo(
    () => buildStarterCareerProfile(selectedQuizOptions.map((item) => item.option)),
    [selectedQuizOptions]
  );
  const quizComplete = selectedQuizOptions.length === STARTER_QUIZ_QUESTIONS.length;
  const experiencePlaceholders = [
    `例：我做过一个${careerProfile.proofAngles[0] || "项目/活动"}，当时目标是...我负责...最后...`,
    `例：一段最能证明${careerProfile.traits[0] || "能力"}的经历，背景是...动作是...结果是...`,
    `例：我能补充一个${careerProfile.proofAngles[1] || "作品/数据"}，人数/金额/增长/反馈是...`,
  ];

  const resolvedFormServiceName = useMemo(() => {
    if (formProviderChoice === CUSTOM_OPTION) return formCustomServiceName.trim();
    return currentFormPreset?.name || "";
  }, [currentFormPreset, formCustomServiceName, formProviderChoice]);

  const resolvedFormProviderId = useMemo(() => {
    if (formProviderChoice === CUSTOM_OPTION) return normalizeProviderId(formCustomServiceName);
    return formProviderChoice;
  }, [formCustomServiceName, formProviderChoice]);

  const resolvedFormModel = useMemo(() => {
    if (formModelChoice === CUSTOM_OPTION) return formCustomModel.trim();
    return formModelChoice;
  }, [formCustomModel, formModelChoice]);

  const resolvedFormBaseUrl = useMemo(() => {
    if (formUrlChoice === CUSTOM_OPTION) return formBaseUrl.trim();
    return formUrlChoice.trim();
  }, [formBaseUrl, formUrlChoice]);

  useEffect(() => {
    const presetsFromServer = Array.isArray((configData as any)?.provider_presets)
      ? ((configData as any).provider_presets as ProviderPreset[])
      : [];
    if (presetsFromServer.length > 0) {
      setProviderPresets(presetsFromServer);
    }
  }, [configData]);

  const validateAiForm = (): Record<string, string> => {
    const errors: Record<string, string> = {};
    if (!resolvedFormServiceName) errors.service_name = "服务商不能为空";
    if (!resolvedFormModel) errors.model = "模型不能为空";
    if (!resolvedFormBaseUrl) {
      errors.base_url = "接口地址不能为空";
    } else if (!/^https?:\/\//i.test(resolvedFormBaseUrl)) {
      errors.base_url = "接口地址需以 http:// 或 https:// 开头";
    }
    if (resolvedFormProviderId !== "ollama") {
      if (!formApiKey.trim()) errors.api_key = "访问密钥不能为空";
      if (formApiKey.includes("*")) errors.api_key = "请填写完整密钥，不能使用脱敏值";
      const prefix = currentFormPreset?.key_prefix || "";
      if (prefix && formApiKey.trim() && !formApiKey.trim().startsWith(prefix)) {
        errors.api_key = `当前服务的密钥通常以 ${prefix} 开头`;
      }
    }
    return errors;
  };

  useEffect(() => {
    if (step !== 1) return;
    setFormErrors(validateAiForm());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, formProviderChoice, formCustomServiceName, formModelChoice, formCustomModel, formUrlChoice, formBaseUrl, formApiKey]);

  const resetAiStepStatus = () => {
    setConfigSaved(false);
    setConfigSaveError("");
  };

  const handleProviderChoiceChange = (value: string) => {
    resetAiStepStatus();
    setFormProviderChoice(value);

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

  const handleServiceInputChange = (value: string) => {
    resetAiStepStatus();
    if (formProviderChoice !== CUSTOM_OPTION) {
      setFormProviderChoice(CUSTOM_OPTION);
      setFormModelChoice(CUSTOM_OPTION);
      setFormCustomModel(resolvedFormModel);
      setFormUrlChoice(CUSTOM_OPTION);
      setFormBaseUrl(resolvedFormBaseUrl);
    }
    setFormCustomServiceName(value);
  };

  const handleModelInputChange = (value: string) => {
    resetAiStepStatus();
    if (formModelChoice !== CUSTOM_OPTION) {
      setFormCustomModel(resolvedFormModel);
      setFormModelChoice(CUSTOM_OPTION);
    }
    setFormCustomModel(value);
  };

  const handleUrlInputChange = (value: string) => {
    resetAiStepStatus();
    if (formUrlChoice !== CUSTOM_OPTION) {
      setFormBaseUrl(resolvedFormBaseUrl);
      setFormUrlChoice(CUSTOM_OPTION);
    }
    setFormBaseUrl(value);
  };

  const handleSaveAiConfig = async () => {
    const errors = validateAiForm();
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) {
      return;
    }

    setSavingConfig(true);
    setConfigSaveError("");

    const providerId = resolvedFormProviderId;
    const nextConfig = {
      id: createConfigId(),
      provider_id: providerId,
      service_name: resolvedFormServiceName,
      model: resolvedFormModel,
      base_url: normalizeBaseUrl(resolvedFormBaseUrl, providerId),
      api_key: providerId === "ollama" ? "" : formApiKey.trim(),
      is_active: true,
      extra_params: {},
    };

    const incomingConfigs = Array.isArray((configData as any)?.llm_api_configs)
      ? ((configData as any).llm_api_configs as any[])
      : [];

    const normalizedExisting = incomingConfigs
      .map((item) => {
        const itemProviderId = normalizeProviderId(String(item?.provider_id || item?.service_name || "custom"));
        return {
          id: String(item?.id || createConfigId()),
          provider_id: itemProviderId,
          service_name: String(item?.service_name || itemProviderId).trim(),
          model: String(item?.model || "").trim(),
          base_url: normalizeBaseUrl(String(item?.base_url || ""), itemProviderId),
          api_key: String(item?.api_key || ""),
          is_active: Boolean(item?.is_active),
          extra_params: (item?.extra_params || {}) as Record<string, string>,
        };
      })
      .filter((item) => item.service_name && item.model && item.base_url);

    const previousActiveId = String((configData as any)?.active_llm_config_id || "");
    const mergedConfigs = [
      ...normalizedExisting.filter((item) => item.id !== previousActiveId),
      nextConfig,
    ];

    const finalConfigs = mergedConfigs
      .map((item) => {
        const itemProviderId = normalizeProviderId(item.provider_id || item.service_name);
        return {
          ...item,
          provider_id: itemProviderId,
          service_name: item.service_name.trim(),
          model: item.model.trim(),
          base_url: normalizeBaseUrl(item.base_url, itemProviderId),
          api_key: itemProviderId === "ollama" ? "" : item.api_key.trim(),
          is_active: item.id === nextConfig.id,
        };
      })
      .filter((item) => item.service_name && item.model && item.base_url);

    const activeConfig = finalConfigs.find((item) => item.id === nextConfig.id) || null;
    const getProviderConfig = (targetProviderId: string) =>
      finalConfigs.find((item) => item.provider_id === targetProviderId) || null;

    const deepseekConfig = getProviderConfig("deepseek");
    const openaiConfig = getProviderConfig("openai");
    const qwenConfig = getProviderConfig("qwen");
    const siliconflowConfig = getProviderConfig("siliconflow");
    const geminiConfig = getProviderConfig("gemini");
    const zhipuConfig = getProviderConfig("zhipu");
    const ollamaConfig = getProviderConfig("ollama");

    try {
      await updateConfig({
        llm_api_configs: finalConfigs,
        active_llm_config_id: activeConfig?.id || "",
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
        ollama_base_url: toLegacyOllamaBaseUrl(
          ollamaConfig?.base_url || "http://localhost:11434/v1"
        ),
      });
      setConfigSaved(true);
      setTimeout(goNext, 600);
    } catch (error) {
      setConfigSaveError(error instanceof Error ? error.message : "保存失败，请稍后重试");
    } finally {
      setSavingConfig(false);
    }
  };

  const handleQuickCreate = async () => {
    if (!userName.trim()) return;
    setCreatingResume(true);
    setResumeCreateError("");

    try {
      const proofNotes = experienceNotes.map((item) => item.trim()).filter(Boolean);
      const templateTitles: Record<string, string> = {
        tech: "技术岗简历",
        business: "商科岗简历",
        general: "我的简历",
      };
      const careerProfilePayload = {
        ...careerProfile,
        target_role: targetRole.trim(),
        proof_notes: proofNotes,
        answers: selectedQuizOptions.reduce<Record<string, string>>((acc, item) => {
          acc[item.question.id] = item.option.label;
          return acc;
        }, {}),
      };

      await profileApi.update({
        name: userName.trim(),
        base_info_json: {
          name: userName.trim(),
          school: school.trim(),
          major: major.trim(),
          job_intention: targetRole.trim(),
          career_profile: careerProfilePayload,
        },
      });

      const profileEvidence = [
        ...(school.trim() || major.trim()
          ? [{
              section_type: "education",
              title: school.trim() || "教育经历",
              content_json: {
                school: school.trim(),
                major: major.trim(),
                bullet: [school.trim(), major.trim()].filter(Boolean).join(" · "),
              },
            }]
          : []),
        ...proofNotes.map((note, index) => ({
          section_type: "experience",
          title: `经历素材 ${index + 1}`,
          content_json: {
            company: "",
            position: "",
            description: note,
            bullet: note,
          },
        })),
      ];
      for (const evidence of profileEvidence) {
        await createProfileSection({
          ...evidence,
          source: "onboarding",
          confidence: 1,
          tier: "verified_fact",
        });
      }

      for (const role of careerProfile.suggestedRoles.slice(0, 3)) {
        try {
          await profileApi.createTargetRole({
            role_name: role,
            fit: role === targetRole.trim() ? "primary" : "secondary",
          });
        } catch {
          // 目标岗位重复时允许继续创建简历。
        }
      }

      const created: any = await createResume({
        user_name: userName.trim(),
        title: templateTitles[selectedTemplate] || "我的简历",
        summary: careerProfile.summary,
        source_profile_snapshot: careerProfilePayload,
        template: selectedTemplate,
      });

      const resumeId = Number(created?.id || 0);
      const sections = Array.isArray(created?.sections) ? created.sections : [];
      const educationSection = sections.find((item: any) => item.section_type === "education");
      const experienceSection = sections.find((item: any) => item.section_type === "experience");
      const skillSection = sections.find((item: any) => item.section_type === "skill");

      if (resumeId && educationSection?.id && (school.trim() || major.trim())) {
        await resumeApi.updateSection(resumeId, educationSection.id, {
          content_json: [
            {
              school: school.trim(),
              major: major.trim(),
              description: [school.trim(), major.trim()].filter(Boolean).join(" · "),
            },
          ],
        });
      }

      if (resumeId && experienceSection?.id && proofNotes.length > 0) {
        await resumeApi.updateSection(resumeId, experienceSection.id, {
          title: "经历素材",
          content_json: proofNotes.map((note, index) => ({
            position: `待打磨经历 ${index + 1}`,
            company: "",
            description: note,
          })),
        });
      }

      if (resumeId && skillSection?.id && careerProfile.proofAngles.length > 0) {
        await resumeApi.updateSection(resumeId, skillSection.id, {
          content_json: [
            {
              category: "优先补强关键词",
              items: careerProfile.proofAngles.slice(0, 6),
            },
          ],
        });
      }

      setResumeCreated(true);
      setTimeout(goNext, 800);
    } catch (error) {
      setResumeCreateError(error instanceof Error ? error.message : "创建失败，请检查后重试。");
    } finally {
      setCreatingResume(false);
    }
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setUploadingFile(true);
    setUploadResult(null);
    setResumeImportResult(null);
    setSelectedImportCandidates([]);

    try {
      const result = await importProfileResume(file);
      setResumeImportResult(result);
      setSelectedImportCandidates((result.bullets || []).map((_, index) => index));
      setUploadResult(
        result.bullets?.length
          ? `已解析 ${result.filename}，请核对并选择要写入简历的候选内容。`
          : `已解析 ${result.filename}，但没有识别出可导入的候选内容。`
      );
    } catch (error) {
      setUploadResult(
        error instanceof Error
          ? error.message
          : "文件解析失败，请确认上传的是有效的 PDF 或 Word 文档。"
      );
    } finally {
      setUploadingFile(false);
      event.target.value = "";
    }
  };

  const handleAiImportForWizard = async (result: ProfileImportResult) => {
    const selected = (result.bullets || []).filter((_, index) =>
      selectedImportCandidates.includes(index)
    );
    if (selected.length === 0) {
      setUploadResult("请至少选择一条候选内容。");
      return;
    }

    setCreatingResume(true);
    try {
      const baseInfo = result.base_info || {};
      const titleName = result.filename.replace(/\.(pdf|docx?)$/i, "").trim();
      const created: any = await createResume({
        user_name: baseInfo.name || "待完善",
        title: titleName || baseInfo.name || "导入简历",
        summary: baseInfo.summary || baseInfo.personal_summary || "",
        contact_json: {
          phone: baseInfo.phone || "",
          email: baseInfo.email || "",
          linkedin: baseInfo.linkedin || "",
          github: baseInfo.github || "",
          website: baseInfo.website || "",
        },
        source_mode: "imported",
      });

      const resumeId = Number(created?.id || 0);
      if (!resumeId) throw new Error("后端没有返回新简历 ID");

      const groups = groupProfileCandidatesForResume(
        selected.map((candidate, index) => {
          const sectionType = normalizeProfileCategoryKey(candidate.section_type || "custom");
          return {
            id: candidate.index ?? index,
            section_type: sectionType,
            title: candidate.title || resolveProfileCategoryLabel(sectionType),
            content_json: candidate.content_json || {},
          };
        })
      );
      const existingSections = Array.isArray(created?.sections) ? created.sections : [];
      for (let index = 0; index < groups.length; index++) {
        const group = groups[index];
        const existing = existingSections.find(
          (section: any) => section.section_type === group.sectionType
        );
        if (existing?.id) {
          await resumeApi.updateSection(resumeId, existing.id, {
            title: group.title,
            sort_order: group.sortOrder,
            content_json: group.items,
          });
        } else {
          await resumeApi.createSection(resumeId, {
            section_type: group.sectionType,
            title: group.title,
            sort_order: group.sortOrder,
            visible: true,
            content_json: group.items,
          });
        }
      }

      setUploadResult(`已确认并写入 ${selected.length} 条简历内容。`);
      setResumeCreated(true);
      setTimeout(goNext, 1000);
    } catch (error) {
      setUploadResult(
        error instanceof Error
          ? `导入创建失败：${error.message}`
          : "导入创建失败，请重试或选择快速创建。"
      );
    } finally {
      setCreatingResume(false);
    }
  };

  // === 内联 AI 导入处理 ===
  const handleCopyPromptInline = async () => {
    try {
      await navigator.clipboard.writeText(AI_IMPORT_PROMPT);
      setAiImportCopied(true);
      setTimeout(() => setAiImportCopied(false), 2000);
      setAiImportStep(1);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = AI_IMPORT_PROMPT;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setAiImportCopied(true);
      setTimeout(() => setAiImportCopied(false), 2000);
      setAiImportStep(1);
    }
  };

  const handlePasteFromClipboardInline = async () => {
    try {
      const text = await navigator.clipboard.readText();
      setAiImportJsonText(text);
    } catch {
      setAiImportError("无法读取剪贴板，请手动粘贴。");
    }
  };

  const handleConfirmAiImportInline = () => {
    if (!aiImportJsonText.trim()) {
      setAiImportError("请先粘贴 AI 返回的 JSON 结果。");
      return;
    }
    setAiImportParsing(true);
    setAiImportError("");
    try {
      const result = parseAiImportJson(aiImportJsonText);
      setResumeImportResult(result);
      setSelectedImportCandidates((result.bullets || []).map((_, index) => index));
      setUploadResult("JSON 已解析，请核对并选择要写入简历的候选内容。");
    } catch (err: any) {
      setAiImportError(err.message || "解析失败，请确认 JSON 格式正确。");
    } finally {
      setAiImportParsing(false);
    }
  };

  const handleFinish = (goToPage?: string) => {
    onComplete();
    if (goToPage) {
      router.push(goToPage);
    }
  };

  const progressPercent = ((step + 1) / TOTAL_STEPS) * 100;

  const slideVariants = {
    enter: (dir: number) => ({ x: dir > 0 ? 300 : -300, opacity: 0 }),
    center: { x: 0, opacity: 1 },
    exit: (dir: number) => ({ x: dir > 0 ? -300 : 300, opacity: 0 }),
  };

  const stepDetails = [
    {
      id: "01",
      label: "职业画像",
      headline: ["了解", "你"],
      note: "先像 MBTI 一样选几题，把你的求职方向、可讲素材和证明点定下来。",
      activePanel: "bg-[#efe3bc] text-black",
    },
    {
      id: "02",
      label: "模型配置",
      headline: ["连接", "模型"],
      note: "把模型、密钥和接口地址接好，后续所有智能能力都会用到。",
      activePanel: "bg-[#fdfbf7] text-black",
    },
    {
      id: "03",
      label: "档案底稿",
      headline: ["创建", "底稿"],
      note: "不只填姓名学校，先补目标岗位和 3 条可追问的经历素材。",
      activePanel: "bg-[#f7ece9] text-black",
    },
    {
      id: "04",
      label: "开始使用",
      headline: ["进入", "岗位"],
      note: "准备完成后，直接进入职位采集和筛选工作台。",
      activePanel: "bg-[#e4ece6] text-black",
    },
  ] as const;

  const currentStep = stepDetails[step] || stepDetails[0];

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[9999] overflow-y-auto bg-[var(--surface-muted)] text-black"
    >
      <div aria-hidden className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute left-[-3rem] top-12 h-28 w-28 rounded-full border border-black/20 bg-[#efe3bc]/65" />
        <div className="absolute right-[10%] top-20 h-24 w-24 rotate-45 border border-black/20 bg-[#e8d2cd]/65" />
        <div className="bauhaus-triangle absolute bottom-8 right-8 h-32 w-32 border border-black/20 bg-[#d8e2da]/65" />
      </div>

      <div className="relative mx-auto flex min-h-screen w-full max-w-7xl items-center px-4 py-6 md:px-8 md:py-10">
        <div className="bauhaus-panel relative w-full overflow-hidden bg-white">
          <div className="grid lg:grid-cols-[0.84fr_1.16fr]">
            <aside className="relative overflow-hidden border-b border-black/15 bg-[var(--surface)] text-black lg:border-b-0 lg:border-r">
              <div aria-hidden className="absolute inset-0 bauhaus-dot-pattern opacity-10" />
              <div className="absolute left-6 top-8 h-14 w-14 rounded-full border border-black/20 bg-[#efe3bc]" />
              <div className="absolute right-20 top-20 h-12 w-12 rotate-45 border border-black/20 bg-[#e8d2cd]" />
              <div className="bauhaus-triangle absolute bottom-10 left-8 h-16 w-16 border border-black/20 bg-[#d8e2da]" />

              <button
                type="button"
                onClick={onSkip}
                className="absolute right-4 top-4 z-10 flex h-11 w-11 items-center justify-center border border-black/20 bg-white text-black shadow-[0_6px_16px_rgba(18,18,18,0.08)] transition-transform hover:-translate-y-[1px]"
              >
                <X size={18} strokeWidth={2.8} />
              </button>

              <div className="relative z-[1] space-y-6 p-6 md:p-8">
                <div className="flex items-center gap-3">
                  <span className="h-5 w-5 rounded-full border border-black/25 bg-[#efe3bc]" />
                  <span className="h-5 w-5 border border-black/25 bg-[#e8d2cd]" />
                  <span className="bauhaus-triangle h-5 w-5 border border-black/25 bg-white" />
                </div>

                <div className="space-y-4">
                  <span className="bauhaus-chip bg-white text-black">OfferU 初始化</span>
                  <div>
                    <p className="bauhaus-label text-black/55">{currentStep.label}</p>
                    <h1 className="mt-3 text-4xl font-bold leading-tight md:text-5xl">
                      {currentStep.headline[0]}
                      <br />
                      {currentStep.headline[1]}
                    </h1>
                    <p className="mt-4 max-w-md text-sm font-medium leading-relaxed text-black/72 md:text-base">
                      {currentStep.note}
                    </p>
                  </div>
                </div>

                <div className="grid gap-3">
                  {stepDetails.map((item, index) => (
                    <div
                      key={item.id}
                      className={`bauhaus-panel-sm px-4 py-4 ${
                        index === step ? item.activePanel : "bg-[#F0F0F0] text-black"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="bauhaus-label opacity-65">步骤 {item.id}</p>
                          <p className="mt-2 text-lg font-semibold">
                            {item.label}
                          </p>
                        </div>
                        <span className="text-2xl font-bold">
                          {index + 1}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="bauhaus-panel-sm bg-white px-4 py-4 text-sm font-medium leading-relaxed text-black">
                  进度 {step + 1} / {TOTAL_STEPS}
                  <div className="mt-3 h-3 border border-black/20 bg-[var(--surface-muted)]">
                    <div className="h-full bg-[#e8d2cd]" style={{ width: `${progressPercent}%` }} />
                  </div>
                </div>

                {step < TOTAL_STEPS - 1 && (
                  <button
                    type="button"
                    onClick={goNext}
                    className="text-sm font-semibold text-black/60 underline underline-offset-4"
                  >
                    暂不设置
                  </button>
                )}
              </div>
            </aside>

            <div className="bg-[#F0F0F0] p-5 md:p-8">
              <div className="mb-6 space-y-3">
                <div className="overflow-hidden border border-black/20 bg-white">
                  <motion.div
                    className="h-4 border-r border-black/20 bg-[#e8d2cd]"
                    animate={{ width: `${progressPercent}%` }}
                    transition={{ type: "spring", damping: 20 }}
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  {stepDetails.map((item, index) => (
                    <span
                      key={item.id}
                      className={`bauhaus-chip ${
                        index === step ? item.activePanel : "bg-white text-black"
                      }`}
                    >
                      {item.label}
                    </span>
                  ))}
                </div>
              </div>

              <AnimatePresence mode="wait" custom={direction}>
                {step === 0 && (
                  <motion.div
                    key="career-profile"
                    custom={direction}
                    variants={slideVariants}
                    initial="enter"
                    animate="center"
                    exit="exit"
                    transition={{ type: "spring", damping: 20 }}
                    className="space-y-6"
                  >
                    <div className="space-y-4">
                      <span className="bauhaus-chip bg-[#efe3bc] text-black">职业画像测试</span>
                      <div>
                        <h2 className="text-4xl font-bold leading-tight md:text-6xl">
                          先了解
                          <br />
                          你怎么做事
                        </h2>
                        <p className="mt-4 max-w-2xl text-base font-medium leading-relaxed text-black/72">
                          像 MBTI 一样选更像你的答案。系统会把结果转成岗位方向、简历素材线索和后续 Agent 追问重点。
                        </p>
                      </div>
                    </div>

                    <div className="grid gap-4 xl:grid-cols-[1fr_0.72fr]">
                      <div className="space-y-4">
                        {STARTER_QUIZ_QUESTIONS.map((question, index) => (
                          <div key={question.id} className="bauhaus-panel-sm bg-white p-4 text-black">
                            <div className="flex items-start justify-between gap-4">
                              <div>
                                <p className="bauhaus-label text-black/50">Question {index + 1}</p>
                                <h3 className="mt-2 text-lg font-semibold">{question.title}</h3>
                                <p className="mt-1 text-sm font-medium leading-relaxed text-black/55">{question.prompt}</p>
                              </div>
                              {quizAnswers[question.id] && <CheckCircle2 size={18} className="mt-1 shrink-0" />}
                            </div>
                            <div className="mt-3 grid gap-2 md:grid-cols-2">
                              {question.options.map((option) => {
                                const selected = quizAnswers[question.id] === option.value;
                                return (
                                  <button
                                    key={option.value}
                                    type="button"
                                    onClick={() =>
                                      setQuizAnswers((prev) => ({
                                        ...prev,
                                        [question.id]: option.value,
                                      }))
                                    }
                                    className={`border px-4 py-3 text-left transition-transform hover:-translate-y-[1px] ${
                                      selected
                                        ? "border-black bg-[#efe3bc] text-black"
                                        : "border-black/15 bg-[#F0F0F0] text-black"
                                    }`}
                                  >
                                    <span className="block text-sm font-semibold">{option.label}</span>
                                    <span className="mt-1 block text-xs font-medium leading-5 text-black/55">{option.description}</span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>

                      <div className="space-y-4">
                        <div className="bauhaus-panel-sm bg-[#d8e2da] p-4 text-black">
                          <p className="bauhaus-label text-black/55">当前画像</p>
                          <p className="mt-3 text-2xl font-semibold">{careerProfile.archetype}</p>
                          <p className="mt-3 text-sm font-medium leading-relaxed text-black/72">{careerProfile.summary}</p>
                        </div>
                        <div className="bauhaus-panel-sm bg-white p-4 text-black">
                          <p className="bauhaus-label text-black/55">推荐方向</p>
                          <div className="mt-3 flex flex-wrap gap-2">
                            {(careerProfile.suggestedRoles.length > 0 ? careerProfile.suggestedRoles : ["运营", "产品助理", "内容运营"]).slice(0, 5).map((role) => (
                              <Chip key={role} size="sm" variant="flat" className="bg-[#efe3bc] text-black">
                                {role}
                              </Chip>
                            ))}
                          </div>
                        </div>
                        <div className="bauhaus-panel-sm bg-[#f7ece9] p-4 text-black">
                          <p className="bauhaus-label text-black/55">后面优先追问</p>
                          <div className="mt-3 flex flex-wrap gap-2">
                            {(careerProfile.proofAngles.length > 0 ? careerProfile.proofAngles : ["人数/金额", "作品案例", "结果反馈"]).slice(0, 6).map((angle) => (
                              <Chip key={angle} size="sm" variant="bordered" className="border-black/20 text-black">
                                {angle}
                              </Chip>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-3">
                      <Button
                        className="bauhaus-button bauhaus-button-red"
                        endContent={<ArrowRight size={16} />}
                        isDisabled={!quizComplete}
                        onPress={handleQuizNext}
                      >
                        生成求职画像
                      </Button>
                      <Button
                        className="bauhaus-button bauhaus-button-outline"
                        onPress={onSkip}
                      >
                        稍后再说
                      </Button>
                    </div>
                  </motion.div>
                )}

                {step === 1 && (
                  <motion.div
                    key="apikey"
                    custom={direction}
                    variants={slideVariants}
                    initial="enter"
                    animate="center"
                    exit="exit"
                    transition={{ type: "spring", damping: 20 }}
                    className="space-y-6"
                  >
                    <div className="space-y-3">
                      <span className="bauhaus-chip bg-[#efe3bc] text-black">模型能力</span>
                      <h2 className="text-4xl font-bold leading-tight md:text-5xl">
                        连接
                        <br />
                        服务
                      </h2>
                      <p className="max-w-2xl text-sm font-medium leading-relaxed text-black/72 md:text-base">
                        选择服务商、模型和接口地址。保存后会同步到设置页，后续页面都将直接复用这套配置。
                      </p>
                    </div>

                    <div className="grid gap-6 xl:grid-cols-[1.14fr_0.86fr]">
                      <Card className="rounded-none border border-black/20 bg-white shadow-[0_8px_22px_rgba(18,18,18,0.08)]">
                        <CardBody className="space-y-4 p-5 md:p-6">
                          <div className="grid gap-4 sm:grid-cols-2">
                            <Autocomplete
                              label="服务商"
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
                              isInvalid={Boolean(formErrors.service_name)}
                              errorMessage={formErrors.service_name}
                              placeholder="例如 DeepSeek"
                              inputProps={{ classNames: bauhausFieldClassNames }}
                              classNames={bauhausAutocompleteClassNames}
                            >
                              {providerOptions.map((item) => (
                                <AutocompleteItem key={item.id} textValue={item.name}>
                                  <div className="flex flex-col">
                                    <span>{item.name}</span>
                                    {item.description && (
                                      <span className="text-xs text-black/55">{item.description}</span>
                                    )}
                                  </div>
                                </AutocompleteItem>
                              ))}
                            </Autocomplete>

                            <Autocomplete
                              label="模型"
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
                                resetAiStepStatus();
                                setFormModelChoice(String(key));
                                setFormCustomModel("");
                              }}
                              isInvalid={Boolean(formErrors.model)}
                              errorMessage={formErrors.model}
                              placeholder="例如 deepseek-v4-flash"
                              inputProps={{ classNames: bauhausFieldClassNames }}
                              classNames={bauhausAutocompleteClassNames}
                            >
                              {modelOptions.map((item) => (
                                <AutocompleteItem key={item.id} textValue={item.name}>
                                  <div className="flex flex-col">
                                    <span>{item.name}</span>
                                    {item.description && (
                                      <span className="text-xs text-black/55">{item.description}</span>
                                    )}
                                  </div>
                                </AutocompleteItem>
                              ))}
                            </Autocomplete>

                            <Autocomplete
                              label="接口地址"
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
                                resetAiStepStatus();
                                const nextValue = String(key);
                                setFormUrlChoice(nextValue);
                                setFormBaseUrl(nextValue);
                              }}
                              isInvalid={Boolean(formErrors.base_url)}
                              errorMessage={formErrors.base_url}
                              placeholder="https://..."
                              inputProps={{ classNames: bauhausFieldClassNames }}
                              classNames={bauhausAutocompleteClassNames}
                              className="sm:col-span-2"
                            >
                              {urlOptions.map((item) => (
                                <AutocompleteItem key={item.id} textValue={item.name}>
                                  {item.name}
                                </AutocompleteItem>
                              ))}
                            </Autocomplete>

                            <Input
                              label="访问密钥"
                              placeholder={resolvedFormProviderId === "ollama" ? "Ollama 无需密钥" : "请输入密钥"}
                              variant="bordered"
                              type={showKey ? "text" : "password"}
                              value={formApiKey}
                              onValueChange={(value) => {
                                resetAiStepStatus();
                                setFormApiKey(value);
                              }}
                              isDisabled={resolvedFormProviderId === "ollama"}
                              isInvalid={Boolean(formErrors.api_key)}
                              errorMessage={formErrors.api_key}
                              classNames={{
                                ...bauhausFieldClassNames,
                                base: "sm:col-span-2",
                              }}
                              startContent={<Key size={16} className="text-black/55" />}
                              endContent={
                                <button
                                  type="button"
                                  onClick={() => setShowKey(!showKey)}
                                  className="text-black/55 hover:text-black"
                                >
                                  {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
                                </button>
                              }
                            />
                          </div>

                          <div className="bauhaus-panel-sm bg-[#F0F0F0] px-4 py-4 text-sm font-medium leading-relaxed text-black/72">
                            这一步可以稍后补充；如果先跳过，之后仍可在设置页新增或切换多套模型配置。
                          </div>

                          {configSaveError && (
                            <div className="bauhaus-panel-sm bg-[#e8d2cd] px-4 py-4 text-sm font-medium leading-relaxed text-black">
                              {configSaveError}
                            </div>
                          )}

                          {configSaved && (
                            <motion.div
                              initial={{ opacity: 0, y: 10 }}
                              animate={{ opacity: 1, y: 0 }}
                              className="bauhaus-panel-sm flex items-center gap-2 bg-[#F0C020] px-4 py-4 text-sm font-medium text-black"
                            >
                              <CheckCircle2 size={18} strokeWidth={2.6} />
                              <span>模型配置已保存并同步。</span>
                            </motion.div>
                          )}
                        </CardBody>
                      </Card>

                      <div className="space-y-4">
                        <div className="bauhaus-panel-sm bg-[#efe3bc] p-4 text-black">
                          <p className="bauhaus-label text-black/55">推荐服务</p>
                          <p className="mt-3 text-2xl font-semibold">
                            {DEFAULT_PROVIDER_PRESET.name}
                          </p>
                          <p className="mt-2 text-sm font-medium leading-relaxed text-black/72">
                            建议先接入稳定且响应快的模型，等工作流跑顺后再扩展更多服务。
                          </p>
                        </div>
                        <div className="bauhaus-panel-sm bg-white p-4 text-black">
                          <p className="bauhaus-label text-black/55">自定义接入</p>
                          <p className="mt-3 text-lg font-semibold">
                            自定义服务
                          </p>
                          <p className="mt-2 text-sm font-medium leading-relaxed text-black/72">
                            输入自定义服务名、模型和接口地址即可接入 OpenAI 兼容接口。
                          </p>
                        </div>
                        <div className="bauhaus-panel-sm bg-[#f7ece9] p-4 text-black">
                          <p className="bauhaus-label text-black/55">安全说明</p>
                          <p className="mt-3 text-lg font-semibold">
                            安全存储
                          </p>
                          <p className="mt-2 text-sm font-medium leading-relaxed text-black/72">
                            访问密钥只在保存时写入配置，平时可以继续切换展示或隐藏输入内容。
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <Button
                        className="bauhaus-button bauhaus-button-outline"
                        startContent={<ArrowLeft size={16} />}
                        onPress={goBack}
                      >
                        上一步
                      </Button>
                      <div className="flex flex-wrap items-center gap-3">
                        <button
                          type="button"
                          onClick={goNext}
                          className="text-sm font-semibold text-black/55 underline underline-offset-4"
                        >
                          跳过
                        </button>
                        <Button
                          className="bauhaus-button bauhaus-button-red"
                          endContent={configSaved ? <CheckCircle2 size={16} /> : <ArrowRight size={16} />}
                          isLoading={savingConfig}
                          onPress={handleSaveAiConfig}
                        >
                          {configSaved ? "已保存" : "保存并继续"}
                        </Button>
                      </div>
                    </div>
                  </motion.div>
                )}

                {step === 2 && (
                  <motion.div
                    key="resume"
                    custom={direction}
                    variants={slideVariants}
                    initial="enter"
                    animate="center"
                    exit="exit"
                    transition={{ type: "spring", damping: 20 }}
                    className="space-y-6"
                  >
                    <div className="space-y-3">
                      <span className="bauhaus-chip bg-[#efe3bc] text-black">简历底稿</span>
                      <h2 className="text-4xl font-bold leading-tight md:text-5xl">
                        创建
                        <br />
                        首份底稿
                      </h2>
                      <p className="max-w-2xl text-sm font-medium leading-relaxed text-black/72 md:text-base">
                        先有一份基础简历，后面的岗位定制和批量生成才有稳定底板。
                      </p>
                    </div>

                    {resumeCreated ? (
                      <motion.div
                        initial={{ scale: 0.94, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        className="bauhaus-panel bg-[#efe3bc] p-8 text-center text-black"
                      >
                        <CheckCircle2 size={54} strokeWidth={2.4} className="mx-auto" />
                        <p className="mt-4 text-3xl font-bold">
                          简历已就绪
                        </p>
                        <p className="mt-3 text-sm font-medium leading-relaxed text-black/72">
                          基础简历已经创建，正在进入下一步。
                        </p>
                      </motion.div>
                    ) : resumeMode === "choose" ? (
                      <>
                        <div className="grid gap-4 md:grid-cols-2">
                          <Card
                            isPressable
                            className="rounded-none border border-black/20 bg-[#d8e2da] text-black shadow-[0_8px_22px_rgba(18,18,18,0.08)]"
                            onPress={() => setResumeMode("create")}
                          >
                            <CardBody className="flex min-h-[220px] flex-col justify-between p-5">
                              <PenTool size={34} strokeWidth={2.4} />
                              <div>
                                <p className="bauhaus-label text-black/55">方案一</p>
                                <p className="mt-3 text-3xl font-bold">
                                  快速创建
                                </p>
                                <p className="mt-3 text-sm font-medium leading-relaxed text-black/72">
                                  补姓名、目标方向和 1-3 条经历素材，生成第一份可继续打磨的简历。
                                </p>
                              </div>
                            </CardBody>
                          </Card>

                          <Card
                            isPressable
                            className="rounded-none border border-black/20 bg-[#efe3bc] text-black shadow-[0_8px_22px_rgba(18,18,18,0.08)]"
                            onPress={() => setResumeMode("upload")}
                          >
                            <CardBody className="flex min-h-[220px] flex-col justify-between p-5">
                              <Sparkles size={34} strokeWidth={2.4} />
                              <div>
                                <p className="bauhaus-label text-black/55">方案二</p>
                                <p className="mt-3 text-3xl font-bold">
                                  AI 导入
                                </p>
                                <p className="mt-3 text-sm font-medium leading-relaxed text-black/72">
                                  借助 AI 工具解析现有简历，快速生成结构化的简历初稿。
                                </p>
                              </div>
                            </CardBody>
                          </Card>
                        </div>

                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <Button
                            className="bauhaus-button bauhaus-button-outline"
                            startContent={<ArrowLeft size={16} />}
                            onPress={goBack}
                          >
                            上一步
                          </Button>
                          <button
                            type="button"
                            onClick={goNext}
                            className="text-sm font-semibold text-black/55 underline underline-offset-4"
                          >
                            跳过
                          </button>
                        </div>
                      </>
                    ) : resumeMode === "create" ? (
                      <div className="space-y-6">
                        <div className="grid gap-6 xl:grid-cols-[1fr_0.88fr]">
                          <Card className="rounded-none border border-black/20 bg-white shadow-[0_8px_22px_rgba(18,18,18,0.08)]">
                            <CardBody className="space-y-4 p-5 md:p-6">
                              <Input
                                label="姓名"
                                placeholder="输入你的姓名"
                                variant="bordered"
                                size="sm"
                                value={userName}
                                onValueChange={setUserName}
                                autoFocus
                                classNames={bauhausFieldClassNames}
                              />
                              <Input
                                label="目标方向"
                                placeholder="例如 AI 产品运营、内容运营、增长运营"
                                variant="bordered"
                                size="sm"
                                value={targetRole}
                                onValueChange={setTargetRole}
                                classNames={bauhausFieldClassNames}
                              />
                              <div className="grid gap-4 sm:grid-cols-2">
                                <Input
                                  label="学校"
                                  placeholder="例如 浙江大学"
                                  variant="bordered"
                                  size="sm"
                                  value={school}
                                  onValueChange={setSchool}
                                  classNames={bauhausFieldClassNames}
                                />
                                <Input
                                  label="专业"
                                  placeholder="例如 计算机科学"
                                  variant="bordered"
                                  size="sm"
                                  value={major}
                                  onValueChange={setMajor}
                                  classNames={bauhausFieldClassNames}
                                />
                              </div>
                              <div className="space-y-3">
                                <div>
                                  <p className="bauhaus-label text-black/55">经历素材</p>
                                  <p className="mt-1 text-xs font-medium leading-relaxed text-black/55">
                                    先随便写 1-3 条，不用像简历。Agent 后面会继续追问数字、作品和结果。
                                  </p>
                                </div>
                                {experienceNotes.map((note, index) => (
                                  <Textarea
                                    key={index}
                                    label={`素材 ${index + 1}`}
                                    placeholder={experiencePlaceholders[index]}
                                    variant="bordered"
                                    minRows={2}
                                    value={note}
                                    onValueChange={(value) =>
                                      setExperienceNotes((prev) => {
                                        const next = [...prev];
                                        next[index] = value;
                                        return next;
                                      })
                                    }
                                    classNames={bauhausFieldClassNames}
                                  />
                                ))}
                              </div>
                            </CardBody>
                          </Card>

                          <div className="space-y-4">
                            <div className="bauhaus-panel-sm bg-[#d8e2da] p-4 text-black">
                              <p className="bauhaus-label text-black/55">画像结果</p>
                              <p className="mt-3 text-xl font-semibold">{careerProfile.archetype}</p>
                              <p className="mt-2 text-sm font-medium leading-relaxed text-black/72">
                                {careerProfile.summary}
                              </p>
                            </div>
                            <div className="bauhaus-panel-sm bg-[#f7ece9] p-4 text-black">
                              <p className="bauhaus-label text-black/55">模板类型</p>
                              <p className="mt-3 text-2xl font-semibold">
                                选择方向
                              </p>
                            </div>

                            <div className="grid gap-3">
                              {RESUME_TEMPLATES.map((template, index) => (
                                <button
                                  key={template.id}
                                  type="button"
                                  onClick={() => setSelectedTemplate(template.id)}
                                  className={`bauhaus-panel-sm p-4 text-left transition-transform hover:-translate-y-[1px] ${
                                    selectedTemplate === template.id
                                      ? index === 0
                                        ? "bg-[#d8e2da] text-black"
                                        : index === 1
                                          ? "bg-[#efe3bc] text-black"
                                          : "bg-[#f7ece9] text-black"
                                      : "bg-white text-black"
                                  }`}
                                >
                                  <p className="bauhaus-label opacity-70">模板 {index + 1}</p>
                                  <p className="mt-2 text-xl font-semibold">
                                    {template.label}
                                  </p>
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>

                        <div className="flex flex-wrap gap-3">
                          <Button
                            className="bauhaus-button bauhaus-button-outline"
                            onPress={() => setResumeMode("choose")}
                          >
                            返回方式选择
                          </Button>
                          <Button
                            className="bauhaus-button bauhaus-button-red"
                            isLoading={creatingResume}
                            isDisabled={!userName.trim()}
                            onPress={handleQuickCreate}
                          >
                            创建简历
                          </Button>
                        </div>
                        {resumeCreateError && (
                          <div className="border border-[var(--primary-red)]/40 bg-[#f7ece9] px-4 py-3 text-sm font-medium leading-relaxed text-black" role="alert">
                            {resumeCreateError}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="space-y-6">
                        <Card className="rounded-none border border-black/20 bg-white shadow-[0_8px_22px_rgba(18,18,18,0.08)]">
                          <CardBody className="space-y-5 p-6">
                            <div className="flex items-center gap-3">
                              <Upload size={28} strokeWidth={2.4} className="text-[var(--primary-red)]" />
                              <p className="text-2xl font-bold">导入现有简历</p>
                            </div>

                            <div className="space-y-3">
                              <p className="text-sm leading-relaxed text-black/70">
                                上传 PDF 或 DOCX。OfferU 会先提取候选内容；只有你勾选确认后，内容才会写入新简历。
                              </p>
                              <label className="bauhaus-button bauhaus-button-red flex w-full cursor-pointer items-center justify-center gap-2">
                                <Upload size={16} />
                                <span>{uploadingFile ? "正在解析…" : "选择 PDF / DOCX"}</span>
                                <input
                                  type="file"
                                  accept=".pdf,.docx"
                                  className="hidden"
                                  disabled={uploadingFile || creatingResume}
                                  onChange={handleFileUpload}
                                />
                              </label>
                            </div>

                            {uploadResult && (
                              <div
                                className={`bauhaus-panel-sm px-4 py-4 text-sm font-medium leading-relaxed ${
                                  resumeCreated
                                    ? "bg-[#efe3bc] text-black"
                                    : "bg-[#e8d2cd] text-black"
                                }`}
                              >
                                {uploadResult}
                              </div>
                            )}

                            {resumeImportResult && (
                              <div className="space-y-4 border-t border-black/15 pt-5">
                                {resumeImportResult.parse_diagnostics && (
                                  <div className="grid gap-2 text-xs font-semibold text-black/60 sm:grid-cols-3">
                                    <span>解析器：{resumeImportResult.parse_diagnostics.parser}</span>
                                    <span>
                                      页数：{resumeImportResult.parse_diagnostics.page_count}
                                      {resumeImportResult.parse_diagnostics.used_ocr ? " · 已使用 OCR" : " · 原生文本"}
                                    </span>
                                    <span>
                                      平均质量：{Math.round(resumeImportResult.parse_diagnostics.average_quality * 100)}%
                                    </span>
                                    {resumeImportResult.parse_diagnostics.ocr
                                      && !resumeImportResult.parse_diagnostics.ocr.configured && (
                                      <span className="sm:col-span-3 text-[#8a4b00]">
                                        未配置完整的 {resumeImportResult.parse_diagnostics.ocr.language} OCR；纯扫描 PDF 可能无法识别。
                                      </span>
                                      )}
                                  </div>
                                )}

                                <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                                  {(resumeImportResult.bullets || []).map((candidate, index) => {
                                    const selected = selectedImportCandidates.includes(index);
                                    const content = candidate.content_json || {};
                                    const preview =
                                      String(content.bullet || content.description || "").trim() ||
                                      Object.values(content)
                                        .filter((value) => typeof value === "string" && value.trim())
                                        .slice(0, 3)
                                        .join(" · ");
                                    return (
                                      <label
                                        key={`${candidate.session_id}-${candidate.index}-${index}`}
                                        className={`block cursor-pointer border p-3 ${
                                          selected ? "border-black bg-[#efe3bc]" : "border-black/15 bg-white"
                                        }`}
                                      >
                                        <div className="flex items-start gap-3">
                                          <input
                                            type="checkbox"
                                            checked={selected}
                                            onChange={() =>
                                              setSelectedImportCandidates((current) =>
                                                selected
                                                  ? current.filter((item) => item !== index)
                                                  : [...current, index]
                                              )
                                            }
                                            className="mt-1 h-4 w-4 accent-black"
                                          />
                                          <div className="min-w-0 flex-1">
                                            <div className="flex flex-wrap items-center gap-2">
                                              <span className="text-sm font-bold">
                                                {candidate.title ||
                                                  resolveProfileCategoryLabel(
                                                    normalizeProfileCategoryKey(candidate.section_type || "custom")
                                                  )}
                                              </span>
                                              {candidate.source_pages?.length ? (
                                                <span className="text-[11px] font-semibold text-black/50">
                                                  第 {candidate.source_pages.join("、")} 页
                                                </span>
                                              ) : null}
                                            </div>
                                            <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-black/65">
                                              {preview || "未生成预览，请展开后在简历编辑器中核对。"}
                                            </p>
                                          </div>
                                        </div>
                                      </label>
                                    );
                                  })}
                                </div>
                                <Button
                                  className="bauhaus-button bauhaus-button-red w-full justify-center"
                                  isDisabled={selectedImportCandidates.length === 0}
                                  isLoading={creatingResume}
                                  onPress={() => void handleAiImportForWizard(resumeImportResult)}
                                >
                                  确认 {selectedImportCandidates.length} 条并创建简历
                                </Button>
                              </div>
                            )}

                            <details className="border-t border-black/15 pt-4">
                              <summary className="cursor-pointer text-sm font-bold text-black/65">
                                备用：让外部 AI 返回结构化 JSON
                              </summary>
                              <div className="mt-4 space-y-4">
                                {aiImportStep === 0 && (
                                  <div className="space-y-4">
                                    <p className="text-sm leading-relaxed text-black/70">
                                      复制提示词，再到外部 AI 工具上传简历；返回的 JSON 仍需在 OfferU 中逐条确认。
                                    </p>
                                    <Button
                                      className="bauhaus-button bauhaus-button-outline w-full justify-center"
                                      startContent={<Sparkles size={16} />}
                                      onPress={handleCopyPromptInline}
                                    >
                                      {aiImportCopied ? "已复制，进入下一步" : "复制提示词"}
                                    </Button>
                                  </div>
                                )}

                                {aiImportStep === 1 && (
                                  <div className="space-y-4">
                                    <p className="text-sm leading-relaxed text-black/70">
                                      提示词已复制。请在外部 AI 中上传简历并发送提示词，然后复制返回的 JSON。
                                    </p>
                                    <div className="flex flex-wrap gap-2">
                                      {[
                                        { name: "豆包", url: "https://www.doubao.com/chat/" },
                                        { name: "ChatGPT", url: "https://chat.openai.com/" },
                                        { name: "通义千问", url: "https://tongyi.aliyun.com/qianwen/" },
                                        { name: "Kimi", url: "https://kimi.moonshot.cn/" },
                                      ].map((tool) => (
                                        <a
                                          key={tool.name}
                                          href={tool.url}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="inline-flex items-center gap-1 rounded-md border border-black/15 px-3 py-1.5 text-sm font-medium text-black/70 transition hover:border-black/30 hover:text-black"
                                        >
                                          {tool.name}
                                        </a>
                                      ))}
                                    </div>
                                    <Button
                                      className="bauhaus-button bauhaus-button-outline w-full justify-center"
                                      onPress={() => setAiImportStep(2)}
                                    >
                                      我已复制 JSON，下一步
                                    </Button>
                                  </div>
                                )}

                                {aiImportStep === 2 && (
                                  <div className="space-y-4">
                                    <Textarea
                                      minRows={6}
                                      maxRows={12}
                                      placeholder="粘贴 AI 返回的 JSON..."
                                      value={aiImportJsonText}
                                      onValueChange={setAiImportJsonText}
                                      variant="bordered"
                                      classNames={{ inputWrapper: "border-black/20 bg-white font-mono text-sm" }}
                                    />
                                    <div className="flex gap-2">
                                      <Button
                                        className="bauhaus-button bauhaus-button-outline flex-1"
                                        onPress={handlePasteFromClipboardInline}
                                      >
                                        从剪贴板粘贴
                                      </Button>
                                      <Button
                                        className="bauhaus-button bauhaus-button-outline flex-1"
                                        onPress={() => setAiImportJsonText("")}
                                        isDisabled={!aiImportJsonText}
                                      >
                                        清空
                                      </Button>
                                    </div>
                                    {aiImportError && (
                                      <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                                        {aiImportError}
                                      </div>
                                    )}
                                    <Button
                                      className="bauhaus-button bauhaus-button-outline w-full justify-center"
                                      isDisabled={!aiImportJsonText.trim()}
                                      isLoading={aiImportParsing}
                                      onPress={handleConfirmAiImportInline}
                                    >
                                      解析 JSON 并进入确认
                                    </Button>
                                  </div>
                                )}
                              </div>
                            </details>
                          </CardBody>
                        </Card>

                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <Button
                            className="bauhaus-button bauhaus-button-outline"
                            startContent={<ArrowLeft size={16} />}
                            onPress={() => { setResumeMode("choose"); setAiImportStep(0); }}
                          >
                            返回方式选择
                          </Button>
                          <button
                            type="button"
                            onClick={goNext}
                            className="text-sm font-semibold text-black/55 underline underline-offset-4"
                          >
                            暂时跳过
                          </button>
                        </div>
                      </div>
                    )}
                  </motion.div>
                )}

                {step === 3 && (
                  <motion.div
                    key="scrape"
                    custom={direction}
                    variants={slideVariants}
                    initial="enter"
                    animate="center"
                    exit="exit"
                    transition={{ type: "spring", damping: 20 }}
                    className="space-y-6"
                  >
                    <div className="space-y-3">
                      <span className="bauhaus-chip bg-[#efe3bc] text-black">开始使用</span>
                      <h2 className="text-4xl font-bold leading-tight md:text-6xl">
                        保存
                        <br />
                        匹配
                        <br />
                        推进
                      </h2>
                      <p className="max-w-2xl text-sm font-medium leading-relaxed text-black/72 md:text-base">
                        现在保存一个你真正想投的岗位。OfferU 会围绕它做岗位研究、准备材料并持续整理下一步。
                      </p>
                    </div>

                    <div className="grid gap-4 md:grid-cols-3">
                      <div className="bauhaus-panel-sm bg-[#d8e2da] p-4 text-black">
                        <p className="bauhaus-label text-black/55">第一步</p>
                        <p className="mt-3 text-2xl font-semibold">保存岗位</p>
                      </div>
                      <div className="bauhaus-panel-sm bg-[#efe3bc] p-4 text-black">
                        <p className="bauhaus-label text-black/55">然后</p>
                        <p className="mt-3 text-2xl font-semibold">自动准备</p>
                      </div>
                      <div className="bauhaus-panel-sm bg-[#f7ece9] p-4 text-black">
                        <p className="bauhaus-label text-black/55">最后</p>
                        <p className="mt-3 text-2xl font-semibold">Today 跟进</p>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-3">
                      <Button
                        className="bauhaus-button bauhaus-button-red"
                        endContent={<Briefcase size={16} />}
                        onPress={() => handleFinish("/jobs")}
                      >
                        保存第一个岗位
                      </Button>
                      <Button
                        className="bauhaus-button bauhaus-button-blue"
                        endContent={<Sparkles size={16} />}
                        onPress={() => handleFinish("/jobs")}
                      >
                        查看岗位池
                      </Button>
                      <Button
                        className="bauhaus-button bauhaus-button-outline"
                        onPress={() => handleFinish()}
                      >
                        返回仪表盘
                      </Button>
                    </div>

                    <Button
                      className="bauhaus-button bauhaus-button-outline"
                      startContent={<ArrowLeft size={16} />}
                      onPress={goBack}
                    >
                      上一步
                    </Button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
