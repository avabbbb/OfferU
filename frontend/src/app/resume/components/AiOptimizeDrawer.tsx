"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Loader2, Sparkles, Check, Copy, Wand2 } from "lucide-react";
import {
  aiOptimizeResume,
  type AiOptimizeResult,
  type AiSuggestion,
} from "@/lib/hooks";
import type { PuckResumeData } from "@/lib/puckMigration";

interface Props {
  open: boolean;
  onClose: () => void;
  resumeId: number;
  puckData: PuckResumeData | null;
  onApplyBulletRewrite: (suggestion: AiSuggestion) => void;
}

export default function AiOptimizeDrawer({
  open,
  onClose,
  resumeId,
  puckData,
  onApplyBulletRewrite,
}: Props) {
  const [jdText, setJdText] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AiOptimizeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [appliedIds, setAppliedIds] = useState<Set<number>>(new Set());

  const handleRun = async () => {
    if (!jdText.trim()) {
      setError("请粘贴 JD 文本");
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    setAppliedIds(new Set());
    try {
      const r = await aiOptimizeResume(resumeId, { jd_text: jdText.trim() });
      setResult(r);
    } catch (e: any) {
      setError(e?.message || "AI 分析失败");
    } finally {
      setLoading(false);
    }
  };

  const handleApply = (idx: number, suggestion: AiSuggestion) => {
    if (suggestion.type !== "bullet_rewrite") {
      const text =
        typeof suggestion.suggested === "string"
          ? suggestion.suggested
          : JSON.stringify(suggestion.suggested, null, 2);
      navigator.clipboard?.writeText(text);
      setAppliedIds((prev) => new Set(prev).add(idx));
      return;
    }
    if (!puckData) return;
    onApplyBulletRewrite(suggestion);
    setAppliedIds((prev) => new Set(prev).add(idx));
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(15, 15, 15, 0.25)",
              zIndex: 50,
            }}
          />
          <motion.aside
            initial={{ x: 460 }}
            animate={{ x: 0 }}
            exit={{ x: 460 }}
            transition={{ type: "spring", stiffness: 320, damping: 32 }}
            style={{
              position: "fixed",
              top: 0,
              right: 0,
              bottom: 0,
              width: 440,
              background: "#fbfaf8",
              borderLeft: "1px solid var(--resume-border, #ebe9e4)",
              boxShadow: "none",
              display: "flex",
              flexDirection: "column",
              zIndex: 51,
              fontFamily:
                "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
            }}
          >
            <header
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "14px 18px",
                borderBottom: "1px solid #ebe9e4",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Wand2 size={16} style={{ color: "#5b59a0" }} />
                <span style={{ fontSize: 14, fontWeight: 600, color: "#37352f" }}>
                  AI 优化（对标 JD）
                </span>
              </div>
              <button
                onClick={onClose}
                style={{
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  color: "#9b9a97",
                  padding: 4,
                }}
                aria-label="关闭"
              >
                <X size={18} />
              </button>
            </header>

            <div
              style={{
                flex: 1,
                overflowY: "auto",
                padding: "16px 18px",
                display: "flex",
                flexDirection: "column",
                gap: 14,
              }}
            >
              <section>
                <label
                  style={{
                    display: "block",
                    fontSize: 12,
                    color: "#6b6a63",
                    marginBottom: 6,
                  }}
                >
                  目标岗位 JD（粘贴全文）
                </label>
                <textarea
                  value={jdText}
                  onChange={(e) => setJdText(e.target.value)}
                  placeholder="贴入 JD…"
                  rows={6}
                  style={{
                    width: "100%",
                    border: "1px solid #ebe9e4",
                    borderRadius: 6,
                    padding: "8px 10px",
                    fontSize: 13,
                    color: "#37352f",
                    background: "#fff",
                    resize: "vertical",
                    outline: "none",
                    boxSizing: "border-box",
                  }}
                />
                <button
                  onClick={handleRun}
                  disabled={loading}
                  style={{
                    marginTop: 8,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "8px 14px",
                    border: "none",
                    borderRadius: 6,
                    background: loading ? "#c7c6c1" : "#37352f",
                    color: "#fff",
                    fontSize: 13,
                    cursor: loading ? "not-allowed" : "pointer",
                  }}
                >
                  {loading ? (
                    <Loader2 size={14} className="spin" />
                  ) : (
                    <Sparkles size={14} />
                  )}
                  {loading ? "分析中…" : "调用 AI 分析"}
                </button>
              </section>

              {error && (
                <div
                  style={{
                    padding: "8px 10px",
                    background: "#fdecea",
                    border: "1px solid #f5c6c0",
                    borderRadius: 6,
                    color: "#b3372e",
                    fontSize: 12,
                  }}
                >
                  {error}
                </div>
              )}

              {result && (
                <>
                  <ResultOverview result={result} />
                  {result.suggestions.map((s, i) => (
                    <SuggestionCard
                      key={i}
                      index={i}
                      suggestion={s}
                      applied={appliedIds.has(i)}
                      onApply={() => handleApply(i, s)}
                    />
                  ))}
                </>
              )}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

function ResultOverview({ result }: { result: AiOptimizeResult }) {
  const score = result.keyword_match?.score ?? 0;
  return (
    <section
      style={{
        border: "1px solid #ebe9e4",
        borderRadius: 8,
        background: "#fff",
        padding: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 8,
        }}
      >
        <div
          style={{
            fontSize: 20,
            fontWeight: 700,
            color: score >= 75 ? "#2e7d32" : score >= 50 ? "#b3541a" : "#b3372e",
          }}
        >
          {score}
        </div>
        <div style={{ fontSize: 12, color: "#6b6a63" }}>关键词匹配度</div>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 8 }}>
        {(result.keyword_match?.matched ?? []).map((k) => (
          <Chip key={`m-${k}`} text={k} tone="ok" />
        ))}
        {(result.keyword_match?.missing ?? []).map((k) => (
          <Chip key={`x-${k}`} text={k} tone="miss" />
        ))}
      </div>
      {result.summary && (
        <p
          style={{
            marginTop: 10,
            fontSize: 12,
            color: "#6b6a63",
            lineHeight: 1.6,
          }}
        >
          {result.summary}
        </p>
      )}
    </section>
  );
}

function Chip({
  text,
  tone,
}: {
  text: string;
  tone: "ok" | "miss";
}) {
  const palette = {
    ok: { bg: "#eef5ee", color: "#2e7d32" },
    miss: { bg: "#fdecea", color: "#b3372e" },
  }[tone];
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 999,
        background: palette.bg,
        color: palette.color,
        fontSize: 11,
      }}
    >
      {text}
    </span>
  );
}

function SuggestionCard({
  index,
  suggestion,
  applied,
  onApply,
}: {
  index: number;
  suggestion: AiSuggestion;
  applied: boolean;
  onApply: () => void;
}) {
  const typeLabel =
    suggestion.type === "bullet_rewrite"
      ? "重写经历 Bullet"
      : suggestion.type === "keyword_add"
      ? "补充技能关键词"
      : suggestion.type === "section_reorder"
      ? "模块排序建议"
      : suggestion.type;
  const writable = suggestion.type === "bullet_rewrite";
  const actionLabel =
    suggestion.type === "bullet_rewrite"
      ? "采纳并写回"
      : "复制建议内容";

  const originalText =
    typeof suggestion.original === "string"
      ? suggestion.original
      : JSON.stringify(suggestion.original, null, 2);
  const suggestedText =
    typeof suggestion.suggested === "string"
      ? suggestion.suggested
      : typeof suggestion.suggested === "object" && suggestion.suggested
      ? JSON.stringify(suggestion.suggested, null, 2)
      : String(suggestion.suggested ?? "");

  return (
    <section
      style={{
        border: "1px solid #ebe9e4",
        borderRadius: 8,
        background: "#fff",
        padding: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 4,
        }}
      >
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: writable ? "#5b59a0" : "#6b6a63",
            background: writable ? "#ecebff" : "#f3f2ee",
            padding: "2px 6px",
            borderRadius: 4,
          }}
        >
          {typeLabel}
        </span>
        {suggestion.item_label && (
          <span style={{ fontSize: 11, color: "#9b9a97" }}>
            {suggestion.item_label}
          </span>
        )}
      </div>
      {(suggestion.section_title || writable) && (
        <div style={{ fontSize: 12, color: "#37352f", marginBottom: 6 }}>
          {suggestion.section_title}
        </div>
      )}
      {originalText && (
        <pre
          style={{
            fontSize: 12,
            color: "#6b6a63",
            background: "#f7f6f3",
            padding: 8,
            borderRadius: 6,
            whiteSpace: "pre-wrap",
            margin: "0 0 6",
            fontFamily: "inherit",
          }}
        >
          {originalText}
        </pre>
      )}
      {suggestedText && (
        <pre
          style={{
            fontSize: 12,
            color: "#1c3a3a",
            background: "#eef7f6",
            padding: 8,
            borderRadius: 6,
            whiteSpace: "pre-wrap",
            margin: "0 0 6",
            fontFamily: "inherit",
            border: "1px solid #c8e4e2",
          }}
        >
          {suggestedText}
        </pre>
      )}
      <p
        style={{
          fontSize: 11,
          color: "#9b9a97",
          margin: "0 0 8",
          fontStyle: "italic",
        }}
      >
        {suggestion.reason}
      </p>
      <button
        onClick={onApply}
        disabled={applied}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 12px",
          border: "1px solid",
          borderColor: applied ? "#c7c6c1" : writable ? "#5b59a0" : "#ebe9e4",
          background: applied ? "#f3f2ee" : writable ? "#5b59a0" : "#fff",
          color: applied ? "#9b9a97" : writable ? "#fff" : "#37352f",
          borderRadius: 6,
          fontSize: 12,
          cursor: applied ? "default" : "pointer",
        }}
      >
        {applied ? <Check size={12} /> : <Copy size={12} />}
        {applied ? (writable ? "已写回" : "已复制") : actionLabel}
      </button>
    </section>
  );
}