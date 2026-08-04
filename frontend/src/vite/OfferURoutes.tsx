import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

const TodayPage = lazy(() => import("@/app/page"));
const JobsPage = lazy(() => import("@/app/jobs/page"));
const JobDetailPage = lazy(() => import("@/app/jobs/[id]/page"));
const ResumePage = lazy(() => import("@/app/resume/page"));
const ResumeDetailPage = lazy(() => import("@/app/resume/[id]/page"));
const ResumePrintPage = lazy(() => import("@/app/resume/print/[id]/page"));
const OptimizePage = lazy(() => import("@/app/optimize/page"));
const ApplicationsPage = lazy(() => import("@/app/applications/page"));
const InterviewPage = lazy(() => import("@/app/interview/page"));
const AIInterviewPage = lazy(() => import("@/app/interview/ai/page"));
const PoseInterviewPage = lazy(() => import("@/app/interview/pose/page"));
const CalendarPage = lazy(() => import("@/app/calendar/page"));
const EmailPage = lazy(() => import("@/app/email/page"));
const ProfilePage = lazy(() => import("@/app/profile/page"));
const SettingsPage = lazy(() => import("@/app/settings/page"));
const StudioPage = lazy(() => import("@/app/studio/page"));

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
        <Route path="/resume/:id" element={<ResumeDetailPage />} />
        <Route path="/resume/print/:id" element={<ResumePrintPage />} />
        <Route path="/optimize" element={<OptimizePage />} />
        <Route path="/applications" element={<ApplicationsPage />} />
        <Route path="/interview" element={<InterviewPage />} />
        <Route path="/interview/ai" element={<AIInterviewPage />} />
        <Route path="/interview/pose" element={<PoseInterviewPage />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/email" element={<EmailPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/studio" element={<StudioPage />} />
        <Route path="/agent" element={<Navigate replace to="/" />} />
        <Route path="/analytics" element={<Navigate replace to="/" />} />
        <Route path="/scraper" element={<Navigate replace to="/jobs" />} />
        <Route path="*" element={<Navigate replace to="/" />} />
      </Routes>
    </Suspense>
  );
}
