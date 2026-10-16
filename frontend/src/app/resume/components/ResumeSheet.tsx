"use client";

import { forwardRef, memo, useMemo } from "react";
import { ResumePaper, resolvePaperTone, type PaperSection, type ResumePaperProps } from "./templates/ResumePaper";
import { normalizeTemplateSettings, settingsToCssVars } from "./templates/templateSettings";
import { resolveApiBase } from "@/lib/apiBase";

/**
 * 一张简历纸：编辑器、缩略图、打印/导出 PDF 共用这一个组件，所以画布上看到的就是导出的样子。
 */
export interface ResumeSheetProps {
  userName: string;
  title?: string;
  photoUrl: string;
  summary: string;
  contactJson: Record<string, string>;
  sections: PaperSection[];
  styleConfig: Record<string, string>;
  editable?: boolean;
  onProfileChange?: ResumePaperProps["onProfileChange"];
  onSectionChange?: ResumePaperProps["onSectionChange"];
  onUploadAsset?: ResumePaperProps["onUploadAsset"];
}

const LOGO_KEYS = ["schoolLogoUrl", "universityLogoUrl", "logoUrl", "school_logo_url"];

function assetUrl(url?: string) {
  if (!url) return "";
  return url.startsWith("/") ? `${resolveApiBase()}${url}` : url;
}

/** Kami 的今楷由后端下载一次后从本地数据目录提供。 */
function ensureKamiFont() {
  if (typeof document === "undefined" || document.getElementById("offeru-kami-font")) return;
  const base = `${resolveApiBase()}/api/resume/assets/fonts`;
  const style = document.createElement("style");
  style.id = "offeru-kami-font";
  style.textContent = [["W04", 400], ["W05", 500]].map(([file, weight]) => `@font-face { font-family: "TsangerJinKai02"; font-style: normal; font-weight: ${weight}; font-display: swap; src: url("${base}/TsangerJinKai02-${file}.ttf") format("truetype"); }`).join("\n");
  document.head.appendChild(style);
}

const ResumeSheet = forwardRef<HTMLDivElement, ResumeSheetProps>(function ResumeSheet(props, ref) {
  const style = props.styleConfig || {};
  const cssVars = useMemo(() => settingsToCssVars(normalizeTemplateSettings(style)), [style]);
  const kami = style.paperStyle === "kami";
  const kai = kami && style.paperFont === "kai";
  if (kai) ensureKamiFont();
  const contact = props.contactJson || {};
  const logo = LOGO_KEYS.map((key) => contact[key]).find(Boolean);
  const classes = ["resume-body", "paper", resolvePaperTone(style) === "white" ? "paper-tone-white" : "", kai ? "paper-font-kai" : "", kami ? "" : "paper-style-cv"].filter(Boolean).join(" ");
  return (
    <div className="resume-sheet inline-block">
      <div ref={ref} className={classes} data-page-size={style.pageSize === "LETTER" ? "LETTER" : "A4"} style={cssVars}>
        <ResumePaper
          userName={props.userName}
          title={props.title || contact.headline || ""}
          summary={props.summary}
          contactJson={contact}
          sections={props.sections}
          styleConfig={style}
          editable={props.editable}
          onProfileChange={props.onProfileChange}
          onSectionChange={props.onSectionChange}
          photoUrl={assetUrl(props.photoUrl)}
          logoUrl={assetUrl(logo)}
          onUploadAsset={props.editable ? props.onUploadAsset : undefined}
        />
      </div>
    </div>
  );
});

export default memo(ResumeSheet);
