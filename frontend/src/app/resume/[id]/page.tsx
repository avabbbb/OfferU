// =============================================
// 简历编辑器页（M3 骨架版，基于 Puck）
// =============================================
// 路由：/resume/[id]
// 数据流：
//   useResume(id) → migrateResumeToPuck → initialData
//   Puck onPublish → unMigratePuckToResume → updateResume(id, payload) → SWR mutate
// 保留功能（M3.6 待补）：
//   AI 优化 / Undo-Redo 按钮控件 / 模板切换
// 说明：
//   · 头像：顶部「上传头像」按钮 → uploadResumePhoto → 写入 Puck Header photoUrl
//     通过 setPuckData + 版本 key 强制 Puck 同步外部更新
//   · Undo/Redo：Puck 0.22 已内置 undo/redo history（ctrl+z / ctrl+shift+z）
//     不再外部 useHistory；后续如需按钮 UI，用 usePuck history dispatch
// 参见 docs/RESUME_PUCK_MIGRATION_PLAN.md
// =============================================

"use client";

import "@puckeditor/core/puck.css";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { Puck, type Data } from "@puckeditor/core";
import { motion } from "framer-motion";
import { ArrowLeft, FileDown, Loader2, ImagePlus, Wand2, Sparkles } from "lucide-react";
import {
  useResume,
  updateResume,
  uploadResumePhoto,
  type ResumeDetail,
  type AiSuggestion,
  type DraftResult,
} from "@/lib/hooks";
import { resumeApi } from "@/lib/api";
import {
  migrateResumeToPuck,
  unMigratePuckToResume,
  draftToPuckContent,
  type PuckResumeData,
} from "@/lib/puckMigration";
import { puckConfig } from "../components/puckComponents";
import AiOptimizeDrawer from "../components/AiOptimizeDrawer";
import AiGenerateDrawer from "../components/AiGenerateDrawer";
import StyleToolbarAria, {
  DEFAULT_STYLE_CONFIG,
  styleConfigToCSSVars,
  type StyleConfig,
} from "../components/StyleToolbar";
import ThemePickerAria from "../components/ThemePickerAria";

export default function ResumeEditorPage() {
  const params = useParams();
  const router = useRouter();
  const resumeId = Number(params?.id);

  const { data: resume, error, isLoading } = useResume(
    Number.isFinite(resumeId) ? resumeId : null
  );

  // 本地 Puck 数据：从后端迁移而来，用作 Puck 编辑器 initialData。
  // 只在加载完成时初始化一次，避免编辑过程中被覆盖。
  const [puckData, setPuckData] = useState<PuckResumeData | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [styleConfig, setStyleConfig] = useState<StyleConfig>({ ...DEFAULT_STYLE_CONFIG });
  const [puckVersion, setPuckVersion] = useState(0);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [aiDrawerOpen, setAiDrawerOpen] = useState(false);
  const [aiGenerateOpen, setAiGenerateOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!resume) {
      setPuckData(null);
      return;
    }
    setPuckData(migrateResumeToPuck(resume));
    const incoming =
      (resume.style_config as StyleConfig | undefined) ?? {};
    setStyleConfig({ ...DEFAULT_STYLE_CONFIG, ...incoming });
    setDirty(false);
    setSaveError(null);
  }, [resume]);

  const handleUploadPhoto = useCallback(async () => {
    if (!resume || !puckData) return;
    fileInputRef.current?.click();
  }, [resume, puckData]);

  // M5a 写回：suggestion.original 是自由文本，按"包含原文片段"找到第一个
  // ExperienceEntry / ProjectItem / EducationItem / AwardItem / CertificateItem，
  // 将其 description 字段中 original 位置替换为 suggested。
  // 找不到一段就只更新第一个 ExperienceEntry/ProjectItem 的 description（追加 suggested）。
  const applyBulletRewrite = useCallback(
    (suggestion: AiSuggestion) => {
      if (!puckData) return;
      const orig = String(suggestion.original ?? "").trim();
      const sugg = String(suggestion.suggested ?? "").trim();
      if (!orig || !sugg) return;
      const targetTypes = new Set([
        "ExperienceEntry",
        "ProjectItem",
        "EducationItem",
        "AwardItem",
        "CertificateItem",
      ]);
      let hitIndex = -1;
      let nextDesc = "";
      for (let i = 0; i < puckData.content.length; i++) {
        const u = puckData.content[i];
        if (!targetTypes.has(u.type)) continue;
        const cur = String((u.props as any).description ?? "").trim();
        if (!cur) continue;
        if (cur === orig || cur.includes(orig) || orig.includes(cur)) {
          hitIndex = i;
          nextDesc = cur === orig ? sugg : cur.replace(orig, sugg);
          if (nextDesc === cur) nextDesc = sugg;
          break;
        }
      }
      if (hitIndex === -1) {
        // fallback：找第一个含 description 字段的 ExperienceEntry/ProjectItem，整段覆盖
        for (let i = 0; i < puckData.content.length; i++) {
          const u = puckData.content[i];
          if (u.type === "ExperienceEntry" || u.type === "ProjectItem") {
            hitIndex = i;
            nextDesc = sugg;
            break;
          }
        }
      }
      if (hitIndex === -1) return;
      const next: PuckResumeData = {
        ...puckData,
        content: puckData.content.map((u, i) =>
          i === hitIndex
            ? { ...u, props: { ...u.props, description: nextDesc } }
            : u
        ),
      };
      setPuckData(next);
      setPuckVersion((v) => v + 1);
      setDirty(true);
    },
    [puckData]
  );

  // M6 一键应用：把 AI 生成初稿转成 Puck content（保留当前 Header 联系方式）
  const applyDraft = useCallback(
    (draft: DraftResult) => {
      const headerUnit = puckData?.content?.find((u) => u.type === "Header");
      const next = draftToPuckContent(
        draft,
        headerUnit ? { ...headerUnit } : undefined
      );
      setPuckData(next);
      setPuckVersion((v) => v + 1);
      setDirty(true);
      setAiGenerateOpen(false);
    },
    [puckData]
  );

  const onPhotoFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file || !puckData) return;
      setUploadingPhoto(true);
      try {
        const result = await uploadResumePhoto(resumeId, file);
        const fullUrl =
          (result?.photo_url as string | undefined)?.startsWith("http")
            ? result.photo_url
            : `${window.location.protocol}//${window.location.hostname}:8765${result?.photo_url ?? ""}`;
        const next: PuckResumeData = {
          ...puckData,
          content: puckData.content.map((unit) =>
            unit.type === "Header"
              ? {
                  ...unit,
                  props: { ...unit.props, photoUrl: fullUrl },
                }
              : unit
          ),
        };
        setPuckData(next);
        setPuckVersion((v) => v + 1);
        setDirty(true);
      } catch (err: any) {
        setSaveError(err?.message || "头像上传失败");
      } finally {
        setUploadingPhoto(false);
      }
    },
    [puckData, resumeId]
  );

  const handlePublish = useCallback(
    async (data: Data) => {
      if (!resume) return;
      setSaving(true);
      setSaveError(null);
      try {
        const payload = unMigratePuckToResume(data as PuckResumeData, resume);
        await updateResume(resumeId, { ...payload, style_config: styleConfig });
        setDirty(false);
        setLastSavedAt(Date.now());
      } catch (e: any) {
        setSaveError(e?.message || "保存失败");
      } finally {
        setSaving(false);
      }
    },
    [resume, resumeId, styleConfig]
  );

  const handleStyleChange = useCallback(
    (next: StyleConfig) => {
      setStyleConfig(next);
      setDirty(true);
    },
    []
  );

  const handlePuckChange = useCallback((data: Data) => {
    setPuckData(data as PuckResumeData);
    setDirty(true);
  }, []);

  const handleExportPdf = useCallback(async () => {
    if (!resume || !puckData) return;
    setExporting(true);
    try {
      if (dirty) {
        setSaving(true);
        const payload = unMigratePuckToResume(puckData, resume);
        await updateResume(resumeId, { ...payload, style_config: styleConfig });
        setDirty(false);
        setLastSavedAt(Date.now());
      }
      const res = await resumeApi.exportPdf(resumeId);
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(error.detail || `导出失败 (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${resume.title || "resume"}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setSaveError(e?.message || "导出失败");
    } finally {
      setSaving(false);
      setExporting(false);
    }
  }, [dirty, puckData, resume, resumeId, styleConfig]);

  const pageTitle = useMemo(
    () => resume?.title || "未命名简历",
    [resume?.title]
  );

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        fontFamily: "Inter, system-ui, sans-serif",
        background: "#fbfaf8",
      }}
    >
      <header
        style={{
          padding: "8px 16px",
          borderBottom: "1px solid rgba(55,53,47,0.08)",
          background: "#ffffff",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button
            onClick={() => router.push("/resume")}
            style={{
              width: 32,
              height: 32,
              border: "none",
              background: "transparent",
              borderRadius: 6,
              cursor: "pointer",
              color: "#37352f",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            aria-label="返回简历列表"
            title="返回"
          >
            <ArrowLeft size={18} />
          </button>
          <span
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "#37352f",
              maxWidth: 320,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {pageTitle}
          </span>
          {dirty && (
            <span style={{ fontSize: 11, color: "#b3541a" }}>未保存</span>
          )}
          {!dirty && lastSavedAt && (
            <span style={{ fontSize: 11, color: "#9b9a97" }}>已保存</span>
          )}
          {saveError && (
            <span style={{ fontSize: 11, color: "#d33" }}>
              {saveError}
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            onClick={() => setAiDrawerOpen(true)}
            disabled={!resume}
            style={btnGhost(false)}
            title="AI 优化（对标 JD）"
          >
            <Wand2 size={14} />
            <span style={{ marginLeft: 4 }}>AI 优化</span>
          </button>
          <button
            onClick={() => setAiGenerateOpen(true)}
            disabled={!resume}
            style={btnGhost(false)}
            title="AI 生成初稿（按 JD 全量生成）"
          >
            <Sparkles size={14} />
            <span style={{ marginLeft: 4 }}>AI 生成初稿</span>
          </button>
          <button
            onClick={handleUploadPhoto}
            disabled={uploadingPhoto || !resume}
            style={btnGhost(uploadingPhoto)}
            title="上传头像到 Header 区块"
          >
            {uploadingPhoto ? (
              <Loader2 size={14} className="spin" />
            ) : (
              <ImagePlus size={14} />
            )}
            <span style={{ marginLeft: 4 }}>上传头像</span>
          </button>
          <button
            onClick={handleExportPdf}
            disabled={exporting || !resume}
            style={btnGhost(exporting)}
          >
            {exporting ? <Loader2 size={14} className="spin" /> : <FileDown size={14} />}
            <span style={{ marginLeft: 4 }}>导出 PDF</span>
          </button>
        </div>
      </header>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={onPhotoFileChange}
      />

      <main style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {isLoading && (
          <div style={centerOverlay}>
            <Loader2 size={28} className="spin" style={{ color: "#37352f" }} />
            <div style={{ marginTop: 12, color: "#9b9a97", fontSize: 13 }}>
              加载简历中…
            </div>
          </div>
        )}
        {error && !isLoading && (
          <div style={centerOverlay}>
            <div style={{ color: "#d33", fontSize: 14, marginBottom: 8 }}>
              加载失败：{String(error.message || error)}
            </div>
            <button
              onClick={() => router.push("/resume")}
              style={btnGhost(false)}
            >
              返回列表
            </button>
          </div>
        )}
        {!isLoading && !error && !resume && (
          <div style={centerOverlay}>
            <div style={{ color: "#9b9a97", fontSize: 13 }}>未找到简历。</div>
          </div>
        )}
        {!isLoading && !error && puckData && (
          <div
            style={{
              height: "100%",
              display: "flex",
              flexDirection: "column",
              ...styleConfigToCSSVars(styleConfig),
            }}
          >
            <div style={{ flex: 1, minHeight: 0 }}>
              <Puck
                key={puckVersion}
                config={puckConfig}
                data={puckData}
                onChange={handlePuckChange}
                onPublish={handlePublish}
                headerTitle={pageTitle}
              />
            </div>
          </div>
        )}
      </main>

      <StyleToolbarAria config={styleConfig} onChange={handleStyleChange} />
      <ThemePickerAria config={styleConfig} onChange={handleStyleChange} />

      <motion.span
        aria-hidden
        initial={false}
        animate={{ opacity: saving ? 1 : 0 }}
        style={{
          position: "fixed",
          bottom: 16,
          right: 16,
          background: "#2b2a28",
          color: "#fff",
          fontSize: 12,
          padding: "6px 12px",
          borderRadius: 6,
          pointerEvents: "none",
        }}
      >
        {saving ? "保存中…" : lastSavedAt ? "已保存" : ""}
      </motion.span>

      <AiOptimizeDrawer
        open={aiDrawerOpen}
        onClose={() => setAiDrawerOpen(false)}
        resumeId={resumeId}
        puckData={puckData}
        onApplyBulletRewrite={applyBulletRewrite}
      />
      <AiGenerateDrawer
        resumeId={resumeId}
        open={aiGenerateOpen}
        onClose={() => setAiGenerateOpen(false)}
        onApply={applyDraft}
      />
    </div>
  );
}

const centerOverlay: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  background: "#fbfaf8",
  zIndex: 10,
};

function btnGhost(disabled: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    padding: "6px 12px",
    fontSize: 13,
    fontWeight: 500,
    color: disabled ? "#9b9a97" : "#37352f",
    background: "transparent",
    border: "1px solid rgba(55,53,47,0.12)",
    borderRadius: 6,
    cursor: disabled ? "not-allowed" : "pointer",
    transition: "background 0.12s",
  };
}
