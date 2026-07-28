// =============================================
// StyleToolbar aria — Notion/Linear 风 简版样式工具条
// =============================================
// 用法：
//   <StyleToolbarAria config={styleConfig} onChange={setStyleConfig} />
// 控制 5 个核心 CSS 变量：
//   --resume-primary   主文本色
//   --resume-secondary 次要文本色
//   --resume-tertiary  弱文本色
//   --resume-link      链接色
//   --resume-border    分隔线色
// 外层 div 通过 styleConfigToCSSVars(config) 把 styleConfig 映射到 CSS 变量。
// 持久化由父组件负责：写入 ResumeUpdatePayload.style_config。
// =============================================

"use client";

import { useEffect, useRef, useState } from "react";
import { Palette, Type, Undo2 } from "lucide-react";

export type StyleConfig = Record<string, string>;

export const DEFAULT_STYLE_CONFIG: StyleConfig = {
  primaryColor: "#37352f",
  secondaryColor: "#666666",
  tertiaryColor: "#999999",
  linkColor: "#5b9cd6",
  borderColor: "#e5e5e5",
};

/** 把 styleConfig 转为 CSS 变量键值对象（供外层 div style 注入）。 */
export function styleConfigToCSSVars(config: StyleConfig): React.CSSProperties {
  const c = { ...DEFAULT_STYLE_CONFIG, ...config };
  return {
    ["--resume-primary" as any]: c.primaryColor,
    ["--resume-secondary" as any]: c.secondaryColor,
    ["--resume-tertiary" as any]: c.tertiaryColor,
    ["--resume-link" as any]: c.linkColor,
    ["--resume-border" as any]: c.borderColor,
  } as React.CSSProperties;
}

interface ToolbarProps {
  config: StyleConfig;
  onChange: (next: StyleConfig) => void;
}

const COLOR_PRESETS: Array<{ label: string; primary: string; secondary: string; tertiary: string; link: string }> = [
  { label: "Notion", primary: "#37352f", secondary: "#666666", tertiary: "#999999", link: "#5b9cd6" },
  { label: "深夜", primary: "#1a1a1a", secondary: "#4a4a4a", tertiary: "#7a7a7a", link: "#4a90e2" },
  { label: "靛蓝", primary: "#1e3a5f", secondary: "#4a6075", tertiary: "#7a8aa0", link: "#3b82f6" },
  { label: "墨绿", primary: "#1a4a3a", secondary: "#426055", tertiary: "#728780", link: "#10b981" },
  { label: "酒红", primary: "#6b1d2a", secondary: "#8a4a55", tertiary: "#a87a82", link: "#ef4444" },
  { label: "深棕", primary: "#4a3728", secondary: "#6a5a4a", tertiary: "#9a8d7e", link: "#b45309" },
];

export default function StyleToolbarAria({ config, onChange }: ToolbarProps) {
  const [openColor, setOpenColor] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!openColor) return;
    const onDown = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) {
        setOpenColor(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [openColor]);

  const update = (key: string, value: string) => {
    onChange({ ...config, [key]: value });
  };

  const applyPreset = (preset: (typeof COLOR_PRESETS)[number]) => {
    onChange({
      ...config,
      primaryColor: preset.primary,
      secondaryColor: preset.secondary,
      tertiaryColor: preset.tertiary,
      linkColor: preset.link,
    });
  };

  const reset = () => onChange({ ...DEFAULT_STYLE_CONFIG });

  const swatches: Array<{ key: keyof typeof DEFAULT_STYLE_CONFIG; label: string }> = [
    { key: "primaryColor", label: "主文本" },
    { key: "secondaryColor", label: "次要文本" },
    { key: "tertiaryColor", label: "弱文本" },
    { key: "linkColor", label: "链接" },
    { key: "borderColor", label: "分隔线" },
  ];

  return (
    <div
      style={{
        position: "fixed",
        right: 16,
        bottom: 52,
        zIndex: 30,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        alignItems: "flex-end",
      }}
    >
      {openColor && (
        <div
          ref={popRef}
          style={{
            background: "#ffffff",
            border: "1px solid rgba(55,53,47,0.10)",
            borderRadius: 10,
            boxShadow: "none",
            padding: "12px 14px",
            width: 240,
            fontSize: 12,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 10,
            }}
          >
            <span
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: "#37352f",
                letterSpacing: 0.1,
              }}
            >
              样式配色
            </span>
            <button
              onClick={reset}
              title="重置为默认"
              style={{
                border: "none",
                background: "transparent",
                cursor: "pointer",
                color: "#9b9a97",
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontSize: 11,
                padding: 0,
              }}
            >
              <Undo2 size={11} />
              重置
            </button>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: 6,
              marginBottom: 12,
            }}
          >
            {COLOR_PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => applyPreset(p)}
                title={p.label}
                style={{
                  border: "1px solid rgba(55,53,47,0.10)",
                  borderRadius: 6,
                  padding: "6px 4px",
                  fontSize: 11,
                  cursor: "pointer",
                  background: "#fbfaf8",
                  color: "#37352f",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 3,
                }}
              >
                <div style={{ display: "flex", gap: 2 }}>
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 2,
                      background: p.primary,
                    }}
                  />
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 2,
                      background: p.link,
                    }}
                  />
                </div>
                <span style={{ fontSize: 10 }}>{p.label}</span>
              </button>
            ))}
          </div>

          <div
            style={{
              borderTop: "1px solid rgba(55,53,47,0.06)",
              paddingTop: 10,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {swatches.map((s) => (
              <label
                key={s.key}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  fontSize: 11,
                  color: "#37352f",
                }}
              >
                <span style={{ color: "#666" }}>{s.label}</span>
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <input
                    type="color"
                    value={config[s.key] || DEFAULT_STYLE_CONFIG[s.key]}
                    onChange={(e) => update(s.key, e.target.value)}
                    style={{
                      width: 28,
                      height: 22,
                      border: "1px solid rgba(55,53,47,0.12)",
                      borderRadius: 4,
                      background: "transparent",
                      cursor: "pointer",
                      padding: 0,
                    }}
                  />
                  <span
                    style={{
                      fontFamily: "ui-monospace, SFMono-Regular, monospace",
                      fontSize: 10,
                      color: "#9b9a97",
                      width: 56,
                    }}
                  >
                    {config[s.key] || DEFAULT_STYLE_CONFIG[s.key]}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </div>
      )}

      <button
        onClick={() => setOpenColor((v) => !v)}
        aria-label="切换样式配色"
        aria-expanded={openColor}
        style={{
          width: 38,
          height: 38,
          borderRadius: 10,
          border: "1px solid rgba(55,53,47,0.10)",
          background: "#ffffff",
          boxShadow: "none",
          cursor: "pointer",
          color: "#37352f",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          transition: "transform 0.12s",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.transform = "translateY(-1px)")}
        onMouseLeave={(e) => (e.currentTarget.style.transform = "translateY(0)")}
      >
        <Palette size={16} />
      </button>
    </div>
  );
}

// Unused export kept for legacy imports — old toolbar no longer mounted,
// but consumer types may still reference it.
export const _legacyType = Type;