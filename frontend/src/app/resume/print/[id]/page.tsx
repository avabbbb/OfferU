"use client";

import { useParams } from "next/navigation";
import { useResume } from "@/lib/hooks";
import ResumePreview from "../../components/ResumePreview";

export default function ResumePrintPage() {
  const params = useParams();
  const resumeId = Number(params.id);
  const { data: resume, error } = useResume(resumeId);

  if (error) {
    return <div className="resume-print p-6 text-sm text-red-700" data-offeru-print-state="error">Resume failed to load.</div>;
  }
  if (!resume) {
    return <div className="resume-print p-6 text-sm text-[var(--foreground)]" data-offeru-print-state="loading">Loading resume...</div>;
  }

  return (
    <div className="resume-print-page-shell" data-offeru-print-ready="true">
      <div className="resume-print" style={{ background: "#ffffff" }}>
        <ResumePreview
          userName={resume.user_name}
          title={resume.title}
          photoUrl={resume.photo_url}
          summary={resume.summary}
          contactJson={resume.contact_json || {}}
          sections={resume.sections}
          styleConfig={resume.style_config || {}}
        />
      </div>
    </div>
  );
}
