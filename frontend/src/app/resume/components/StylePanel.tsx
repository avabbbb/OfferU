// =============================================
// StylePanel — 样式调节面板
// =============================================
// 用户通过此面板调节简历的视觉样式
// 所有参数对应 CSS 变量，实时作用于 A4 预览
// 保存时存入 resume.style_config JSON
// =============================================
// 可调参数：
//   - 主色调（primaryColor）
//   - 正文字号（bodySize）
//   - 标题字号（headingSize）
//   - 行高（lineHeight）
//   - 页面边距（pageMargin）
//   - 段落间距（sectionGap）
// =============================================

"use client";

import { Card, CardBody, Slider } from "@heroui/react";
import { Palette, Type, AlignVerticalSpaceAround } from "lucide-react";

/** 默认样式值，与后端 DEFAULT_STYLE 保持一致 */
export const DEFAULT_STYLE_CONFIG: Record<string, string> = {
  primaryColor: "#222222",
  accentColor: "#666666",
  bodySize: "10",
  headingSize: "12",
  lineHeight: "1.5",
  pageMargin: "2",
  sectionGap: "14",
};

/** 预设颜色方案 */
const COLOR_PRESETS = [
  { label: "经典黑", value: "#222222" },
  { label: "深蓝", value: "#1e3a5f" },
  { label: "墨绿", value: "#1a4a3a" },
  { label: "酒红", value: "#6b1d2a" },
  { label: "靛蓝", value: "#2d3561" },
  { label: "深棕", value: "#4a3728" },
];

interface StylePanelProps {
  config: Record<string, string>;
  onChange: (config: Record<string, string>) => void;
}

/**
 * 样式调节面板
 * ─────────────────────────────────────────────
 * 所有滑块/颜色选择器的变更会实时触发 onChange，
 * 父组件将 config 注入到 A4 预览区的 CSS 变量中。
 */
export default function StylePanel({ config, onChange }: StylePanelProps) {
  const update = (key: string, value: string) => {
    onChange({ ...config, [key]: value });
  };

  const val = (key: string) => config[key] || DEFAULT_STYLE_CONFIG[key];

  return (
    <Card className="bg-white/5 border border-white/10">
      <CardBody className="space-y-5 p-4">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Palette size={16} className="text-white/60" />
          样式调节
        </h3>

        {/* 主色调 */}
        <div className="space-y-2">
          <label className="text-xs text-white/50">主色调</label>
          <div className="flex gap-2 flex-wrap">
            {COLOR_PRESETS.map((preset) => (
              <button
                key={preset.value}
                className={`w-7 h-7 rounded-lg border-2 transition-all ${
                  val("primaryColor") === preset.value
                    ? "border-white scale-110"
                    : "border-transparent hover:border-white/30"
                }`}
                style={{ backgroundColor: preset.value }}
                onClick={() => update("primaryColor", preset.value)}
                title={preset.label}
              />
            ))}
            {/* 自定义颜色输入 */}
            <input
              type="color"
              value={val("primaryColor")}
              onChange={(e) => update("primaryColor", e.target.value)}
              className="w-7 h-7 rounded-lg cursor-pointer bg-transparent border border-white/20"
              title="自定义颜色"
            />
          </div>
        </div>

        {/* 正文字号 */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-xs text-white/50 flex items-center gap-1">
              <Type size={12} />
              正文字号
            </label>
            <span className="text-xs text-white/40 font-mono">{val("bodySize")}pt</span>
          </div>
          <Slider
            size="sm"
            step={0.5}
            minValue={8}
            maxValue={14}
            value={parseFloat(val("bodySize"))}
            onChange={(v) => update("bodySize", String(v))}
            className="max-w-full"
          />
        </div>

        {/* 标题字号 */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-xs text-white/50 flex items-center gap-1">
              <Type size={12} />
              标题字号
            </label>
            <span className="text-xs text-white/40 font-mono">{val("headingSize")}pt</span>
          </div>
          <Slider
            size="sm"
            step={0.5}
            minValue={10}
            maxValue={18}
            value={parseFloat(val("headingSize"))}
            onChange={(v) => update("headingSize", String(v))}
            className="max-w-full"
          />
        </div>

        {/* 行高 */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-xs text-white/50 flex items-center gap-1">
              <AlignVerticalSpaceAround size={12} />
              行高
            </label>
            <span className="text-xs text-white/40 font-mono">{val("lineHeight")}</span>
          </div>
          <Slider
            size="sm"
            step={0.1}
            minValue={1.0}
            maxValue={2.0}
            value={parseFloat(val("lineHeight"))}
            onChange={(v) => update("lineHeight", String(v))}
            className="max-w-full"
          />
        </div>

        {/* 页面边距 */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-xs text-white/50">页面边距</label>
            <span className="text-xs text-white/40 font-mono">{val("pageMargin")}cm</span>
          </div>
          <Slider
            size="sm"
            step={0.1}
            minValue={1.0}
            maxValue={3.0}
            value={parseFloat(val("pageMargin"))}
            onChange={(v) => update("pageMargin", String(v))}
            className="max-w-full"
          />
        </div>

        {/* 段落间距 */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-xs text-white/50">段落间距</label>
            <span className="text-xs text-white/40 font-mono">{val("sectionGap")}pt</span>
          </div>
          <Slider
            size="sm"
            step={1}
            minValue={6}
            maxValue={24}
            value={parseInt(val("sectionGap"))}
            onChange={(v) => update("sectionGap", String(v))}
            className="max-w-full"
          />
        </div>
      </CardBody>
    </Card>
  );
}
