// =============================================
// 批次分组折叠 — 未筛选 Tab 内按 batch 分组
// =============================================
// 每个 Batch: 可折叠头部 + 内部卡片网格
// 头部: 来源 + 关键词 + 岗位数 + 一键操作
// 空 batch 自动隐藏
// =============================================

"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Button, Chip } from "@nextui-org/react";
import {
  ChevronDown,
  ChevronRight,
  Star,
  EyeOff,
  Undo2,
  Clock,
} from "lucide-react";
import { JobCard } from "@/components/jobs/JobCard";
import type { Job, BatchSummary, Pool } from "@/lib/hooks";

const cardContainer = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.04 } },
};

const cardItem = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 400, damping: 30 } },
};

interface BatchGroupProps {
  batch: BatchSummary | null;
  jobs: Job[];
  batchMode: boolean;
  selectedIds: Set<number>;
  onToggleJob: (id: number) => void;
  onTriage: (jobId: number, status: string, poolId?: number | null) => void;
  onBatchTriage: (jobIds: number[], status: string, poolId?: number | null) => void;
  pools: Pool[];
  triageStatus: string;
}

export function BatchGroup({
  batch,
  jobs,
  batchMode,
  selectedIds,
  onToggleJob,
  onTriage,
  onBatchTriage,
  pools,
  triageStatus,
}: BatchGroupProps) {
  const [expanded, setExpanded] = useState(true);

  if (jobs.length === 0) return null;

  const batchJobIds = jobs.map((j) => j.id);
  const dateStr = batch?.latest_created_at
    ? new Date(batch.latest_created_at).toLocaleDateString("zh-CN", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

  return (
    <div className="rounded-xl border border-black/10 overflow-hidden bg-black/[0.02]">
      {/* ── 批次头部 ── */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-black/5 transition-colors text-left"
      >
        {expanded ? (
          <ChevronDown size={16} className="text-black/40 shrink-0" />
        ) : (
          <ChevronRight size={16} className="text-black/40 shrink-0" />
        )}

        {batch ? (
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <Chip size="sm" variant="flat" color="primary">
              {batch.source}
            </Chip>
            {batch.keywords?.length > 0 && (
              <span className="text-sm text-black/70 truncate">
                {batch.keywords.join("、")}
              </span>
            )}
            {batch.location && (
              <span className="text-xs text-black/40">· {batch.location}</span>
            )}
          </div>
        ) : (
          <span className="text-sm text-black/50 flex-1">无批次</span>
        )}

        <div className="flex items-center gap-2 shrink-0">
          {dateStr && (
            <span className="flex items-center gap-1 text-xs text-black/30">
              <Clock size={12} />
              {dateStr}
            </span>
          )}
          <Chip size="sm" variant="flat" className="bg-black/5 text-black/50">
            {jobs.length} 个岗位
          </Chip>
        </div>
      </button>

      {/* ── 批次一键操作栏 ── */}
      {expanded && (
        <div className="flex items-center gap-2 px-4 py-2 border-t border-black/5 bg-black/[0.02]">
          {triageStatus === "inbox" && (
            <>
              <Button
                size="sm"
                variant="flat"
                color="primary"
                startContent={<Star size={12} />}
                onPress={() => onBatchTriage(batchJobIds, "picked")}
              >
                全部筛入
              </Button>
              <Button
                size="sm"
                variant="flat"
                color="warning"
                startContent={<EyeOff size={12} />}
                onPress={() => onBatchTriage(batchJobIds, "ignored")}
              >
                全部忽略
              </Button>
            </>
          )}
          {triageStatus === "picked" && (
            <Button
              size="sm"
              variant="flat"
              startContent={<Undo2 size={12} />}
              onPress={() => onBatchTriage(batchJobIds, "inbox")}
            >
              全部退回
            </Button>
          )}
          {triageStatus === "ignored" && (
            <Button
              size="sm"
              variant="flat"
              startContent={<Undo2 size={12} />}
              onPress={() => onBatchTriage(batchJobIds, "inbox")}
            >
              全部恢复
            </Button>
          )}
        </div>
      )}

      {/* ── 卡片网格 ── */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: "spring", stiffness: 320, damping: 34 }}
            className="overflow-hidden"
          >
            <motion.div
              variants={cardContainer}
              initial="hidden"
              animate="show"
              className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 p-4"
            >
              {jobs.map((job) => (
                <motion.div
                  key={job.id}
                  variants={cardItem}
                  whileHover={{ y: -4, transition: { type: "spring", stiffness: 400, damping: 28 } }}
                  className="h-full"
                >
                  <JobCard
                    job={job}
                    showCheckbox={batchMode}
                    selected={selectedIds.has(job.id)}
                    onToggle={(id) => onToggleJob(id)}
                  />
                </motion.div>
              ))}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
