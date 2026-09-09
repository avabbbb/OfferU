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
}

export default function StudioPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (SHOWCASE) {
      // 展示模式：模板列表由本地数据层提供（无后端）
      showcaseHandle("/api/studio/templates").then((data) => {
        if (Array.isArray(data)) setTemplates(data as Template[]);
      });
      return;
    }
    fetch(`${API_BASE}/api/studio/templates`, { redirect: "error" })
      .then(res => res.json())
      .then(setTemplates);
  }, []);

  const handleGenerate = async () => {
    if (!selectedTemplate) return;

    setLoading(true);
    const res = await fetch(`${API_BASE}/api/studio/generate`, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profile_id: 1, // 本地单人应用：固定默认 profile
        template_id: selectedTemplate,
        design_overrides: {},
        job_ids: []
      })
    });

    const data = await res.json();
    setPreviewUrl(`${API_BASE}/api/studio/resumes/${data.id}/preview`);
    setLoading(false);
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
          {templates.map(tpl => (
            <Card
              key={tpl.id}
              isPressable
              isHoverable
              className={selectedTemplate === tpl.id ? "border-2 border-blue-500" : ""}
              onPress={() => setSelectedTemplate(tpl.id)}
            >
              <div className="p-4">
                {SHOWCASE ? (
                  // 展示模式：预览图资产在后端本地，用品牌色占位块
                  <div className="flex h-32 w-full items-center justify-center rounded bg-[#f2e9e1] text-sm font-bold text-[#b3541a]">
                    {tpl.display_name}
                  </div>
                ) : (
                  <img src={`${API_BASE}${tpl.preview_image}`} alt={tpl.display_name} className="mb-2 h-32 w-full min-w-0 rounded object-cover" />
                )}
                <div className="font-medium">{tpl.display_name}</div>
                <div className="text-xs text-gray-500">{tpl.category}</div>
              </div>
            </Card>
          ))}
        </div>

        {/* 中间：预览区 */}
        <div className="min-w-0">
          <div className="h-[min(70dvh,720px)] min-h-[320px] overflow-hidden rounded-lg bg-white p-4 shadow-lg sm:min-h-[400px]">
            {previewUrl ? (
              <iframe src={previewUrl} className="w-full h-full border-0" />
            ) : (
              <div className="flex items-center justify-center h-full text-gray-400">
                选择模板后点击生成预览
              </div>
            )}
          </div>
        </div>

        {/* 右侧：设计系统 */}
        <div className="min-w-0 space-y-4">
          <h2 className="font-semibold mb-4">设计系统</h2>
          <Card>
            <div className="p-4">
              <label className="block mb-2 text-sm">主题色</label>
              <input type="color" defaultValue="#2563eb" className="w-full h-10 rounded" />
            </div>
          </Card>

          <Card>
            <div className="p-4">
              <label className="block mb-2 text-sm">字体</label>
              <select className="w-full p-2 border rounded">
                <option>Inter</option>
                <option>Poppins</option>
                <option>JetBrains Mono</option>
              </select>
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
