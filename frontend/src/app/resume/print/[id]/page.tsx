"use client";

import { useParams } from "next/navigation";
import { Render } from "@puckeditor/core";
import "@puckeditor/core/puck.css";
import { useResume } from "@/lib/hooks";
import {
  migrateResumeToPuck,
  type PuckResumeData,
} from "@/lib/puckMigration";
import { puckConfig } from "../../components/puckComponents";
import {
  DEFAULT_STYLE_CONFIG,
  styleConfigToCSSVars,
  type StyleConfig,
} from "../../components/StyleToolbar";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

function prefixUrl(u?: string): string {
  if (!u) return "";
  return u.startsWith("/") ? `${API_BASE}${u}` : u;
}

function withAbsolutePhoto(data: PuckResumeData): PuckResumeData {
  return {
    ...data,
    content: data.content.map((unit) =>
      unit.type === "Header"
        ? {
            ...unit,
            props: {
              ...unit.props,
              photoUrl: prefixUrl(unit.props.photoUrl),
            },
          }
        : unit
    ),
  };
}

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

  const styleConfig: StyleConfig = {
    ...DEFAULT_STYLE_CONFIG,
    ...((resume.style_config as StyleConfig | undefined) ?? {}),
  };
  const puckData = withAbsolutePhoto(migrateResumeToPuck(resume));

  return (
    <div className="resume-print-page-shell" data-offeru-print-ready="true">
      <div
        className="resume-print"
        style={{
          background: "#ffffff",
          ...styleConfigToCSSVars(styleConfig),
        }}
      >
        <Render config={puckConfig} data={puckData} />
      </div>
    </div>
  );
}
