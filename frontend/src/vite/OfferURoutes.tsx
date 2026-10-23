import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { resumeModeHref, type ResumeMode } from "@/app/resume/resumeModes";

const TodayPage = lazy(() => import("@/app/page"));
const JobsPage = lazy(() => import("@/app/jobs/page"));
const JobDetailPage = lazy(() => import("@/app/jobs/[id]/page"));
const ResumeHub = lazy(() => import("@/app/resume/ResumeHub"));
const ResumeDetailPage = lazy(() => import("@/app/resume/[id]/page"));
const InterviewPage = lazy(() => import("@/app/interview/page"));
const InterviewReviewPage = lazy(() => import("@/app/interview/review/page"));
const AIInterviewPage = lazy(() => import("@/app/interview/ai/page"));
const PoseInterviewPage = lazy(() => import("@/app/interview/pose/page"));
const SettingsPage = lazy(() => import("@/app/settings/page"));

function RouteFallback() {
  return (
    <div className="grid min-h-[45vh] place-items-center">
      <p className="text-sm font-semibold text-[var(--foreground-muted)]">正在打开工作区…</p>
    </div>
  );
}

/** 旧入口 /optimize 合并进「简历」后的重定向，保留 job_ids 等参数。 */
function LegacyResumeRedirect({ mode }: { mode: ResumeMode }) {
  const { search } = useLocation();
  return <Navigate replace to={resumeModeHref(mode, search)} />;
}

export function OfferURoutes() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/" element={<TodayPage />} />
        <Route path="/jobs" element={<JobsPage />} />
        <Route path="/jobs/:id" element={<JobDetailPage />} />
        <Route path="/resume" element={<ResumeHub />} />
        <Route path="/resume/:id" element={<ResumeDetailPage />} />
        <Route path="/optimize" element={<LegacyResumeRedirect mode="tailor" />} />
        <Route path="/applications" element={<Navigate replace to="/jobs" />} />
        <Route path="/interview" element={<InterviewPage />} />
        <Route path="/interview/review" element={<InterviewReviewPage />} />
        <Route path="/interview/ai" element={<AIInterviewPage />} />
        <Route path="/interview/pose" element={<PoseInterviewPage />} />
        <Route path="/calendar" element={<Navigate replace to="/" />} />
        
        <Route path="/profile" element={<LegacyResumeRedirect mode="profile" />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/agent" element={<Navigate replace to="/" />} />
        <Route path="/analytics" element={<Navigate replace to="/" />} />
        <Route path="/scraper" element={<Navigate replace to="/jobs" />} />
        <Route path="*" element={<Navigate replace to="/" />} />
      </Routes>
    </Suspense>
  );
}
