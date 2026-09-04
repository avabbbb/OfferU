import type {
  ClipboardCopyResponse,
  ExtractedJob,
  Message,
  PageAgentCollectViaResponse,
  RemoveResponse,
  ResumeDetail,
  ResumeListItem,
  SmartFillAiSettings,
  StatusResponse,
  SyncResponse,
} from "./types.js";
import {
  DEFAULT_OFFERU_FRONTEND_PORT,
  DEFAULT_OFFERU_FRONTEND_URL,
  DEFAULT_OFFERU_SERVER_URL,
  normalizeOfferUFrontendPort,
  normalizeOfferUServerUrl,
} from "./background/server-url.js";
import { safeExtensionError } from "./lib/safe-error.js";

type MessageType = "success" | "error" | "info";
type TabKey = "cart" | "resumes" | "settings";
type ResumeSortMode = "updated" | "title";
type UiTheme = "light" | "dark" | "system";
type DesktopOpenMode = "docker" | "app";
type TimeRangeFilter = "all" | "7d" | "30d" | "90d" | "custom";
type JobPlatformFilter = "all" | ExtractedJob["source"] | "other";
type JobSalaryFilter =
  | "all"
  | "day_lt_100"
  | "day_100_200"
  | "day_200_300"
  | "day_gt_300"
  | "month_lt_8k"
  | "month_8k_15k"
  | "month_15k_25k"
  | "month_gt_25k";

const queryParams = new URLSearchParams(window.location.search);
const EMBED_MODE = queryParams.get("embed") === "drawer";
const DRAWER_CLOSE_REASON_BUTTON = "close-button";

if (EMBED_MODE) {
  document.documentElement.dataset.embed = "drawer";
}

interface ResumeFilterState {
  time: TimeRangeFilter;
  startDate: string;
  endDate: string;
}

interface JobFilterState {
  time: TimeRangeFilter;
  startDate: string;
  endDate: string;
  platform: JobPlatformFilter;
  salary: JobSalaryFilter;
  city: string;
}

interface PopupUiSettings {
  autoSync: boolean;
  copyAndDownloadPng: boolean;
  theme: UiTheme;
}

interface ShortcutSettings {
  collect: string;
  sync: string;
  settings: string;
}

interface DesktopOpenSettings {
  mode: DesktopOpenMode;
  dockerPort: string;
  appPath: string;
}

interface CollectFromPageResponse {
  ok: boolean;
  message: string;
  added: number;
  upgraded: number;
  skipped: number;
}

const DEFAULT_SERVER_URL = DEFAULT_OFFERU_SERVER_URL;
const RESUME_IMAGE_EXPORT_SCALE = 1.2;
const RESUME_THUMB_PREFETCH_LIMIT = 1;
const SETTINGS_KEY = "settings";
const JOBS_KEY = "collectedJobs";
const UI_SETTINGS_KEY = "popupUiSettings";
const SHORTCUT_SETTINGS_KEY = "shortcutSettingsV1";
const DESKTOP_OPEN_SETTINGS_KEY = "desktopOpenSettingsV1";
const DEFAULT_DOCKER_PORT = DEFAULT_OFFERU_FRONTEND_PORT;

const DEFAULT_UI_SETTINGS: PopupUiSettings = {
  autoSync: true,
  copyAndDownloadPng: false,
  theme: "light",
};

const DEFAULT_SHORTCUT_SETTINGS: ShortcutSettings = {
  collect: "Alt+J",
  sync: "Alt+S",
  settings: "Alt+O",
};

const DEFAULT_DESKTOP_OPEN_SETTINGS: DesktopOpenSettings = {
  mode: "docker",
  dockerPort: DEFAULT_DOCKER_PORT,
  appPath: "",
};

const DEFAULT_SMART_FILL_SETTINGS: SmartFillAiSettings = {
  enabled: false,
  provider: "openai-compatible",
  baseUrl: "",
  apiKey: "",
  model: "",
  enableFallback: true,
};

const SOURCE_LABELS: Record<ExtractedJob["source"], string> = {
  boss: "Boss",
  liepin: "猎聘",
  zhaopin: "智联",
  shixiseng: "实习僧",
  linkedin: "LinkedIn",
  unknown: "平台",
};

const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".tab-btn"));
const tabPanels = Array.from(document.querySelectorAll<HTMLElement>(".tab-panel"));
const topbarEl = document.querySelector(".topbar") as HTMLElement | null;

const messageEl = document.getElementById("message") as HTMLDivElement;

const cartTotalBadgeEl = document.getElementById("cartTotalBadge") as HTMLSpanElement;
const readyCountInlineEl = document.getElementById("readyCountInline") as HTMLSpanElement;
const draftCountInlineEl = document.getElementById("draftCountInline") as HTMLSpanElement;
const cartFilterBtn = document.getElementById("cartFilterBtn") as HTMLButtonElement;
const clearBtn = document.getElementById("clearBtn") as HTMLButtonElement;
const addCurrentBtn = document.getElementById("addCurrentBtn") as HTMLButtonElement;
const syncBtn = document.getElementById("syncBtn") as HTMLButtonElement;
const jobListEl = document.getElementById("jobList") as HTMLDivElement;

const resumeTotalBadgeEl = document.getElementById("resumeTotalBadge") as HTMLSpanElement;
const resumeSearchToggleBtn = document.getElementById("resumeSearchToggleBtn") as HTMLButtonElement;
const resumeSortBtn = document.getElementById("resumeSortBtn") as HTMLButtonElement;
const resumeSearchRow = document.getElementById("resumeSearchRow") as HTMLDivElement;
const resumeSearchInput = document.getElementById("resumeSearchInput") as HTMLInputElement;
const resumeSearchClearBtn = document.getElementById("resumeSearchClearBtn") as HTMLButtonElement;
const resumeFilterWrap = document.getElementById("resumeFilterWrap") as HTMLDivElement;
const resumeTimeFilter = document.getElementById("resumeTimeFilter") as HTMLSelectElement;
const resumeCustomRange = document.getElementById("resumeCustomRange") as HTMLDivElement;
const resumeDateStartInput = document.getElementById("resumeDateStart") as HTMLInputElement;
const resumeDateEndInput = document.getElementById("resumeDateEnd") as HTMLInputElement;
const resumeResetFilterBtn = document.getElementById("resumeResetFilterBtn") as HTMLButtonElement;
const resumeListEl = document.getElementById("resumeList") as HTMLDivElement;
const previewResumeBtn = document.getElementById("previewResumeBtn") as HTMLButtonElement;
const copySelectedResumeBtn = document.getElementById("copySelectedResumeBtn") as HTMLButtonElement;
const openDesktopResumeBtn = document.getElementById("openDesktopResumeBtn") as HTMLButtonElement;

const jobTimeFilter = document.getElementById("jobTimeFilter") as HTMLSelectElement;
const jobFilterWrap = document.getElementById("jobFilterWrap") as HTMLDivElement;
const jobCustomRange = document.getElementById("jobCustomRange") as HTMLDivElement;
const jobDateStartInput = document.getElementById("jobDateStart") as HTMLInputElement;
const jobDateEndInput = document.getElementById("jobDateEnd") as HTMLInputElement;
const jobPlatformFilter = document.getElementById("jobPlatformFilter") as HTMLSelectElement;
const jobSalaryFilter = document.getElementById("jobSalaryFilter") as HTMLSelectElement;
const jobCityFilter = document.getElementById("jobCityFilter") as HTMLInputElement;
const jobHotCityRow = document.getElementById("jobHotCityRow") as HTMLDivElement;
const jobResetFilterBtn = document.getElementById("jobResetFilterBtn") as HTMLButtonElement;

const autoSyncToggle = document.getElementById("autoSyncToggle") as HTMLInputElement;
const copyAndDownloadPngToggle = document.getElementById("copyAndDownloadPngToggle") as HTMLInputElement;
const shortcutButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>(".shortcut-btn[data-shortcut-action]"),
);
let themeButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>("#themeSegment .segment-btn[data-theme]"),
);
const serverUrlInput = document.getElementById("serverUrl") as HTMLInputElement;
const saveSettingsBtn = document.getElementById("saveSettingsBtn") as HTMLButtonElement;
const checkServerBtn = document.getElementById("checkServerBtn") as HTMLButtonElement;
const serviceStatusDotEl = document.getElementById("serviceStatusDot") as HTMLSpanElement;
const serviceStatusEl = document.getElementById("serviceStatus") as HTMLSpanElement;
const aiSmartFillToggle = document.getElementById("aiSmartFillToggle") as HTMLInputElement;
const aiProviderSelect = document.getElementById("aiProviderSelect") as HTMLSelectElement;
const aiBaseUrlInput = document.getElementById("aiBaseUrlInput") as HTMLInputElement;
const aiApiKeyInput = document.getElementById("aiApiKeyInput") as HTMLInputElement;
const aiModelInput = document.getElementById("aiModelInput") as HTMLInputElement;
const aiFallbackToggle = document.getElementById("aiFallbackToggle") as HTMLInputElement;
const saveAiSettingsBtn = document.getElementById("saveAiSettingsBtn") as HTMLButtonElement;
const checkAiConnectionBtn = document.getElementById("checkAiConnectionBtn") as HTMLButtonElement;
const aiServiceStatusDotEl = document.getElementById("aiServiceStatusDot") as HTMLSpanElement;
const aiServiceStatusEl = document.getElementById("aiServiceStatus") as HTMLSpanElement;
const feedbackBtn = document.getElementById("feedbackBtn") as HTMLButtonElement;
const checkUpdateBtn = document.getElementById("checkUpdateBtn") as HTMLButtonElement;
const updateStatusTextEl = document.getElementById("updateStatusText") as HTMLParagraphElement;

const openServerBtn = document.getElementById("openServerBtn") as HTMLButtonElement;
const openDesktopFooterBtn = document.getElementById("openDesktopFooterBtn") as HTMLButtonElement;

const desktopModeDockerRadio = document.getElementById("desktopModeDocker") as HTMLInputElement;
const desktopModeAppRadio = document.getElementById("desktopModeApp") as HTMLInputElement;
const desktopDockerConfig = document.getElementById("desktopDockerConfig") as HTMLDivElement;
const desktopAppConfig = document.getElementById("desktopAppConfig") as HTMLDivElement;
const desktopDockerPortInput = document.getElementById("desktopDockerPort") as HTMLInputElement;
const saveDesktopDockerPortBtn = document.getElementById("saveDesktopDockerPortBtn") as HTMLButtonElement;
const checkDesktopDockerBtn = document.getElementById("checkDesktopDockerBtn") as HTMLButtonElement;
const desktopDockerStatusEl = document.getElementById("desktopDockerStatus") as HTMLParagraphElement;
const desktopAppPathInput = document.getElementById("desktopAppPath") as HTMLInputElement;
const browseDesktopAppPathBtn = document.getElementById("browseDesktopAppPathBtn") as HTMLButtonElement;
const saveDesktopAppPathBtn = document.getElementById("saveDesktopAppPathBtn") as HTMLButtonElement;
const desktopAppPathPicker = document.getElementById("desktopAppPathPicker") as HTMLInputElement;

const resumePreviewModal = document.getElementById("resumePreviewModal") as HTMLDivElement;
const resumeModalTitleEl = document.getElementById("resumeModalTitle") as HTMLHeadingElement;
const resumeModalMetaEl = document.getElementById("resumeModalMeta") as HTMLParagraphElement;
const resumeModalBodyEl = document.getElementById("resumeModalBody") as HTMLDivElement;
const copyResumeModalBtn = document.getElementById("copyResumeModalBtn") as HTMLButtonElement;
const closeResumePreviewBtn = document.getElementById("closeResumePreviewBtn") as HTMLButtonElement;
const closeResumePreviewBtn2 = document.getElementById("closeResumePreviewBtn2") as HTMLButtonElement;

const feedbackModal = document.getElementById("feedbackModal") as HTMLDivElement;
const closeFeedbackBtn = document.getElementById("closeFeedbackBtn") as HTMLButtonElement;
const cancelFeedbackBtn = document.getElementById("cancelFeedbackBtn") as HTMLButtonElement;
const submitFeedbackBtn = document.getElementById("submitFeedbackBtn") as HTMLButtonElement;
const feedbackContentInput = document.getElementById("feedbackContent") as HTMLTextAreaElement;
const feedbackContactInput = document.getElementById("feedbackContact") as HTMLInputElement;
const supportedPlatformsBtn = document.getElementById("supportedPlatformsBtn") as HTMLButtonElement;
const supportedPlatformsModal = document.getElementById("supportedPlatformsModal") as HTMLDivElement;
const closeSupportedPlatformsBtn = document.getElementById("closeSupportedPlatformsBtn") as HTMLButtonElement;
const closeSupportedPlatformsBtn2 = document.getElementById("closeSupportedPlatformsBtn2") as HTMLButtonElement;

let currentTab: TabKey = "cart";
let currentJobs: ExtractedJob[] = [];
let currentResumes: ResumeListItem[] = [];
let selectedResumeId: number | null = null;
let resumeSortMode: ResumeSortMode = "updated";
let currentReadyCount = 0;
let uiSettings: PopupUiSettings = { ...DEFAULT_UI_SETTINGS };
let shortcutSettings: ShortcutSettings = { ...DEFAULT_SHORTCUT_SETTINGS };
let desktopOpenSettings: DesktopOpenSettings = { ...DEFAULT_DESKTOP_OPEN_SETTINGS };
let smartFillSettings: SmartFillAiSettings = { ...DEFAULT_SMART_FILL_SETTINGS };
let shortcutCaptureAction: keyof ShortcutSettings | null = null;
let resumeFilterVisible = false;
let cartFilterVisible = false;
let openingOfferUFrontend = false;
let statusRefreshTimer: number | null = null;

const resumeFilters: ResumeFilterState = {
  time: "all",
  startDate: "",
  endDate: "",
};

const jobFilters: JobFilterState = {
  time: "all",
  startDate: "",
  endDate: "",
  platform: "all",
  salary: "all",
  city: "",
};

const selectedJobHashKeys = new Set<string>();
const resumeDetailCache = new Map<number, ResumeDetail>();
const resumeThumbUrlCache = new Map<number, string>();
const resumeImageBlobCache = new Map<number, Blob>();
const resumeImageBlobLoading = new Map<number, Promise<Blob>>();
const resumeThumbLoading = new Set<number>();
const systemDarkMedia = window.matchMedia("(prefers-color-scheme: dark)");

function queryThemeButtons(): HTMLButtonElement[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>("#themeSegment .segment-btn[data-theme]"),
  );
}

function ensureThemeControls(): void {
  if (document.getElementById("themeSegment")) {
    themeButtons = queryThemeButtons();
    return;
  }

  const settingsPanel = document.getElementById("panel-settings") as HTMLElement | null;
  if (!settingsPanel) return;

  const settingsCards = Array.from(settingsPanel.querySelectorAll<HTMLElement>(".settings-card"));
  const insertAnchor = settingsCards.find((card) => card.classList.contains("stack")) || settingsCards[0] || null;

  const themeCard = document.createElement("section");
  themeCard.className = "settings-card stack";
  themeCard.id = "themeSettingsCard";
  themeCard.innerHTML = [
    '<div class="settings-row">',
    '  <span class="settings-label">外观</span>',
    '  <span class="settings-value">浅色 / 深色 / 系统</span>',
    '</div>',
    '<div class="segment-group" id="themeSegment">',
    '  <button class="segment-btn" data-theme="light" type="button">浅色</button>',
    '  <button class="segment-btn" data-theme="dark" type="button">深色</button>',
    '  <button class="segment-btn" data-theme="system" type="button">系统默认</button>',
    '</div>',
  ].join("");

  if (insertAnchor?.parentElement === settingsPanel) {
    insertAnchor.insertAdjacentElement("afterend", themeCard);
  } else {
    settingsPanel.prepend(themeCard);
  }

  themeButtons = queryThemeButtons();
}

function cleanupResumeThumbCache(validResumeIds: Set<number>): void {
  for (const [resumeId, objectUrl] of resumeThumbUrlCache.entries()) {
    if (validResumeIds.has(resumeId)) continue;
    URL.revokeObjectURL(objectUrl);
    resumeThumbUrlCache.delete(resumeId);
    resumeThumbLoading.delete(resumeId);
    resumeImageBlobLoading.delete(resumeId);
    resumeImageBlobCache.delete(resumeId);
  }
}

function sendBackgroundMessage<T>(message: Message): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: T) => {
      if (chrome.runtime.lastError) {
        reject(new Error(safeExtensionError(chrome.runtime.lastError.message, "扩展后台无响应")));
        return;
      }
      resolve(response);
    });
  });
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDateTime(iso: string): string {
  if (!iso) return "-";
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return iso;
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const d = String(dt.getDate()).padStart(2, "0");
  const hh = String(dt.getHours()).padStart(2, "0");
  const mm = String(dt.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

function toEpoch(iso: string): number | null {
  if (!iso) return null;
  const value = new Date(iso).getTime();
  return Number.isNaN(value) ? null : value;
}

function toDateStartEpoch(value: string): number | null {
  if (!value) return null;
  const ts = new Date(`${value}T00:00:00`).getTime();
  return Number.isNaN(ts) ? null : ts;
}

function toDateEndEpoch(value: string): number | null {
  if (!value) return null;
  const ts = new Date(`${value}T23:59:59`).getTime();
  return Number.isNaN(ts) ? null : ts;
}

function matchTimeRange(
  iso: string,
  mode: TimeRangeFilter,
  startDate: string,
  endDate: string,
): boolean {
  const ts = toEpoch(iso);
  if (ts === null) return false;

  if (mode === "all") return true;

  if (mode === "7d" || mode === "30d" || mode === "90d") {
    const days = mode === "7d" ? 7 : mode === "30d" ? 30 : 90;
    return Date.now() - ts <= days * 24 * 60 * 60 * 1000;
  }

  const startTs = toDateStartEpoch(startDate);
  const endTs = toDateEndEpoch(endDate);
  if (startTs !== null && ts < startTs) return false;
  if (endTs !== null && ts > endTs) return false;
  return true;
}

function compareSemver(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i += 1) {
    const lv = left[i] || 0;
    const rv = right[i] || 0;
    if (lv > rv) return 1;
    if (lv < rv) return -1;
  }
  return 0;
}

function normalizeSalaryValue(raw: string): number | null {
  const text = (raw || "").trim();
  if (!text) return null;

  const values: number[] = [];
  const matches = text.matchAll(/(\d+(?:\.\d+)?)(\s*[kK万]?)/g);
  for (const match of matches) {
    const base = Number.parseFloat(match[1]);
    if (!Number.isFinite(base)) continue;
    const unit = (match[2] || "").trim().toLowerCase();
    if (unit === "k") {
      values.push(base * 1000);
      continue;
    }
    if (unit === "万") {
      values.push(base * 10000);
      continue;
    }
    values.push(base);
  }

  if (values.length === 0) return null;
  return Math.max(...values);
}

function inferSalaryMode(jobs: ExtractedJob[]): "day" | "month" {
  const hasDaySalary = jobs.some((job) => /日薪|\/天|天|\/day/i.test(job.salary_text || ""));
  return hasDaySalary ? "day" : "month";
}

function getSalaryOptionLabels(mode: "day" | "month"): Array<{ value: JobSalaryFilter; label: string }> {
  if (mode === "day") {
    return [
      { value: "all", label: "全部" },
      { value: "day_lt_100", label: "100/天以下" },
      { value: "day_100_200", label: "100-200/天" },
      { value: "day_200_300", label: "200-300/天" },
      { value: "day_gt_300", label: "300/天以上" },
    ];
  }

  return [
    { value: "all", label: "全部" },
    { value: "month_lt_8k", label: "8K以下" },
    { value: "month_8k_15k", label: "8K-15K" },
    { value: "month_15k_25k", label: "15K-25K" },
    { value: "month_gt_25k", label: "25K以上" },
  ];
}

function matchSalaryFilter(job: ExtractedJob, filter: JobSalaryFilter, mode: "day" | "month"): boolean {
  if (filter === "all") return true;

  const fallback = normalizeSalaryValue(job.salary_text || "");
  const numeric = typeof job.salary_max === "number" && job.salary_max > 0 ? job.salary_max : fallback;
  if (numeric === null || !Number.isFinite(numeric)) return false;

  if (mode === "day") {
    if (filter === "day_lt_100") return numeric < 100;
    if (filter === "day_100_200") return numeric >= 100 && numeric <= 200;
    if (filter === "day_200_300") return numeric > 200 && numeric <= 300;
    if (filter === "day_gt_300") return numeric > 300;
    return true;
  }

  if (filter === "month_lt_8k") return numeric < 8000;
  if (filter === "month_8k_15k") return numeric >= 8000 && numeric <= 15000;
  if (filter === "month_15k_25k") return numeric > 15000 && numeric <= 25000;
  if (filter === "month_gt_25k") return numeric > 25000;
  return true;
}

function normalizeShortcutKey(rawKey: string): string {
  const lowered = rawKey.trim().toLowerCase();
  if (!lowered) return "";
  if (lowered === " ") return "Space";
  if (lowered === "escape") return "Esc";
  if (lowered === "arrowup") return "Up";
  if (lowered === "arrowdown") return "Down";
  if (lowered === "arrowleft") return "Left";
  if (lowered === "arrowright") return "Right";
  if (lowered.length === 1) return lowered.toUpperCase();
  if (/^f\d{1,2}$/.test(lowered)) return lowered.toUpperCase();
  return rawKey.trim();
}

function normalizeShortcutString(rawShortcut: string): string {
  if (!rawShortcut) return "";

  const parts = rawShortcut
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);

  const modifierSet = new Set<string>();
  let keyPart = "";

  for (const part of parts) {
    const lowered = part.toLowerCase();
    if (lowered === "ctrl" || lowered === "control") {
      modifierSet.add("Ctrl");
      continue;
    }
    if (lowered === "alt" || lowered === "option") {
      modifierSet.add("Alt");
      continue;
    }
    if (lowered === "shift") {
      modifierSet.add("Shift");
      continue;
    }
    if (lowered === "meta" || lowered === "cmd" || lowered === "command") {
      modifierSet.add("Meta");
      continue;
    }
    keyPart = normalizeShortcutKey(part);
  }

  if (!keyPart) return "";

  const ordered: string[] = [];
  if (modifierSet.has("Ctrl")) ordered.push("Ctrl");
  if (modifierSet.has("Alt")) ordered.push("Alt");
  if (modifierSet.has("Shift")) ordered.push("Shift");
  if (modifierSet.has("Meta")) ordered.push("Meta");
  ordered.push(keyPart);
  return ordered.join("+");
}

function shortcutFromKeyboardEvent(event: KeyboardEvent): string {
  const modifierOnlyKeys = ["Control", "Shift", "Alt", "Meta"];
  if (modifierOnlyKeys.includes(event.key)) return "";

  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Meta");
  parts.push(normalizeShortcutKey(event.key));
  return normalizeShortcutString(parts.join("+"));
}

function resolveThemeValue(theme: UiTheme): "light" | "dark" {
  if (theme === "system") {
    return systemDarkMedia.matches ? "dark" : "light";
  }
  return theme;
}

function applyThemeToDocument(): void {
  const resolved = resolveThemeValue(uiSettings.theme);
  document.documentElement.setAttribute("data-theme", resolved);
}

function refreshShortcutButtons(): void {
  shortcutButtons.forEach((button) => {
    const action = button.dataset.shortcutAction as keyof ShortcutSettings | undefined;
    if (!action) return;
    button.textContent = shortcutSettings[action] || "未设置";
    button.classList.toggle("capture", shortcutCaptureAction === action);
  });
}

function normalizeServerUrl(input: string): string {
  return normalizeOfferUServerUrl(input);
}

function getServerUrl(): string {
  return normalizeServerUrl(serverUrlInput.value || DEFAULT_SERVER_URL);
}

function normalizeDockerPort(input: string): string {
  return normalizeOfferUFrontendPort(input);
}

function normalizeDesktopOpenMode(input: string | undefined): DesktopOpenMode {
  return input === "app" ? "app" : "docker";
}

function normalizeDesktopOpenSettings(input?: Partial<DesktopOpenSettings>): DesktopOpenSettings {
  return {
    mode: normalizeDesktopOpenMode(input?.mode),
    dockerPort: normalizeDockerPort(input?.dockerPort || DEFAULT_DOCKER_PORT),
    appPath: (input?.appPath || "").trim(),
  };
}

function syncDesktopOpenControls(): void {
  const normalized = normalizeDesktopOpenSettings(desktopOpenSettings);
  desktopOpenSettings = normalized;

  desktopModeDockerRadio.checked = normalized.mode === "docker";
  desktopModeAppRadio.checked = normalized.mode === "app";
  desktopDockerConfig.classList.toggle("hidden", normalized.mode !== "docker");
  desktopAppConfig.classList.toggle("hidden", normalized.mode !== "app");

  desktopDockerPortInput.value = normalized.dockerPort;
  desktopAppPathInput.value = normalized.appPath;
}

function setDesktopDockerStatus(text: string, mode: "pending" | "ok" | "error"): void {
  desktopDockerStatusEl.textContent = text;
  desktopDockerStatusEl.classList.remove("ok", "err");
  if (mode === "ok") {
    desktopDockerStatusEl.classList.add("ok");
  }
  if (mode === "error") {
    desktopDockerStatusEl.classList.add("err");
  }
}

function saveDesktopOpenSettings(showToast = false): void {
  chrome.storage.local.set({ [DESKTOP_OPEN_SETTINGS_KEY]: desktopOpenSettings }, () => {
    if (showToast) {
      showMessage("桌面端打开设置已保存", "success");
    }
  });
}

function getDockerDesktopUrl(port: string): string {
  const normalized = normalizeDockerPort(port);
  return `http://127.0.0.1:${normalized}`;
}

async function probeOfferUFrontend(): Promise<boolean> {
  const url = DEFAULT_OFFERU_FRONTEND_URL;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const html = await response.text();
    return /OfferU/i.test(html);
  } catch {
    return false;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function openOfferUFrontend(): Promise<void> {
  if (openingOfferUFrontend) return;
  openingOfferUFrontend = true;
  const url = DEFAULT_OFFERU_FRONTEND_URL;
  try {
    if (!(await probeOfferUFrontend())) {
      showMessage("OfferU 网页服务未启动，已停止打开浏览器窗口。请先启动 7410 服务。", "error");
      return;
    }

    try {
      await chrome.tabs.create({ url });
    } catch {
      showMessage("打开 OfferU 网页失败，请稍后重试。", "error");
    }
  } finally {
    openingOfferUFrontend = false;
  }
}

function toFileUrl(pathInput: string): string {
  const input = pathInput.trim();
  if (/^file:\/\//i.test(input)) {
    return input;
  }

  const normalized = input.replace(/\\/g, "/").replace(/^\/+/, "");
  return `file:///${encodeURI(normalized)}`;
}

function extractAbsoluteDirectoryFromPickerFile(
  file: File & { path?: string; webkitRelativePath?: string },
): string | null {
  const nativePath = (file.path || "").trim();
  if (!nativePath) return null;

  const normalizedNativePath = nativePath.replace(/\//g, "\\");
  if (!/^[a-zA-Z]:\\/.test(normalizedNativePath)) return null;

  const relativePath = (file.webkitRelativePath || file.name || "").replace(/\//g, "\\");
  if (relativePath && normalizedNativePath.toLowerCase().endsWith(relativePath.toLowerCase())) {
    const absoluteDirectory = normalizedNativePath
      .slice(0, normalizedNativePath.length - relativePath.length)
      .replace(/\\+$/, "");
    return absoluteDirectory || null;
  }

  const lastSeparator = normalizedNativePath.lastIndexOf("\\");
  if (lastSeparator <= 2) {
    return normalizedNativePath;
  }
  return normalizedNativePath.slice(0, lastSeparator);
}

function resolveDesktopOpenUrl(): string | null {
  if (desktopOpenSettings.mode === "docker") {
    return getDockerDesktopUrl(desktopOpenSettings.dockerPort);
  }

  const appPath = desktopOpenSettings.appPath.trim();
  if (!appPath) {
    return null;
  }
  return toFileUrl(appPath);
}

async function openDesktopTarget(): Promise<void> {
  if (desktopOpenSettings.mode === "docker") {
    await openOfferUFrontend();
    return;
  }

  const url = resolveDesktopOpenUrl();
  if (!url) {
    showMessage("请先在设置中配置应用程序路径", "error");
    activateTab("settings");
    return;
  }

  try {
    await chrome.tabs.create({ url });
  } catch {
    showMessage("打开失败：请确认路径或本地服务配置", "error");
  }
}

async function checkDesktopDockerConnection(): Promise<void> {
  const normalizedPort = normalizeDockerPort(desktopDockerPortInput.value);
  desktopDockerPortInput.value = normalizedPort;
  desktopOpenSettings.dockerPort = normalizedPort;

  const url = getDockerDesktopUrl(normalizedPort);
  setDesktopDockerStatus("检查中...", "pending");
  if (url === DEFAULT_OFFERU_FRONTEND_URL && (await probeOfferUFrontend())) {
    setDesktopDockerStatus(`连接正常：${url}`, "ok");
    return;
  }
  setDesktopDockerStatus(`连接失败：${url}`, "error");
}

function initDrawerDragBridge(): void {
  if (!EMBED_MODE || !topbarEl) return;

  topbarEl.classList.add("is-draggable");
  let pointerId: number | null = null;
  let startScreenX = 0;
  let startScreenY = 0;
  let dragging = false;

  const isInteractiveTarget = (target: EventTarget | null): boolean => {
    if (!(target instanceof HTMLElement)) return false;
    return Boolean(target.closest("button, a, input, textarea, select, [role='button']"));
  };

  const resetDragState = (): void => {
    pointerId = null;
    dragging = false;
    document.body.classList.remove("drawer-dragging");
  };

  const postDragMessage = (
    type: string,
    screenX: number,
    screenY: number,
    clientX: number,
    clientY: number,
  ): void => {
    window.parent.postMessage({ type, screenX, screenY, clientX, clientY }, "*");
  };

  topbarEl.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (isInteractiveTarget(event.target)) return;

    pointerId = event.pointerId;
    startScreenX = event.screenX;
    startScreenY = event.screenY;
    dragging = false;
    document.body.classList.add("drawer-dragging");
    topbarEl.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  topbarEl.addEventListener("pointermove", (event) => {
    if (pointerId === null || event.pointerId !== pointerId) return;

    const dx = event.screenX - startScreenX;
    const dy = event.screenY - startScreenY;
    if (!dragging) {
      if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
      dragging = true;
      postDragMessage("offeru:drawer-drag-start", startScreenX, startScreenY, event.clientX, event.clientY);
    }

    postDragMessage("offeru:drawer-drag-move", event.screenX, event.screenY, event.clientX, event.clientY);
    event.preventDefault();
  });

  const finishPointerDrag = (event: PointerEvent): void => {
    if (pointerId === null || event.pointerId !== pointerId) return;
    if (dragging) {
      postDragMessage("offeru:drawer-drag-end", event.screenX, event.screenY, event.clientX, event.clientY);
    }

    if (topbarEl.hasPointerCapture(event.pointerId)) {
      topbarEl.releasePointerCapture(event.pointerId);
    }
    resetDragState();
  };

  topbarEl.addEventListener("pointerup", finishPointerDrag);
  topbarEl.addEventListener("pointercancel", finishPointerDrag);
  topbarEl.addEventListener("lostpointercapture", () => {
    resetDragState();
  });
}

function showMessage(text: string, type: MessageType): void {
  messageEl.textContent = text;
  messageEl.className = `message ${type}`;
  window.setTimeout(() => {
    if (messageEl.textContent === text) {
      messageEl.textContent = "";
      messageEl.className = "message";
    }
  }, 3600);
}

function activateTab(tab: TabKey): void {
  currentTab = tab;
  tabButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tab);
  });
  tabPanels.forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.panel === tab);
  });

  if (tab === "resumes") {
    void refreshResumes();
  }

  if (tab === "cart") {
    void refreshStatus();
  }
}

function resolveInitialTab(): TabKey {
  const queryTab = queryParams.get("tab");
  if (queryTab === "cart" || queryTab === "resumes" || queryTab === "settings") {
    return queryTab;
  }
  return "cart";
}

function isReadyJob(job: ExtractedJob): boolean {
  return Boolean(job.raw_description?.trim());
}

function hasActiveJobFilters(): boolean {
  return (
    jobFilters.time !== "all"
    || Boolean(jobFilters.startDate)
    || Boolean(jobFilters.endDate)
    || jobFilters.platform !== "all"
    || jobFilters.salary !== "all"
    || Boolean(jobFilters.city.trim())
  );
}

function refreshJobSalaryOptions(): void {
  const salaryMode = inferSalaryMode(currentJobs);
  const options = getSalaryOptionLabels(salaryMode);
  const previousValue = jobFilters.salary;

  jobSalaryFilter.innerHTML = options
    .map((option) => `<option value="${option.value}">${option.label}</option>`)
    .join("");

  const valid = options.some((item) => item.value === previousValue);
  jobFilters.salary = valid ? previousValue : "all";
  jobSalaryFilter.value = jobFilters.salary;
}

function syncJobFilterControls(): void {
  jobTimeFilter.value = jobFilters.time;
  jobDateStartInput.value = jobFilters.startDate;
  jobDateEndInput.value = jobFilters.endDate;
  jobPlatformFilter.value = jobFilters.platform;
  jobCityFilter.value = jobFilters.city;
  jobCustomRange.classList.toggle("hidden", jobFilters.time !== "custom");
  refreshJobSalaryOptions();
}

function syncCartFilterControls(): void {
  jobFilterWrap.classList.toggle("hidden", !cartFilterVisible);
  cartFilterBtn.textContent = cartFilterVisible ? "收起筛选" : "展开筛选";
}

function resetJobFilters(): void {
  jobFilters.time = "all";
  jobFilters.startDate = "";
  jobFilters.endDate = "";
  jobFilters.platform = "all";
  jobFilters.salary = "all";
  jobFilters.city = "";
  cartFilterVisible = false;
  syncCartFilterControls();
  syncJobFilterControls();
  renderJobs();
  showMessage("岗位筛选已重置并收起", "info");
}

function getDisplayedJobs(): ExtractedJob[] {
  const salaryMode = inferSalaryMode(currentJobs);
  return currentJobs.filter((job) => {
    if (!matchTimeRange(job.created_at, jobFilters.time, jobFilters.startDate, jobFilters.endDate)) {
      return false;
    }

    if (jobFilters.platform !== "all") {
      if (jobFilters.platform === "other") {
        const mainstream: Array<ExtractedJob["source"]> = ["boss", "liepin", "zhaopin", "shixiseng"];
        if (mainstream.includes(job.source)) return false;
      } else if (job.source !== jobFilters.platform) {
        return false;
      }
    }

    if (!matchSalaryFilter(job, jobFilters.salary, salaryMode)) {
      return false;
    }

    const cityKeyword = jobFilters.city.trim().toLowerCase();
    if (cityKeyword) {
      const location = (job.location || "").toLowerCase();
      if (!location.includes(cityKeyword)) {
        return false;
      }
    }

    return true;
  });
}

function sourceLabel(source: ExtractedJob["source"]): string {
  return SOURCE_LABELS[source] || SOURCE_LABELS.unknown;
}

function renderJobs(): void {
  const jobs = getDisplayedJobs();

  if (jobs.length === 0) {
    const emptyText = hasActiveJobFilters()
      ? "当前筛选条件下暂无岗位"
      : "购物车为空，先在招聘网站手动加入岗位";
    jobListEl.innerHTML = `<div class="empty-state">${emptyText}</div>`;
    return;
  }

  jobListEl.innerHTML = jobs
    .map((job) => {
      const selected = selectedJobHashKeys.has(job.hash_key);
      const ready = isReadyJob(job);
      const salaryText = job.salary_text || "薪资未标注";
      const locationText = job.location || "地点待补充";
      const metaText = `${job.company || "公司未知"}  |  ${salaryText}  |  ${locationText}`;

      return `
        <article class="job-card ${selected ? "is-selected" : ""}" data-job-hash="${escapeHtml(job.hash_key)}">
          <button
            class="pick-button ${selected ? "is-picked" : ""}"
            type="button"
            data-job-pick="${escapeHtml(job.hash_key)}"
            aria-label="选择岗位"
          >✓</button>
          <div class="card-main">
            <div class="card-title-row">
              <div class="card-title" title="${escapeHtml(job.title)}">${escapeHtml(job.title)}</div>
              <span class="status-pill ${ready ? "ready" : "draft"}">${ready ? "可同步" : "草稿"}</span>
            </div>
            <div class="card-meta" title="${escapeHtml(metaText)}">${escapeHtml(metaText)}</div>
            <div class="chip-row">
              <span class="meta-chip">${escapeHtml(sourceLabel(job.source))}</span>
              <span class="meta-chip">${escapeHtml(locationText)}</span>
            </div>
          </div>
        </article>
      `;
    })
    .join("");
}

async function refreshJobs(): Promise<void> {
  try {
    const resp = await sendBackgroundMessage<{ jobs: ExtractedJob[] }>({ type: "GET_JOBS" });
    currentJobs = [...(resp?.jobs || [])].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    syncJobFilterControls();

    const availableKeys = new Set(currentJobs.map((job) => job.hash_key));
    for (const key of Array.from(selectedJobHashKeys)) {
      if (!availableKeys.has(key)) {
        selectedJobHashKeys.delete(key);
      }
    }

    renderJobs();
  } catch {
    jobListEl.innerHTML = '<div class="empty-state">读取岗位失败，请稍后重试</div>';
  }
}

function updateStatusSummary(status: StatusResponse): void {
  cartTotalBadgeEl.textContent = String(status.total);
  readyCountInlineEl.textContent = String(status.ready);
  draftCountInlineEl.textContent = String(status.draft);
  currentReadyCount = status.total;
  syncBtn.textContent = `一键同步 (${status.total})`;
  syncBtn.disabled = status.total <= 0;
}

async function refreshStatus(): Promise<void> {
  try {
    const status = await sendBackgroundMessage<StatusResponse>({ type: "GET_STATUS" });
    updateStatusSummary(status);

    if (!serverUrlInput.value.trim()) {
      serverUrlInput.value = status.serverUrl;
    }

    await refreshJobs();
  } catch {
    showMessage("读取状态失败，请稍后重试", "error");
  }
}

function scheduleStatusRefresh(): void {
  if (statusRefreshTimer !== null) {
    window.clearTimeout(statusRefreshTimer);
  }

  statusRefreshTimer = window.setTimeout(() => {
    statusRefreshTimer = null;
    void refreshStatus();
  }, 120);
}

function toggleJobSelection(hashKey: string): void {
  if (!hashKey) return;
  if (selectedJobHashKeys.has(hashKey)) {
    selectedJobHashKeys.delete(hashKey);
  } else {
    selectedJobHashKeys.add(hashKey);
  }
  renderJobs();
}

async function syncJobs(): Promise<void> {
  syncBtn.disabled = true;
  const previousText = syncBtn.textContent;
  syncBtn.textContent = "同步中...";

  try {
    const resp = await sendBackgroundMessage<SyncResponse>({ type: "SYNC_TO_SERVER" });
    if (resp.ok) {
      const tips = resp.skippedDraft > 0 ? `，${resp.skippedDraft} 条草稿待补全` : "";
      showMessage(`已同步 ${resp.synced} 条岗位${tips}`, "success");
    } else {
      const base = resp.error || "未知错误";
      const tips = resp.skippedDraft > 0 ? `（草稿 ${resp.skippedDraft} 条）` : "";
      showMessage(`同步失败：${base}${tips}`, "error");
    }
  } catch (error: unknown) {
    const text = safeExtensionError(error, "请求失败");
    showMessage(`同步失败：${text}`, "error");
  } finally {
    syncBtn.textContent = previousText || `一键同步 (${currentReadyCount})`;
    await refreshStatus();
  }
}

async function clearJobs(): Promise<void> {
  if (selectedJobHashKeys.size > 0) {
    if (!window.confirm(`确认移除 ${selectedJobHashKeys.size} 条已选岗位吗？`)) return;
    try {
      const resp = await sendBackgroundMessage<RemoveResponse>({
        type: "REMOVE_JOBS",
        hashKeys: Array.from(selectedJobHashKeys),
      });
      selectedJobHashKeys.clear();
      showMessage(`已移除 ${resp.removed} 条岗位`, "info");
      await refreshStatus();
    } catch (error: unknown) {
      const text = safeExtensionError(error, "请求失败");
      showMessage(`移除失败：${text}`, "error");
    }
    return;
  }

  if (!window.confirm("确认清空购物车中的岗位吗？")) return;
  try {
    await sendBackgroundMessage<{ ok: boolean }>({ type: "CLEAR_JOBS" });
    showMessage("购物车已清空", "info");
    await refreshStatus();
  } catch (error: unknown) {
    const text = safeExtensionError(error, "请求失败");
    showMessage(`清空失败：${text}`, "error");
  }
}

function sendCollectCommandToTab(tabId: number): Promise<CollectFromPageResponse> {
  return new Promise<CollectFromPageResponse>((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: "OFFERU_TRIGGER_COLLECT" }, (resp: CollectFromPageResponse) => {
      if (chrome.runtime.lastError) {
        reject(new Error(safeExtensionError(chrome.runtime.lastError.message, "当前页面无响应")));
        return;
      }
      resolve(resp);
    });
  });
}

async function collectCurrentPageJob(): Promise<void> {
  addCurrentBtn.disabled = true;
  const previousText = addCurrentBtn.textContent;
  addCurrentBtn.textContent = "处理中...";

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeTab = tabs[0];

    if (!activeTab?.id) {
      showMessage("未找到当前标签页", "error");
      return;
    }

    // 优先规则包采集（显式注入 Page Agent）；不受支持时回退旧 content script 路径
    const resp = await sendBackgroundMessage<PageAgentCollectViaResponse>({
      type: "COLLECT_VIA_PAGE_AGENT",
    });
    if (resp.ok) {
      showMessage(resp.message || "已加入购物车", "success");
    } else if (!resp.fallback) {
      showMessage(resp.message || "采集失败", "error");
    } else {
      const legacy = await sendCollectCommandToTab(activeTab.id);
      if (legacy.ok) {
        showMessage(legacy.message || "已加入购物车", "success");
      } else {
        showMessage(legacy.message || "当前页面无法加入岗位", "error");
      }
    }

    await refreshStatus();
  } catch (error: unknown) {
    const text = safeExtensionError(error, "发送失败");
    showMessage(`加入失败：${text}`, "error");
  } finally {
    addCurrentBtn.disabled = false;
    addCurrentBtn.textContent = previousText || "+ 加入购物车";
  }
}

function inferResumeFormat(resume: ResumeListItem): string {
  const title = (resume.title || "").toLowerCase();
  if (title.endsWith(".pdf")) return "PDF";
  if (title.endsWith(".doc") || title.endsWith(".docx")) return "DOC";
  if (resume.source_mode && resume.source_mode.trim()) return resume.source_mode.toUpperCase();
  return "PDF";
}

function hasActiveResumeFilter(): boolean {
  return (
    resumeFilters.time !== "all"
    || Boolean(resumeFilters.startDate)
    || Boolean(resumeFilters.endDate)
    || Boolean(resumeSearchInput.value.trim())
  );
}

function syncResumeFilterControls(): void {
  resumeFilterWrap.classList.toggle("hidden", !resumeFilterVisible);
  resumeTimeFilter.value = resumeFilters.time;
  resumeDateStartInput.value = resumeFilters.startDate;
  resumeDateEndInput.value = resumeFilters.endDate;
  resumeCustomRange.classList.toggle("hidden", resumeFilters.time !== "custom");
}

function resetResumeFilters(): void {
  resumeFilters.time = "all";
  resumeFilters.startDate = "";
  resumeFilters.endDate = "";
  resumeSearchInput.value = "";
  syncResumeFilterControls();
  renderResumes();
  showMessage("简历筛选已重置", "info");
}

function getDisplayedResumes(): ResumeListItem[] {
  const keyword = resumeSearchInput.value.trim().toLowerCase();
  const sorted = [...currentResumes].sort((a, b) => {
    if (resumeSortMode === "title") {
      return (a.title || "").localeCompare(b.title || "", "zh-CN");
    }
    return a.updated_at < b.updated_at ? 1 : -1;
  });

  return sorted.filter((resume) => {
    const timeAnchor = resume.created_at || resume.updated_at;
    if (!matchTimeRange(timeAnchor, resumeFilters.time, resumeFilters.startDate, resumeFilters.endDate)) {
      return false;
    }

    if (!keyword) {
      return true;
    }

    const title = (resume.title || "").toLowerCase();
    const owner = (resume.user_name || "").toLowerCase();
    return title.includes(keyword) || owner.includes(keyword);
  });
}

function ensureSelectedResume(displayedResumes: ResumeListItem[]): void {
  if (displayedResumes.length === 0) {
    selectedResumeId = null;
    return;
  }

  const found = displayedResumes.some((item) => item.id === selectedResumeId);
  if (!found) {
    selectedResumeId = displayedResumes[0].id;
  }
}

function renderResumes(): void {
  resumeTotalBadgeEl.textContent = String(currentResumes.length);

  const displayed = getDisplayedResumes();
  ensureSelectedResume(displayed);

  if (displayed.length === 0) {
    const text = currentResumes.length === 0
      ? "暂无简历，先在桌面端生成后再查看"
      : hasActiveResumeFilter()
        ? "当前筛选条件下暂无简历"
        : "未找到匹配的简历";
    resumeListEl.innerHTML = `<div class="empty-state">${text}</div>`;
    return;
  }

  resumeListEl.innerHTML = displayed
    .map((resume) => {
      const selected = resume.id === selectedResumeId;
      const formatTag = inferResumeFormat(resume);
      const owner = resume.user_name || "默认候选人";
      const thumbUrl = resumeThumbUrlCache.get(resume.id);
      const thumbTitle = `${resume.title || "未命名简历"} 缩略图`;
      const thumbHtml = thumbUrl
        ? `<img class="resume-thumb-media loaded" data-thumb-id="${resume.id}" src="${thumbUrl}" alt="${escapeHtml(thumbTitle)}" />`
        : `<span class="resume-thumb-media placeholder" data-thumb-id="${resume.id}" aria-hidden="true">${escapeHtml(formatTag)}</span>`;

      return `
        <article class="resume-card ${selected ? "is-selected" : ""}" data-resume-id="${resume.id}">
          <button class="pick-button ${selected ? "is-picked" : ""}" type="button" data-resume-pick="${resume.id}" aria-label="选择简历">✓</button>
          <button class="resume-thumb" type="button" data-preview-resume="${resume.id}" aria-label="预览简历">
            ${thumbHtml}
          </button>
          <div class="card-main">
            <div class="card-title-row">
              <div class="card-title" title="${escapeHtml(resume.title || "未命名简历")}">${escapeHtml(resume.title || "未命名简历")}</div>
            </div>
            <div class="card-meta">更新于 ${escapeHtml(formatDateTime(resume.updated_at))}</div>
            <div class="chip-row">
              <span class="meta-chip">${escapeHtml(owner)}</span>
              <span class="meta-chip">${escapeHtml(formatTag)}</span>
            </div>
          </div>
        </article>
      `;
    })
    .join("");

  const prefetchResumeIds = new Set<number>();
  if (selectedResumeId) {
    prefetchResumeIds.add(selectedResumeId);
  }
  for (const resume of displayed.slice(0, RESUME_THUMB_PREFETCH_LIMIT)) {
    prefetchResumeIds.add(resume.id);
  }

  for (const resumeId of prefetchResumeIds) {
    if (!resumeThumbUrlCache.has(resumeId)) {
      void ensureResumeThumbnail(resumeId);
    }
  }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, redirect: "error" });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

async function refreshResumes(): Promise<void> {
  try {
    const serverUrl = getServerUrl();
    const resumes = await fetchJson<ResumeListItem[]>(`${serverUrl}/api/resume/`);
    currentResumes = resumes || [];
    cleanupResumeThumbCache(new Set(currentResumes.map((resume) => resume.id)));
    renderResumes();
  } catch (error: unknown) {
    const text = safeExtensionError(error, "读取失败");
    resumeListEl.innerHTML = `<div class="empty-state">读取简历失败：${escapeHtml(text)}</div>`;
  }
}

function normalizeSectionLines(section: ResumeDetail["sections"][number]): string[] {
  const lines: string[] = [];
  for (const entry of section.content_json || []) {
    if (!entry || typeof entry !== "object") continue;

    const line = Object.values(entry)
      .filter((value) => typeof value === "string" && value.trim())
      .join("  ")
      .trim();

    if (line) {
      lines.push(line);
    }
  }
  return lines;
}

function renderResumePreview(detail: ResumeDetail): void {
  resumeModalTitleEl.textContent = detail.title || "未命名简历";
  resumeModalMetaEl.textContent = `${detail.user_name || "默认候选人"}  更新时间 ${formatDateTime(detail.updated_at)}`;

  const sections = detail.sections
    .filter((section) => section.visible)
    .slice(0, 8)
    .map((section) => {
      const lines = normalizeSectionLines(section).slice(0, 4);
      const body = lines.length
        ? `<ul>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>`
        : "<p>暂无内容</p>";

      return `
        <section class="modal-section">
          <div class="modal-section-title">${escapeHtml(section.title || section.section_type)}</div>
          ${body}
        </section>
      `;
    })
    .join("");

  const summary = (detail.summary || "").trim();
  const summaryHtml = summary
    ? `<section class="modal-section"><div class="modal-section-title">个人摘要</div><p>${escapeHtml(summary)}</p></section>`
    : "";

  resumeModalBodyEl.innerHTML = summaryHtml + sections;
}

async function getResumeDetail(resumeId: number): Promise<ResumeDetail> {
  const cached = resumeDetailCache.get(resumeId);
  if (cached) return cached;

  const detail = await fetchJson<ResumeDetail>(`${getServerUrl()}/api/resume/${resumeId}`);
  resumeDetailCache.set(resumeId, detail);
  return detail;
}

function openResumeModal(): void {
  resumePreviewModal.classList.remove("hidden");
  resumePreviewModal.setAttribute("aria-hidden", "false");
}

function closeResumeModal(): void {
  resumePreviewModal.classList.add("hidden");
  resumePreviewModal.setAttribute("aria-hidden", "true");
}

async function openResumePreview(resumeId: number): Promise<void> {
  try {
    const detail = await getResumeDetail(resumeId);
    renderResumePreview(detail);
    openResumeModal();
  } catch (error: unknown) {
    const text = safeExtensionError(error, "读取失败");
    showMessage(`预览失败：${text}`, "error");
  }
}

async function requestDrawerHostFocus(): Promise<void> {
  if (!EMBED_MODE) return;

  await new Promise<void>((resolve) => {
    const requestId = `focus-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let settled = false;

    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      window.clearTimeout(timer);
      resolve();
    };

    const onMessage = (event: MessageEvent): void => {
      if (event.source !== window.parent) return;
      const payload = event.data as { type?: string; requestId?: string } | null;
      if (payload?.type !== "offeru:drawer-focus-ack") return;
      if (payload.requestId !== requestId) return;
      cleanup();
    };

    const timer = window.setTimeout(() => {
      cleanup();
    }, 180);

    window.addEventListener("message", onMessage);
    window.parent.postMessage({ type: "offeru:drawer-focus-request", requestId }, "*");
  });
}

function triggerResumeImageDownload(resumeId: number, blob: Blob): void {
  const normalizedBlob = blob.type === "image/png" ? blob : new Blob([blob], { type: "image/png" });
  const objectUrl = URL.createObjectURL(normalizedBlob);
  const stamp = new Date().toISOString().replace(/[.:]/g, "-").slice(0, 19);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = `OfferU_Resume_${resumeId}_${stamp}.png`;
  anchor.rel = "noopener";
  anchor.click();
  window.setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
  }, 1200);
}

async function maybeDownloadResumeImageAfterCopy(
  resumeId: number,
  blobOrPromise?: Blob | Promise<Blob>,
): Promise<void> {
  if (!uiSettings.copyAndDownloadPng) return;

  const source = blobOrPromise || getResumeImageBlob(resumeId);
  const blob = await Promise.resolve(source);
  triggerResumeImageDownload(resumeId, blob);
}

async function copyBlobToClipboard(blobOrPromise: Blob | Promise<Blob>): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("当前浏览器不支持图片写入剪贴板");
  }

  await requestDrawerHostFocus();

  if (!document.hasFocus()) {
    try {
      window.focus();
    } catch {
      // ignore focus failures and continue to clipboard write attempt
    }
  }

  const normalizedBlobPromise = Promise.resolve(blobOrPromise).then((blob) => {
    if (blob.type === "image/png") return blob;
    return new Blob([blob], { type: "image/png" });
  });

  // Keep clipboard.write inside click task by passing a promise value.
  await navigator.clipboard.write([new ClipboardItem({ "image/png": normalizedBlobPromise })]);
}

function isClipboardPermissionPolicyBlocked(error: unknown): boolean {
  const text = (error instanceof Error ? error.message : String(error || "")).toLowerCase();
  return (
    text.includes("permissions policy")
    || text.includes("clipboard api has been blocked")
    || text.includes("not allowed")
  );
}

function isClipboardFocusError(error: unknown): boolean {
  const text = (error instanceof Error ? error.message : String(error || "")).toLowerCase();
  return text.includes("document is not focused") || text.includes("not focused");
}

async function copyImageViaBackground(imageUrl: string): Promise<void> {
  const result = await sendBackgroundMessage<ClipboardCopyResponse>({
    type: "COPY_IMAGE_TO_CLIPBOARD",
    imageUrl,
  });

  if (!result?.ok) {
    throw new Error(result?.error || "后台复制失败");
  }
}

function buildResumeImageEndpoint(resumeId: number): string {
  const endpoint = new URL(`${getServerUrl()}/api/resume/${resumeId}/export/image`);
  endpoint.searchParams.set("scale", String(RESUME_IMAGE_EXPORT_SCALE));
  return endpoint.toString();
}

function applyResumeThumbBlob(resumeId: number, blob: Blob): void {
  resumeImageBlobCache.set(resumeId, blob);

  const staleUrl = resumeThumbUrlCache.get(resumeId);
  if (staleUrl) {
    URL.revokeObjectURL(staleUrl);
  }

  const objectUrl = URL.createObjectURL(blob);
  resumeThumbUrlCache.set(resumeId, objectUrl);

  const node = resumeListEl.querySelector<HTMLElement>(`[data-thumb-id="${resumeId}"]`);
  if (!node) return;

  const img = document.createElement("img");
  img.className = "resume-thumb-media loaded";
  img.setAttribute("data-thumb-id", String(resumeId));
  img.src = objectUrl;
  img.alt = "简历缩略图";
  node.replaceWith(img);
}

async function getResumeImageBlob(resumeId: number): Promise<Blob> {
  const cached = resumeImageBlobCache.get(resumeId);
  if (cached) return cached;

  const inFlight = resumeImageBlobLoading.get(resumeId);
  if (inFlight) {
    return await inFlight;
  }

  const loading = (async () => {
    const blob = await fetchResumeImageBlob(resumeId);
    applyResumeThumbBlob(resumeId, blob);
    return blob;
  })();

  resumeImageBlobLoading.set(resumeId, loading);
  try {
    return await loading;
  } finally {
    resumeImageBlobLoading.delete(resumeId);
  }
}

async function fetchResumeImageBlob(resumeId: number): Promise<Blob> {
  const endpoint = buildResumeImageEndpoint(resumeId);
  let response = await fetch(endpoint, {
    method: "GET",
    redirect: "error",
  });

  if (response.status === 405) {
    response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
    });
  }

  if (!response.ok) {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const payload = (await response.json()) as { detail?: string };
      throw new Error(payload.detail || `HTTP ${response.status}`);
    }

    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }

  const mediaType = response.headers.get("content-type") || "";
  if (!mediaType.startsWith("image/")) {
    throw new Error(`后端返回了非图片内容：${mediaType || "unknown"}`);
  }

  return await response.blob();
}

async function ensureResumeThumbnail(resumeId: number): Promise<void> {
  if (resumeThumbUrlCache.has(resumeId)) return;
  if (resumeThumbLoading.has(resumeId)) return;

  const cachedBlob = resumeImageBlobCache.get(resumeId);
  if (cachedBlob) {
    applyResumeThumbBlob(resumeId, cachedBlob);
    return;
  }

  resumeThumbLoading.add(resumeId);
  try {
    await getResumeImageBlob(resumeId);
  } catch {
    // 缩略图失败不影响主流程，保留占位态
  } finally {
    resumeThumbLoading.delete(resumeId);
  }
}

async function copyResumeImage(resumeId: number): Promise<void> {
  const endpoint = buildResumeImageEndpoint(resumeId);

  const cachedBlob = resumeImageBlobCache.get(resumeId);
  try {
    if (cachedBlob) {
      await copyBlobToClipboard(cachedBlob);
      await maybeDownloadResumeImageAfterCopy(resumeId, cachedBlob);
      return;
    }

    const liveBlobPromise = getResumeImageBlob(resumeId);
    await copyBlobToClipboard(liveBlobPromise);
    await maybeDownloadResumeImageAfterCopy(resumeId, liveBlobPromise);
    return;
  } catch (error: unknown) {
    if (isClipboardFocusError(error)) {
      try {
        const retrySource = cachedBlob || getResumeImageBlob(resumeId);
        if (!document.hasFocus()) {
          await requestDrawerHostFocus();
          try {
            window.focus();
          } catch {
            // ignore focus failures and let retry decide
          }
        }

        await copyBlobToClipboard(retrySource);
        await maybeDownloadResumeImageAfterCopy(resumeId, retrySource);
        return;
      } catch (retryError: unknown) {
        if (!isClipboardFocusError(retryError)) {
          throw retryError;
        }

        await copyImageViaBackground(endpoint);
        void ensureResumeThumbnail(resumeId);
        await maybeDownloadResumeImageAfterCopy(resumeId, cachedBlob || getResumeImageBlob(resumeId));
        return;
      }
    }

    if (isClipboardPermissionPolicyBlocked(error)) {
      await copyImageViaBackground(endpoint);
      void ensureResumeThumbnail(resumeId);
      await maybeDownloadResumeImageAfterCopy(resumeId, cachedBlob || getResumeImageBlob(resumeId));
      return;
    }

    throw error;
  }
}

function getSelectedResumeId(): number | null {
  return selectedResumeId;
}

async function previewSelectedResume(): Promise<void> {
  const resumeId = getSelectedResumeId();
  if (!resumeId) {
    showMessage("请先选择一份简历", "error");
    return;
  }

  await openResumePreview(resumeId);
}

async function copySelectedResumeImage(): Promise<void> {
  const resumeId = getSelectedResumeId();
  if (!resumeId) {
    showMessage("请先选择一份简历", "error");
    return;
  }

  copySelectedResumeBtn.disabled = true;
  const previousText = copySelectedResumeBtn.textContent;
  copySelectedResumeBtn.textContent = "复制中...";

  try {
    await copyResumeImage(resumeId);
    showMessage("复制成功", "success");
  } catch (error: unknown) {
    const text = safeExtensionError(error, "复制失败");
    showMessage(`复制失败：${text}`, "error");
  } finally {
    copySelectedResumeBtn.disabled = false;
    copySelectedResumeBtn.textContent = previousText || "复制发送";
  }
}

function setServiceStatus(text: string, mode: "pending" | "ok" | "error"): void {
  serviceStatusEl.textContent = text;
  serviceStatusDotEl.classList.remove("ok", "err");
  if (mode === "ok") {
    serviceStatusDotEl.classList.add("ok");
  }
  if (mode === "error") {
    serviceStatusDotEl.classList.add("err");
  }
}

async function checkServerConnection(): Promise<void> {
  const serverUrl = getServerUrl();
  serverUrlInput.value = serverUrl;
  setServiceStatus("检查中...", "pending");
  try {
    const health = await fetchJson<{
      status: string;
      service: string;
      runtime: string;
    }>(`${serverUrl}/api/health`);
    if (health.status !== "ok" || health.service !== "OfferU" || health.runtime !== "python") {
      throw new Error("OfferU 后端健康检查失败");
    }
    setServiceStatus(`连接正常：${health.service} (${health.status})`, "ok");
  } catch {
    setServiceStatus("连接失败：请先启动 OfferU 后端服务", "error");
  }
}

function setAiServiceStatus(text: string, mode: "pending" | "ok" | "error"): void {
  aiServiceStatusEl.textContent = text;
  aiServiceStatusDotEl.classList.remove("ok", "err");
  if (mode === "ok") {
    aiServiceStatusDotEl.classList.add("ok");
  }
  if (mode === "error") {
    aiServiceStatusDotEl.classList.add("err");
  }
}

function applySmartFillSettingsToUi(): void {
  aiSmartFillToggle.checked = smartFillSettings.enabled;
  aiProviderSelect.value = smartFillSettings.provider || DEFAULT_SMART_FILL_SETTINGS.provider;
  aiBaseUrlInput.value = smartFillSettings.baseUrl || "";
  aiApiKeyInput.value = smartFillSettings.apiKey || "";
  aiModelInput.value = smartFillSettings.model || "";
  aiFallbackToggle.checked = smartFillSettings.enableFallback;

  if (!smartFillSettings.enabled) {
    setAiServiceStatus("未启用", "pending");
    return;
  }

  const configured = Boolean(
    smartFillSettings.baseUrl.trim()
    && smartFillSettings.apiKey.trim()
    && smartFillSettings.model.trim(),
  );
  if (configured) {
    setAiServiceStatus("已配置", "ok");
  } else {
    setAiServiceStatus("未完整配置，将走后端通道", "pending");
  }
}

async function loadSmartFillSettingsFromBackground(): Promise<void> {
  try {
    const response = await sendBackgroundMessage<{ ok: boolean; settings?: SmartFillAiSettings }>({
      type: "GET_SMART_FILL_SETTINGS",
    });
    if (!response?.ok || !response.settings) {
      smartFillSettings = { ...DEFAULT_SMART_FILL_SETTINGS };
    } else {
      smartFillSettings = {
        ...DEFAULT_SMART_FILL_SETTINGS,
        ...response.settings,
      };
    }
  } catch {
    smartFillSettings = { ...DEFAULT_SMART_FILL_SETTINGS };
  }

  applySmartFillSettingsToUi();
}

async function saveSmartFillSettingsToBackground(): Promise<void> {
  smartFillSettings = {
    enabled: aiSmartFillToggle.checked,
    provider: aiProviderSelect.value.trim() || DEFAULT_SMART_FILL_SETTINGS.provider,
    baseUrl: aiBaseUrlInput.value.trim(),
    apiKey: aiApiKeyInput.value.trim(),
    model: aiModelInput.value.trim(),
    enableFallback: aiFallbackToggle.checked,
  };

  await sendBackgroundMessage<{ ok: boolean }>({
    type: "SAVE_SMART_FILL_SETTINGS",
    settings: smartFillSettings,
  });
  applySmartFillSettingsToUi();
}

async function requestSmartFillHostPermissionIfNeeded(baseUrl: string): Promise<void> {
  const normalizedBaseUrl = baseUrl.trim();
  if (!normalizedBaseUrl) return;
  let parsed: URL;
  try {
    parsed = new URL(normalizedBaseUrl);
  } catch {
    throw new Error("AI 服务地址格式不正确");
  }

  const originPattern = `${parsed.protocol}//${parsed.host}/*`;
  const chromeWithPermissions = chrome as typeof chrome & {
    permissions?: {
      contains: (permissions: { origins?: string[] }) => Promise<boolean>;
      request: (permissions: { origins?: string[] }) => Promise<boolean>;
    };
  };

  if (!chromeWithPermissions.permissions) return;
  // Keep request in the same user-gesture task. Awaiting `contains` first
  // may lose gesture context in some Chromium builds.
  const granted = await chromeWithPermissions.permissions.request({ origins: [originPattern] });
  if (granted) return;

  const hasPermission = await chromeWithPermissions.permissions.contains({ origins: [originPattern] });
  if (!hasPermission) {
    throw new Error("用户未授予目标 AI 服务地址权限");
  }
}

async function checkSmartFillAiConnection(): Promise<void> {
  setAiServiceStatus("检查中...", "pending");
  try {
    const response = await sendBackgroundMessage<{
      ok: boolean;
      channel: "plugin-direct" | "backend" | "none";
      fallbackUsed: boolean;
      error?: string;
    }>({
      type: "CHECK_SMART_FILL_AI_CONNECTION",
    });

    if (!response.ok) {
      setAiServiceStatus(`连接失败：${response.error || "未知错误"}`, "error");
      return;
    }

    const suffix = response.fallbackUsed ? "（已自动切换）" : "";
    const channelText = response.channel === "plugin-direct"
      ? "插件直连"
      : response.channel === "backend"
        ? "后端通道"
        : "未知通道";
    setAiServiceStatus(`连接成功：${channelText}${suffix}`, "ok");
  } catch (error: unknown) {
    const text = safeExtensionError(error, "未知错误");
    setAiServiceStatus(`连接失败：${text}`, "error");
  }
}

function openFeedbackModal(): void {
  feedbackModal.classList.remove("hidden");
  feedbackModal.setAttribute("aria-hidden", "false");
  window.setTimeout(() => {
    feedbackContentInput.focus();
  }, 0);
}

function closeFeedbackModal(): void {
  feedbackModal.classList.add("hidden");
  feedbackModal.setAttribute("aria-hidden", "true");
}

function openSupportedPlatformsModal(): void {
  supportedPlatformsModal.classList.remove("hidden");
  supportedPlatformsModal.setAttribute("aria-hidden", "false");
}

function closeSupportedPlatformsModal(): void {
  supportedPlatformsModal.classList.add("hidden");
  supportedPlatformsModal.setAttribute("aria-hidden", "true");
}

function storeOfflineFeedback(payload: { content: string; contact: string; created_at: string }): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.get(["offlineFeedbackQueueV1"], (result) => {
      const existing = Array.isArray(result.offlineFeedbackQueueV1)
        ? (result.offlineFeedbackQueueV1 as Array<Record<string, unknown>>)
        : [];
      const next = [
        ...existing,
        {
          ...payload,
          source: "extension_popup",
        },
      ].slice(-30);

      chrome.storage.local.set({ offlineFeedbackQueueV1: next }, () => {
        resolve();
      });
    });
  });
}

async function submitFeedback(): Promise<void> {
  const content = feedbackContentInput.value.trim();
  const contact = feedbackContactInput.value.trim();
  if (!content) {
    showMessage("请先填写反馈内容", "error");
    feedbackContentInput.focus();
    return;
  }

  submitFeedbackBtn.disabled = true;
  const previousText = submitFeedbackBtn.textContent;
  submitFeedbackBtn.textContent = "提交中...";

  const payload = {
    content,
    contact,
    created_at: new Date().toISOString(),
  };

  let submitted = false;
  try {
    const response = await fetch(`${getServerUrl()}/api/feedback`, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    submitted = response.ok;
  } catch {
    submitted = false;
  }

  if (!submitted) {
    await storeOfflineFeedback(payload);
  }

  feedbackContentInput.value = "";
  feedbackContactInput.value = "";
  closeFeedbackModal();
  showMessage(submitted ? "反馈提交成功，感谢你的建议" : "反馈已离线暂存，后端恢复后可统一上报", "success");

  submitFeedbackBtn.disabled = false;
  submitFeedbackBtn.textContent = previousText || "提交反馈";
}

function resolveLatestVersionPayload(payload: unknown): { latestVersion: string; downloadUrl?: string } | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const value = payload as Record<string, unknown>;
  const latest = typeof value.latest_version === "string"
    ? value.latest_version
    : typeof value.version === "string"
      ? value.version
      : "";

  if (!latest) {
    return null;
  }

  const rawDownloadUrl = typeof value.download_url === "string"
    ? value.download_url
    : typeof value.url === "string"
      ? value.url
      : undefined;

  return {
    latestVersion: latest,
    downloadUrl: normalizeReleaseDownloadUrl(rawDownloadUrl),
  };
}

function normalizeReleaseDownloadUrl(input: unknown): string | undefined {
  if (typeof input !== "string" || !input.trim()) return undefined;

  try {
    const parsed = new URL(input.trim());
    const hostname = parsed.hostname.toLowerCase();
    if (
      parsed.protocol !== "https:"
      || parsed.username
      || parsed.password
      || parsed.port
      || hostname === "localhost"
      || hostname.endsWith(".localhost")
      || hostname === "127.0.0.1"
      || hostname === "[::1]"
      || hostname === "0.0.0.0"
    ) {
      return undefined;
    }
    return parsed.href;
  } catch {
    return undefined;
  }
}

async function checkExtensionUpdate(): Promise<void> {
  const currentVersion = chrome.runtime.getManifest().version;
  updateStatusTextEl.textContent = `当前版本：v${currentVersion}（检查中）`;
  checkUpdateBtn.disabled = true;

  try {
    const payload = await fetchJson<unknown>(`${getServerUrl()}/api/extension/version`);
    const versionInfo = resolveLatestVersionPayload(payload);

    if (!versionInfo) {
      updateStatusTextEl.textContent = `当前版本：v${currentVersion}（更新源返回异常）`;
      showMessage("更新服务响应异常，请稍后重试", "error");
      return;
    }

    const diff = compareSemver(versionInfo.latestVersion, currentVersion);
    if (diff <= 0) {
      updateStatusTextEl.textContent = `当前版本：v${currentVersion}（已是最新版本）`;
      showMessage("已是最新版本", "success");
      return;
    }

    updateStatusTextEl.textContent = `发现新版本：v${versionInfo.latestVersion}`;
    showMessage(`发现新版本 v${versionInfo.latestVersion}`, "info");

    if (!versionInfo.downloadUrl && (typeof (payload as Record<string, unknown>).download_url === "string" || typeof (payload as Record<string, unknown>).url === "string")) {
      showMessage("更新地址不安全，已停止打开浏览器窗口", "error");
      return;
    }

    if (versionInfo.downloadUrl && window.confirm("检测到新版本，是否立即打开更新页面？")) {
      void chrome.tabs.create({ url: versionInfo.downloadUrl });
    }
  } catch {
    updateStatusTextEl.textContent = `当前版本：v${currentVersion}（未连接更新服务）`;
    showMessage("检查更新失败：未连接到更新服务", "error");
  } finally {
    checkUpdateBtn.disabled = false;
  }
}

function updateSegmentSelection(buttons: HTMLButtonElement[], selectedValue: string, key: string): void {
  buttons.forEach((button) => {
    const value = button.dataset[key] || "";
    button.classList.toggle("active", value === selectedValue);
  });
}

function applyUiSettings(): void {
  autoSyncToggle.checked = uiSettings.autoSync;
  copyAndDownloadPngToggle.checked = uiSettings.copyAndDownloadPng;
  updateSegmentSelection(themeButtons, uiSettings.theme, "theme");
  applyThemeToDocument();
  refreshShortcutButtons();
}

function saveUiSettings(): void {
  chrome.storage.local.set({ [UI_SETTINGS_KEY]: uiSettings });
}

function saveShortcutSettings(): void {
  chrome.storage.local.set({ [SHORTCUT_SETTINGS_KEY]: shortcutSettings });
}

function loadSettings(): Promise<{
  serverUrl: string;
  ui: PopupUiSettings;
  shortcuts: ShortcutSettings;
  desktop: DesktopOpenSettings;
}> {
  return new Promise((resolve) => {
    chrome.storage.local.get([SETTINGS_KEY, UI_SETTINGS_KEY, SHORTCUT_SETTINGS_KEY, DESKTOP_OPEN_SETTINGS_KEY], (result) => {
      const settings = (result[SETTINGS_KEY] || {}) as { serverUrl?: string };
      const ui = (result[UI_SETTINGS_KEY] || {}) as Partial<PopupUiSettings>;
      const shortcuts = (result[SHORTCUT_SETTINGS_KEY] || {}) as Partial<ShortcutSettings>;
      const desktop = (result[DESKTOP_OPEN_SETTINGS_KEY] || {}) as Partial<DesktopOpenSettings>;

      resolve({
        serverUrl: normalizeServerUrl(settings.serverUrl || DEFAULT_SERVER_URL),
        ui: {
          autoSync: typeof ui.autoSync === "boolean" ? ui.autoSync : DEFAULT_UI_SETTINGS.autoSync,
          copyAndDownloadPng:
            typeof ui.copyAndDownloadPng === "boolean"
              ? ui.copyAndDownloadPng
              : DEFAULT_UI_SETTINGS.copyAndDownloadPng,
          theme:
            ui.theme === "light" || ui.theme === "dark" || ui.theme === "system"
              ? ui.theme
              : DEFAULT_UI_SETTINGS.theme,
        },
        shortcuts: {
          collect: normalizeShortcutString(shortcuts.collect || DEFAULT_SHORTCUT_SETTINGS.collect),
          sync: normalizeShortcutString(shortcuts.sync || DEFAULT_SHORTCUT_SETTINGS.sync),
          settings: normalizeShortcutString(shortcuts.settings || DEFAULT_SHORTCUT_SETTINGS.settings),
        },
        desktop: normalizeDesktopOpenSettings(desktop),
      });
    });
  });
}

function saveServerSettings(): void {
  const normalized = normalizeServerUrl(serverUrlInput.value);
  serverUrlInput.value = normalized;

  chrome.storage.local.set({ [SETTINGS_KEY]: { serverUrl: normalized } }, () => {
    showMessage("设置已保存", "success");
  });
}

function bindTabEvents(): void {
  tabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const tab = (button.dataset.tab || "cart") as TabKey;
      activateTab(tab);
    });
  });
}

function bindCartEvents(): void {
  cartFilterBtn.addEventListener("click", () => {
    cartFilterVisible = !cartFilterVisible;
    syncCartFilterControls();
    showMessage(cartFilterVisible ? "已展开岗位筛选" : "已收起岗位筛选", "info");
  });

  jobResetFilterBtn.addEventListener("click", () => {
    resetJobFilters();
  });

  jobTimeFilter.addEventListener("change", () => {
    const next = jobTimeFilter.value as TimeRangeFilter;
    jobFilters.time = next;
    jobCustomRange.classList.toggle("hidden", next !== "custom");
    renderJobs();
  });

  jobDateStartInput.addEventListener("change", () => {
    jobFilters.startDate = jobDateStartInput.value;
    renderJobs();
  });

  jobDateEndInput.addEventListener("change", () => {
    jobFilters.endDate = jobDateEndInput.value;
    renderJobs();
  });

  jobPlatformFilter.addEventListener("change", () => {
    const next = jobPlatformFilter.value as JobPlatformFilter;
    jobFilters.platform = next;
    renderJobs();
  });

  jobSalaryFilter.addEventListener("change", () => {
    const next = jobSalaryFilter.value as JobSalaryFilter;
    jobFilters.salary = next;
    renderJobs();
  });

  jobCityFilter.addEventListener("input", () => {
    jobFilters.city = jobCityFilter.value;
    renderJobs();
  });

  jobHotCityRow.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const chip = target.closest<HTMLButtonElement>("button[data-city]");
    if (!chip) return;
    jobFilters.city = chip.dataset.city || "";
    jobCityFilter.value = jobFilters.city;
    renderJobs();
  });

  clearBtn.addEventListener("click", () => {
    void clearJobs();
  });

  addCurrentBtn.addEventListener("click", () => {
    void collectCurrentPageJob();
  });

  syncBtn.addEventListener("click", () => {
    void syncJobs();
  });

  jobListEl.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;

    const pickButton = target.closest<HTMLButtonElement>("button[data-job-pick]");
    if (pickButton) {
      const hash = pickButton.dataset.jobPick || "";
      toggleJobSelection(hash);
      return;
    }

    const card = target.closest<HTMLElement>("[data-job-hash]");
    if (!card) return;
    const hash = card.dataset.jobHash || "";
    toggleJobSelection(hash);
  });
}

function bindResumeEvents(): void {
  resumeSearchToggleBtn.addEventListener("click", () => {
    const hidden = resumeSearchRow.classList.toggle("hidden");
    if (!hidden) {
      resumeSearchInput.focus();
    }
  });

  resumeSearchInput.addEventListener("input", () => {
    renderResumes();
  });

  resumeSearchClearBtn.addEventListener("click", () => {
    resumeSearchInput.value = "";
    renderResumes();
    resumeSearchInput.focus();
  });

  resumeSortBtn.addEventListener("click", () => {
    resumeFilterVisible = !resumeFilterVisible;
    syncResumeFilterControls();
    showMessage(resumeFilterVisible ? "已展开简历筛选" : "已收起简历筛选", "info");
  });

  resumeTimeFilter.addEventListener("change", () => {
    const next = resumeTimeFilter.value as TimeRangeFilter;
    resumeFilters.time = next;
    resumeCustomRange.classList.toggle("hidden", next !== "custom");
    renderResumes();
  });

  resumeDateStartInput.addEventListener("change", () => {
    resumeFilters.startDate = resumeDateStartInput.value;
    renderResumes();
  });

  resumeDateEndInput.addEventListener("change", () => {
    resumeFilters.endDate = resumeDateEndInput.value;
    renderResumes();
  });

  resumeResetFilterBtn.addEventListener("click", () => {
    resetResumeFilters();
  });

  previewResumeBtn.addEventListener("click", () => {
    void previewSelectedResume();
  });

  copySelectedResumeBtn.addEventListener("click", () => {
    void copySelectedResumeImage();
  });

  openDesktopResumeBtn.addEventListener("click", () => {
    void openDesktopTarget();
  });

  resumeListEl.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;

    const previewButton = target.closest<HTMLButtonElement>("button[data-preview-resume]");
    if (previewButton) {
      const resumeId = Number(previewButton.dataset.previewResume || "0");
      if (resumeId > 0) {
        selectedResumeId = resumeId;
        void previewSelectedResume();
      }
      return;
    }

    const card = target.closest<HTMLElement>("[data-resume-id]");
    if (!card) return;

    const resumeId = Number(card.dataset.resumeId || "0");
    if (resumeId <= 0) return;

    selectedResumeId = resumeId;
    renderResumes();
  });
}

function bindModalEvents(): void {
  closeResumePreviewBtn.addEventListener("click", closeResumeModal);
  closeResumePreviewBtn2.addEventListener("click", closeResumeModal);

  resumePreviewModal.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.matches("[data-close-modal='1']")) {
      closeResumeModal();
    }
  });

  copyResumeModalBtn.addEventListener("click", () => {
    const resumeId = getSelectedResumeId();
    if (!resumeId) {
      showMessage("请先选择一份简历", "error");
      return;
    }

    copyResumeModalBtn.disabled = true;
    const previousText = copyResumeModalBtn.textContent;
    copyResumeModalBtn.textContent = "复制中...";

    void (async () => {
      try {
        await copyResumeImage(resumeId);
        showMessage("复制成功", "success");
      } catch (error: unknown) {
        const text = safeExtensionError(error, "复制失败");
        showMessage(`复制失败：${text}`, "error");
      } finally {
        copyResumeModalBtn.disabled = false;
        copyResumeModalBtn.textContent = previousText || "复制简历图片";
      }
    })();
  });

  closeFeedbackBtn.addEventListener("click", closeFeedbackModal);
  cancelFeedbackBtn.addEventListener("click", closeFeedbackModal);

  feedbackModal.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.matches("[data-close-feedback='1']")) {
      closeFeedbackModal();
    }
  });

  closeSupportedPlatformsBtn.addEventListener("click", closeSupportedPlatformsModal);
  closeSupportedPlatformsBtn2.addEventListener("click", closeSupportedPlatformsModal);
  supportedPlatformsModal.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.matches("[data-close-platforms='1']")) {
      closeSupportedPlatformsModal();
    }
  });
}

function bindSettingsEvents(): void {
  autoSyncToggle.addEventListener("change", () => {
    uiSettings.autoSync = autoSyncToggle.checked;
    saveUiSettings();
  });

  copyAndDownloadPngToggle.addEventListener("change", () => {
    uiSettings.copyAndDownloadPng = copyAndDownloadPngToggle.checked;
    saveUiSettings();
    showMessage(
      uiSettings.copyAndDownloadPng
        ? "已开启：复制后同时下载 PNG"
        : "已关闭：复制后不下载图片",
      "info",
    );
  });

  themeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const theme = button.dataset.theme as UiTheme | undefined;
      if (!theme) return;
      uiSettings.theme = theme;
      applyUiSettings();
      saveUiSettings();
    });
  });

  shortcutButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.shortcutAction as keyof ShortcutSettings | undefined;
      if (!action) return;
      shortcutCaptureAction = action;
      refreshShortcutButtons();
      showMessage("请按下新的组合键，按 Esc 清空", "info");
    });
  });

  document.addEventListener("keydown", (event) => {
    if (!shortcutCaptureAction) return;
    event.preventDefault();
    event.stopPropagation();

    if (event.key === "Escape") {
      shortcutSettings[shortcutCaptureAction] = "";
      saveShortcutSettings();
      shortcutCaptureAction = null;
      refreshShortcutButtons();
      showMessage("快捷键已清空", "info");
      return;
    }

    const nextShortcut = shortcutFromKeyboardEvent(event);
    if (!nextShortcut) return;

    const duplicateAction = (Object.keys(shortcutSettings) as Array<keyof ShortcutSettings>).find(
      (key) => key !== shortcutCaptureAction && shortcutSettings[key] === nextShortcut,
    );

    if (duplicateAction) {
      showMessage("该组合键已被其他动作占用", "error");
      return;
    }

    shortcutSettings[shortcutCaptureAction] = nextShortcut;
    saveShortcutSettings();
    shortcutCaptureAction = null;
    refreshShortcutButtons();
    showMessage(`快捷键已更新：${nextShortcut}`, "success");
  });

  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!shortcutCaptureAction) return;
      const target = event.target as HTMLElement;
      if (target.closest(".shortcut-btn")) return;
      shortcutCaptureAction = null;
      refreshShortcutButtons();
    },
    true,
  );

  saveSettingsBtn.addEventListener("click", () => {
    saveServerSettings();
  });

  checkServerBtn.addEventListener("click", () => {
    void checkServerConnection();
  });

  aiSmartFillToggle.addEventListener("change", () => {
    smartFillSettings.enabled = aiSmartFillToggle.checked;
    applySmartFillSettingsToUi();
  });

  aiProviderSelect.addEventListener("change", () => {
    smartFillSettings.provider = aiProviderSelect.value.trim();
  });

  aiFallbackToggle.addEventListener("change", () => {
    smartFillSettings.enableFallback = aiFallbackToggle.checked;
  });

  saveAiSettingsBtn.addEventListener("click", () => {
    void (async () => {
      try {
        const baseUrl = aiBaseUrlInput.value.trim();
        if (baseUrl) {
          await requestSmartFillHostPermissionIfNeeded(baseUrl);
        }
        await saveSmartFillSettingsToBackground();
        showMessage("AI 服务设置已保存", "success");
      } catch (error: unknown) {
        const text = safeExtensionError(error, "保存失败");
        showMessage(`AI 服务设置保存失败：${text}`, "error");
      }
    })();
  });

  checkAiConnectionBtn.addEventListener("click", () => {
    void (async () => {
      try {
        const baseUrl = aiBaseUrlInput.value.trim();
        if (baseUrl) {
          await requestSmartFillHostPermissionIfNeeded(baseUrl);
        }
        await saveSmartFillSettingsToBackground();
      } catch (error: unknown) {
        const text = safeExtensionError(error, "权限申请失败");
        setAiServiceStatus(`连接失败：${text}`, "error");
        return;
      }
      await checkSmartFillAiConnection();
    })();
  });

  feedbackBtn.addEventListener("click", () => {
    openFeedbackModal();
  });

  supportedPlatformsBtn.addEventListener("click", () => {
    openSupportedPlatformsModal();
  });

  submitFeedbackBtn.addEventListener("click", () => {
    void submitFeedback();
  });

  checkUpdateBtn.addEventListener("click", () => {
    void checkExtensionUpdate();
  });

  desktopModeDockerRadio.addEventListener("change", () => {
    if (!desktopModeDockerRadio.checked) return;
    desktopOpenSettings.mode = "docker";
    syncDesktopOpenControls();
    saveDesktopOpenSettings();
  });

  desktopModeAppRadio.addEventListener("change", () => {
    if (!desktopModeAppRadio.checked) return;
    desktopOpenSettings.mode = "app";
    syncDesktopOpenControls();
    saveDesktopOpenSettings();
  });

  saveDesktopDockerPortBtn.addEventListener("click", () => {
    desktopOpenSettings.dockerPort = normalizeDockerPort(desktopDockerPortInput.value);
    syncDesktopOpenControls();
    saveDesktopOpenSettings(true);
  });

  checkDesktopDockerBtn.addEventListener("click", () => {
    void checkDesktopDockerConnection();
  });

  browseDesktopAppPathBtn.addEventListener("click", async () => {
    const pickerWindow = window as Window & {
      showDirectoryPicker?: () => Promise<{ name: string }>;
    };

    if (typeof pickerWindow.showDirectoryPicker === "function") {
      try {
        const directoryHandle = await pickerWindow.showDirectoryPicker();
        desktopAppPathInput.value = directoryHandle.name || "";
        showMessage("已选择文件夹，请补充完整本地路径后保存", "info");
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        showMessage("目录选择器不可用，已切换兼容模式", "info");
      }
    }

    desktopAppPathPicker.value = "";
    desktopAppPathPicker.click();
  });

  desktopAppPathPicker.addEventListener("change", () => {
    const file = desktopAppPathPicker.files?.[0] as (File & { webkitRelativePath?: string }) | undefined;
    if (!file) return;

    const absoluteDirectory = extractAbsoluteDirectoryFromPickerFile(file as File & { path?: string; webkitRelativePath?: string });
    if (absoluteDirectory) {
      desktopAppPathInput.value = absoluteDirectory;
      showMessage("已选择文件夹路径，可直接保存", "success");
      return;
    }

    const pickedFolder = (file.webkitRelativePath || "").split("/")[0] || "";
    if (pickedFolder) {
      desktopAppPathInput.value = pickedFolder;
    }
    showMessage("已选择文件夹，请补充为完整本地路径后保存", "info");
  });

  saveDesktopAppPathBtn.addEventListener("click", () => {
    desktopOpenSettings.appPath = desktopAppPathInput.value.trim();
    syncDesktopOpenControls();
    saveDesktopOpenSettings(true);
  });
}

function bindGlobalEvents(): void {
  openDesktopFooterBtn.addEventListener("click", () => {
    void openDesktopTarget();
  });

  systemDarkMedia.addEventListener("change", () => {
    if (uiSettings.theme === "system") {
      applyThemeToDocument();
    }
  });

  if (EMBED_MODE) {
    openServerBtn.textContent = "↙";
    openServerBtn.setAttribute("aria-label", "收起弹窗");
    openServerBtn.addEventListener("click", () => {
      window.parent.postMessage(
        { type: "offeru:drawer-close", reason: DRAWER_CLOSE_REASON_BUTTON },
        "*",
      );
    });

    initDrawerDragBridge();
    return;
  }

  openServerBtn.addEventListener("click", () => {
    // This is a user-triggered web navigation; readiness is checked first so a
    // stopped local service never creates a broken browser tab.
    void openOfferUFrontend();
  });
}

function bindStorageSyncEvents(): void {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (!changes[JOBS_KEY]) return;

    scheduleStatusRefresh();
  });
}

async function bootstrap(): Promise<void> {
  bindTabEvents();
  bindCartEvents();
  bindResumeEvents();
  bindModalEvents();
  ensureThemeControls();
  bindSettingsEvents();
  bindGlobalEvents();
  bindStorageSyncEvents();

  syncResumeFilterControls();
  syncCartFilterControls();
  syncJobFilterControls();
  updateStatusTextEl.textContent = `当前版本：v${chrome.runtime.getManifest().version}`;

  const loaded = await loadSettings();
  serverUrlInput.value = loaded.serverUrl;
  uiSettings = loaded.ui;
  shortcutSettings = loaded.shortcuts;
  desktopOpenSettings = loaded.desktop;
  applyUiSettings();
  await loadSmartFillSettingsFromBackground();
  syncDesktopOpenControls();
  setDesktopDockerStatus("未检测", "pending");

  activateTab(resolveInitialTab());
  await refreshStatus();
  void checkServerConnection();
}

void bootstrap().catch((error: unknown) => {
  const text = safeExtensionError(error, "扩展初始化失败");
  // eslint-disable-next-line no-console
  console.error("[OfferU Popup] bootstrap failed:", text);
  try {
    if (messageEl) {
      messageEl.textContent = `插件启动失败：${text}`;
      messageEl.className = "message error";
      return;
    }
  } catch {
    // ignore render failures
  }
  document.body.innerHTML = `<div style="padding:12px;font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#b91c1c;">插件启动失败：${text}</div>`;
});
