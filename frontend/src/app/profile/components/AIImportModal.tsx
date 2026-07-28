"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Textarea,
} from "@nextui-org/react";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  ExternalLink,
  FileText,
  Sparkles,
} from "lucide-react";
import type { ProfileImportResult } from "@/lib/hooks";

// ---------------------------------------------------------------------------
// 提示词常量
// ---------------------------------------------------------------------------
export const AI_IMPORT_PROMPT = `你现在是一个专业的简历数据结构化引擎。请深度解析用户上传的简历文件，并将提取出的信息严格按照指定的 JSON 格式返回。

【数据字典与字段约束】
返回的 JSON 必须包含两个顶层键：base_info 和 sections。

一、base_info（基本信息对象）
- name (String): 姓名
- phone (String | null): 手机号
- email (String | null): 邮箱
- github (String | null): GitHub 主页链接
- linkedin (String | null): LinkedIn 主页链接
- website (String | null): 个人网站链接
- current_city (String | null): 当前城市
- job_intention (String | null): 求职意向/目标岗位
- summary (String | null): 个人简介/自我评价

二、sections（经历条目数组）
每个条目必须包含：
- section_type (String): 必须为以下之一："education"、"experience"、"project"、"skill"、"certificate"
- content (Object): 根据 section_type 填写对应字段

各 section_type 的 content 字段规范：

【education 教育经历】
- school (String): 学校名称
- degree (String): 学历（如：本科、硕士、博士）
- major (String): 专业
- start_date (String): 开始时间，格式 YYYY-MM 或 YYYY
- end_date (String): 结束时间，格式 YYYY-MM 或 YYYY，若在读可填 "至今"
- gpa (String | null): GPA 或成绩排名
- description (String | null): 补充描述

【experience 工作/实习经历】
- company (String): 公司名称
- position (String): 职位/岗位
- start_date (String): 开始时间
- end_date (String): 结束时间
- description (String): 工作内容描述，保留原始要点

【project 项目经历】
- name (String): 项目名称
- role (String | null): 担任角色
- start_date (String | null): 开始时间
- end_date (String | null): 结束时间
- description (String): 项目内容描述，保留原始要点

【skill 技能】
- category (String): 技能分类（如：编程语言、框架、工具、语言能力等）
- items (String[]): 该分类下的具体技能列表

【certificate 证书/荣誉】
- name (String): 证书/荣誉名称
- issuer (String | null): 颁发机构
- date (String | null): 获得时间

【极端场景处理红线】
- 字段缺失：若简历中未提供某字段，对应值填 null，不可编造
- 日期格式：统一为 YYYY-MM 或 YYYY，不可用"2023年9月"等中文格式
- 描述保留：工作/项目描述请原样保留简历中的要点，不要概括或删减
- 技能归类：将零散的技能描述归类到合适的 category 下，同类合并

【合规输出样例】
{
  "base_info": {
    "name": "张三",
    "phone": "13800138000",
    "email": "zhangsan@example.com",
    "github": "https://github.com/zhangsan",
    "linkedin": null,
    "website": null,
    "current_city": "北京",
    "job_intention": "前端工程师",
    "summary": "3年前端开发经验..."
  },
  "sections": [
    {
      "section_type": "education",
      "content": {
        "school": "北京大学",
        "degree": "硕士",
        "major": "计算机科学与技术",
        "start_date": "2020-09",
        "end_date": "2023-06",
        "gpa": "3.8/4.0",
        "description": null
      }
    },
    {
      "section_type": "experience",
      "content": {
        "company": "字节跳动",
        "position": "前端开发实习生",
        "start_date": "2022-06",
        "end_date": "2022-09",
        "description": "- 负责抖音创作者平台的组件库开发\\n- 优化页面加载性能，FCP 降低 40%"
      }
    }
  ]
}

系统指令：请跳过所有寒暄、思考过程及任何解释性文本，只允许返回合法的 JSON 对象，确保可直接被程序反序列化。`;

// ---------------------------------------------------------------------------
// JSON 解析工具
// ---------------------------------------------------------------------------

/** 从 AI 返回的文本中提取 JSON（兼容 markdown 代码块等） */
function extractJsonPayload(source: string): string {
  const trimmed = source.trim();

  // 1. 尝试提取 markdown 代码块（取最后一个，避免 AI 先输出解释再输出 JSON 的情况）
  const codeBlockMatches = [...trimmed.matchAll(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/g)];
  if (codeBlockMatches.length > 0) {
    // 优先选择包含 base_info 的代码块
    const withBaseInfo = codeBlockMatches.find((m) => m[1].includes("base_info"));
    return (withBaseInfo || codeBlockMatches[codeBlockMatches.length - 1])[1].trim();
  }

  // 2. 直接使用原始文本
  return trimmed;
}

/** 从 JSON 文本中提取第一个完整的 JSON 对象/数组 */
function extractJsonByBrackets(source: string): string | null {
  const startBrace = source.indexOf("{");
  const startBracket = source.indexOf("[");

  if (startBrace === -1 && startBracket === -1) return null;

  let startIndex: number;
  if (startBrace === -1) startIndex = startBracket;
  else if (startBracket === -1) startIndex = startBrace;
  else startIndex = Math.min(startBrace, startBracket);

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIndex; i < source.length; i++) {
    const ch = source[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{" || ch === "[") depth++;
    if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return source.slice(startIndex, i + 1);
    }
  }

  return null;
}

interface AiImportJson {
  base_info: Record<string, any>;
  sections: Array<{
    section_type: string;
    content: Record<string, any>;
  }>;
}

/** 根据内容生成条目标题 */
function deriveTitle(sectionType: string, content: Record<string, any>): string {
  switch (sectionType) {
    case "education":
      return content.school || "教育经历";
    case "experience":
      return content.company || "工作经历";
    case "project":
      return content.name || "项目经历";
    case "skill":
      return content.category || "技能";
    case "certificate":
      return content.name || "证书";
    default:
      return "经历";
  }
}

/** 根据内容生成简短摘要文本 */
function deriveBullet(sectionType: string, content: Record<string, any>): string {
  switch (sectionType) {
    case "education": {
      const parts = [content.school, content.degree, content.major].filter(Boolean);
      return parts.join(" | ");
    }
    case "experience": {
      const parts = [content.company, content.position].filter(Boolean);
      return parts.join(" | ");
    }
    case "project": {
      const parts = [content.name, content.role].filter(Boolean);
      return parts.join(" | ");
    }
    case "skill": {
      const items = Array.isArray(content.items) ? content.items.join("、") : "";
      return items || content.category || "";
    }
    case "certificate": {
      const parts = [content.name, content.issuer].filter(Boolean);
      return parts.join(" | ");
    }
    default:
      return "";
  }
}

/** 将 AI 返回的 JSON 转换为 ProfileImportResult 格式 */
export function parseAiImportJson(raw: string): ProfileImportResult {
  const payload = extractJsonPayload(raw);
  let jsonStr = payload;

  // 尝试直接解析
  let parsed: any = null;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    // 降级：尝试花括号/方括号提取
    const extracted = extractJsonByBrackets(jsonStr);
    if (extracted) {
      try {
        parsed = JSON.parse(extracted);
      } catch {
        throw new Error("无法解析 JSON，请确认粘贴的是 AI 返回的完整 JSON 结果。");
      }
    } else {
      throw new Error("未找到有效的 JSON 内容，请确认粘贴的是 AI 返回的完整结果。");
    }
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("JSON 格式不正确，期望一个包含 base_info 和 sections 的对象。");
  }

  // 兼容：如果 AI 返回的是数组，包装为对象
  if (Array.isArray(parsed)) {
    parsed = { base_info: {}, sections: parsed };
  }

  const data = parsed as AiImportJson;
  const baseInfo = data.base_info && typeof data.base_info === "object" ? data.base_info : {};
  const sections = Array.isArray(data.sections) ? data.sections : [];

  // 验证 section_type 并过滤掉 content 为空的条目
  const validTypes = new Set(["education", "experience", "project", "skill", "certificate"]);
  const filteredSections = sections.filter(
    (s) => validTypes.has(s.section_type) && s.content && typeof s.content === "object"
  );

  if (filteredSections.length === 0 && !baseInfo.name) {
    throw new Error("未识别到有效的简历信息，请确认 JSON 包含 base_info 或 sections。");
  }

  return {
    session_id: 0,
    filename: "ai-import",
    text_length: raw.length,
    base_info: {
      name: baseInfo.name ?? undefined,
      phone: baseInfo.phone ?? undefined,
      email: baseInfo.email ?? undefined,
      linkedin: baseInfo.linkedin ?? undefined,
      github: baseInfo.github ?? undefined,
      website: baseInfo.website ?? undefined,
      current_city: baseInfo.current_city ?? undefined,
      job_intention: baseInfo.job_intention ?? undefined,
      summary: baseInfo.summary ?? undefined,
      personal_summary: baseInfo.summary ?? undefined,
    },
    bullets: filteredSections.map((section, index) => ({
      index,
      session_id: 0,
      section_type: section.section_type,
      title: deriveTitle(section.section_type, section.content),
      content_json: {
        schema_version: "ai_import_v1",
        category_key: section.section_type,
        field_values: section.content,
        normalized: section.content,
        bullet: deriveBullet(section.section_type, section.content),
      },
      confidence: 0.9,
    })),
  };
}

// ---------------------------------------------------------------------------
// 剪贴板检测
// ---------------------------------------------------------------------------

function looksLikeResumeJson(text: string): boolean {
  if (!text || text.length < 20) return false;
  const t = text.trim();
  return (
    (t.startsWith("{") && t.includes("base_info") && t.includes("sections")) ||
    (t.startsWith("[") && t.includes("section_type"))
  );
}

// ---------------------------------------------------------------------------
// 步骤定义
// ---------------------------------------------------------------------------

const STEP_TITLES = ["复制提示词", "去 AI 工具识别", "粘贴结果"];

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

interface AIImportModalProps {
  open: boolean;
  onClose: () => void;
  onImport: (result: ProfileImportResult) => void;
}

export default function AIImportModal({ open, onClose, onImport }: AIImportModalProps) {
  const [step, setStep] = useState(0);
  const [jsonText, setJsonText] = useState("");
  const [copied, setCopied] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState("");
  const autoFilledRef = useRef(false);

  // 剪贴板自动检测：用户从 AI 工具切回来时自动识别
  useEffect(() => {
    if (!open || step !== 2) return;

    const checkClipboard = async () => {
      if (autoFilledRef.current) return;
      try {
        const text = await navigator.clipboard.readText();
        if (looksLikeResumeJson(text)) {
          // 使用函数式更新避免覆盖用户手动输入
          setJsonText((prev) => {
            if (prev) return prev; // 用户已有输入，不覆盖
            autoFilledRef.current = true;
            return text;
          });
        }
      } catch {
        // 剪贴板权限被拒绝，静默忽略
      }
    };

    // 页面获得焦点时检测
    const handleFocus = () => {
      setTimeout(checkClipboard, 300);
    };
    window.addEventListener("focus", handleFocus);

    // 初次进入 Step 2 时也检测一次
    checkClipboard();

    return () => window.removeEventListener("focus", handleFocus);
  }, [open, step]);

  // 重置状态
  const resetAndClose = useCallback(() => {
    setStep(0);
    setJsonText("");
    setCopied(false);
    setParsing(false);
    setError("");
    autoFilledRef.current = false;
    onClose();
  }, [onClose]);

  const goNext = () => setStep((prev) => Math.min(prev + 1, STEP_TITLES.length - 1));
  const goBack = () => setStep((prev) => Math.max(prev - 1, 0));

  const handleCopyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(AI_IMPORT_PROMPT);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      goNext();
    } catch {
      // 降级：使用 textarea 复制
      const ta = document.createElement("textarea");
      ta.value = AI_IMPORT_PROMPT;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      goNext();
    }
  };

  const handlePasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      setJsonText(text);
    } catch {
      setError("无法读取剪贴板，请手动粘贴。");
    }
  };

  const handleConfirmImport = () => {
    if (!jsonText.trim()) {
      setError("请先粘贴 AI 返回的 JSON 结果。");
      return;
    }

    setParsing(true);
    setError("");

    try {
      const result = parseAiImportJson(jsonText);
      onImport(result);
      resetAndClose();
    } catch (err: any) {
      setError(err.message || "解析失败，请确认 JSON 格式正确。");
    } finally {
      setParsing(false);
    }
  };

  // ---- 渲染步骤内容 ----

  const renderStepContent = () => {
    switch (step) {
      case 0:
        return (
          <div className="space-y-4">
            <div className="rounded-md border border-[var(--border-strong)]/15 bg-white/60 p-4">
              <p className="text-sm leading-relaxed text-[var(--foreground-muted)]">
                点击下方按钮复制提示词，然后前往 AI 工具（如豆包、ChatGPT、通义千问等），
                上传你的简历文件并将提示词发送给 AI，AI 会返回一段结构化的 JSON 数据。
              </p>
            </div>
            <div className="max-h-48 overflow-y-auto rounded-md border border-[var(--border-strong)]/10 bg-black/5 p-3">
              <pre className="whitespace-pre-wrap break-words text-xs leading-relaxed text-[var(--foreground-muted)]">
                {AI_IMPORT_PROMPT}
              </pre>
            </div>
            <Button
              className="bauhaus-button bauhaus-button-red w-full justify-center"
              startContent={<ClipboardCopy size={16} />}
              onPress={handleCopyPrompt}
            >
              {copied ? "已复制提示词" : "复制提示词"}
            </Button>
          </div>
        );

      case 1:
        return (
          <div className="space-y-4">
            <div className="rounded-md border border-[var(--border-strong)]/15 bg-white/60 p-4">
              <p className="text-sm leading-relaxed text-[var(--foreground-muted)]">
                提示词已复制到剪贴板。现在请前往你常用的 AI 工具，上传简历并发送提示词：
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
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
                    className="inline-flex items-center gap-1 rounded-md border border-[var(--border-strong)]/15 px-3 py-1.5 text-sm font-medium text-[var(--foreground-muted)] transition hover:border-[var(--border-strong)]/30 hover:text-[var(--foreground)]"
                  >
                    <ExternalLink size={14} />
                    {tool.name}
                  </a>
                ))}
              </div>
            </div>
            <div className="space-y-2 rounded-md border border-[rgba(201,85,72,0.2)] bg-[rgba(201,85,72,0.05)] p-4">
              <p className="text-sm font-semibold text-[var(--primary-red)]">操作步骤</p>
              <ol className="ml-4 list-decimal space-y-1 text-sm text-[var(--foreground-muted)]">
                <li>打开 AI 工具（点击上方链接或自行打开）</li>
                <li>上传你的简历文件（PDF / Word / 图片均可）</li>
                <li>粘贴刚才复制的提示词并发送</li>
                <li>复制 AI 返回的 JSON 结果</li>
              </ol>
            </div>
            <Button
              className="bauhaus-button bauhaus-button-red w-full justify-center"
              endContent={<ChevronRight size={16} />}
              onPress={goNext}
            >
              我已复制 JSON，下一步
            </Button>
          </div>
        );

      case 2:
        return (
          <div className="space-y-4">
            <div className="rounded-md border border-[var(--border-strong)]/15 bg-white/60 p-4">
              <p className="text-sm leading-relaxed text-[var(--foreground-muted)]">
                将 AI 返回的 JSON 结果粘贴到下方文本框中，点击确认导入即可自动解析。
              </p>
            </div>
            <Textarea
              minRows={8}
              maxRows={14}
              placeholder='粘贴 AI 返回的 JSON，例如：{"base_info": {...}, "sections": [...]}'
              value={jsonText}
              onValueChange={setJsonText}
              variant="bordered"
              classNames={{
                inputWrapper: "border-[var(--border-strong)]/20 bg-white font-mono text-sm",
              }}
            />
            <div className="flex gap-2">
              <Button
                className="bauhaus-button bauhaus-button-outline flex-1"
                startContent={<ClipboardCopy size={14} />}
                onPress={handlePasteFromClipboard}
              >
                从剪贴板粘贴
              </Button>
              <Button
                className="bauhaus-button bauhaus-button-outline flex-1"
                onPress={() => { setJsonText(""); autoFilledRef.current = false; }}
                isDisabled={!jsonText}
              >
                清空
              </Button>
            </div>
            {error && (
              <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
                {error}
              </div>
            )}
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <Modal
      isOpen={open}
      onClose={resetAndClose}
      size="2xl"
      placement="center"
      scrollBehavior="inside"
    >
      <ModalContent className="border border-[var(--border-strong)] bg-[var(--surface-muted)] text-[var(--foreground)] shadow-[4px_4px_0_0_rgba(18,18,18,0.45)]">
        <ModalHeader className="border-b-2 border-[var(--border-strong)] px-6 py-5">
          <div className="flex w-full items-center gap-3">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-[var(--primary-red)] text-white">
              <Sparkles size={18} />
            </div>
            <div>
              <h2 className="text-lg font-black tracking-[-0.04em]">AI 导入简历</h2>
              <p className="text-xs text-[var(--foreground-muted)]">借助 AI 工具快速解析简历</p>
            </div>
          </div>
        </ModalHeader>

        {/* 步骤进度条 */}
        <div className="flex items-center gap-1 border-b border-[var(--border-strong)]/10 px-6 py-3">
          {STEP_TITLES.map((title, index) => (
            <div key={title} className="flex items-center gap-1">
              {index > 0 && (
                <div className={`h-px w-6 ${index <= step ? "bg-[var(--primary-red)]" : "bg-black/15"}`} />
              )}
              <div
                className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold transition ${
                  index === step
                    ? "bg-[var(--primary-red)] text-white"
                    : index < step
                      ? "bg-black/10 text-[var(--foreground-muted)]"
                      : "bg-transparent text-[var(--foreground-muted)]"
                }`}
              >
                {index < step ? (
                  <CheckCircle2 size={12} />
                ) : (
                  <span className="grid h-4 w-4 place-items-center rounded-full border border-current text-[10px]">
                    {index + 1}
                  </span>
                )}
                <span className="hidden sm:inline">{title}</span>
              </div>
            </div>
          ))}
        </div>

        <ModalBody className="px-6 py-5">{renderStepContent()}</ModalBody>

        <ModalFooter className="border-t-2 border-[var(--border-strong)] px-6 py-4">
          <div className="flex w-full items-center justify-between">
            <Button
              className="bauhaus-button bauhaus-button-outline"
              startContent={<ChevronLeft size={14} />}
              isDisabled={step === 0}
              onPress={goBack}
            >
              上一步
            </Button>
            <div className="flex gap-2">
              {step < 2 && (
                <Button
                  className="bauhaus-button bauhaus-button-red"
                  endContent={<ChevronRight size={14} />}
                  onPress={goNext}
                >
                  下一步
                </Button>
              )}
              {step === 2 && (
                <Button
                  className="bauhaus-button bauhaus-button-red"
                  startContent={<FileText size={14} />}
                  isLoading={parsing}
                  isDisabled={!jsonText.trim()}
                  onPress={handleConfirmImport}
                >
                  确认导入
                </Button>
              )}
            </div>
          </div>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
