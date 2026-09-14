// frontend/src/app/studio/page.tsx
"use client";

import { useState, useEffect } from "react";
import { Card, Button, Spinner } from "@nextui-org/react";
import { SHOWCASE, showcaseHandle } from "@/lib/showcase/router";
import { resolveApiBase } from "@/lib/apiBase";

// 与 lib/api.ts 同款后端地址解析；vite dev 无 proxy，
// 相对路径 /api/... 会打到 Vite 自身（7410）返回 index.html。
const API_BASE = resolveApiBase();

interface Template {
  id: number;
  name: string;
  display_name: string;
  category: string;
  preview_image: string;
  // 展示模式数据层不带该字段，因此可选。
  design_tokens?: Record<string, string> | null;
}

// 与 template_seeder 的 design_tokens 键名一致，后端把 overrides 合并进 design_tokens。
const DESIGN_FONTS = ["Inter", "Poppins", "JetBrains Mono"];
const DEFAULT_PRIMARY_COLOR = "#2563eb";

export default function StudioPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [previewFailures, setPreviewFailures] = useState<Record<number, boolean>>({});
  const [selectedTemplate, setSelectedTemplate] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [primaryColor, setPrimaryColor] = useState(DEFAULT_PRIMARY_COLOR);
  const [fontFamily, setFontFamily] = useState(DESIGN_FONTS[0]);

  // creative-gradient / tech-dark 的 html_template 不引用 fontFamily，
  // 选中这类模板时字体控件无效，需要显式禁用而不是静默失效。
  const activeTemplateTokens = templates.find((tpl) => tpl.id === selectedTemplate)?.design_tokens;
  const supportsFontFamily =
    SHOWCASE || !selectedTemplate || Boolean(activeTemplateTokens?.fontFamily);

  useEffect(() => {
    if (SHOWCASE) {
      // 展示模式：模板列表由本地数据层提供（无后端）
      showcaseHandle("/api/studio/templates").then((data) => {
        if (Array.isArray(data)) setTemplates(data as Template[]);
      });
      return;
    }
    let cancelled = false;
    fetch(`${API_BASE}/api/studio/templates`, { redirect: "error" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        if (Array.isArray(data)) setTemplates(data as Template[]);
      })
      .catch((err) => {
        if (cancelled) return;
        // 失败保持可见：不再静默留下空模板列表
        setTemplatesError(err instanceof Error ? err.message : "模板加载失败");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleGenerate = async () => {
    if (!selectedTemplate) return;

    setLoading(true);
    setGenerateError(null);
    try {
      const res = await fetch(`${API_BASE}/api/studio/generate`, {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile_id: 1, // 本地单人应用：固定默认 profile
          template_id: selectedTemplate,
          design_overrides: {
            primaryColor,
            ...(supportsFontFamily ? { fontFamily: `'${fontFamily}', sans-serif` } : {}),
          },
          job_ids: []
        })
      });

      const data = await res.json().catch(() => null);
      if (!res.ok) {
        // 失败不伪造成功：不把 undefined 拼成预览地址，也不在 iframe 里静默显示错误页
        const detail = data?.detail ?? data?.message;
        throw new Error(
          typeof detail === "string" && detail ? detail : `生成失败（HTTP ${res.status}）`
        );
      }
      if (!data?.id) throw new Error("生成结果缺少简历 ID");
      setPreviewUrl(`${API_BASE}/api/studio/resumes/${data.id}/preview`);
    } catch (err) {
      setPreviewUrl(null);
      setGenerateError(err instanceof Error ? err.message : "生成失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-[1440px] min-w-0 p-4 sm:p-6 lg:p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">HTML 简历工作室</h1>
        <p className="text-gray-600">选择模板，AI 一键生成可视化简历</p>
      </div>

      {/* 宽屏三栏；中小屏按模板 → 预览 → 设计控制顺序重排。 */}
      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(190px,0.8fr)_minmax(0,1.6fr)_minmax(190px,0.8fr)] lg:gap-6">
        {/* 左侧：模板列表 */}
        <div className="min-w-0 space-y-4">
          <h2 className="font-semibold mb-4">选择模板</h2>
          {templatesError && (
            <p role="alert" className="rounded bg-red-50 px-3 py-2 text-xs text-red-700">
              模板加载失败：{templatesError}
            </p>
          )}
          {!templatesError && templates.length === 0 && (
            <p className="text-xs text-gray-500">暂无可用模板</p>
          )}
          {templates.map(tpl => (
            <Card
              key={tpl.id}
              isPressable
              isHoverable
              className={selectedTemplate === tpl.id ? "border-2 border-blue-500" : ""}
              onPress={() => setSelectedTemplate(tpl.id)}
            >
              <div className="p-4">
                {SHOWCASE || previewFailures[tpl.id] ? (
                  // 展示模式或资源不可用时保留可操作的品牌占位态
                  <div className="flex h-32 w-full items-center justify-center rounded bg-[#f2e9e1] text-sm font-bold text-[#b3541a]">
                    <span className="text-center">
                      <span className="block">{tpl.display_name}</span>
                      {previewFailures[tpl.id] && <span className="mt-1 block text-[10px] font-medium opacity-70">预览图暂不可用</span>}
                    </span>
                  </div>
                ) : (
                  <img
                    src={`${API_BASE}${tpl.preview_image}`}
                    alt={tpl.display_name}
                    className="mb-2 h-32 w-full min-w-0 rounded object-cover"
                    onError={() => setPreviewFailures((current) => ({ ...current, [tpl.id]: true }))}
                  />
                )}
                <div className="font-medium">{tpl.display_name}</div>
                <div className="text-xs text-gray-500">{tpl.category}</div>
              </div>
            </Card>
          ))}
        </div>

        {/* 中间：预览区 */}
        <div className="min-w-0 space-y-2">
          <div className="h-[min(70dvh,720px)] min-h-[320px] overflow-hidden rounded-lg bg-white p-4 shadow-lg sm:min-h-[400px]">
            {previewUrl ? (
              <iframe src={previewUrl} title="简历预览" className="w-full h-full border-0" />
            ) : (
              <div className="flex items-center justify-center h-full text-gray-400">
                选择模板后点击生成预览
              </div>
            )}
          </div>
          {generateError && (
            <p role="alert" className="rounded bg-red-50 px-3 py-2 text-xs text-red-700">
              生成失败：{generateError}
            </p>
          )}
        </div>

        {/* 右侧：设计系统 */}
        <div className="min-w-0 space-y-4">
          <h2 className="font-semibold mb-4">设计系统</h2>
          <Card>
            <div className="p-4">
              <label className="block mb-2 text-sm" htmlFor="studio-primary-color">主题色</label>
              <input
                id="studio-primary-color"
                type="color"
                value={primaryColor}
                onChange={(event) => setPrimaryColor(event.target.value)}
                className="w-full h-10 rounded"
              />
            </div>
          </Card>

          <Card>
            <div className="p-4">
              <label className="block mb-2 text-sm" htmlFor="studio-font-family">字体</label>
              <select
                id="studio-font-family"
                value={fontFamily}
                onChange={(event) => setFontFamily(event.target.value)}
                disabled={!supportsFontFamily}
                className="w-full p-2 border rounded disabled:opacity-50"
              >
                {DESIGN_FONTS.map((font) => (
                  <option key={font} value={font}>{font}</option>
                ))}
              </select>
              {!supportsFontFamily && (
                <p className="mt-2 text-[11px] text-gray-500">当前模板不使用自定义字体</p>
              )}
            </div>
          </Card>

          <Button
            color="primary"
            className="w-full"
            onPress={handleGenerate}
            isLoading={loading}
            isDisabled={!selectedTemplate}
          >
            {loading ? "生成中..." : "生成简历"}
          </Button>
        </div>
      </div>
    </div>
  );
}
