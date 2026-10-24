import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

const TodayPage = lazy(() => import("@/app/page"));
const JobsPage = lazy(() => import("@/app/jobs/page"));
const JobDetailPage = lazy(() => import("@/app/jobs/[id]/page"));
const ResumePage = lazy(() => import("@/app/resume/page"));
const ProfilePage = lazy(() => import("@/app/profile/page"));
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

export function OfferURoutes() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/" element={<TodayPage />} />
        <Route path="/jobs" element={<JobsPage />} />
        <Route path="/jobs/:id" element={<JobDetailPage />} />
        <Route path="/resume" element={<ResumePage />} />
        <Route path="/resume/:id" element={<ResumePage />} />
        <Route path="/optimize" element={<Navigate replace to="/resume" />} />
        <Route path="/applications" element={<Navigate replace to="/jobs" />} />
        <Route path="/interview" element={<InterviewPage />} />
        <Route path="/interview/review" element={<InterviewReviewPage />} />
        <Route path="/interview/ai" element={<AIInterviewPage />} />
        <Route path="/interview/pose" element={<PoseInterviewPage />} />
        <Route path="/calendar" element={<Navigate replace to="/" />} />
        
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/agent" element={<Navigate replace to="/" />} />
        <Route path="/analytics" element={<Navigate replace to="/" />} />
        <Route path="/scraper" element={<Navigate replace to="/jobs" />} />
        <Route path="*" element={<Navigate replace to="/" />} />
      </Routes>
    </Suspense>
  );
}
