// =============================================
// 批量 AI 简历定制弹窗 — OfferU 核心差异化功能
// =============================================
// 流程：选择基底简历 → 确认 → 逐个优化 → 展示结果
// 每个 JD 独立克隆一份简历，AI 针对性优化
// =============================================

"use client";

import { useRef, useState } from "react";
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Select,
  SelectItem,
  Progress,
  Chip,
  Card,
  CardBody,
  Switch,
} from "@nextui-org/react";
import { FileText, Sparkles, CheckCircle2, XCircle, AlertTriangle, ExternalLink } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  useResumes,
  batchOptimizeResume,
  type Job,
  type BatchOptimizeEntry,
} from "@/lib/hooks";
import { safeClientErrorMessage } from "@/lib/safe-error";

interface BatchOptimizeModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedJobs: Job[];
}

type Phase = "select" | "running" | "done";

export function BatchOptimizeModal({
  isOpen,
  onClose,
  selectedJobs,
}: BatchOptimizeModalProps) {
  const router = useRouter();
  const { data: resumes } = useResumes();
  const [selectedResumeId, setSelectedResumeId] = useState<number | null>(null);
  const [autoApply, setAutoApply] = useState(false);
  const [phase, setPhase] = useState<Phase>("select");
  const [results, setResults] = useState<BatchOptimizeEntry[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // 关闭弹窗时中止进行中的 SSE 流，避免卸载后 setState 与连接泄漏
  const abortRef = useRef<AbortController | null>(null);

  const resumeList = Array.isArray(resumes) ? resumes : [];

  const handleStart = async () => {
    if (!selectedResumeId || selectedJobs.length === 0) return;

    setPhase("running");
    setError(null);
    setResults([]);
    setCurrentIndex(0);
    abortRef.current = new AbortController();

    try {
      await batchOptimizeResume(
        selectedResumeId,
        selectedJobs.map((j) => j.id),
        autoApply,
        // SSE onProgress 回调 — 每完成一个岗位即时更新
        (entry) => {
          setResults((prev) => [...prev, entry]);
          setCurrentIndex(entry.index + 1);
        },
        abortRef.current.signal
      );
      setPhase("done");
    } catch (e: unknown) {
      if (e instanceof Error && e.name === "AbortError") {
        // 用户主动关闭弹窗，不算失败
        return;
      }
      setError(safeClientErrorMessage(e, "批量优化失败，请稍后重试。"));
      setPhase("done");
    }
  };

  const handleClose = () => {
    abortRef.current?.abort();
    setPhase("select");
    setResults([]);
    setError(null);
    setSelectedResumeId(null);
    onClose();
  };

  const successCount = results.filter((r) => r.status === "success").length;
  const failCount = results.filter((r) => r.status === "failed").length;

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      size="2xl"
      scrollBehavior="inside"
      classNames={{
        base: "bg-zinc-900 border border-white/10",
        header: "border-b border-white/10",
        footer: "border-t border-white/10",
      }}
    >
      <ModalContent>
        <ModalHeader className="flex items-center gap-2">
          <Sparkles size={20} className="text-blue-400" />
          <span>批量 AI 简历定制</span>
          <Chip size="sm" variant="flat" color="primary">
            {selectedJobs.length} 个岗位
          </Chip>
        </ModalHeader>

        <ModalBody className="py-6">
          {/* ── 阶段 1: 选择简历 ── */}
          {phase === "select" && (
            <div className="space-y-5">
              <p className="text-sm text-white/60">
                选择一份基底简历，AI 将为每个岗位 JD 分别克隆并针对性优化，
                生成 {selectedJobs.length} 份定制简历。
              </p>

              {/* 简历选择 */}
              <Select
                label="选择基底简历"
                placeholder="请选择一份简历作为基底"
                selectedKeys={selectedResumeId ? [String(selectedResumeId)] : []}
                onSelectionChange={(keys) => {
                  const val = Array.from(keys)[0] as string;
                  setSelectedResumeId(val ? Number(val) : null);
                }}
                classNames={{
                  trigger: "bg-white/5 border border-white/10",
                }}
              >
                {resumeList.map((r: any) => (
                  <SelectItem key={String(r.id)} textValue={r.title || r.user_name}>
                    <div className="flex items-center gap-2">
                      <FileText size={14} />
                      <span>{r.title || r.user_name}</span>
                      {r.is_primary && (
                        <Chip size="sm" variant="flat" color="success">主简历</Chip>
                      )}
                    </div>
                  </SelectItem>
                ))}
              </Select>

              {/* 自动应用开关 */}
              <div className="flex items-center justify-between p-3 rounded-lg bg-white/5 border border-white/10">
                <div>
                  <p className="text-sm font-medium">自动应用 AI 建议</p>
                  <p className="text-xs text-white/40 mt-0.5">
                    开启后 AI 改写建议将直接写入克隆简历，关闭则仅生成建议
                  </p>
                </div>
                <Switch
                  isSelected={autoApply}
                  onValueChange={setAutoApply}
                  size="sm"
                  color="primary"
                />
              </div>

              {/* 已选岗位预览 */}
              <div className="space-y-2">
                <p className="text-xs text-white/40 font-medium">已选岗位</p>
                <div className="max-h-[200px] overflow-y-auto space-y-1.5 pr-1">
                  {selectedJobs.map((job) => (
                    <div
                      key={job.id}
                      className="flex items-center justify-between p-2 rounded bg-white/5 text-sm"
                    >
                      <span className="truncate flex-1">{job.title}</span>
                      <span className="text-white/40 text-xs ml-2 shrink-0">{job.company}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ── 阶段 2: 运行中（实时显示进度） ── */}
          {phase === "running" && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <Sparkles size={20} className="text-blue-400 animate-pulse" />
                <div className="flex-1">
                  <p className="text-sm font-medium">
                    正在处理第 {currentIndex + 1} / {selectedJobs.length} 个岗位...
                  </p>
                  <Progress
                    value={(currentIndex / selectedJobs.length) * 100}
                    color="primary"
                    size="sm"
                    className="mt-1"
                  />
                </div>
              </div>

              {/* 已完成的结果实时显示 */}
              {results.length > 0 && (
                <div className="space-y-2 max-h-[250px] overflow-y-auto pr-1">
                  {results.map((entry) => (
                    <div
                      key={entry.job_id}
                      className={`flex items-center gap-2 p-2 rounded text-sm ${
                        entry.status === "success"
                          ? "bg-green-500/10"
                          : entry.status === "failed"
                          ? "bg-red-500/10"
                          : "bg-yellow-500/10"
                      }`}
                    >
                      {entry.status === "success" ? (
                        <CheckCircle2 size={14} className="text-green-400 shrink-0" />
                      ) : entry.status === "failed" ? (
                        <XCircle size={14} className="text-red-400 shrink-0" />
                      ) : (
                        <AlertTriangle size={14} className="text-yellow-400 shrink-0" />
                      )}
                      <span className="truncate flex-1">
                        {entry.company} · {entry.job_title}
                      </span>
                      {entry.ats_score != null && (
                        <Chip size="sm" variant="flat" color="success">{entry.ats_score}分</Chip>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── 阶段 3: 完成 ── */}
          {phase === "done" && (
            <div className="space-y-4">
              {error && (
                <Card className="bg-red-500/10 border border-red-500/30">
                  <CardBody className="p-3 flex items-center gap-2 text-red-400 text-sm">
                    <XCircle size={16} />
                    <span>{error}</span>
                  </CardBody>
                </Card>
              )}

              {results.length > 0 && (
                <>
                  {/* 统计摘要 */}
                  <div className="flex items-center gap-3 text-sm">
                    <Chip color="success" variant="flat" size="sm">
                      成功 {successCount}
                    </Chip>
                    {failCount > 0 && (
                      <Chip color="danger" variant="flat" size="sm">
                        失败 {failCount}
                      </Chip>
                    )}
                    <span className="text-white/40">
                      共 {results.length} 个岗位
                    </span>
                  </div>

                  {/* ATS 评分对比条形图 */}
                  {results.some((r) => r.ats_score != null) && (
                    <div className="space-y-2 p-3 rounded-lg bg-white/5 border border-white/10">
                      <p className="text-xs text-white/50 font-medium">ATS 评分对比</p>
                      {results
                        .filter((r) => r.status === "success" && r.ats_score != null)
                        .sort((a, b) => (b.ats_score ?? 0) - (a.ats_score ?? 0))
                        .map((entry) => (
                          <div key={entry.job_id} className="flex items-center gap-2">
                            <span className="text-xs text-white/60 w-28 shrink-0 truncate">
                              {entry.company}
                            </span>
                            <div className="flex-1 h-4 bg-white/5 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all ${
                                  (entry.ats_score ?? 0) >= 80
                                    ? "bg-green-500"
                                    : (entry.ats_score ?? 0) >= 60
                                    ? "bg-blue-500"
                                    : "bg-amber-500"
                                }`}
                                style={{ width: `${Math.min(entry.ats_score ?? 0, 100)}%` }}
                              />
                            </div>
                            <span className="text-xs font-mono text-white/70 w-8 text-right">
                              {entry.ats_score}
                            </span>
                          </div>
                        ))}
                    </div>
                  )}

                  {/* 逐条结果 */}
                  <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
                    {results.map((entry) => (
                      <Card
                        key={entry.job_id}
                        className={`border ${
                          entry.status === "success"
                            ? "bg-green-500/5 border-green-500/20"
                            : entry.status === "failed"
                            ? "bg-red-500/5 border-red-500/20"
                            : "bg-yellow-500/5 border-yellow-500/20"
                        }`}
                      >
                        <CardBody className="p-3">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2 flex-1 min-w-0">
                              {entry.status === "success" ? (
                                <CheckCircle2 size={16} className="text-green-400 shrink-0" />
                              ) : entry.status === "failed" ? (
                                <XCircle size={16} className="text-red-400 shrink-0" />
                              ) : (
                                <AlertTriangle size={16} className="text-yellow-400 shrink-0" />
                              )}
                              <div className="min-w-0">
                                <p className="text-sm font-medium truncate">
                                  {entry.company} · {entry.job_title}
                                </p>
                                {entry.status === "success" && (
                                  <div className="flex items-center gap-2 text-xs text-white/40 mt-0.5">
                                    {entry.ats_score != null && (
                                      <span>ATS: {entry.ats_score}分</span>
                                    )}
                                    {entry.suggestions_applied > 0 && (
                                      <span>已应用 {entry.suggestions_applied} 条建议</span>
                                    )}
                                  </div>
                                )}
                                {entry.error && (
                                  <p className="text-xs text-red-400 mt-0.5">{entry.error}</p>
                                )}
                              </div>
                            </div>
                            {entry.status === "success" && entry.new_resume_id && (
                              <Button
                                size="sm"
                                variant="flat"
                                color="primary"
                                startContent={<ExternalLink size={14} />}
                                onPress={() => router.push(`/resume/${entry.new_resume_id}`)}
                              >
                                查看
                              </Button>
                            )}
                          </div>
                        </CardBody>
                      </Card>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </ModalBody>

        <ModalFooter>
          {phase === "select" && (
            <>
              <Button variant="flat" onPress={handleClose}>
                取消
              </Button>
              <Button
                color="primary"
                isDisabled={!selectedResumeId}
                onPress={handleStart}
                startContent={<Sparkles size={16} />}
              >
                开始定制 ({selectedJobs.length} 份)
              </Button>
            </>
          )}
          {phase === "running" && (
            <p className="text-xs text-white/30">请勿关闭窗口，正在处理中...</p>
          )}
          {phase === "done" && (
            <>
              <Button variant="flat" onPress={handleClose}>
                关闭
              </Button>
              {successCount > 0 && (
                <Button
                  color="primary"
                  onPress={() => {
                    handleClose();
                    router.push("/resume");
                  }}
                  startContent={<FileText size={16} />}
                >
                  查看所有简历
                </Button>
              )}
            </>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
