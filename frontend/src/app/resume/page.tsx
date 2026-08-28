// =============================================
// 简历列表页 — 简历管理入口
// =============================================
// 展示用户所有简历的卡片列表
// 支持：新建简历、删除简历、进入编辑器
// Figma/Notion 风格：简洁卡片 + 渐变装饰
// =============================================

"use client";

import { useState, useEffect, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { Card, CardBody, Button, Chip, Input, Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, useDisclosure, Checkbox, Textarea } from "@nextui-org/react";
import { Plus, FileText, Trash2, Edit3, Globe, Upload, CheckCircle2 } from "lucide-react";
import {
  ResumeBrief,
  useProfile,
  useResumes,
  createResume,
  deleteResume,
  importProfileResume,
  type ResumeParseDiagnostics,
} from "@/lib/hooks";
import { resumeApi } from "@/lib/api";
import {
  getProfileBulletText,
  groupProfileCandidatesForResume,
  normalizeProfileCategoryKey,
  resolveProfileCategoryLabel,
} from "@/lib/profileSchema";

const bauhausFieldClassNames = {
  inputWrapper:
    "border border-[var(--border-strong)] bg-[var(--surface)] group-data-[focus=true]:border-[var(--foreground-muted)]",
  input: "font-medium text-[var(--foreground)] placeholder:text-[var(--foreground-muted)]",
  label: "font-semibold text-[11px] text-[var(--foreground-soft)]",
};

const bauhausModalContentClassName =
  "border border-[var(--border-strong)] bg-[var(--surface)] text-[var(--foreground)]";

function getResumeSourceLabel(resume: ResumeBrief): { text: string; color: "default" | "secondary" | "success" } {
  if (resume.source_mode === "per_job") {
    const first = resume.source_jobs?.[0];
    if (first) {
      return { text: `基于 ${first.company}-${first.title} 生成`, color: "secondary" };
    }
    const count = resume.source_job_ids?.length || 0;
    return { text: count > 0 ? `基于 ${count} 个岗位生成` : "AI 逐岗位生成", color: "secondary" };
  }

  if (resume.source_mode === "combined") {
    const count = resume.source_job_ids?.length || 0;
    return { text: count > 0 ? `综合 ${count} 个岗位生成` : "AI 综合生成", color: "success" };
  }

  if (resume.source_mode === "imported") {
    return { text: "由现有简历导入", color: "success" };
  }

  return { text: "手动创建", color: "default" };
}

interface UploadCandidateDraft {
  localId: string;
  selected: boolean;
  sectionType: string;
  categoryLabel: string;
  title: string;
  confidence: number;
  sourcePages: number[];
  sourceRef: string;
  contentJson: Record<string, any>;
}

export default function ResumesListPage() {
  const router = useRouter();
  const { data: resumes, mutate } = useResumes();
  const { data: profileData } = useProfile();
  const { isOpen, onOpen, onClose } = useDisclosure();
  const [newTitle, setNewTitle] = useState("未命名简历");
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [actionError, setActionError] = useState("");
  const [deleteTargetId, setDeleteTargetId] = useState<number | null>(null);
  const { isOpen: isDeleteOpen, onOpen: onDeleteOpen, onClose: onDeleteClose } = useDisclosure();

  // ---- 上传简历相关状态 ----
  const [uploading, setUploading] = useState(false);
  const [uploadingToDb, setUploadingToDb] = useState(false);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [uploadCandidates, setUploadCandidates] = useState<UploadCandidateDraft[]>([]);
  const [uploadTitle, setUploadTitle] = useState("上传简历");
  const [uploadDiagnostics, setUploadDiagnostics] = useState<ResumeParseDiagnostics | null>(null);

  // 错误横幅 5.5s 自动消失
  useEffect(() => {
    if (!actionError) return;
    const t = setTimeout(() => setActionError(""), 5500);
    return () => clearTimeout(t);
  }, [actionError]);

  const openResume = (resumeId: number) => {
    router.push(`/resume/${resumeId}`);
  };

  const handleResumeCardKeyDown = (event: KeyboardEvent<HTMLDivElement>, resumeId: number) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openResume(resumeId);
    }
  };

  /** 创建新简历并跳转到编辑器 */
  const handleCreate = async () => {
    try {
      setActionError("");
      setCreating(true);
      const profileName = String(profileData?.base_info_json?.name || profileData?.name || "").trim();
      const res = await createResume({
        user_name: profileName,
        title: newTitle.trim() || "未命名简历",
      });
      onClose();
      mutate();
      if (res?.id) {
        router.push(`/resume/${res.id}`);
      }
    } catch (err: any) {
      setActionError(err.message || "创建失败，请重试");
    } finally {
      setCreating(false);
    }
  };

  /** 删除简历 — 先设目标，弹确认框 */
  const handleDelete = (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteTargetId(id);
    onDeleteOpen();
  };

  /** 确认删除 */
  const confirmDelete = async () => {
    if (deleteTargetId == null) return;
    try {
      setActionError("");
      setDeletingId(deleteTargetId);
      onDeleteClose();
      await deleteResume(deleteTargetId);
      mutate();
    } catch (err: any) {
      setActionError(err.message || "删除失败，请重试");
    } finally {
      setDeletingId(null);
      setDeleteTargetId(null);
    }
  };

  /** 上传简历 — 解析 + AI 提取候选 */
  const handleUploadResume = async (file: File) => {
    if (!file) return;
    try {
      setUploading(true);
      setActionError("");
      const result = await importProfileResume(file);
      const candidates = (result.bullets || []).map((item, index) => {
        const sectionType = normalizeProfileCategoryKey(item.section_type || "custom");
        const contentJson =
          item.content_json && typeof item.content_json === "object"
            ? { ...item.content_json }
            : {};
        const previewBullet =
          String(contentJson.bullet || "").trim() ||
          getProfileBulletText({
            id: index,
            section_type: sectionType,
            title: String(item.title || ""),
            content_json: contentJson,
          } as any);
        return {
          localId: `upload-${item.session_id}-${item.index}-${index}`,
          selected: true,
          sectionType,
          categoryLabel: resolveProfileCategoryLabel(sectionType),
          title: String(item.title || resolveProfileCategoryLabel(sectionType)),
          confidence: Number(item.confidence ?? 0.7),
          sourcePages: Array.isArray(item.source_pages) ? item.source_pages : [],
          sourceRef: String(item.source_ref || ""),
          contentJson: { ...contentJson, bullet: previewBullet },
        } as UploadCandidateDraft;
      });
      setUploadCandidates(candidates);
      setUploadDiagnostics(result.parse_diagnostics || null);
      const baseName = file.name.replace(/\.(pdf|docx?)$/i, "").trim();
      setUploadTitle(baseName || "上传简历");
      setUploadModalOpen(true);
    } catch (err: any) {
      setActionError(err.message || "简历解析失败，请重试");
    } finally {
      setUploading(false);
    }
  };

  /** 确认上传 — 新建简历 + 逐条写入段落 + 跳转编辑器 */
  const confirmUploadResume = async () => {
    const selected = uploadCandidates.filter((c) => c.selected);
    if (selected.length === 0) {
      setActionError("请至少选择一条候选内容");
      return;
    }
    try {
      setUploadingToDb(true);
      setActionError("");
      const profileName = String(profileData?.base_info_json?.name || profileData?.name || "").trim();
      const newResume = await createResume({
        user_name: profileName,
        title: uploadTitle.trim() || "上传简历",
        source_mode: "imported",
      });
      const groups = groupProfileCandidatesForResume(
        selected.map((candidate, index) => ({
          id: index,
          section_type: candidate.sectionType,
          title: candidate.title,
          content_json: candidate.contentJson,
        }))
      );
      const existingSections = Array.isArray(newResume.sections) ? newResume.sections : [];
      for (let index = 0; index < groups.length; index++) {
        const group = groups[index];
        const existing = existingSections.find(
          (section: any) => section.section_type === group.sectionType
        );
        if (existing?.id) {
          await resumeApi.updateSection(newResume.id, existing.id, {
            title: group.title,
            sort_order: group.sortOrder,
            content_json: group.items,
          });
        } else {
          await resumeApi.createSection(newResume.id, {
            section_type: group.sectionType,
            title: group.title,
            sort_order: group.sortOrder,
            visible: true,
            content_json: group.items,
          });
        }
      }
      setUploadModalOpen(false);
      setUploadCandidates([]);
      setUploadDiagnostics(null);
      mutate();
      router.push(`/resume/${newResume.id}`);
    } catch (err: any) {
      setActionError(err.message || "创建简历失败，请重试");
    } finally {
      setUploadingToDb(false);
    }
  };

  const selectedUploadCount = uploadCandidates.filter((c) => c.selected).length;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 360, damping: 34, mass: 0.82 }}
      className="stage-page stage-page--resume space-y-6"
    >
      <section className="stage-hero bauhaus-panel overflow-hidden bg-[var(--surface)]">
        <div className="grid gap-6 border-b border-[var(--border)] p-6 md:p-8 xl:grid-cols-[1.05fr_0.95fr]">
          <div className="space-y-4">
            <span className="bauhaus-chip bg-[var(--surface-muted)] text-[var(--foreground)]">简历管理中心</span>
            <div>
              <p className="bauhaus-label text-[var(--foreground-soft)]">创建、管理与迭代</p>
              <h1 className="mt-2 text-3xl font-bold leading-tight md:text-5xl">材料</h1>
              <p className="mt-3 max-w-2xl text-sm font-medium leading-relaxed text-[var(--foreground-soft)] md:text-base">
                在这里集中管理所有简历版本。你可以快速新建、进入编辑器、删除旧稿，并保留不同岗位定制所需的多份副本。
              </p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3 xl:grid-cols-1">
            <div className="bauhaus-panel-sm bg-[var(--surface-muted)] p-4 text-[var(--foreground)]">
              <p className="bauhaus-label text-[var(--foreground-soft)]">简历数量</p>
              <p className="mt-2 text-3xl font-bold">{resumes?.length ?? 0}</p>
              <p className="mt-2 text-sm font-medium text-[var(--foreground-soft)]">当前已保存的简历总数。</p>
            </div>
            <div className="bauhaus-panel-sm bg-[var(--surface-muted)] p-4 text-[var(--foreground)]">
              <p className="bauhaus-label text-[var(--foreground-soft)]">档案姓名</p>
              <p className="mt-2 truncate text-2xl font-semibold">
                {String(profileData?.base_info_json?.name || profileData?.name || "未命名用户")}
              </p>
              <p className="mt-2 text-sm font-medium text-[var(--foreground-soft)]">新建简历时会默认写入这份档案姓名。</p>
            </div>
            <div className="bauhaus-panel-sm bg-[var(--surface-muted)] p-4 text-[var(--foreground)]">
              <p className="bauhaus-label text-[var(--foreground-soft)]">快捷操作</p>
              <Button
                startContent={<Plus size={16} />}
                onPress={onOpen}
                className="bauhaus-button bauhaus-button-outline mt-3 !w-full !justify-center !px-4 !py-3 !text-[11px]"
              >
                新建简历
              </Button>
              <label className="mt-2 block">
                <input
                  type="file"
                  accept=".pdf,.docx"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleUploadResume(f);
                    e.target.value = "";
                  }}
                />
                <Button
                  as="span"
                  startContent={<Upload size={16} />}
                  isLoading={uploading}
                  className="bauhaus-button bauhaus-button-outline !w-full !justify-center !px-4 !py-3 !text-[11px] cursor-pointer"
                >
                  上传简历
                </Button>
              </label>
            </div>
          </div>
        </div>
      </section>

      {actionError && (
        <div role="alert" className="bauhaus-panel-sm flex items-center justify-between bg-[var(--status-blush)] px-4 py-3 text-sm font-semibold text-[var(--primary-red)]">
          <span>{actionError}</span>
          <button onClick={() => setActionError("")} className="ml-4 font-black" aria-label="关闭错误提示">✕</button>
        </div>
      )}

      {/* 简历卡片网格 */}
      <div className="grid [grid-template-columns:repeat(1,minmax(0,1fr))] md:[grid-template-columns:repeat(3,minmax(0,1fr))] lg:[grid-template-columns:repeat(4,minmax(0,1fr))] xl:[grid-template-columns:repeat(5,minmax(0,1fr))] gap-5 items-stretch">
        <AnimatePresence>
          {(resumes || []).map((resume: ResumeBrief, i: number) => (
            <motion.div
              key={resume.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ delay: i * 0.05 }}
              className="min-w-0"
            >
<Card
                className="bauhaus-panel bauhaus-lift group h-full w-full bg-[var(--surface)]"
              >
                <CardBody className="flex h-full flex-col gap-4 p-4 md:p-5">
                  <div
                    role="button"
                    tabIndex={0}
                    aria-label={`编辑 ${resume.title || "未命名简历"}`}
                    onClick={() => openResume(resume.id)}
                    onKeyDown={(event) => handleResumeCardKeyDown(event, resume.id)}
                    className="flex min-h-0 flex-1 cursor-pointer flex-col gap-4 rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--primary-blue)]"
                  >
                    {/* 缩略图占位 —— 柔和灰底 */}
                    <div className="relative flex min-h-[150px] items-center justify-center overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface-muted)]">
                      <FileText size={36} className="relative z-10 text-[var(--foreground-faint)]" />
                    </div>

                    {/* 简历信息 */}
                    <div className="space-y-1.5">
                      <h3 className="truncate text-base font-semibold text-[var(--foreground)]">
                        {resume.title || "未命名简历"}
                      </h3>
                      <div className="flex items-center gap-2 text-xs font-medium text-[var(--foreground-muted)]">
                        <span>{resume.user_name}</span>
                        {resume.language && (
                          <span className="flex items-center gap-0.5">
                            <Globe size={10} />
                            {resume.language === "zh" ? "中文" : resume.language === "en" ? "English" : resume.language}
                          </span>
                        )}
                      </div>
                      <div>
                        <Chip
                          size="sm"
                          variant="flat"
                          color={getResumeSourceLabel(resume).color}
                          className={`border border-[var(--border)] text-[10px] bg-[var(--surface-muted)] text-[var(--foreground-soft)]`}
                        >
                          {getResumeSourceLabel(resume).text}
                        </Chip>
                      </div>
                      <p className="text-xs font-medium text-[var(--foreground-muted)]">
                        更新于 {new Date(resume.updated_at).toLocaleDateString("zh-CN")}
                      </p>
                    </div>
                  </div>

                  {/* 操作按钮 */}
                  <div className="mt-auto flex gap-2 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100">
                    <Button
                      size="sm"
                      startContent={<Edit3 size={12} />}
                      className="bauhaus-button bauhaus-button-outline !flex-1 !px-4 !py-3 !text-[11px]"
                      onPress={() => openResume(resume.id)}
                    >
                      编辑
                    </Button>
                    <Button
                      size="sm"
                      isIconOnly
                      aria-label="删除简历"
                      className="bauhaus-button bauhaus-button-red !px-0 !py-0 !text-[11px]"
                      isLoading={deletingId === resume.id}
                      onClick={(e) => handleDelete(resume.id, e)}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </CardBody>
              </Card>
            </motion.div>
          ))}
        </AnimatePresence>

        {/* 空状态 */}
        {resumes && resumes.length === 0 && (
          <motion.section
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="bauhaus-panel col-span-full overflow-hidden bg-[var(--surface)]"
          >
            <div className="grid gap-6 p-8 md:grid-cols-[1.05fr_0.95fr] md:p-10">
              <div className="space-y-3">
              <span className="bauhaus-chip bg-[var(--surface-muted)] text-[var(--foreground)]">暂无简历草稿</span>
              <h2 className="text-3xl font-bold md:text-5xl">
                从第一份
                <br />
                简历开始
              </h2>
                <p className="max-w-xl text-sm font-medium leading-relaxed text-[var(--foreground-soft)] md:text-base">
                  还没有简历。点击上方「新建简历」开始第一份版本，然后再按岗位逐步复制和打磨。
                </p>
              </div>
              <div className="bauhaus-panel-sm flex min-h-[220px] items-center justify-center bg-[var(--surface-muted)] p-6 text-[var(--foreground)]">
                <div className="text-center">
                  <FileText size={54} className="mx-auto" aria-hidden="true" />
                  <p className="mt-4 text-lg font-semibold">随时创建新版本</p>
                </div>
              </div>
            </div>
          </motion.section>
        )}
      </div>

      {/* 新建简历弹窗 */}
      <Modal isOpen={isOpen} onClose={onClose} placement="center">
        <ModalContent className={bauhausModalContentClassName}>
          <ModalHeader className="border-b border-[var(--border)] px-6 py-5 text-xl font-semibold">
            新建简历
          </ModalHeader>
          <ModalBody className="space-y-3 px-6 py-6">
            <Input
              label="简历命名"
              variant="bordered"
              value={newTitle}
              onValueChange={setNewTitle}
              autoFocus
              placeholder="如：前端工程师-中文版"
              classNames={bauhausFieldClassNames}
            />
          </ModalBody>
          <ModalFooter className="border-t border-[var(--border)] px-6 py-5">
            <Button
              variant="light"
              className="bauhaus-button bauhaus-button-outline !px-4 !py-3 !text-[11px]"
              onPress={onClose}
            >
              取消
            </Button>
            <Button
              isLoading={creating}
              onPress={handleCreate}
              className="bauhaus-button bauhaus-button-red !px-4 !py-3 !text-[11px]"
            >
              创建并编辑
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* 删除确认弹窗 */}
      <Modal isOpen={isDeleteOpen} onClose={onDeleteClose} placement="center">
        <ModalContent className={bauhausModalContentClassName}>
          <ModalHeader className="border-b border-[var(--border)] bg-[var(--status-blush)] px-6 py-5 text-xl font-semibold text-[var(--primary-red)]">
            确认删除
          </ModalHeader>
          <ModalBody className="px-6 py-6">
            <p className="text-base font-medium text-[var(--foreground-soft)]">确定要删除这份简历吗？此操作不可撤销。</p>
          </ModalBody>
          <ModalFooter className="border-t border-[var(--border)] px-6 py-5">
            <Button
              variant="light"
              className="bauhaus-button bauhaus-button-outline !px-4 !py-3 !text-[11px]"
              onPress={onDeleteClose}
            >
              取消
            </Button>
            <Button
              isLoading={deletingId === deleteTargetId}
              onPress={confirmDelete}
              className="bauhaus-button bauhaus-button-red !px-4 !py-3 !text-[11px]"
            >
              确认删除
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* 上传简历审核弹窗 */}
      <Modal isOpen={uploadModalOpen} onClose={() => setUploadModalOpen(false)} size="3xl" scrollBehavior="inside">
        <ModalContent className={bauhausModalContentClassName}>
          <ModalHeader className="border-b border-[var(--border)] bg-[var(--status-sage)] px-6 py-5 text-xl font-semibold text-[var(--foreground)]">
            上传简历 — AI 解析审核
          </ModalHeader>
          <ModalBody className="space-y-4 px-6 py-6">
            <Input
              label="简历标题"
              variant="bordered"
              value={uploadTitle}
              onValueChange={setUploadTitle}
              placeholder="如：前端工程师-中文版"
              classNames={bauhausFieldClassNames}
            />
            {uploadDiagnostics && (
              <div className="bauhaus-panel-sm bg-[var(--surface-muted)] px-4 py-3 text-xs text-[var(--foreground-soft)]">
                {uploadDiagnostics.parser === "python-docx"
                  ? "已解析 Word 文档"
                  : `已解析 ${uploadDiagnostics.page_count} 页`}
                {uploadDiagnostics.parser === "python-docx"
                  ? ""
                  : uploadDiagnostics.used_ocr
                    ? " · 扫描页已使用 OCR"
                    : " · 原生文本层"}
                {` · 质量 ${Math.round(uploadDiagnostics.average_quality * 100)}%`}
                {uploadDiagnostics.parser !== "python-docx"
                  && uploadDiagnostics.low_quality_pages.length > 0 && (
                  <p className="mt-1 font-semibold text-[var(--primary-yellow)]">
                    第 {uploadDiagnostics.low_quality_pages.join("、")} 页识别质量偏低，请结合页码来源重点核对。
                  </p>
                  )}
                {uploadDiagnostics.parser !== "python-docx"
                  && uploadDiagnostics.ocr
                  && !uploadDiagnostics.ocr.configured && (
                  <p className="mt-1 font-semibold text-[var(--primary-yellow)]">
                    当前未配置完整的 {uploadDiagnostics.ocr.language} OCR 训练数据；纯扫描 PDF 可能无法识别。
                  </p>
                  )}
              </div>
            )}

            {uploadCandidates.length === 0 ? (
              <div className="bauhaus-panel-sm bg-[var(--surface)] px-4 py-3 text-sm font-medium text-[var(--foreground-soft)]">
                暂无候选段落。
              </div>
            ) : (
              uploadCandidates.map((candidate) => (
                <div
                  key={candidate.localId}
                  className={`bauhaus-panel-sm space-y-3 p-4 bg-[var(--surface-muted)]`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <Checkbox
                      isSelected={candidate.selected}
                      onValueChange={(next) => {
                        setUploadCandidates((prev) =>
                          prev.map((c) => c.localId === candidate.localId ? { ...c, selected: next } : c)
                        );
                      }}
                    >
                      导入此段
                    </Checkbox>
                    <span
                      className={`inline-block border border-[var(--border)] px-2 py-0.5 text-[10px] font-semibold bg-[var(--surface)] text-[var(--foreground-soft)]`}
                    >
                      置信度 {Math.round(candidate.confidence * 100)}%
                    </span>
                    {candidate.sourcePages.length > 0 && (
                      <span className="text-[10px] font-semibold text-[var(--foreground-soft)]">
                        来源：第 {candidate.sourcePages.join("、")} 页
                      </span>
                    )}
                    {uploadDiagnostics?.parser !== "python-docx"
                      && candidate.sourcePages.length === 0 && (
                      <span className="text-[10px] font-semibold text-[var(--primary-yellow)]">
                        {candidate.sourceRef || "未精确定位原文页码"}
                      </span>
                      )}
                  </div>

                  {candidate.confidence < 0.65 && (
                    <div className="text-[11px] font-semibold text-[var(--primary-yellow)]">
                      该候选条目置信度偏低，建议核对后再导入。
                    </div>
                  )}

                  <div className="grid grid-cols-1 gap-2 md:grid-cols-[160px_1fr]">
                    <span className="inline-block border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-1.5 text-[11px] font-semibold text-[var(--foreground-soft)]">
                      {candidate.categoryLabel}
                    </span>
                    <Input
                      size="sm"
                      variant="bordered"
                      value={candidate.title}
                      onValueChange={(next) => {
                        setUploadCandidates((prev) =>
                          prev.map((c) => c.localId === candidate.localId ? { ...c, title: next } : c)
                        );
                      }}
                      classNames={bauhausFieldClassNames}
                    />
                  </div>

                  <Textarea
                    size="sm"
                    variant="bordered"
                    minRows={2}
                    value={String(candidate.contentJson?.bullet || "")}
                    onValueChange={(next) => {
                      setUploadCandidates((prev) =>
                        prev.map((c) =>
                          c.localId === candidate.localId
                            ? { ...c, contentJson: { ...(c.contentJson || {}), bullet: next } }
                            : c
                        )
                      );
                    }}
                    classNames={bauhausFieldClassNames}
                  />
                </div>
              ))
            )}
          </ModalBody>
          <ModalFooter className="border-t border-[var(--border)] px-6 py-5">
            <Button
              variant="light"
              className="bauhaus-button bauhaus-button-outline !px-4 !py-3 !text-[11px]"
              onPress={() => setUploadModalOpen(false)}
            >
              取消
            </Button>
            <Button
              startContent={<CheckCircle2 size={14} />}
              isLoading={uploadingToDb}
              isDisabled={selectedUploadCount === 0}
              onPress={() => void confirmUploadResume()}
              className="bauhaus-button bauhaus-button-blue !px-4 !py-3 !text-[11px]"
            >
              创建简历（{selectedUploadCount} 段）
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </motion.div>
  );
}
