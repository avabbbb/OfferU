"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Spinner } from "@nextui-org/react";
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
      setNotice("档案已保存");
    } catch (err: any) {
      setError(err.message || "保存失败");
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
      setError(err.message || "同步失败");
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
