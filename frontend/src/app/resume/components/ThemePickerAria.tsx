"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { LayoutTemplate, Check } from "lucide-react";
import {
  THEME_PRESETS,
  applyPreset,
  type ThemePreset,
} from "./themePresets";
import type { StyleConfig } from "./StyleToolbar";

interface Props {
  config: StyleConfig;
  onChange: (next: StyleConfig) => void;
}

export default function ThemePickerAria({ config, onChange }: Props) {
  const [open, setOpen] = useState(false);

  const activePresetId = findActivePresetId(config);

  const handleApply = (preset: ThemePreset) => {
    onChange(applyPreset(preset, config));
    setOpen(false);
  };

  return (
    <div
      style={{
        position: "fixed",
        bottom: 16,
        left: 16,
        zIndex: 30,
        fontFamily:
          "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
      }}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        title="切换模板预设"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "8px 12px",
          border: "1px solid #ebe9e4",
          borderRadius: 999,
          background: open ? "#2b2a28" : "#fff",
          color: open ? "#fff" : "#37352f",
          fontSize: 12,
          cursor: "pointer",
          boxShadow: "none",
        }}
      >
        <LayoutTemplate size={14} />
        <span>模板预设</span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.18 }}
            style={{
              position: "absolute",
              bottom: 44,
              left: 0,
              width: 320,
              padding: 12,
              background: "#fbfaf8",
              border: "1px solid #ebe9e4",
              borderRadius: 10,
              boxShadow: "none",
            }}
          >
            <div
              style={{
                fontSize: 12,
                color: "#6b6a63",
                marginBottom: 10,
              }}
            >
              选择主题预设 · 颜色一键覆盖
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(2, 1fr)",
                gap: 8,
              }}
            >
              {THEME_PRESETS.map((p) => {
                const active = p.id === activePresetId;
                return (
                  <button
                    key={p.id}
                    onClick={() => handleApply(p)}
                    style={{
                      textAlign: "left",
                      padding: 10,
                      border: active
                        ? "1px solid #2b2a28"
                        : "1px solid #ebe9e4",
                      borderRadius: 8,
                      background: active ? "#f0eee9" : "#fff",
                      cursor: "pointer",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        marginBottom: 6,
                      }}
                    >
                      <span
                        style={{
                          display: "inline-block",
                          width: 10,
                          height: 10,
                          borderRadius: 999,
                          background: p.swatch.primary,
                        }}
                      />
                      <span
                        style={{
                          display: "inline-block",
                          width: 10,
                          height: 10,
                          borderRadius: 999,
                          background: p.swatch.secondary,
                        }}
                      />
                      <span
                        style={{
                          display: "inline-block",
                          width: 10,
                          height: 10,
                          borderRadius: 999,
                          background: p.swatch.accent,
                        }}
                      />
                      {active && <Check size={12} style={{ color: "#2b2a28", marginLeft: "auto" }} />}
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: "#37352f",
                      }}
                    >
                      {p.name}
                    </div>
                    <div
                      style={{
                        fontSize: 10,
                        color: "#9b9a97",
                        marginTop: 2,
                        lineHeight: 1.4,
                      }}
                    >
                      {p.description}
                    </div>
                  </button>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function findActivePresetId(config: StyleConfig): string | null {
  for (const p of THEME_PRESETS) {
    const k = Object.keys(p.config) as (keyof StyleConfig)[];
    if (k.every((key) => config[key] === p.config[key])) {
      return p.id;
    }
  }
  return null;
}