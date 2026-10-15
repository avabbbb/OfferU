// =============================================
// 岗位列表页 — 卡片式展示 + 多维度筛选 + 批量选择
// =============================================
// 筛选：关键词搜索 / 数据源 / 时间范围 / 岗位类型 / 学历 / 校招
// 布局：响应式网格 + 动画列表
// 批量模式：多选岗位 → AI 简历定制
// =============================================

"use client";

import { PageHeader } from "@/components/layout/PageHeader";
import { useState, useCallback, useEffect, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  Tabs,
  Tab,
  Pagination,
  Spinner,
  Input,
  Select,
  SelectItem,
  Switch,
  Button,
  Checkbox,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  useDisclosure,
} from "@heroui/react";
import { Search, Sparkles, X, CheckSquare, FolderPlus, Trash2, PencilLine, Plus, SlidersHorizontal } from "lucide-react";
import { AddJobModal } from "@/components/jobs/AddJobModal";
import { JobCard } from "@/components/jobs/JobCard";
import { jobsApi } from "@/lib/api";
import {
  useJobs,
  useScraperTasks,
  usePools,
  patchJobsBatch,
  deleteJobsBatch,
  createPool,
  updatePoolName,
  deletePoolById,
  type Job,
  type Pool,
} from "@/lib/hooks";
import { safeClientErrorMessage } from "@/lib/safe-error";
import { tailorResumeHref } from "@/app/resume/resumeModes";

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.05, delayChildren: 0.06 } },
};

const item = {
  hidden: { opacity: 0, x: -16 },
  show: { opacity: 1, x: 0, transition: { type: "spring", stiffness: 400, damping: 30 } },
};

const SOURCE_OPTIONS = [
  { value: "", label: "全部来源" },
  { value: "boss", label: "BOSS直聘" },
  { value: "zhilian", label: "智联招聘" },
  { value: "linkedin", label: "领英" },
  { value: "shixiseng", label: "实习僧" },
  { value: "maimai", label: "脉脉" },
  { value: "corporate", label: "大厂官网" },
];

const JOB_TYPE_OPTIONS = [
  { value: "", label: "全部类型" },
  { value: "全职", label: "全职" },
  { value: "实习", label: "实习" },
  { value: "校招", label: "校招" },
  { value: "兼职", label: "兼职" },
];

const EDUCATION_OPTIONS = [
  { value: "", label: "全部学历" },
  { value: "不限", label: "不限" },
  { value: "本科", label: "本科" },
  { value: "硕士", label: "硕士" },
  { value: "博士", label: "博士" },
];

const bauhausInputClassNames = {
  inputWrapper:
    "border border-[var(--border)] bg-[var(--surface)]  transition-all hover:bg-[var(--surface-muted)]",
  input: "font-medium text-[var(--foreground)] placeholder:text-[var(--foreground-muted)]",
  label: "font-semibold text-[11px] text-[var(--foreground-muted)]",
};

const bauhausSelectClassNames = {
  trigger:
    "border border-[var(--border)] bg-[var(--surface)] ",
  value: "font-medium text-[var(--foreground)]",
  label: "font-semibold text-[11px] text-[var(--foreground-muted)]",
};

const bauhausPaginationClassNames = {
  base: "gap-1",
  item: "border border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)] ",
  cursor: "border border-[var(--border-strong)] bg-[var(--surface-muted)] text-[var(--foreground)] ",
  next: "border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--foreground)] ",
  prev: "border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--foreground)] ",
};

const bauhausModalContentClassName =
  "border border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)] ";

const bauhausIconButtonClassName =
  "min-h-11 min-w-11 border border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)] ";

function resolveTriageTab(raw: string | null): "all" | "inbox" | "picked" | "ignored" {
  if (!raw) return "inbox";
  const value = raw.toLowerCase();
  if (value === "all") return "all";
  if (value === "inbox" || value === "unscreened") return "inbox";
  if (value === "picked" || value === "screened") return "picked";
  if (value === "ignored") return "ignored";
  return "inbox";
}

export default function JobsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const guidedSetup = searchParams.get("setup") === "1";
  const fromScraper = searchParams.get("from_scraper") === "1";
  const scraperTaskId = (searchParams.get("task_id") || "").trim();
  const { isOpen: poolOpen, onOpen: openPoolModal, onClose: closePoolModal } = useDisclosure();
  const {
    isOpen: moveToPickedOpen,
    onOpen: openMoveToPickedModal,
    onClose: closeMoveToPickedModal,
  } = useDisclosure();
  const {
    isOpen: moveToTrashOpen,
    onOpen: openMoveToTrashModal,
    onClose: closeMoveToTrashModal,
  } = useDisclosure();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [trashActionSource, setTrashActionSource] = useState<"inbox" | "picked">("inbox");
  const {
    isOpen: confirmDeleteOpen,
    onOpen: openConfirmDelete,
    onClose: closeConfirmDelete,
  } = useDisclosure();
  const [confirmDeleteContext, setConfirmDeleteContext] = useState<{ type: "batch"; count: number } | { type: "pool"; pool: Pool } | null>(null);

  const [triageStatus, setTriageStatus] = useState<"all" | "inbox" | "picked" | "ignored">(() =>
    resolveTriageTab(searchParams.get("tab"))
  );
  const [period, setPeriod] = useState<string>("");
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState("");
  const [debouncedKeyword, setDebouncedKeyword] = useState("");
  const [source, setSource] = useState("");
  const [jobType, setJobType] = useState("");
  const [education, setEducation] = useState("");
  const [isCampus, setIsCampus] = useState(false);
  const [selectedPoolFilter, setSelectedPoolFilter] = useState<string>(() => {
    const poolFromQuery = (searchParams.get("pool_id") || "").trim();
    if (!poolFromQuery) return "all";
    if (poolFromQuery === "ungrouped") return "ungrouped";
    if (/^\d+$/.test(poolFromQuery)) return poolFromQuery;
    return "all";
  });
  const [targetPoolForInbox, setTargetPoolForInbox] = useState<string>("ungrouped");
  const [targetPoolForBatch, setTargetPoolForBatch] = useState<string>("ungrouped");
  const [actionLoading, setActionLoading] = useState(false);
  const [selectAllLoading, setSelectAllLoading] = useState(false);

  const [newPoolName, setNewPoolName] = useState("");
  const [editingPoolId, setEditingPoolId] = useState<number | null>(null);
  const [editingPoolName, setEditingPoolName] = useState("");
  const [poolError, setPoolError] = useState("");
  const [poolBusy, setPoolBusy] = useState(false);

  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [lastSelectedAnchorId, setLastSelectedAnchorId] = useState<number | null>(null);
  const [pointerSelectionActive, setPointerSelectionActive] = useState(false);
  const [pointerSelectionMode, setPointerSelectionMode] = useState<"select" | "deselect">("select");
  const [isScraperSyncing, setIsScraperSyncing] = useState(fromScraper && !!scraperTaskId);
  const [actionError, setActionError] = useState("");
  const [addJobOpen, setAddJobOpen] = useState(false);

  useEffect(() => {
    if (guidedSetup) setAddJobOpen(true);
  }, [guidedSetup]);

  const closeAddJob = useCallback((reason?: "dismissed" | "created") => {
    setAddJobOpen(false);
    if (!guidedSetup || reason === "created") return;
    const params = new URLSearchParams(searchParams.toString());
    params.delete("setup");
    const query = params.toString();
    router.replace(query ? "/jobs?" + query : "/jobs", { scroll: false });
  }, [guidedSetup, router, searchParams]);

  // 错误横幅 5.5s 自动消失
  useEffect(() => {
    if (!actionError) return;
    const t = setTimeout(() => setActionError(""), 5500);
    return () => clearTimeout(t);
  }, [actionError]);

  // 搜索关键词 debounce（300ms）
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedKeyword(keyword);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [keyword]);

  const scopedPoolFilter =
    (triageStatus === "all" || triageStatus === "inbox" || triageStatus === "picked") && selectedPoolFilter !== "all"
      ? (selectedPoolFilter === "ungrouped" ? "ungrouped" : String(selectedPoolFilter))
      : undefined;
  const poolScope = triageStatus === "all" ? undefined : triageStatus;

  const { data, isLoading, isValidating, mutate: mutateJobs } = useJobs({
    page,
    page_size: 21,
    period: period || undefined,
    source: source || undefined,
    keyword: debouncedKeyword || undefined,
    job_type: jobType || undefined,
    education: education || undefined,
    is_campus: isCampus || undefined,
    triage_status: triageStatus === "all" ? undefined : triageStatus,
    pool_id: scopedPoolFilter,
  });

  const { data: pools, mutate: mutatePools } = usePools(poolScope);
  const { data: pickedPools, mutate: mutatePickedPools } = usePools("picked");
  const { data: scraperTasks } = useScraperTasks();
  const jobs = useMemo(() => data?.items ?? [], [data?.items]);
  const poolList = useMemo(() => pools ?? [], [pools]);
  const pickedPoolList = useMemo(() => pickedPools ?? [], [pickedPools]);
  const totalMatchingJobs = data?.total ?? 0;
  const poolFilterOptions = useMemo(
    () => [
      { key: "all", label: "全部池" },
      { key: "ungrouped", label: "未分组" },
      ...poolList.map((pool) => ({ key: String(pool.id), label: pool.name })),
    ],
    [poolList]
  );
  const poolAssignOptions = useMemo(
    () => [
      { key: "ungrouped", label: "移到未分组" },
      ...pickedPoolList.map((pool) => ({ key: String(pool.id), label: pool.name })),
    ],
    [pickedPoolList]
  );
  const totalPages = Math.ceil((data?.total ?? 0) / (data?.page_size ?? 20));
  const isAllSelected = totalMatchingJobs > 0 && selectedIds.size === totalMatchingJobs;
  const activeFilterCount = [keyword, source, jobType, education].filter(Boolean).length + (isCampus ? 1 : 0) + (period ? 1 : 0);
  const hasFilters = activeFilterCount > 0;
  const triageMeta = {
    all: {
      label: "全部岗位",
      tone: "bg-[var(--surface-muted)] text-[var(--foreground)]",
      accent: "bg-[var(--surface-muted)]",
      description: "查看所有已同步职位，并通过筛选器把注意力拉回到目标范围。",
    },
    inbox: {
      label: "待筛选",
      tone: "bg-[var(--surface-muted)] text-[var(--foreground)]",
      accent: "bg-[var(--surface-muted)]",
      description: "这里承接刚抓取回来的职位，用来做第一轮判断与归档。",
    },
    picked: {
      label: "已筛选池",
      tone: "bg-[var(--surface-muted)] text-[var(--foreground)]",
      accent: "bg-[var(--surface-muted)]",
      description: "只保留你真正要追的岗位，再继续做简历定制和投递动作。",
    },
    ignored: {
      label: "已忽略",
      tone: "bg-[var(--surface)] text-[var(--foreground)]",
      accent: "bg-[var(--background-muted)]",
      description: "回收站保留恢复入口，也支持彻底删除，避免主列表持续膨胀。",
    },
  }[triageStatus];

  const visibleJobIndexMap = useMemo(() => {
    return new Map(jobs.map((job, index) => [job.id, index]));
  }, [jobs]);

  // 批量选择辅助
  const toggleJobSelect = useCallback((id: number, options?: { shiftKey?: boolean }) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);

      const shiftRangeSelectable =
        !!options?.shiftKey &&
        lastSelectedAnchorId !== null &&
        visibleJobIndexMap.has(lastSelectedAnchorId) &&
        visibleJobIndexMap.has(id);

      if (shiftRangeSelectable) {
        const start = visibleJobIndexMap.get(lastSelectedAnchorId)!;
        const end = visibleJobIndexMap.get(id)!;
        const from = Math.min(start, end);
        const to = Math.max(start, end);
        for (let i = from; i <= to; i += 1) {
          next.add(jobs[i].id);
        }
      } else if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }

      return next;
    });
    setLastSelectedAnchorId(id);
  }, [lastSelectedAnchorId, visibleJobIndexMap, jobs]);

  const handleSelectionPointerDown = useCallback(
    (id: number, options?: { shiftKey?: boolean }) => {
      if (!options?.shiftKey) {
        setPointerSelectionMode(selectedIds.has(id) ? "deselect" : "select");
        setPointerSelectionActive(true);
      }
    },
    [selectedIds]
  );

  const handleSelectionPointerEnter = useCallback(
    (id: number) => {
      if (!pointerSelectionActive) return;
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (pointerSelectionMode === "select") next.add(id);
        else next.delete(id);
        return next;
      });
    },
    [pointerSelectionActive, pointerSelectionMode]
  );

  const fetchAllFilteredJobIds = useCallback(async () => {
    const pageSize = 100;
    let nextPage = 1;
    let total = 0;
    const ids: number[] = [];

    do {
      const result = await jobsApi.list({
        page: nextPage,
        page_size: pageSize,
        period: period || undefined,
        source: source || undefined,
        keyword: debouncedKeyword || undefined,
        job_type: jobType || undefined,
        education: education || undefined,
        is_campus: isCampus || undefined,
        triage_status: triageStatus === "all" ? undefined : triageStatus,
        pool_id: scopedPoolFilter,
      });

      const items = Array.isArray((result as any)?.items) ? (result as any).items : [];
      total = Number((result as any)?.total || 0);
      ids.push(...items.map((job: Job) => job.id));

      if (items.length === 0) break;
      nextPage += 1;
    } while (ids.length < total);

    return Array.from(new Set(ids));
  }, [
    period,
    source,
    debouncedKeyword,
    jobType,
    education,
    isCampus,
    triageStatus,
    scopedPoolFilter,
  ]);

  const toggleSelectAll = useCallback(async () => {
    if (!totalMatchingJobs) {
      setSelectedIds(new Set());
      return;
    }

    if (selectedIds.size === totalMatchingJobs) {
      setSelectedIds(new Set());
      setLastSelectedAnchorId(null);
      return;
    }

    setSelectAllLoading(true);
    try {
      const allIds = await fetchAllFilteredJobIds();
      setSelectedIds(new Set(allIds));
      setLastSelectedAnchorId(allIds.length > 0 ? allIds[allIds.length - 1] : null);
    } catch (err: any) {
      setActionError(safeClientErrorMessage(err, "全选失败，请重试"));
    } finally {
      setSelectAllLoading(false);
    }
  }, [fetchAllFilteredJobIds, selectedIds.size, totalMatchingJobs]);

  const goOptimizeWithSelection = useCallback(() => {
    if (selectedIds.size === 0) return;
    const jobIds = Array.from(selectedIds).sort((a, b) => a - b);
    router.push(tailorResumeHref(jobIds));
  }, [router, selectedIds]);

  const refreshAfterMutation = useCallback(async () => {
    await Promise.all([mutateJobs(), mutatePools(), mutatePickedPools()]);
  }, [mutateJobs, mutatePools, mutatePickedPools]);

  const handleJobCreated = useCallback(async (jobId: number | null) => {
    await refreshAfterMutation();
    if (jobId) router.push(`/jobs/${jobId}`);
  }, [refreshAfterMutation, router]);

  const runBatchAction = useCallback(
    async (payload: { triage_status?: "inbox" | "picked" | "ignored"; pool_id?: number; clear_pool?: boolean }) => {
      if (selectedIds.size === 0) return;
      setActionLoading(true);
      try {
        const ids = Array.from(selectedIds);
        const chunkSize = 500;
        for (let i = 0; i < ids.length; i += chunkSize) {
          await patchJobsBatch({ job_ids: ids.slice(i, i + chunkSize), ...payload });
        }
        setSelectedIds(new Set());
        await refreshAfterMutation();
      } catch (err: any) {
        setActionError(safeClientErrorMessage(err, "批量操作失败"));
      } finally {
        setActionLoading(false);
      }
    },
    [refreshAfterMutation, selectedIds]
  );

  const runPermanentDelete = useCallback(() => {
    if (selectedIds.size === 0) return;
    setConfirmDeleteContext({ type: "batch", count: selectedIds.size });
    openConfirmDelete();
  }, [selectedIds, openConfirmDelete]);

  const executeConfirmDelete = useCallback(async () => {
    closeConfirmDelete();
    if (!confirmDeleteContext) return;

    if (confirmDeleteContext.type === "batch") {
      setActionLoading(true);
      try {
        await deleteJobsBatch({ job_ids: Array.from(selectedIds) });
        setSelectedIds(new Set());
        setLastSelectedAnchorId(null);
        await refreshAfterMutation();
      } catch (err: any) {
        setActionError(safeClientErrorMessage(err, "彻底删除失败"));
      } finally {
        setActionLoading(false);
      }
    } else if (confirmDeleteContext.type === "pool") {
      setPoolBusy(true);
      setPoolError("");
      try {
        await deletePoolById(confirmDeleteContext.pool.id, poolScope);
        await refreshAfterMutation();
      } catch (err: any) {
        setPoolError(safeClientErrorMessage(err, "删除池失败"));
      } finally {
        setPoolBusy(false);
      }
    }
    setConfirmDeleteContext(null);
  }, [confirmDeleteContext, selectedIds, refreshAfterMutation, closeConfirmDelete, poolScope]);

  const handleCreatePool = useCallback(async () => {
    if (!newPoolName.trim()) return;
    if (triageStatus !== "picked") {
      setPoolError("未筛选池仅支持爬虫自动生成，不能手动新建");
      return;
    }
    setPoolBusy(true);
    setPoolError("");
    try {
      await createPool(newPoolName.trim(), "picked");
      setNewPoolName("");
      await refreshAfterMutation();
    } catch (err: any) {
      setPoolError(safeClientErrorMessage(err, "创建池失败"));
    } finally {
      setPoolBusy(false);
    }
  }, [newPoolName, refreshAfterMutation, triageStatus]);

  const handleRenamePool = useCallback(
    async (poolId: number) => {
      if (!editingPoolName.trim()) return;
      setPoolBusy(true);
      setPoolError("");
      try {
        await updatePoolName(poolId, editingPoolName.trim(), poolScope);
        setEditingPoolId(null);
        setEditingPoolName("");
        await refreshAfterMutation();
      } catch (err: any) {
        setPoolError(safeClientErrorMessage(err, "重命名失败"));
      } finally {
        setPoolBusy(false);
      }
    },
    [editingPoolName, poolScope, refreshAfterMutation]
  );

  const handleDeletePool = useCallback(
    (pool: Pool) => {
      setConfirmDeleteContext({ type: "pool", pool });
      openConfirmDelete();
    },
    [openConfirmDelete]
  );

  useEffect(() => {
    if (!fromScraper || !scraperTaskId) {
      setIsScraperSyncing(false);
      return;
    }

    const targetTask = (scraperTasks || []).find((task) => task.id === scraperTaskId);
    if (!targetTask || targetTask.status === "running") {
      setIsScraperSyncing(true);
      return;
    }

    setIsScraperSyncing(false);
    void refreshAfterMutation();

    const params = new URLSearchParams(searchParams.toString());
    params.delete("from_scraper");
    params.delete("task_id");
    router.replace(`/jobs?${params.toString()}`, { scroll: false });
  }, [fromScraper, refreshAfterMutation, router, scraperTaskId, scraperTasks, searchParams]);

  useEffect(() => {
    setSelectedIds(new Set());
    setLastSelectedAnchorId(null);
  }, [triageStatus, selectedPoolFilter, period, source, debouncedKeyword, jobType, education, isCampus]);

  useEffect(() => {
    if (!pointerSelectionActive) return;
    const stopPointerSelection = () => setPointerSelectionActive(false);
    window.addEventListener("mouseup", stopPointerSelection);
    return () => window.removeEventListener("mouseup", stopPointerSelection);
  }, [pointerSelectionActive]);

  const resetFilters = useCallback(() => {
    setPage(1);
    setKeyword("");
    setDebouncedKeyword("");
    setPeriod("");
    setSource("");
    setJobType("");
    setEducation("");
    setIsCampus(false);
    setSelectedPoolFilter("all");
  }, []);

  const selectionStatusText = selectAllLoading
    ? "正在汇总当前筛选下的全部岗位..."
    : selectedIds.size > 0
      ? `已选 ${selectedIds.size} / 共 ${totalMatchingJobs} 个岗位`
      : `共 ${totalMatchingJobs} 个岗位`;

  return (
    <motion.div
      initial={{ opacity: 0, y: 14, scale: 0.99 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 380, damping: 28 }}
      className="stage-page stage-page--jobs space-y-6"
    >
      <PageHeader
        title="岗位"
        description={triageMeta.description}
        actions={
          <Button
            size="sm"
            startContent={<Plus size={14} />}
            onPress={() => setAddJobOpen(true)}
            className="bauhaus-button bauhaus-button-red !min-h-9 !px-4"
            data-testid="open-add-job"
          >
            保存岗位
          </Button>
        }
      />

      <div className="space-y-3">
        {isScraperSyncing && (
          <p className="text-[13px] text-[var(--foreground-muted)]">正在同步最新抓取结果，列表会自动刷新。</p>
        )}

        <div className="flex flex-wrap items-center gap-2">
                <Tabs
                  selectedKey={triageStatus}
                  onSelectionChange={(key) => {
                    const nextStatus = key as "all" | "inbox" | "picked" | "ignored";
                    setTriageStatus(nextStatus);
                    setPage(1);

                    const params = new URLSearchParams(searchParams.toString());
                    params.set("tab", nextStatus);
                    if (nextStatus === "ignored" || nextStatus === "all") {
                      params.delete("pool_id");
                    } else if (selectedPoolFilter !== "all") {
                      params.set("pool_id", selectedPoolFilter);
                    } else {
                      params.delete("pool_id");
                    }
                    router.push(`/jobs?${params.toString()}`, { scroll: false });
                  }}
                  color="primary"
                  variant="solid"
                  classNames={{
                    base: "",
                    tabList: "gap-0.5 rounded-lg border-0 bg-[var(--surface-muted)] p-0.5",
                    cursor: "rounded-md bg-[var(--surface)] shadow-[0_1px_2px_rgba(31,31,29,0.08)]",
                    tab: "h-8 rounded-md px-3",
                    tabContent: "text-[12.5px] font-medium text-[var(--foreground-muted)] group-data-[selected=true]:text-[var(--foreground)]",
                  }}
                >
                  <Tab key="inbox" title="未筛选" />
                  <Tab key="picked" title="已筛选" />
                  <Tab key="ignored" title="回收站" />
                  <Tab key="all" title="全部" />
                </Tabs>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <div className="w-[220px]">
              <Input
                placeholder="搜索岗位或公司"
                value={keyword}
                onValueChange={setKeyword}
                startContent={<Search size={15} className="text-[var(--foreground-muted)]" />}
                classNames={bauhausInputClassNames}
                size="sm"
              />
            </div>
            <Button
              size="sm"
              startContent={<SlidersHorizontal size={14} />}
              onPress={() => setFiltersOpen((open) => !open)}
              aria-expanded={filtersOpen}
              className={`bauhaus-button !min-h-9 !px-3 ${filtersOpen || activeFilterCount > 0 ? "bauhaus-button-blue" : "bauhaus-button-outline"}`}
            >
              筛选{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ""}
            </Button>
            {triageStatus !== "ignored" && (
              <Button
                size="sm"
                startContent={<FolderPlus size={14} />}
                onPress={openPoolModal}
                className="bauhaus-button bauhaus-button-outline !min-h-9 !px-3"
              >
                岗位池
              </Button>
            )}
          </div>
        </div>

        {filtersOpen && (
          <div className="bauhaus-panel-sm grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
                <Select
                  aria-label="时间范围"
                  size="sm"
                  selectedKeys={[period]}
                  onSelectionChange={(keys) => {
                    setPeriod(Array.from(keys)[0] as string);
                    setPage(1);
                  }}
                  classNames={{ ...bauhausSelectClassNames, base: "w-full" }}
                >
                  <SelectItem key="">全部时间</SelectItem>
                  <SelectItem key="today">今日</SelectItem>
                  <SelectItem key="week">本周</SelectItem>
                  <SelectItem key="month">本月</SelectItem>
                </Select>

                {triageStatus !== "ignored" && (
                  <Select
                    aria-label="岗位池"
                    size="sm"
                    selectedKeys={[selectedPoolFilter]}
                    onSelectionChange={(keys) => {
                      const value = Array.from(keys)[0] as string;
                      setSelectedPoolFilter(value);
                      setPage(1);
                      const params = new URLSearchParams(searchParams.toString());
                      params.set("tab", triageStatus);
                      if (value === "all") {
                        params.delete("pool_id");
                      } else {
                        params.set("pool_id", value);
                      }
                      router.push(`/jobs?${params.toString()}`, { scroll: false });
                    }}
                    classNames={{ ...bauhausSelectClassNames, base: "w-full" }}
                    items={poolFilterOptions}
                  >
                    {(item) => <SelectItem key={item.key}>{item.label}</SelectItem>}
                  </Select>
                )}
                <Select
                  aria-label="数据来源"
                  size="sm"
                  selectedKeys={source ? [source] : [""]}
                  onSelectionChange={(keys) => {
                    const val = Array.from(keys)[0] as string;
                    setSource(val);
                    setPage(1);
                  }}
                  classNames={{ ...bauhausSelectClassNames, base: "w-full" }}
                >
                  {SOURCE_OPTIONS.map((option) => (
                    <SelectItem key={option.value}>{option.label}</SelectItem>
                  ))}
                </Select>

                <Select
                  aria-label="岗位类型"
                  size="sm"
                  selectedKeys={jobType ? [jobType] : [""]}
                  onSelectionChange={(keys) => {
                    const val = Array.from(keys)[0] as string;
                    setJobType(val);
                    setPage(1);
                  }}
                  classNames={{ ...bauhausSelectClassNames, base: "w-full" }}
                >
                  {JOB_TYPE_OPTIONS.map((option) => (
                    <SelectItem key={option.value}>{option.label}</SelectItem>
                  ))}
                </Select>

                <Select
                  aria-label="学历要求"
                  size="sm"
                  selectedKeys={education ? [education] : [""]}
                  onSelectionChange={(keys) => {
                    const val = Array.from(keys)[0] as string;
                    setEducation(val);
                    setPage(1);
                  }}
                  classNames={{ ...bauhausSelectClassNames, base: "w-full" }}
                >
                  {EDUCATION_OPTIONS.map((option) => (
                    <SelectItem key={option.value}>{option.label}</SelectItem>
                  ))}
                </Select>
            <div className="flex items-center gap-3 sm:col-span-2 lg:col-span-3 xl:col-span-6">
              <Switch
                size="sm"
                isSelected={isCampus}
                onValueChange={(val) => {
                  setIsCampus(val);
                  setPage(1);
                }}
                classNames={{ wrapper: "bg-black/10" }}
              >
                <span className="text-[13px] text-[var(--foreground-soft)]">只看校招</span>
              </Switch>
              {hasFilters && (
                <button type="button" onClick={resetFilters} className="ml-auto text-[12.5px] text-[var(--foreground-muted)] underline-offset-2 hover:text-[var(--foreground)] hover:underline">
                  清空筛选
                </button>
              )}
            </div>
          </div>
        )}

        {totalMatchingJobs > 0 && (
          <div className="flex items-center justify-between text-[12.5px] text-[var(--foreground-muted)]">
            <span>{selectionStatusText}</span>
            <button
              type="button"
              onClick={() => { void toggleSelectAll(); }}
              disabled={selectAllLoading}
              className="hover:text-[var(--foreground)]"
            >
              {isAllSelected ? "取消全选" : "全选"}
            </button>
          </div>
        )}
      </div>
      {isLoading || (isValidating && jobs.length === 0) ? (
        <div className="bauhaus-panel flex justify-center bg-white py-20">
          <div className="flex items-center gap-3 text-sm font-medium text-[var(--foreground-soft)]">
            <Spinner size="lg" color="warning" />
            <span>岗位数据加载中...</span>
          </div>
        </div>
      ) : jobs.length > 0 ? (
        <>
          <motion.div
            variants={container}
            initial="hidden"
            animate="show"
            className="grid grid-cols-1 items-stretch gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4"
          >
            {jobs.map((job) => (
              <motion.div
                key={job.id}
                variants={item}
                className="h-full min-w-0"
              >
                <JobCard
                  job={job}
                  showCheckbox
                  selected={selectedIds.has(job.id)}
                  onToggle={toggleJobSelect}
                  onSelectPointerDown={handleSelectionPointerDown}
                  onSelectPointerEnter={handleSelectionPointerEnter}
                />
              </motion.div>
            ))}
          </motion.div>

          {/* 分页 */}
          {totalPages > 1 && (
            <div className="flex justify-center pt-4">
              <Pagination
                total={totalPages}
                page={page}
                onChange={setPage}
                showControls
                classNames={bauhausPaginationClassNames}
              />
            </div>
          )}

          {/* 浮动操作栏 — 选中岗位后出现 */}
          <AnimatePresence>
            {selectedIds.size > 0 && (
              <motion.div
                initial={{ y: 80, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: 80, opacity: 0 }}
                transition={{ type: "spring", damping: 20 }}
                className="fixed bottom-6 left-0 right-0 z-50 flex justify-center px-4 pointer-events-none md:left-64 md:right-auto md:w-[calc(100vw-16rem)]"
              >
                <div className="pointer-events-auto flex max-w-full flex-wrap items-center gap-2 rounded-xl bg-white px-3 py-2 shadow-[0_0_0_1px_rgba(15,15,15,0.06),0_8px_24px_rgba(15,15,15,0.12)]">
                  <span className="text-sm font-semibold text-[var(--foreground-soft)]">
                    已选 <span className="font-semibold text-[#2383e2]">{selectedIds.size}</span> 个
                  </span>

                  {actionError && (
                    <span className="border border-[var(--primary-red)]/30 bg-[var(--status-blush)] px-3 py-1 text-xs font-semibold text-[var(--primary-red)]" role="alert">
                      {actionError}
                    </span>
                  )}

                  {triageStatus === "inbox" && (
                    <>
                      <Button
                        size="sm"
                        isDisabled={actionLoading}
                        className="bauhaus-button bauhaus-button-red !px-4 !py-3 !text-[11px]"
                        onPress={() => {
                          setTargetPoolForInbox("ungrouped");
                          openMoveToPickedModal();
                        }}
                      >
                        加入已筛选
                      </Button>
                      <Button
                        size="sm"
                        isLoading={actionLoading}
                        isDisabled={actionLoading}
                        className="bauhaus-button bauhaus-button-yellow !px-4 !py-3 !text-[11px]"
                        onPress={() => {
                          setTrashActionSource("inbox");
                          openMoveToTrashModal();
                        }}
                      >
                        移入回收站
                      </Button>
                    </>
                  )}

                  {triageStatus === "ignored" && (
                    <>
                      <Button
                        size="sm"
                        isLoading={actionLoading}
                        className="bauhaus-button bauhaus-button-blue !px-4 !py-3 !text-[11px]"
                        onPress={() => runBatchAction({ triage_status: "inbox" })}
                      >
                        恢复到未筛选
                      </Button>
                      <Button
                        size="sm"
                        isLoading={actionLoading}
                        className="bauhaus-button bauhaus-button-red !px-4 !py-3 !text-[11px]"
                        onPress={runPermanentDelete}
                      >
                        彻底删除
                      </Button>
                    </>
                  )}

                  {triageStatus === "picked" && (
                    <>
                      <Select
                        aria-label="分配池"
                        size="sm"
                        selectedKeys={[targetPoolForBatch]}
                        onSelectionChange={(keys) => setTargetPoolForBatch(Array.from(keys)[0] as string)}
                        classNames={{ ...bauhausSelectClassNames, base: "w-44 min-w-[11rem]" }}
                        items={poolAssignOptions}
                      >
                        {(item) => <SelectItem key={item.key}>{item.label}</SelectItem>}
                      </Select>
                      <Button
                        size="sm"
                        isLoading={actionLoading}
                        className="bauhaus-button bauhaus-button-blue !px-4 !py-3 !text-[11px]"
                        onPress={() =>
                          targetPoolForBatch === "ungrouped"
                            ? runBatchAction({ triage_status: "picked", clear_pool: true })
                            : runBatchAction({ pool_id: Number(targetPoolForBatch), triage_status: "picked" })
                        }
                      >
                        应用分组
                      </Button>
                      <Button
                        size="sm"
                        startContent={<Sparkles size={14} />}
                        className="bauhaus-button bauhaus-button-red !px-4 !py-3 !text-[11px]"
                        onPress={goOptimizeWithSelection}
                      >
                        去 AI 简历定制
                      </Button>
                      <Button
                        size="sm"
                        isLoading={actionLoading}
                        isDisabled={actionLoading}
                        className="bauhaus-button bauhaus-button-yellow !px-4 !py-3 !text-[11px]"
                        onPress={() => {
                          setTrashActionSource("picked");
                          openMoveToTrashModal();
                        }}
                      >
                        移入回收站
                      </Button>
                    </>
                  )}

                  <Button
                    isIconOnly
                    size="sm"
                    aria-label="取消选择"
                    className={bauhausIconButtonClassName}
                    onPress={() => { setSelectedIds(new Set()); setActionError(""); }}
                  >
                    <X size={14} />
                  </Button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      ) : (
        <section className="flex flex-col items-center rounded-[10px] border border-dashed border-[var(--border-strong)] px-6 py-16 text-center">
          <h2 className="text-[17px] font-semibold text-[var(--foreground)]">{hasFilters ? "没有符合筛选的岗位" : "还没有岗位"}</h2>
          <p className="mt-2 max-w-md text-[13.5px] leading-relaxed text-[var(--foreground-muted)]">
            {hasFilters
              ? "放宽关键词或来源试试。"
              : "粘贴一个岗位链接或职位描述就能开始，OfferU 会围绕它准备简历和面试。"}
          </p>
          <div className="mt-5 flex items-center gap-3">
            <Button
              startContent={<Plus size={15} />}
              onPress={() => setAddJobOpen(true)}
              className="bauhaus-button bauhaus-button-red !min-h-9 !px-4"
              data-testid="empty-add-job"
            >
              保存第一个岗位
            </Button>
            {hasFilters && (
              <button type="button" onClick={resetFilters} className="text-[13px] text-[var(--foreground-muted)] hover:text-[var(--foreground)]">
                清空筛选
              </button>
            )}
          </div>
        </section>
      )}

      <AddJobModal
        isOpen={addJobOpen}
        guided={guidedSetup}
        onClose={closeAddJob}
        onCreated={(jobId) => {
          void handleJobCreated(jobId).catch((error) => {
            setActionError(
              safeClientErrorMessage(error, "岗位已保存，但详情页打开失败。请从 Pipeline 进入。"),
            );
          });
        }}
      />

      <Modal isOpen={moveToPickedOpen} onClose={closeMoveToPickedModal} size="md">
        <ModalContent className={bauhausModalContentClassName}>
          <ModalHeader className="border-b border-[var(--border)] px-6 py-5 text-xl font-semibold">
            加入已筛选池
          </ModalHeader>
          <ModalBody className="space-y-4 px-6 py-6">
            <p className="text-sm font-medium leading-relaxed text-[var(--foreground-soft)]">
              选择目标已筛选池，确认后将从当前未筛选池中移除并流转到对应已筛选池。
            </p>
            <Select
              aria-label="加入已筛选池"
              size="sm"
              selectedKeys={[targetPoolForInbox]}
              onSelectionChange={(keys) => setTargetPoolForInbox(Array.from(keys)[0] as string)}
              items={poolAssignOptions}
              classNames={{ ...bauhausSelectClassNames, base: "w-full" }}
            >
              {(item) => <SelectItem key={item.key}>{item.label}</SelectItem>}
            </Select>
          </ModalBody>
          <ModalFooter className="border-t border-[var(--border)] px-6 py-5">
            <Button
              variant="light"
              className="bauhaus-button bauhaus-button-outline !px-4 !py-3 !text-[11px]"
              onPress={closeMoveToPickedModal}
            >
              取消
            </Button>
            <Button
              isLoading={actionLoading}
              className="bauhaus-button bauhaus-button-red !px-4 !py-3 !text-[11px]"
              onPress={async () => {
                await runBatchAction(
                  targetPoolForInbox === "ungrouped"
                    ? { triage_status: "picked", clear_pool: true }
                    : { triage_status: "picked", pool_id: Number(targetPoolForInbox) }
                );
                closeMoveToPickedModal();
              }}
            >
              确认加入
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal isOpen={moveToTrashOpen} onClose={closeMoveToTrashModal} size="md">
        <ModalContent className={bauhausModalContentClassName}>
          <ModalHeader className="border-b border-[var(--border)] bg-[var(--surface-muted)] px-6 py-5 text-xl font-semibold">
            移入回收站
          </ModalHeader>
          <ModalBody className="space-y-4 px-6 py-6">
            <p className="text-sm font-medium leading-relaxed text-[var(--foreground-soft)]">
              确认将选中的 {selectedIds.size} 个岗位移入回收站吗？移入后可在回收站页面恢复或永久删除。
            </p>
          </ModalBody>
          <ModalFooter className="border-t border-[var(--border)] px-6 py-5">
            <Button
              variant="light"
              className="bauhaus-button bauhaus-button-outline !px-4 !py-3 !text-[11px]"
              onPress={closeMoveToTrashModal}
            >
              取消
            </Button>
            <Button
              isLoading={actionLoading}
              className="bauhaus-button bauhaus-button-yellow !px-4 !py-3 !text-[11px]"
              onPress={async () => {
                await runBatchAction({ triage_status: "ignored" });
                closeMoveToTrashModal();
              }}
            >
              {trashActionSource === "picked" ? "确认移入" : "确认移入"}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal isOpen={poolOpen} onClose={closePoolModal} size="lg">
        <ModalContent className={bauhausModalContentClassName}>
          <ModalHeader className="border-b border-[var(--border)] px-6 py-5 text-xl font-semibold">
            岗位池管理
          </ModalHeader>
          <ModalBody className="space-y-5 px-6 py-6">
            {triageStatus === "picked" ? (
              <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                <Input
                  size="sm"
                  placeholder="输入新池名称"
                  value={newPoolName}
                  onValueChange={setNewPoolName}
                  classNames={bauhausInputClassNames}
                />
                <Button
                  size="sm"
                  isLoading={poolBusy}
                  className="bauhaus-button bauhaus-button-red !px-4 !py-3 !text-[11px]"
                  onPress={handleCreatePool}
                >
                  创建
                </Button>
              </div>
            ) : (
              <div className="bauhaus-panel-sm bg-[var(--surface-muted)] px-4 py-3 text-sm font-medium leading-relaxed text-[var(--foreground-soft)]">
                未筛选池仅由爬虫任务自动生成，当前仅支持重命名与删除管理。
              </div>
            )}

            {poolError && (
              <p className="bauhaus-panel-sm bg-[var(--surface-muted)] px-4 py-3 text-sm font-medium text-[var(--primary-red)]">
                {poolError}
              </p>
            )}

            <div className="space-y-2 max-h-72 overflow-auto pr-1">
              {poolList.length === 0 ? (
                <p className="bauhaus-panel-sm bg-white px-4 py-4 text-sm font-medium text-[var(--foreground-muted)]">
                  {triageStatus === "picked" ? "暂无岗位池，先创建一个文件夹。" : "暂无自动生成的爬取池。"}
                </p>
              ) : (
                poolList.map((pool) => (
                  <div
                    key={pool.id}
                    className="bauhaus-panel-sm flex items-center justify-between gap-3 bg-white p-3"
                  >
                    {editingPoolId === pool.id ? (
                      <div className="grid flex-1 gap-3 md:grid-cols-[1fr_auto_auto]">
                        <Input
                          size="sm"
                          value={editingPoolName}
                          onValueChange={setEditingPoolName}
                          classNames={bauhausInputClassNames}
                        />
                        <Button
                          size="sm"
                          isLoading={poolBusy}
                          className="bauhaus-button bauhaus-button-blue !px-4 !py-3 !text-[11px]"
                          onPress={() => handleRenamePool(pool.id)}
                        >
                          保存
                        </Button>
                        <Button
                          size="sm"
                          variant="light"
                          className="bauhaus-button bauhaus-button-outline !px-4 !py-3 !text-[11px]"
                          onPress={() => {
                            setEditingPoolId(null);
                            setEditingPoolName("");
                          }}
                        >
                          取消
                        </Button>
                      </div>
                    ) : (
                      <>
                        <div>
                          <p className="text-base font-semibold tracking-[-0.04em] text-[var(--foreground)]">
                            {pool.name}
                          </p>
                          <p className="text-xs font-medium text-[var(--foreground-muted)]">
                            岗位数 {pool.job_count}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            isIconOnly
                            size="sm"
                            aria-label="编辑池名称"
                            className={bauhausIconButtonClassName}
                            onPress={() => {
                              setEditingPoolId(pool.id);
                              setEditingPoolName(pool.name);
                            }}
                          >
                            <PencilLine size={14} />
                          </Button>
                          <Button
                            isIconOnly
                            size="sm"
                            aria-label="删除池"
                            className={`${bauhausIconButtonClassName} bg-[var(--surface-muted)] text-[var(--primary-red)]`}
                            onPress={() => handleDeletePool(pool)}
                          >
                            <Trash2 size={14} />
                          </Button>
                        </div>
                      </>
                    )}
                  </div>
                ))
              )}
            </div>
          </ModalBody>
          <ModalFooter className="border-t border-[var(--border)] px-6 py-5">
            <Button
              variant="light"
              className="bauhaus-button bauhaus-button-outline !px-4 !py-3 !text-[11px]"
              onPress={closePoolModal}
            >
              关闭
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* 删除确认弹窗 */}
      <Modal isOpen={confirmDeleteOpen} onClose={closeConfirmDelete} placement="center">
        <ModalContent className={bauhausModalContentClassName}>
          <ModalHeader className="border-b border-[var(--border)] bg-[var(--surface-muted)] px-6 py-5 text-xl font-semibold text-[var(--primary-red)]">
            确认删除
          </ModalHeader>
          <ModalBody className="px-6 py-6">
            <p className="text-base font-medium text-[var(--foreground-soft)]">
              {confirmDeleteContext?.type === "batch"
                ? `确认彻底删除选中的 ${confirmDeleteContext.count} 个岗位吗？该操作会从本地数据库永久移除，无法恢复。`
                : confirmDeleteContext?.type === "pool"
                  ? `确认删除池"${confirmDeleteContext.pool.name}"吗？池内岗位将变为未分组。`
                  : ""}
            </p>
          </ModalBody>
          <ModalFooter className="border-t border-[var(--border)] px-6 py-5">
            <Button
              variant="light"
              className="bauhaus-button bauhaus-button-outline !px-4 !py-3 !text-[11px]"
              onPress={closeConfirmDelete}
            >
              取消
            </Button>
            <Button
              onPress={executeConfirmDelete}
              className="bauhaus-button bauhaus-button-red !px-4 !py-3 !text-[11px]"
            >
              确认删除
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </motion.div>
  );
}
