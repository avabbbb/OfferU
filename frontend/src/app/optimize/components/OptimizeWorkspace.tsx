"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Input, Select, SelectItem, Spinner } from "@heroui/react";
import { Check, ClipboardPaste, History, Search } from "lucide-react";
import { jobsApi } from "@/lib/api";
import { bauhausFieldClassNames, bauhausSelectClassNames } from "@/lib/bauhaus";
import { Job, ResumeBrief, useProfile, usePools, useResumes } from "@/lib/hooks";
import { OptimizeChatPanel } from "./OptimizeChatPanel";
import { ConversationList } from "./ConversationList";
import { JobCaptureCard } from "./JobCaptureCard";
import { ProfileColdStart } from "./ProfileColdStart";

type PoolFilter = "all" | "ungrouped" | number;

interface OptimizeWorkspaceProps {
  seedJobIds?: number[];
}

function chipClass(active: boolean) {
  return `rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
    active
      ? "border-[var(--foreground)] bg-[var(--foreground)] text-[var(--surface)]"
      : "border-[var(--border)] bg-[var(--surface)] text-[var(--foreground-muted)] hover:text-[var(--foreground)]"
  }`;
}

export function OptimizeWorkspace({ seedJobIds = [] }: OptimizeWorkspaceProps) {
  const seedJobId = useMemo(
    () => seedJobIds.find((id) => Number.isFinite(id) && id > 0) ?? null,
    [seedJobIds]
  );
  const [poolFilter, setPoolFilter] = useState<PoolFilter>("all");
  const [keyword, setKeyword] = useState("");
  const [selectedJobId, setSelectedJobId] = useState<number | null>(seedJobId);
  const [seedJob, setSeedJob] = useState<Job | null>(null);
  const [referenceResumeId, setReferenceResumeId] = useState<number | null>(null);
  const [showConversationList, setShowConversationList] = useState(false);
  const [loadRunId, setLoadRunId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [jobsError, setJobsError] = useState("");

  const router = useRouter();
  const [showCapture, setShowCapture] = useState(false);
  const [coldStartActive, setColdStartActive] = useState(false);
  const { data: profileData, isLoading: loadingProfile, mutate: mutateProfile } = useProfile();
  const { data: pools } = usePools("picked");
  const { data: resumeListData } = useResumes();
  const referenceResumes: ResumeBrief[] = Array.isArray(resumeListData) ? resumeListData : [];

  // 定制只用 tier=verified_fact 的事实；待确认/偏好/假设都不算数。
  const verifiedCount = useMemo(
    () => (profileData?.sections || []).filter((section) => section.tier === "verified_fact").length,
    [profileData]
  );

  // 档案为空时进入冷启动；用户确认过几条之后由用户自己决定何时回到定制。
  useEffect(() => {
    if (!loadingProfile && profileData && verifiedCount === 0) setColdStartActive(true);
  }, [loadingProfile, profileData, verifiedCount]);
  const showColdStart = !loadingProfile && (verifiedCount === 0 || coldStartActive);

  const handleJobCaptured = (jobId: number) => {
    setShowCapture(false);
    setSelectedJobId(jobId);
    router.replace(`/optimize?job_ids=${jobId}`);
  };

  // A job opened from its own workspace must stay selectable even when it has
  // not been moved into the picked list; otherwise the page has nothing to start.
  useEffect(() => {
    if (!seedJobId) return;
    setSelectedJobId(seedJobId);
    let cancelled = false;
    jobsApi
      .get(seedJobId)
      .then((job) => { if (!cancelled) setSeedJob(job as Job); })
      .catch(() => { if (!cancelled) setSeedJob(null); });
    return () => { cancelled = true; };
  }, [seedJobId]);

  useEffect(() => {
    let cancelled = false;
    const poolId = poolFilter === "all" ? undefined : String(poolFilter);
    const keywordText = keyword.trim() || undefined;
    const load = async () => {
      setLoadingJobs(true);
      setJobsError("");
      try {
        const all: Job[] = [];
        for (let page = 1; ; page += 1) {
          const result: any = await jobsApi.list({ page, page_size: 100, triage_status: "picked", pool_id: poolId, keyword: keywordText });
          const items: Job[] = Array.isArray(result?.items) ? result.items : [];
          all.push(...items);
          if (items.length === 0 || all.length >= Number(result?.total || 0)) break;
        }
        if (!cancelled) setJobs(Array.from(new Map(all.map((job) => [job.id, job])).values()));
      } catch {
        if (!cancelled) {
          setJobs([]);
          setJobsError("岗位列表加载失败，请稍后刷新。");
        }
      } finally {
        if (!cancelled) setLoadingJobs(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [poolFilter, keyword]);

  const visibleJobs = useMemo(() => {
    if (!seedJob || jobs.some((job) => job.id === seedJob.id)) return jobs;
    return [seedJob, ...jobs];
  }, [jobs, seedJob]);
  const selectedJob = visibleJobs.find((job) => job.id === selectedJobId) ?? (seedJob?.id === selectedJobId ? seedJob : null);

  const blockedReason = loadingProfile
    ? "正在读取档案…"
    : verifiedCount === 0
      ? "profile"
      : !selectedJobId
        ? "job"
        : "";

  return (
    <div className="grid gap-4 xl:grid-cols-[340px_minmax(0,1fr)] xl:items-start">
      <section className="bauhaus-panel flex flex-col overflow-hidden bg-[var(--surface)] xl:h-[calc(100vh-9rem)]">
        <div className="space-y-3 border-b border-[var(--border)] p-4">
          <div className="flex items-baseline justify-between">
            <h2 className="text-[15px] font-semibold text-[var(--foreground)]">目标岗位</h2>
            {!showCapture && (
              <button
                type="button"
                onClick={() => setShowCapture(true)}
                className="flex items-center gap-1 text-xs font-semibold text-[var(--foreground-muted)] hover:text-[var(--foreground)]"
              >
                <ClipboardPaste size={12} /> 粘贴岗位
              </button>
            )}
          </div>
          {showCapture && <JobCaptureCard onCreated={handleJobCaptured} onClose={() => setShowCapture(false)} />}
          <Input
            size="sm"
            aria-label="搜索岗位"
            placeholder="搜索岗位、公司"
            value={keyword}
            onValueChange={setKeyword}
            startContent={<Search size={14} className="text-[var(--foreground-muted)]" />}
            classNames={bauhausFieldClassNames}
          />
          {(pools || []).length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              <button type="button" className={chipClass(poolFilter === "all")} onClick={() => setPoolFilter("all")}>全部</button>
              <button type="button" className={chipClass(poolFilter === "ungrouped")} onClick={() => setPoolFilter("ungrouped")}>未分组</button>
              {(pools || []).map((pool) => (
                <button key={pool.id} type="button" className={chipClass(poolFilter === pool.id)} onClick={() => setPoolFilter(pool.id)}>
                  {pool.name}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="min-h-[12rem] flex-1 overflow-y-auto p-2 custom-scrollbar" role="listbox" aria-label="目标岗位">
          {loadingJobs && visibleJobs.length === 0 ? (
            <div className="flex h-40 items-center justify-center gap-2 text-sm text-[var(--foreground-muted)]">
              <Spinner size="sm" color="warning" /> 正在加载岗位…
            </div>
          ) : jobsError ? (
            <p role="alert" className="p-4 text-sm text-[var(--primary-red)]">{jobsError}</p>
          ) : visibleJobs.length === 0 ? (
            <div className="space-y-3 p-2 text-sm text-[var(--foreground-muted)]">
              <p className="px-2">{keyword.trim() ? "没有匹配的岗位。" : "已筛选列表里还没有岗位。"}</p>
              {!showCapture && !keyword.trim() && <JobCaptureCard onCreated={handleJobCaptured} />}
              <Link href="/jobs" className="block px-2 text-xs font-semibold text-[var(--foreground)] underline">或去机会列表挑一个</Link>
            </div>
          ) : (
            visibleJobs.map((job) => {
              const checked = job.id === selectedJobId;
              const notPicked = job.id === seedJob?.id && !jobs.some((item) => item.id === job.id);
              return (
                <button
                  key={job.id}
                  type="button"
                  role="option"
                  aria-selected={checked}
                  onClick={() => setSelectedJobId(checked ? null : job.id)}
                  className={`mb-1 flex w-full items-start gap-3 rounded-[10px] px-3 py-2.5 text-left transition-colors ${
                    checked ? "bg-[var(--surface-muted)] ring-1 ring-[var(--foreground)]" : "hover:bg-[var(--surface-muted)]"
                  }`}
                >
                  <span
                    className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                      checked ? "border-[var(--foreground)] bg-[var(--foreground)] text-[var(--surface)]" : "border-[var(--border-strong)]"
                    }`}
                  >
                    {checked && <Check size={10} strokeWidth={3} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-[var(--foreground)]">{job.title}</span>
                    <span className="mt-0.5 block truncate text-xs text-[var(--foreground-muted)]">
                      {job.company}{job.location ? ` · ${job.location}` : ""}
                      {notPicked ? " · 来自岗位详情" : ""}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>

        <div className="space-y-2 border-t border-[var(--border)] p-4">
          <Select
            size="sm"
            aria-label="参考简历"
            label="参考简历（可选）"
            placeholder="不指定"
            selectedKeys={referenceResumeId ? [String(referenceResumeId)] : []}
            onSelectionChange={(keys) => {
              const raw = Array.from(keys)[0] as string | undefined;
              setReferenceResumeId(raw ? Number(raw) : null);
            }}
            classNames={{ ...bauhausSelectClassNames, base: "w-full" }}
          >
            {referenceResumes.map((resume) => (
              <SelectItem key={String(resume.id)}>{resume.title || `简历 #${resume.id}`}</SelectItem>
            ))}
          </Select>
          <p className="text-xs leading-relaxed text-[var(--foreground-muted)]">
            参考简历只影响措辞和版式；内容只用档案里已确认的事实，你接受提案后才会生成正式简历。
          </p>
        </div>
      </section>

      <section className="bauhaus-panel relative flex h-[calc(100vh-9rem)] min-h-[560px] flex-col overflow-hidden bg-[var(--surface)]">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--border)] px-5 py-3">
          <div className="min-w-0">
            <p className="text-xs text-[var(--foreground-muted)]">正在为这个岗位定制</p>
            <p className="truncate text-[15px] font-semibold text-[var(--foreground)]">
              {selectedJob ? `${selectedJob.title} · ${selectedJob.company}` : "还没有选择岗位"}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowConversationList(!showConversationList)}
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--border)] px-3 py-1.5 text-xs font-semibold text-[var(--foreground-muted)] hover:text-[var(--foreground)]"
          >
            <History size={13} />
            {showConversationList ? "返回当前对话" : "历史对话"}
          </button>
        </div>
        <div className="min-h-0 flex-1">
          {showColdStart ? (
            <ProfileColdStart
              verifiedCount={verifiedCount}
              onProfileChanged={() => mutateProfile()}
              onDone={() => setColdStartActive(false)}
            />
          ) : showConversationList ? (
            <ConversationList
              jobId={selectedJobId}
              onSelect={(runId) => {
                setLoadRunId(runId);
                setShowConversationList(false);
              }}
              onClose={() => setShowConversationList(false)}
            />
          ) : (
            <OptimizeChatPanel
              jobIds={selectedJobId ? [selectedJobId] : []}
              mode="per_job"
              disabled={Boolean(blockedReason)}
              blockedReason={blockedReason}
              profileId={profileData?.id ?? null}
              referenceResumeId={referenceResumeId}
              loadRunId={loadRunId}
              onLoadRunConsumed={() => setLoadRunId(null)}
            />
          )}
        </div>
      </section>
    </div>
  );
}
