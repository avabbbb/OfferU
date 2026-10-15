// 简历的两种模式。/optimize 与 /studio 旧入口都重定向到这里（版式已并进每份简历的「排版」面板），
// 这样外部书签、岗位页里的旧链接都不会坏。
export type ResumeMode = "list" | "tailor";

export const RESUME_MODES: Array<{ id: ResumeMode; label: string; hint: string }> = [
  { id: "list", label: "我的简历", hint: "所有简历版本都在这里。点开任意一份，直接在纸面上修改；换模板、字体、主题色在右侧「排版」里。" },
  { id: "tailor", label: "岗位定制", hint: "选一个岗位，AI 只用你档案里已确认的事实提出修改，你逐条决定，原稿不会被覆盖。" },
];

export function parseResumeMode(value: string | null | undefined): ResumeMode {
  return value === "tailor" ? value : "list";
}

/** 生成某个模式的地址，保留其它查询参数（如 job_ids）。 */
export function resumeModeHref(mode: ResumeMode, search: string | URLSearchParams = ""): string {
  const params = new URLSearchParams(search);
  if (mode === "list") params.delete("mode");
  else params.set("mode", mode);
  if (mode !== "tailor") params.delete("job_ids");
  const query = params.toString();
  return query ? `/resume?${query}` : "/resume";
}

/** 岗位定制的直达地址：从岗位页、Today、命令面板跳转都用它。 */
export function tailorResumeHref(jobIds: Array<number | string> = []): string {
  const ids = jobIds.map(String).filter(Boolean);
  return ids.length ? `/resume?mode=tailor&job_ids=${ids.join(",")}` : "/resume?mode=tailor";
}
