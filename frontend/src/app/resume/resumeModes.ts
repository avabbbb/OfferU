// 简历的两种模式。旧的 /optimize 入口重定向到这里，
// 这样外部书签、岗位页里的旧链接都不会坏。
export type ResumeMode = "list" | "tailor" | "profile";

export const RESUME_MODES: Array<{ id: ResumeMode; label: string; hint: string }> = [
  { id: "list", label: "我的简历", hint: "所有简历版本都在这里。点开任意一份，直接在纸面上修改；换模板、字体、主题色在右侧「排版」里。" },
  { id: "tailor", label: "岗位定制", hint: "选一个岗位，AI 只用你档案里已确认的事实提出修改，你逐条决定，原稿不会被覆盖。" },
  { id: "profile", label: "档案", hint: "你的经历、技能和证据。AI 写简历、做定制时只用这里确认过的事实。" },
];

export function parseResumeMode(value: string | null | undefined): ResumeMode {
  return value === "tailor" || value === "profile" ? value : "list";
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
