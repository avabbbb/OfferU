"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Chip, Input, Select, SelectItem, Spinner } from "@nextui-org/react";
import {
  CheckCircle2,
  FolderOpen,
  ListChecks,
  MessageSquare,
  Search,
  Sparkles,
} from "lucide-react";
import { jobsApi } from "@/lib/api";
import { bauhausFieldClassNames, bauhausSelectClassNames } from "@/lib/bauhaus";
import {
  Job,
  ResumeBrief,
  useProfile,
  usePools,
  useResumes,
} from "@/lib/hooks";
import { normalizePersonalArchiveFromProfile } from "@/lib/personalArchive";
import { OptimizeChatPanel } from "./OptimizeChatPanel";
import { ConversationList } from "./ConversationList";

type PoolFilter = "all" | "ungrouped" | number;

interface OptimizeWorkspaceProps {
  seedJobIds?: number[];
}

function getPoolButtonClassName(active: boolean, tone: "yellow" | "red" | "white" = "white") {
  if (active) {
    const activeMap = {
      yellow: "bg-[var(--surface-muted)] text-[var(--foreground)]",
      red: "bg-[var(--status-blush)] text-[var(--foreground)]",
      white: "bg-[var(--surface)] text-[var(--foreground)]",
    };
    return `border border-[var(--border-strong)]/15 px-3 py-2 text-xs font-semibold shadow-[1px_1px_0_0_rgba(18,18,18,0.1)] transition-colors ${activeMap[tone]}`;
  }

  return "border border-[var(--border-strong)]/15 bg-[var(--surface)] px-3 py-2 text-xs font-medium text-[var(--foreground-muted)] shadow-[1px_1px_0_0_rgba(18,18,18,0.08)] transition-colors hover:bg-[var(--surface-muted)]";
}

function getLocationLabel(job: Job) {
  return job.location || "地点未知";
}

export function OptimizeWorkspace({ seedJobIds = [] }: OptimizeWorkspaceProps) {
  const normalizedSeedJobIds = useMemo(
    () => Array.from(new Set(seedJobIds.filter((id) => Number.isFinite(id) && id > 0))).slice(0, 1),
    [seedJobIds]
  );
  const lastAppliedSeedRef = useRef("");
  const [poolFilter, setPoolFilter] = useState<PoolFilter>("all");
  const [keyword, setKeyword] = useState("");
  const mode = "per_job" as const;
  const [selectedJobIds, setSelectedJobIds] = useState<number[]>(normalizedSeedJobIds);
  const [referenceResumeId, setReferenceResumeId] = useState<number | null>(null);
  const [showConversationList, setShowConversationList] = useState(false);
  const [loadSessionId, setLoadSessionId] = useState<string | null>(null);

  const { data: profileData, isLoading: loadingProfile } = useProfile();

  useEffect(() => {
    const seedSignature = normalizedSeedJobIds.join(",");
    if (!seedSignature) {
      lastAppliedSeedRef.current = "";
      return;
    }
    if (seedSignature === lastAppliedSeedRef.current) return;
    setSelectedJobIds(normalizedSeedJobIds);
    lastAppliedSeedRef.current = seedSignature;
  }, [normalizedSeedJobIds]);

  const poolIdForQuery = poolFilter === "all" ? undefined : poolFilter;
  const { data: pools } = usePools("picked");
  const { data: resumeListData } = useResumes();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [jobsTotal, setJobsTotal] = useState(0);
  const archive = useMemo(() => normalizePersonalArchiveFromProfile(profileData), [profileData]);
  const profileSectionCount = useMemo(() => {
    const r = archive.resumeArchive;
    return (
      r.education.length +
      r.workExperiences.length +
      r.internshipExperiences.length +
      r.projects.length +
      r.skills.length +
      r.certificates.length +
      r.awards.length +
      r.personalExperiences.length
    );
  }, [archive]);
  const referenceResumes: ResumeBrief[] = Array.isArray(resumeListData) ? resumeListData : [];
  const canStart = selectedJobIds.length === 1 && profileSectionCount > 0;

  useEffect(() => {
    let cancelled = false;
    const keywordText = keyword.trim();

    const loadJobs = async () => {
      setLoadingJobs(true);
      try {
        const pageSize = 100;
        let page = 1;
        let total = 0;
        const all: Job[] = [];

        while (true) {
          const result = await jobsApi.list({
            page,
            page_size: pageSize,
            triage_status: "picked",
            pool_id: poolIdForQuery,
            keyword: keywordText || undefined,
          });

          const items = Array.isArray((result as any)?.items) ? ((result as any).items as Job[]) : [];
          total = Number((result as any)?.total || 0);
          all.push(...items);

          if (all.length >= total || items.length === 0) {
            break;
          }
          page += 1;
        }

        if (!cancelled) {
          const deduped = Array.from(new Map(all.map((job) => [job.id, job])).values());
          setJobs(deduped);
          setJobsTotal(total || deduped.length);
        }
      } catch {
        if (!cancelled) {
          setJobs([]);
          setJobsTotal(0);
        }
      } finally {
        if (!cancelled) {
          setLoadingJobs(false);
        }
      }
    };

    void loadJobs();

    return () => {
      cancelled = true;
    };
  }, [poolIdForQuery, keyword]);

  useEffect(() => {
    if (loadingJobs) return;
    const visibleIds = new Set(jobs.map((job) => job.id));
    setSelectedJobIds((prev) => prev.filter((id) => visibleIds.has(id)));
  }, [jobs, loadingJobs]);

  const selectedCountInCurrentList = useMemo(
    () => jobs.filter((job) => selectedJobIds.includes(job.id)).length,
    [jobs, selectedJobIds]
  );
  const totalJobsInCurrentPool = useMemo(
    () => Math.max(jobsTotal, jobs.length),
    [jobsTotal, jobs.length]
  );

  const toggleJob = (jobId: number) => {
    setSelectedJobIds((prev) => (prev.includes(jobId) ? [] : [jobId]));
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[0.95fr_1fr_1.05fr] xl:items-start">
      <section className="bauhaus-panel overflow-hidden bg-[var(--surface)] text-[var(--foreground)]">
        <div className="border-b border-[var(--border-strong)]/12 p-5 md:p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-3">
              <span className="bauhaus-chip bg-[var(--surface-muted)] text-[var(--foreground)]">步骤一 · 设置范围</span>
              <div>
                <p className="bauhaus-label text-[var(--foreground-muted)]">先筛选再生成</p>
                <h2 className="mt-2 text-3xl font-bold leading-tight md:text-4xl">筛选岗位与生成条件</h2>
              </div>
            </div>

            <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
              <div className="bauhaus-panel-sm bg-[var(--surface-muted)] p-3">
                <p className="bauhaus-label text-[var(--foreground-muted)]">档案条目</p>
                <p className="mt-2 text-2xl font-bold">
                  {loadingProfile ? "--" : profileSectionCount}
                </p>
              </div>
              <div className="bauhaus-panel-sm bg-[var(--surface-muted)] p-3 text-[var(--foreground)]">
                <p className="bauhaus-label text-[var(--foreground-muted)]">已选岗位</p>
                <p className="mt-2 text-2xl font-bold">
                  {selectedJobIds.length}
                </p>
              </div>
              <div className="bauhaus-panel-sm bg-[var(--status-blush)] p-3 text-[var(--foreground)]">
                <p className="bauhaus-label text-[var(--foreground-muted)]">生成方式</p>
                <p className="mt-2 text-lg font-semibold">
                  单岗位提案
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-5 p-5 md:p-6">
          {!loadingProfile && profileSectionCount === 0 && (
            <div className="bauhaus-panel-sm bg-[var(--surface-muted)] px-4 py-4 text-sm font-medium leading-relaxed text-[var(--foreground-muted)]">
              当前还没有可复用的档案条目。先去
              <Link href="/profile" className="mx-1 font-bold underline">
                个人档案
              </Link>
              完成确认，再回来批量生成简历。
            </div>
          )}

          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <FolderOpen size={18} strokeWidth={2.6} />
              <p className="bauhaus-label text-[var(--foreground-muted)]">岗位池筛选</p>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={getPoolButtonClassName(poolFilter === "all", "white")}
                onClick={() => setPoolFilter("all")}
              >
                全部已挑选
              </button>
              <button
                type="button"
                className={getPoolButtonClassName(poolFilter === "ungrouped", "red")}
                onClick={() => setPoolFilter("ungrouped")}
              >
                未分组
              </button>
              {(pools || []).map((pool) => (
                <button
                  key={pool.id}
                  type="button"
                  className={getPoolButtonClassName(poolFilter === pool.id, "yellow")}
                  onClick={() => setPoolFilter(pool.id)}
                >
                  {pool.name}
                </button>
              ))}
            </div>
          </div>

          <Input
            size="sm"
            label="关键词"
            placeholder="搜索岗位标题、公司或关键词"
            value={keyword}
            onValueChange={setKeyword}
            startContent={<Search size={15} className="text-[var(--foreground-muted)]" />}
            classNames={bauhausFieldClassNames}
          />

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Sparkles size={18} strokeWidth={2.6} />
                <p className="bauhaus-label text-[var(--foreground-muted)]">审核方式</p>
              </div>
              <div className="bauhaus-panel-sm bg-[var(--status-blush)] px-3 py-3 text-sm font-semibold">
                一次选择一个岗位，先调研并生成 diff 提案；明确接受后才创建正式简历。
              </div>
            </div>

            <Select
              aria-label="参考简历"
              label="参考简历"
              placeholder="可选：指定参考简历"
              selectedKeys={referenceResumeId ? [String(referenceResumeId)] : []}
              onSelectionChange={(keys) => {
                const raw = Array.from(keys)[0] as string | undefined;
                setReferenceResumeId(raw ? Number(raw) : null);
              }}
              classNames={{ ...bauhausSelectClassNames, base: "w-full" }}
            >
              {referenceResumes.map((resume) => (
                <SelectItem key={String(resume.id)}>
                  {resume.title || `简历 #${resume.id}`}
                </SelectItem>
              ))}
            </Select>
          </div>

          <div className="bauhaus-panel-sm bg-[var(--surface-muted)] px-4 py-4 text-sm font-medium leading-relaxed text-[var(--foreground-muted)]">
            参考简历只会影响表达方式和版面倾向，事实来源仍然限定为档案中已确认的内容。
          </div>
        </div>
      </section>

      <section className="bauhaus-panel overflow-hidden bg-[var(--surface-muted)] text-[var(--foreground)]">
        <div className="border-b border-[var(--border-strong)]/12 p-5 md:p-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="bauhaus-label text-[var(--foreground-muted)]">步骤二 · 选择岗位</p>
              <h2 className="mt-2 text-3xl font-bold leading-tight md:text-4xl">选择一个目标岗位</h2>
            </div>
            <div className="bauhaus-panel-sm bg-[var(--surface-muted)] px-4 py-3 text-[var(--foreground)]">
              <p className="bauhaus-label text-[var(--foreground-muted)]">当前可见岗位</p>
              <p className="mt-2 text-2xl font-bold">{jobs.length}</p>
            </div>
          </div>
        </div>

        <div className="space-y-4 p-5 md:p-6">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <ListChecks size={18} strokeWidth={2.6} />
              <p className="bauhaus-label text-[var(--foreground-muted)]">当前队列</p>
            </div>
            <Chip className="bauhaus-chip bg-white text-[var(--foreground)]">
              {selectedCountInCurrentList} / {totalJobsInCurrentPool}
            </Chip>
          </div>

          <div className="bauhaus-panel-sm max-h-[32rem] space-y-3 overflow-y-auto bg-white p-3 text-[var(--foreground)] custom-scrollbar">
            {loadingJobs ? (
              <div className="flex min-h-48 items-center justify-center gap-3 text-sm font-medium text-[var(--foreground-muted)]">
                <Spinner size="sm" color="warning" />
                <span>正在加载岗位列表…</span>
              </div>
            ) : jobs.length === 0 ? (
              <div className="flex min-h-48 items-center justify-center text-center text-sm font-medium text-[var(--foreground-muted)]">
                当前筛选范围内没有岗位。
              </div>
            ) : (
              jobs.map((job, index) => {
                const checked = selectedJobIds.includes(job.id);
                return (
                  <button
                    key={job.id}
                    type="button"
                    onClick={() => toggleJob(job.id)}
                    className={`w-full border border-[var(--border-strong)]/15 p-4 text-left shadow-[1px_1px_0_0_rgba(18,18,18,0.12)] transition-transform hover:-translate-y-[1px] ${
                      checked ? "bg-[var(--surface-muted)]" : "bg-[var(--surface)]"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="bauhaus-label text-[var(--foreground-muted)]">#{String(index + 1).padStart(2, "0")}</p>
                        <h3 className="mt-1 line-clamp-2 text-lg font-semibold leading-snug">
                          {job.title}
                        </h3>
                        <p className="mt-2 text-sm font-semibold tracking-[0.02em] text-[var(--foreground-muted)]">
                          {job.company}
                        </p>
                        <p className="mt-2 text-sm font-medium leading-relaxed text-[var(--foreground-muted)]">
                          {getLocationLabel(job)}
                        </p>
                      </div>

                      <span
                        className={`flex h-11 w-11 items-center justify-center border border-[var(--border-strong)]/20 ${
                          checked ? "bg-[var(--surface-muted)] text-[var(--foreground)]" : "bg-white text-[var(--foreground)]"
                        }`}
                      >
                        <CheckCircle2 size={18} strokeWidth={2.6} />
                      </span>
                    </div>
                  </button>
                );
              })
            )}
          </div>

          <div className="bauhaus-panel-sm bg-[var(--surface)] px-4 py-4 text-sm font-medium leading-relaxed text-[var(--foreground-muted)]">
            当前池内共 {totalJobsInCurrentPool} 个岗位，本轮请选择 1 个岗位逐项审核。
          </div>
        </div>
      </section>

      <section className="bauhaus-panel relative overflow-hidden bg-[var(--surface)] text-[var(--foreground)] h-[calc(100vh-6rem)]">
        <div className="absolute inset-0 flex flex-col">
          {/* Header bar with title and conversation list toggle */}
          <div className="shrink-0 border-b border-[var(--border-strong)]/12 px-5 py-3 md:px-6 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <MessageSquare size={18} strokeWidth={2.4} />
              <span className="text-sm font-bold text-[var(--foreground-muted)]">智能优化工作流</span>
            </div>
            <button
              type="button"
              onClick={() => setShowConversationList(!showConversationList)}
              className="flex items-center gap-1.5 border border-[var(--border-strong)]/15 bg-[var(--surface-muted)] px-3 py-1.5 text-sm font-semibold text-[var(--foreground-muted)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]"
            >
              <FolderOpen size={15} />
              {showConversationList ? "返回对话" : "往期对话"}
            </button>
          </div>
          <div className="flex-1 min-h-0">
            {showConversationList ? (
              <ConversationList
                onSelect={(sid) => {
                  setLoadSessionId(sid);
                  setShowConversationList(false);
                }}
                onClose={() => setShowConversationList(false)}
              />
            ) : (
              <OptimizeChatPanel
                jobIds={selectedJobIds}
                mode={mode}
                disabled={!canStart}
                profileId={profileData?.id ?? null}
                referenceResumeId={referenceResumeId}
                loadSessionId={loadSessionId}
                onLoadSessionConsumed={() => setLoadSessionId(null)}
              />
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
