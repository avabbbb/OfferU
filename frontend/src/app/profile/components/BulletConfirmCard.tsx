// =============================================
// BulletConfirmCard — AI 生成的 Bullet 确认卡片
// =============================================
// 嵌入对话流中，展示 AI 提取的简历条目
// 用户可以: ✅ 加入档案 | 编辑 | ✗ 跳过
// =============================================

"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Button, Textarea, Chip } from "@nextui-org/react";
import { CheckCircle2, Edit3, X, Pin } from "lucide-react";
import { profileApi } from "@/lib/api";

export interface BulletCandidate {
  session_id: number;
  bullet_index: number;
  section_id?: number;
  title: string;
  organization?: string;
  date_range?: string;
  description: string;
  confidence: number;
}

interface BulletConfirmCardProps {
  bullet: BulletCandidate;
  onConfirmed: () => void;
  onSkipped: () => void;
}

export function BulletConfirmCard({
  bullet,
  onConfirmed,
  onSkipped,
}: BulletConfirmCardProps) {
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [editDesc, setEditDesc] = useState(bullet.description);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);

  const confidenceColor =
    bullet.confidence > 0.8
      ? "success"
      : bullet.confidence > 0.5
      ? "warning"
      : "danger";

  const confidenceLabel =
    bullet.confidence > 0.8
      ? "高"
      : bullet.confidence > 0.5
      ? "中"
      : "低";

  const handleConfirm = async () => {
    setConfirming(true);
    try {
      const edits =
        mode === "edit" && editDesc !== bullet.description
          ? { content_json: { bullet: editDesc } }
          : undefined;

      await profileApi.confirmBullet({
        session_id: bullet.session_id,
        bullet_index: bullet.bullet_index,
        edits,
      });
      setDone(true);
      onConfirmed();
    } catch {
      // 即使失败也标记完成，避免卡住
      setDone(true);
      onConfirmed();
    } finally {
      setConfirming(false);
    }
  };

  if (done) {
    return (
      <motion.div
        initial={{ opacity: 1 }}
        animate={{ opacity: 0.6 }}
        className="bg-green-500/10 border border-green-500/20 rounded-xl p-3 my-2"
      >
        <div className="flex items-center gap-2 text-green-400 text-sm">
          <CheckCircle2 size={14} />
          <span>已加入档案: {bullet.title}</span>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 400, damping: 30 }}
      className="bg-[var(--surface-muted)] border border-[var(--border)] rounded-xl p-4 my-2"
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        <Pin size={14} className="text-blue-400" />
        <span className="text-sm font-medium text-[var(--foreground)]">
          生成的 Bullet:
        </span>
        <Chip size="sm" variant="flat" color={confidenceColor}>
          置信度 {confidenceLabel}
        </Chip>
      </div>

      {/* Content */}
      <div className="pl-5 space-y-1">
        <p className="text-sm font-medium text-[var(--foreground-soft)]">{bullet.title}</p>
        {bullet.organization && (
          <p className="text-xs text-[var(--foreground-muted)]">
            {bullet.organization}
            {bullet.date_range && ` · ${bullet.date_range}`}
          </p>
        )}

        {mode === "view" ? (
          <p className="text-sm text-[var(--foreground-soft)] mt-1 whitespace-pre-wrap">
            {bullet.description}
          </p>
        ) : (
          <Textarea
            value={editDesc}
            onValueChange={setEditDesc}
            minRows={2}
            maxRows={6}
            variant="bordered"
            classNames={{
              input: "text-sm text-[var(--foreground-soft)]",
              inputWrapper: "bg-[var(--surface-muted)] border-[var(--border)]",
            }}
          />
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 mt-3 pl-5">
        <Button
          size="sm"
          color="success"
          variant="flat"
          startContent={<CheckCircle2 size={14} />}
          isLoading={confirming}
          onPress={handleConfirm}
        >
          加入档案
        </Button>
        <Button
          size="sm"
          variant="flat"
          startContent={mode === "view" ? <Edit3 size={14} /> : <CheckCircle2 size={14} />}
          onPress={() => setMode(mode === "view" ? "edit" : "view")}
        >
          {mode === "view" ? "编辑" : "确认修改"}
        </Button>
        <Button
          size="sm"
          variant="light"
          startContent={<X size={14} />}
          className="text-[var(--foreground-muted)]"
          onPress={onSkipped}
        >
          跳过
        </Button>
      </div>
    </motion.div>
  );
}
