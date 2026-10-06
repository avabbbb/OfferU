"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Spinner } from "@heroui/react";
import {
  type ArchiveTab,
  type PersonalArchive,
  type ResumeBasicInfo,
  createDefaultPersonalArchive,
  normalizePersonalArchiveFromProfile,
  computeArchiveCompleteness,
  applyResumeToApplicationSync,
  markApplicationOverride,
  clearApplicationOverride,
  getResumeArchive,
  getApplicationArchive,
  SHARED_ROOT_PATHS,
  sanitizePersonalArchive,
  buildProfileBaseInfoForSave,
} from "@/lib/personalArchive";
import { updateProfileData, useProfile, type ProfileImportResult } from "@/lib/hooks";
import { request } from "@/lib/api";
import { safeClientErrorMessage } from "@/lib/safe-error";
import ArchiveIntroCard from "./components/archive/ArchiveIntroCard";
import ArchiveTabsHeader, {
  type ProfileArchiveView,
} from "./components/archive/ArchiveTabsHeader";
import ArchiveSettingsDialog from "./components/archive/ArchiveSettingsDialog";
import ResumeArchiveEditor from "./components/archive/ResumeArchiveEditor";
import ApplicationArchiveEditor from "./components/archive/ApplicationArchiveEditor";
import { ProfileOnboarding } from "./components/ProfileOnboarding";
import ProfileOverview from "./components/ProfileOverview";
import AIImportModal from "./components/AIImportModal";
import CareerLedgerPanel from "./components/archive/CareerLedgerPanel";
import CareerDiscoveryCard, {
  type CareerBriefing,
  type CareerSnapshot,
  type CareerStageAssessment,
} from "./components/CareerDiscoveryCard";

type CareerDiscoveryTaskResult = {
  task_id: string;
  status: "queued" | "running" | "completed" | "failed" | "blocked" | "cancelled";
  result?: { briefing?: CareerBriefing };
  error?: string;
};

export default function ProfilePage() {
  const { data: profile, mutate, isLoading } = useProfile();

  const [archive, setArchive] = useState<PersonalArchive>(createDefaultPersonalArchive);
  const [activeView, setActiveView] = useState<ProfileArchiveView>("overview");
  const [focusSection, setFocusSection] = useState<string | undefined>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [aiImportOpen, setAiImportOpen] = useState(false);
  const [careerSnapshot, setCareerSnapshot] = useState<CareerSnapshot | null>(null);
  const [careerBriefing, setCareerBriefing] = useState<CareerBriefing | null>(null);
  const [careerDiscoveryStatus, setCareerDiscoveryStatus] = useState<"idle" | "queued" | "running" | "completed" | "failed">("idle");
  const [careerDiscoveryError, setCareerDiscoveryError] = useState("");
  const [careerDiscoveryTaskId, setCareerDiscoveryTaskId] = useState("");

  const lastProfileArchiveUpdatedAtRef = useRef("");
  const archiveDirtyRef = useRef(false);

  // Sync archive from profile data
  useEffect(() => {
    if (!profile) return;
    const fromProfile = normalizePersonalArchiveFromProfile(profile);
    const incomingStamp = fromProfile.updatedAt || String(profile.updated_at || "");
    lastProfileArchiveUpdatedAtRef.current = incomingStamp;
    if (!archiveDirtyRef.current) {
      setArchive(fromProfile);
    }
  }, [profile]);

  useEffect(() => {
    if (!profile?.id) return;
    let active = true;
    request<CareerSnapshot>("/api/profile/career-snapshot")
      .then((snapshot) => {
        if (active) setCareerSnapshot(snapshot);
      })
      .catch((err) => {
        if (active) setCareerDiscoveryError(safeClientErrorMessage(err, "暂时无法读取档案信息"));
      });
    request<{ tasks: CareerDiscoveryTaskResult[] }>(
      `/api/agent/runtime/career-tasks?task_type=career_director&target_type=profile&target_id=${encodeURIComponent(String(profile.id))}&limit=10`,
    )
      .then(({ tasks }) => {
        if (!active || !tasks.length) return;
        const latest = tasks[0];
        if ((latest.status === "queued" || latest.status === "running") && latest.task_id) {
          setCareerDiscoveryTaskId(latest.task_id);
          setCareerDiscoveryStatus(latest.status);
        } else if (latest.status === "completed" && latest.result?.briefing) {
          setCareerBriefing(latest.result.briefing);
          setCareerDiscoveryStatus("completed");
          setCareerDiscoveryTaskId(latest.task_id);
        } else if (["failed", "blocked", "cancelled"].includes(latest.status)) {
          setCareerDiscoveryStatus("failed");
          setCareerDiscoveryError(latest.error || "上次分析没有完成，可以重试。");
        }
      })
      .catch((err) => {
        if (active) setCareerDiscoveryError(safeClientErrorMessage(err, "暂时无法读取最近一次分析"));
      });
    return () => { active = false; };
  }, [profile?.id]);

  useEffect(() => {
    if (!careerDiscoveryTaskId) return;
    let active = true;
    let timer: number | undefined;
    const stopPolling = () => {
      if (timer !== undefined) window.clearInterval(timer);
    };
    const poll = async () => {
      try {
        const task = await request<CareerDiscoveryTaskResult>(
          `/api/agent/runtime/career-tasks/${encodeURIComponent(careerDiscoveryTaskId)}/result`,
        );
        if (!active) return;
        if (task.status === "queued" || task.status === "running") {
          setCareerDiscoveryStatus(task.status);
          return;
        }
        if (task.status === "completed" && task.result?.briefing) {
          setCareerBriefing(task.result.briefing);
          setCareerDiscoveryStatus("completed");
          setCareerDiscoveryError("");
          stopPolling();
          return;
        }
        setCareerDiscoveryStatus("failed");
        setCareerDiscoveryError(task.error || "分析未能完成，可以重试。 ");
        stopPolling();
      } catch (err) {
        if (!active) return;
        setCareerDiscoveryStatus("failed");
        setCareerDiscoveryError(safeClientErrorMessage(err, "暂时无法读取分析结果"));
        stopPolling();
      }
    };
    void poll();
    timer = window.setInterval(() => { void poll(); }, 1200);
    return () => {
      active = false;
      stopPolling();
    };
  }, [careerDiscoveryTaskId]);

  const startCareerDiscovery = async () => {
    if (!profile?.id) return;
    setCareerDiscoveryStatus("queued");
    setCareerDiscoveryError("");
    setCareerBriefing(null);
    try {
      const attemptKey = crypto.randomUUID();
      const event = await request<{
        result?: { task?: { task_id?: string } };
        status?: string;
        error?: string;
      }>("/api/profile/career-discovery/start", {
        method: "POST",
        body: JSON.stringify({ profile_id: profile.id, attempt_key: attemptKey }),
      });
      const taskId = String(event.result?.task?.task_id || "");
      if (!taskId) {
        setCareerDiscoveryStatus("failed");
        setCareerDiscoveryError(event.error || "没有成功排入分析任务，请稍后重试。");
        return;
      }
      setCareerDiscoveryTaskId(taskId);
    } catch (err) {
      setCareerDiscoveryStatus("failed");
      setCareerDiscoveryError(safeClientErrorMessage(err, "无法开始职业方向分析"));
    }
  };

  const refreshCareerSnapshot = async () => {
    try {
      const snapshot = await request<CareerSnapshot>("/api/profile/career-snapshot");
      setCareerSnapshot(snapshot);
      setCareerDiscoveryError("");
    } catch (err) {
      setCareerDiscoveryError(safeClientErrorMessage(err, "暂时无法读取档案信息"));
    }
  };

  const correctCareerStage = async (stage: Pick<CareerStageAssessment, "track" | "substage">) => {
    try {
      const result = await request<{ snapshot: CareerSnapshot }>("/api/profile/career-stage/correction", {
        method: "POST",
        body: JSON.stringify(stage),
      });
      setCareerSnapshot(result.snapshot);
      await mutate();
      setNotice("已按你的选择更新职业阶段");
    } catch (err) {
      setCareerDiscoveryError(safeClientErrorMessage(err, "无法保存职业阶段更正"));
      setCareerDiscoveryStatus("failed");
    }
  };

  const metrics = useMemo(() => computeArchiveCompleteness(archive), [archive]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 5500);
    return () => clearTimeout(timer);
  }, [notice]);

  // === Save ===
  const handleSave = async () => {
    try {
      setSaving(true);
      setError("");
      const sanitized = sanitizePersonalArchive(archive);
      const baseInfoPayload = buildProfileBaseInfoForSave(profile?.base_info_json, sanitized);
      await updateProfileData({
        name: sanitized.resumeArchive.basicInfo.name || "默认档案",
        base_info_json: { ...(profile?.base_info_json || {}), ...baseInfoPayload },
      });
      archiveDirtyRef.current = false;
      await mutate();
      setCareerBriefing(null);
      await refreshCareerSnapshot();
      setNotice("档案已保存");
    } catch (err: any) {
      setError(safeClientErrorMessage(err, "保存失败"));
    } finally {
      setSaving(false);
    }
  };

  // === Import ===
  const triggerImport = () => {
    setAiImportOpen(true);
  };

  const handleAiImport = (result: ProfileImportResult) => {
    const importedBase = result.base_info || {};
    const importedBaseInfo = {
      ...(profile?.base_info_json || {}),
      personal_archive: undefined,
      ...importedBase,
    };
    const rawArchive = normalizePersonalArchiveFromProfile({
      ...profile,
      name: importedBase.name || profile?.name || "",
      base_info_json: importedBaseInfo,
      sections: result.bullets?.map((b: any) => ({
        ...b,
        category_key: b.section_type,
        category_label: "",
        title: b.title || "",
        content_json: b.content_json || {},
        confidence: b.confidence ?? 0.7,
        source: "ai_import",
      })) || [],
    } as any);
    rawArchive.resumeArchive.basicInfo = {
      ...rawArchive.resumeArchive.basicInfo,
      name: importedBase.name || rawArchive.resumeArchive.basicInfo.name,
      phone: importedBase.phone || rawArchive.resumeArchive.basicInfo.phone,
      email: importedBase.email || rawArchive.resumeArchive.basicInfo.email,
      currentCity: importedBase.current_city || rawArchive.resumeArchive.basicInfo.currentCity,
      jobIntention: importedBase.job_intention || rawArchive.resumeArchive.basicInfo.jobIntention,
      website: importedBase.website || rawArchive.resumeArchive.basicInfo.website,
      github: importedBase.github || rawArchive.resumeArchive.basicInfo.github,
    };

    const importedSummary = importedBase.summary || importedBase.personal_summary;
    if (importedSummary && !rawArchive.resumeArchive.personalSummary) {
      rawArchive.resumeArchive.personalSummary = importedSummary;
    }

    const syncedArchive = applyResumeToApplicationSync(rawArchive, [...SHARED_ROOT_PATHS], true).nextArchive;
    archiveDirtyRef.current = true;
    setArchive(syncedArchive);
    setNotice("已导入 AI 解析结果");
  };

  const handleOpenView = (view: ArchiveTab, section?: string) => {
    setActiveView(view);
    setFocusSection(section);
  };

  // === Sync ===
  const handleOneClickSync = () => {
    try {
      setSyncing(true);
      setError("");
      const { nextArchive, syncedPaths } = applyResumeToApplicationSync(archive, [...SHARED_ROOT_PATHS]);
      archiveDirtyRef.current = true;
      setArchive(nextArchive);
      setNotice(syncedPaths.length > 0 ? `已同步 ${syncedPaths.length} 个字段` : "无需同步");
    } catch (err: any) {
      setError(safeClientErrorMessage(err, "同步失败"));
    } finally {
      setSyncing(false);
    }
  };

  // === Override ===
  const handleToggleOverride = (path: string, enabled: boolean) => {
    archiveDirtyRef.current = true;
    setArchive((prev) =>
      enabled ? markApplicationOverride(prev, path) : clearApplicationOverride(prev, path)
    );
  };

  const handleRequestEditShared = (path: string) => {
    setActiveView("resume");
    setFocusSection(path);
  };

  const handleUpdateBasicInfo = (field: keyof ResumeBasicInfo, value: string) => {
    archiveDirtyRef.current = true;
    setArchive((prev) => {
      const next: PersonalArchive = {
        ...prev,
        updatedAt: new Date().toISOString(),
        resumeArchive: {
          ...prev.resumeArchive,
          basicInfo: {
            ...prev.resumeArchive.basicInfo,
            [field]: value,
          },
        },
      };
      if (!next.syncSettings.autoSyncEnabled) return next;
      return applyResumeToApplicationSync(next, [`basicInfo.${field}`]).nextArchive;
    });
  };

  // === Loading ===
  if (isLoading && !profile) {
    return (
      <div className="grid h-[70vh] place-items-center">
        <div className="bauhaus-panel flex items-center gap-3 bg-white px-6 py-5 text-sm font-medium text-[var(--foreground-muted)]">
          <Spinner color="warning" />
          <span>正在加载档案...</span>
        </div>
      </div>
    );
  }

  const activeTab: ArchiveTab = activeView === "application" ? "application" : "resume";
  const missingSections = activeTab === "resume"
    ? metrics.missingResumeSectionKeys
    : metrics.missingApplicationSectionKeys;

  return (
    <div className="mx-auto max-w-[1080px] space-y-4 pb-8">
      {/* AI Import Modal */}
      <AIImportModal
        open={aiImportOpen}
        onClose={() => setAiImportOpen(false)}
        onImport={handleAiImport}
      />

      {showOnboarding && (
        <ProfileOnboarding
          currentArchive={archive}
          profile={profile}
          onClose={() => setShowOnboarding(false)}
          onComplete={async (nextArchive) => {
            archiveDirtyRef.current = false;
            setArchive(nextArchive);
            setShowOnboarding(false);
            await mutate();
            setNotice("新人投递档案已生成，可以开始继续补细节或直接制作简历。");
          }}
        />
      )}

      {/* Header */}
      <ArchiveIntroCard
        name={archive.resumeArchive.basicInfo.name}
        jobIntention={archive.resumeArchive.basicInfo.jobIntention}
        updatedAt={archive.updatedAt}
        onImport={triggerImport}
        onOnboarding={() => setShowOnboarding(true)}
        onSave={handleSave}
        saving={saving}
      />

      <CareerDiscoveryCard
        snapshot={careerSnapshot}
        briefing={careerBriefing}
        status={careerDiscoveryStatus}
        error={careerDiscoveryError}
        onStart={() => { void startCareerDiscovery(); }}
        onRefresh={() => { void refreshCareerSnapshot(); }}
        onCorrect={(stage) => { void correctCareerStage(stage); }}
        taskId={careerDiscoveryTaskId || undefined}
        onAnswered={() => { void Promise.all([mutate(), refreshCareerSnapshot()]); }}
      />

      <ArchiveTabsHeader
        activeView={activeView}
        onViewChange={(view) => {
          setActiveView(view);
          setFocusSection(undefined);
        }}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {/* Error / Notice */}
      {error && (
        <div className="rounded-md bg-[var(--status-blush)] px-3 py-2 text-[12.5px] font-medium text-[var(--primary-red)]">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-md bg-[var(--status-sage)] px-3 py-2 text-[12.5px] font-medium text-[var(--primary-green)]">
          {notice}
        </div>
      )}

      {activeView === "overview" ? (
        <ProfileOverview
          archive={archive}
          metrics={metrics}
          onOpenView={handleOpenView}
          onStartOnboarding={() => setShowOnboarding(true)}
          onUpdateBasicInfo={handleUpdateBasicInfo}
          onSave={handleSave}
        />
      ) : activeView === "ledger" ? (
        <CareerLedgerPanel />
      ) : activeView === "resume" ? (
        <ResumeArchiveEditor
          value={getResumeArchive(archive)}
          focusSection={focusSection}
          missingSections={missingSections}
          saving={saving}
          onChange={(nextResume, changedPaths) => {
            archiveDirtyRef.current = true;
            setArchive((prev) => ({
              ...prev,
              updatedAt: new Date().toISOString(),
              resumeArchive: nextResume,
            }));
            if (archive.syncSettings.autoSyncEnabled && changedPaths.length > 0) {
              // Auto-sync in background
              const synced = applyResumeToApplicationSync({
                ...archive,
                resumeArchive: nextResume,
              }, changedPaths);
              if (synced.syncedPaths.length > 0) {
                archiveDirtyRef.current = true;
                setArchive(synced.nextArchive);
                return;
              }
            }
          }}
          onSaveItem={handleSave}
        />
      ) : (
        <ApplicationArchiveEditor
          value={getApplicationArchive(archive)}
          resumeArchive={getResumeArchive(archive)}
          overriddenPaths={archive.syncSettings.overriddenFieldPaths}
          focusSection={focusSection}
          missingSections={missingSections}
          saving={saving}
          onChange={(nextApp) => {
            archiveDirtyRef.current = true;
            setArchive((prev) => ({
              ...prev,
              updatedAt: new Date().toISOString(),
              applicationArchive: nextApp,
            }));
          }}
          onToggleOverride={handleToggleOverride}
          onRequestEditSharedModule={handleRequestEditShared}
          onSaveItem={handleSave}
        />
      )}

      {/* Settings Dialog */}
      <ArchiveSettingsDialog
        open={settingsOpen}
        autoSyncEnabled={archive.syncSettings.autoSyncEnabled}
        onClose={() => setSettingsOpen(false)}
        onAutoSyncChange={(next) =>
          {
            archiveDirtyRef.current = true;
            setArchive((prev) => ({
              ...prev,
              syncSettings: { ...prev.syncSettings, autoSyncEnabled: next },
            }));
          }
        }
        onOneClickSync={handleOneClickSync}
        syncing={syncing}
      />
    </div>
  );
}
