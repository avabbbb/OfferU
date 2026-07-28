"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Sparkles, X, Loader2, AlertCircle, Check } from "lucide-react";
import {
  streamGenerateResumeDraft,
  type DraftResult,
} from "@/lib/hooks";

interface Props {
  resumeId: number;
  open: boolean;
  onClose: () => void;
  onApply: (draft: DraftResult) => void;
}

type Stage = "idle" | "loading" | "result" | "error";

export default function AiGenerateDrawer({ resumeId, open, onClose, onApply }: Props) {
  const [jdText, setJdText] = useState("");
  const [stage, setStage] = useState<Stage>("idle");
  const [progressMsg, setProgressMsg] = useState("");
  const [draft, setDraft] = useState<DraftResult | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [applied, setApplied] = useState(false);

  const resetState = () => {
    setStage("idle");
    setProgressMsg("");
    setDraft(null);
    setErrorMsg("");
    setApplied(false);
  };

  const handleClose = () => {
    resetState();
    onClose();
  };

  const handleGenerate = async () => {
    if (jdText.trim().length < 10) {
      setErrorMsg("JD 文本至少 10 字符");
      setStage("error");
      return;
    }
    setStage("loading");
    setProgressMsg("Loading profile...");
    setDraft(null);
    setErrorMsg("");
    setApplied(false);
    try {
      await streamGenerateResumeDraft(
        resumeId,
        { jd_text: jdText.trim() },
        {
          onEvent: (ev) => {
            if (ev.progress) setProgressMsg(ev.progress.message);
            else if (ev.result) {
              setDraft(ev.result);
              setStage("result");
            } else if (ev.error) {
              setErrorMsg(ev.error);
              setStage("error");
            }
          },
        }
      );
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setStage("error");
    }
  };

  const handleApply = () => {
    if (!draft) return;
    onApply(draft);
    setApplied(true);
    setTimeout(() => handleClose(), 600);
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={handleClose}
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(15, 15, 15, 0.32)",
              zIndex: 40,
            }}
          />
          <motion.div
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", stiffness: 360, damping: 38 }}
            style={{
              position: "fixed",
              top: 0,
              right: 0,
              bottom: 0,
              width: "min(560px, 92vw)",
              background: "#fbfaf8",
              borderLeft: "1px solid #ebe9e4",
              zIndex: 41,
              display: "flex",
              flexDirection: "column",
              fontFamily:
                "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
            }}
          >
            {/* Header */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "16px 20px",
                borderBottom: "1px solid #ebe9e4",
              }}
            >
              <Sparkles size={18} style={{ color: "#2b2a28" }} />
              <div style={{ fontWeight: 600, fontSize: 14, color: "#37352f", flex: 1 }}>
                AI 生成简历初稿
              </div>
              <button
                onClick={handleClose}
                style={{
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  color: "#9b9a97",
                  display: "inline-flex",
                }}
                aria-label="关闭"
              >
                <X size={16} />
              </button>
            </div>

            {/* Body */}
            <div style={{ flex: 1, overflow: "auto", padding: "16px 20px" }}>
              <label
                style={{
                  display: "block",
                  fontSize: 12,
                  color: "#6b6a63",
                  marginBottom: 6,
                }}
              >
                目标岗位 JD
              </label>
              <textarea
                value={jdText}
                onChange={(e) => setJdText(e.target.value)}
                placeholder="粘贴目标岗位的 JD 全文..."
                disabled={stage === "loading"}
                style={{
                  width: "100%",
                  minHeight: 140,
                  padding: 10,
                  border: "1px solid #ebe9e4",
                  borderRadius: 8,
                  background: "#fff",
                  fontSize: 13,
                  fontFamily: "inherit",
                  resize: "vertical",
                  outline: "none",
                  color: "#37352f",
                  boxSizing: "border-box",
                }}
              />

              <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
                <button
                  onClick={handleGenerate}
                  disabled={stage === "loading" || jdText.trim().length < 10}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "8px 14px",
                    border: "1px solid #2b2a28",
                    borderRadius: 8,
                    background: "#2b2a28",
                    color: "#fff",
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: stage === "loading" ? "wait" : "pointer",
                    opacity: stage === "loading" || jdText.trim().length < 10 ? 0.6 : 1,
                  }}
                >
                  {stage === "loading" ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <Sparkles size={13} />
                  )}
                  {stage === "loading" ? "生成中..." : "生成初稿"}
                </button>
                {stage === "result" && draft && !applied && (
                  <button
                    onClick={handleApply}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "8px 14px",
                      border: "1px solid #2e7d32",
                      borderRadius: 8,
                      background: "#2e7d32",
                      color: "#fff",
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    <Check size={13} />
                    一键应用到编辑器
                  </button>
                )}
                {applied && (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "#2e7d32", fontSize: 12, fontWeight: 600 }}>
                    <Check size={14} /> 已应用
                  </span>
                )}
              </div>

              {/* Progress */}
              {stage === "loading" && progressMsg && (
                <div style={{ marginTop: 14, fontSize: 12, color: "#9b9a97" }}>
                  <Loader2 size={12} style={{ display: "inline-block", marginRight: 6 }} className="animate-spin" />
                  {progressMsg}
                </div>
              )}

              {/* Error */}
              {stage === "error" && errorMsg && (
                <div
                  style={{
                    marginTop: 14,
                    padding: 12,
                    border: "1px solid #d73645",
                    borderRadius: 8,
                    background: "#fff0f1",
                    display: "flex",
                    gap: 8,
                    alignItems: "flex-start",
                  }}
                >
                  <AlertCircle size={14} style={{ color: "#d73645", flexShrink: 0, marginTop: 1 }} />
                  <div style={{ fontSize: 12, color: "#d73645", lineHeight: 1.5 }}>{errorMsg}</div>
                </div>
              )}

              {/* Result preview */}
              {stage === "result" && draft && (
                <div style={{ marginTop: 16 }}>
                  <div style={{ fontSize: 12, color: "#6b6a63", marginBottom: 8 }}>
                    生成完成 · 共 {draft.sections.length} 个 section · 点击「一键应用」将覆盖当前编辑器内容
                  </div>

                  {draft.summary && (
                    <div
                      style={{
                        padding: 10,
                        border: "1px solid #ebe9e4",
                        borderRadius: 8,
                        background: "#fff",
                        marginBottom: 10,
                      }}
                    >
                      <div style={{ fontSize: 11, color: "#9b9a97", marginBottom: 4 }}>
                        Summary
                      </div>
                      <div style={{ fontSize: 12, color: "#37352f", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
                        {draft.summary}
                      </div>
                    </div>
                  )}

                  {draft.sections
                    .slice()
                    .sort((a, b) => a.sort_order - b.sort_order)
                    .map((sec, idx) => (
                      <div
                        key={idx}
                        style={{
                          padding: 10,
                          border: "1px solid #ebe9e4",
                          borderRadius: 8,
                          background: "#fff",
                          marginBottom: 8,
                        }}
                      >
                        <div style={{ fontSize: 11, color: "#9b9a97", marginBottom: 4 }}>
                          {sec.title || sec.section_type} · {sec.content_json.length} 条目
                        </div>
                        <div style={{ fontSize: 12, color: "#37352f", lineHeight: 1.5 }}>
                          {sec.content_json.map((item, i) => (
                            <div key={i} style={{ marginBottom: 4 }}>
                              {_summarizeItem(sec.section_type, item)}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </div>

            {/* Footer */}
            <div
              style={{
                padding: "12px 20px",
                borderTop: "1px solid #ebe9e4",
                fontSize: 11,
                color: "#9b9a97",
              }}
            >
              数据源：你的默认 Profile 档案 · 失败不会修改编辑器现有内容
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function _summarizeItem(sectionType: string, item: any): string {
  if (!item || typeof item !== "object") return String(item ?? "");
  switch (sectionType) {
    case "workExperiences":
    case "internshipExperiences":
      return `${item.company ?? ""} / ${item.position ?? ""} — ${(item.description ?? "").split("\n")[0]}`.trim();
    case "projects":
      return `${item.name ?? ""} ${item.role ? "· " + item.role : ""} — ${(item.description ?? "").split("\n")[0]}`.trim();
    case "education":
      return `${item.school ?? ""} / ${item.degree ?? ""} ${item.major ?? ""}`.trim();
    case "skills":
      return `${item.category ?? ""}: ${Array.isArray(item.items) ? item.items.join(", ") : item.items ?? ""}`;
    case "certificates":
      return `${item.name ?? ""} ${item.scoreOrLevel ? "· " + item.scoreOrLevel : ""} ${item.issuer ? "· " + item.issuer : ""}`.trim();
    case "awards":
      return `${item.awardName ?? item.name ?? ""} ${item.issuer ? "· " + item.issuer : ""} ${item.awardedAt ? "· " + item.awardedAt : ""}`.trim();
    case "personalExperiences":
      return `${item.experienceTitle ?? ""} — ${(item.description ?? "").split("\n")[0]}`.trim();
    default:
      return JSON.stringify(item).slice(0, 120);
  }
}