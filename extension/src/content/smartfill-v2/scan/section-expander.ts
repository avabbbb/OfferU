// Dynamic section expansion — auto-clicks edit/add buttons on collapsed card UIs
// Safety-first: explicitly excludes upload/file buttons that could trigger native OS file dialogs
import type { NormalizedProfile } from "../core/types.js";
import type { AddButtonInstruction } from "../ats/adapters/adapter.interface.js";
import { FIELD_SCAN } from "../shared/constants.js";
import { normalizeText } from "../shared/text-utils.js";

function clickInMainWorld(element: HTMLElement): boolean {
  try {
    const rect = element.getBoundingClientRect();
    const clientX = rect.left + Math.max(0, rect.width) / 2;
    const clientY = rect.top + Math.max(0, rect.height) / 2;
    const down = { bubbles: true, cancelable: true, view: window, button: 0, buttons: 1, clientX, clientY };
    const up = { ...down, buttons: 0 };
    if (typeof PointerEvent !== "undefined") {
      element.dispatchEvent(new PointerEvent("pointerdown", down));
    }
    element.dispatchEvent(new MouseEvent("mousedown", down));
    element.dispatchEvent(new MouseEvent("mouseup", up));
    element.click();
    return true;
  } catch {
    try {
      element.click();
      return true;
    } catch {
      return false;
    }
  }
}

export interface ExpansionResult {
  expandedCount: number;
  expandedSections: string[];
}

const DEFAULT_EDIT_LABELS = ["编辑", "修改", "展开", "expand", "完善", "填写", "edit"];
const DEFAULT_ADD_LABELS = ["添加", "新增", "增加", "add", "+"];

const DEFAULT_SAVE_LABELS = ["保存", "确定", "完成", "save", "done", "ok", "提交"];

const UPLOAD_LABELS = ["上传", "附件", "文件", "简历", "upload", "attach", "file", "resume", "import", "导入"];

export async function expandEditableSections(options?: {
  editLabels?: string[];
  saveLabels?: string[];
  sectionExpandSelectors?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<ExpansionResult> {
  const editLabels = options?.editLabels || DEFAULT_EDIT_LABELS;
  const saveLabels = options?.saveLabels || DEFAULT_SAVE_LABELS;
  const expandedSections: string[] = [];
  let expandedCount = 0;

  const buttons = findEditButtons(editLabels, saveLabels);

  for (const btn of buttons) {
    if (expandedCount >= FIELD_SCAN.maxEditExpansions) break;
    if (options?.signal?.aborted) break;

    const buttonText = (btn.textContent || "").trim().toLowerCase();
    const isAddButton = DEFAULT_ADD_LABELS.some((l) => buttonText.includes(l.toLowerCase()));

    const container = btn.closest(
      "[class*=card], [class*=item], [class*=section], [class*=block], "
      + "[class*=collapse], [class*=panel], fieldset, details",
    );

    if (container && hasVisibleFormControls(container as HTMLElement) && !isAddButton) continue;

    if (!container) {
      const formArea = btn.closest("form, [role=form], [class*=form]");
      if (!formArea) continue;
    }

    if (wouldTriggerFileDialog(btn)) continue;

    btn.setAttribute("data-smartfill-edit-attempt", "true");

    try { btn.scrollIntoView({ block: "center", behavior: "smooth" }); } catch { /* keep click attempt */ }
    try {
      clickInMainWorld(btn);
      expandedCount++;
      const sectionLabel = resolveSectionLabel(btn);
      if (sectionLabel) expandedSections.push(sectionLabel);
      await sleep(FIELD_SCAN.expansionDelayMs);
    } catch { /* ignore click failures */ }
  }

  return { expandedCount, expandedSections };
}

const MAX_ADD_ENTRIES = 7;

const SECTION_CATEGORIES: Array<{ keys: string[]; labels: string[] }> = [
  { keys: ["education"], labels: ["教育经历", "教育背景", "学习经历"] },
  { keys: ["workExperiences"], labels: ["工作经历", "工作经验", "工作背景"] },
  { keys: ["internshipExperiences"], labels: ["实习经历", "实习经验"] },
  { keys: ["projects"], labels: ["项目经历", "项目经验"] },
  { keys: ["skills"], labels: ["技能", "技能特长", "专业技能"] },
  { keys: ["certificates"], labels: ["证书", "资格证书", "认证"] },
  { keys: ["awards"], labels: ["获奖经历", "荣誉奖项", "获奖情况"] },
  { keys: ["personalExperiences"], labels: ["个人经历", "校园经历", "社会实践"] },
];

const MODULE_NAME_TO_SECTION: Record<string, string[]> = {
  "教育经历": ["教育经历", "教育背景", "学习经历", "教育情况"],
  "教育背景": ["教育经历", "教育背景", "学习经历", "教育情况"],
  "工作经历": ["工作经历", "工作经验", "工作背景"],
  "工作经验": ["工作经历", "工作经验", "工作背景"],
  "实习经历": ["实习经历", "实习经验"],
  "实习经验": ["实习经历", "实习经验"],
  "项目经历": ["项目经历", "项目经验"],
  "项目经验": ["项目经历", "项目经验"],
  "技能": ["技能", "技能特长", "专业技能", "计算机技能", "技能爱好"],
  "技能特长": ["技能", "技能特长", "专业技能", "计算机技能", "技能爱好"],
  "专业技能": ["技能", "技能特长", "专业技能", "计算机技能", "技能爱好"],
  "计算机技能": ["技能", "技能特长", "专业技能", "计算机技能", "技能爱好"],
  "证书": ["证书", "资格证书", "认证"],
  "资格证书": ["证书", "资格证书", "认证"],
  "获奖经历": ["获奖经历", "荣誉奖项", "获奖情况", "获奖", "奖励荣誉", "获奖或社团职务"],
  "获奖": ["获奖经历", "荣誉奖项", "获奖情况", "获奖", "奖励荣誉", "获奖或社团职务"],
  "荣誉奖项": ["获奖经历", "荣誉奖项", "获奖情况", "获奖", "奖励荣誉", "获奖或社团职务"],
  "个人经历": ["个人经历", "校园经历", "社会实践"],
  "校园经历": ["个人经历", "校园经历", "社会实践"],
  "家庭关系": ["家庭关系", "亲属关系"],
  "语言能力": ["语言能力", "英语能力", "其他语言能力", "其他外语能力"],
  "英语能力": ["语言能力", "英语能力", "其他语言能力", "其他外语能力"],
  "其他语言能力": ["语言能力", "英语能力", "其他语言能力", "其他外语能力"],
  "其他外语能力": ["语言能力", "英语能力", "其他语言能力", "其他外语能力"],
  "论文": ["论文", "论文发表"],
  "论文发表": ["论文", "论文发表"],
  "专利": ["专利"],
  "作品": ["作品", "作品集", "作品集或附件"],
  "作品集或附件": ["作品", "作品集", "作品集或附件"],
  "求职意向": ["求职意向"],
  "自我评价": ["自我评价", "自我描述"],
  "自我描述": ["自我评价", "自我描述"],
};

export async function addNewEntries(
  profile: NormalizedProfile,
  options?: { signal?: AbortSignal },
): Promise<number> {
  let addedCount = 0;

  const categoryItemCounts = new Map<string, number>();
  for (const entry of profile.entries) {
    if (!entry.subsection) continue;
    const match = entry.subsection.match(/第(\d+)条/);
    if (!match) continue;
    const itemIndex = Number(match[1]);
    const key = entry.category;
    categoryItemCounts.set(key, Math.max(categoryItemCounts.get(key) || 0, itemIndex));
  }

  for (const section of SECTION_CATEGORIES) {
    let maxItemIndex = 0;
    for (const label of section.labels) {
      maxItemIndex = Math.max(maxItemIndex, categoryItemCounts.get(label) || 0);
    }
    if (maxItemIndex <= 1) continue;

    const existingSections = countExistingSections(section.labels);
    const toAdd = Math.min(maxItemIndex - existingSections, MAX_ADD_ENTRIES);
    if (toAdd <= 0) continue;

    for (let i = 0; i < toAdd; i++) {
      if (options?.signal?.aborted) break;
      const addBtn = findAddButtonInSection(section.labels);
      if (!addBtn) break;

      const prevCount = Number(addBtn.getAttribute("data-smartfill-add-count") || "0");
      addBtn.setAttribute("data-smartfill-add-count", String(prevCount + 1));
      try { addBtn.scrollIntoView({ block: "center", behavior: "smooth" }); } catch { /* keep click attempt */ }
      try {
        clickInMainWorld(addBtn);
        addedCount++;
        await sleep(FIELD_SCAN.expansionDelayMs);
      } catch { /* ignore */ }
    }
  }

  return addedCount;
}

export async function addNewEntriesFromModuleCount(
  moduleCountMap: Map<string, number>,
  options?: { signal?: AbortSignal; adapterAddInstructions?: AddButtonInstruction[] },
): Promise<number> {
  let addedCount = 0;
  const adapterInstructions = options?.adapterAddInstructions || [];

  for (const [moduleName, requiredCount] of moduleCountMap) {
    if (requiredCount <= 1) continue;

    let sectionLabels: string[] | null = MODULE_NAME_TO_SECTION[moduleName];
    if (!sectionLabels) {
      sectionLabels = fuzzyMatchModuleToSection(moduleName);
    }
    if (!sectionLabels) continue;

    const matchedInstruction = adapterInstructions.find((inst) =>
      inst.sectionLabels.some((l) => sectionLabels!.includes(l)),
    );

    const existingSections = countExistingSections(sectionLabels, matchedInstruction?.repeatItemSelector);
    const toAdd = Math.min(requiredCount - existingSections, MAX_ADD_ENTRIES);
    if (toAdd <= 0) continue;

    for (let i = 0; i < toAdd; i++) {
      if (options?.signal?.aborted) break;

      let addBtn: HTMLElement | null = null;

      if (matchedInstruction) {
        addBtn = findAddButtonViaAdapter(matchedInstruction, sectionLabels);
      }

      if (!addBtn) {
        addBtn = findAddButtonInSection(sectionLabels);
      }

      if (!addBtn) break;

      const prevCount = Number(addBtn.getAttribute("data-smartfill-add-count") || "0");
      addBtn.setAttribute("data-smartfill-add-count", String(prevCount + 1));
      try { addBtn.scrollIntoView({ block: "center", behavior: "smooth" }); } catch { /* keep click attempt */ }
      try {
        clickInMainWorld(addBtn);
        addedCount++;
        const waitMs = matchedInstruction?.waitForMs || FIELD_SCAN.expansionDelayMs;
        await sleep(waitMs);
      } catch { /* ignore */ }
    }
  }

  return addedCount;
}

function findAddButtonViaAdapter(
  instruction: AddButtonInstruction,
  sectionLabels: string[],
): HTMLElement | null {
  const sectionHeaders = document.querySelectorAll(instruction.sectionHeaderSelector);
  for (const header of sectionHeaders) {
    const headerEl = header as HTMLElement;
    const headerText = normalizeText(headerEl.textContent || "");
    if (!sectionLabels.some((label) => headerText.includes(label))) continue;

    const container = headerEl.closest(
      "[class*=card], [class*=section], section, [class*=block], [class*=module], "
      + "fieldset, form, [role=form], [class*=group], [class*=area], [class*=panel]",
    ) || headerEl.parentElement?.parentElement;
    if (!container) continue;

    const buttons = container.querySelectorAll(instruction.buttonSelector);
    for (const btn of buttons) {
      const btnEl = btn as HTMLElement;
      if (Number(btnEl.getAttribute("data-smartfill-add-count") || "0") >= MAX_ADD_ENTRIES) continue;
      if (btnEl.hasAttribute("data-smartfill-edit-attempt")) continue;

      const text = (btnEl.textContent || "").trim().toLowerCase();
      const isAdd = DEFAULT_ADD_LABELS.some((l) => text.includes(l.toLowerCase()));
      if (!isAdd) continue;

      const isSave = DEFAULT_SAVE_LABELS.some((l) => text.includes(l.toLowerCase()));
      if (isSave) continue;

      if (wouldTriggerFileDialog(btnEl)) continue;

      const rect = btnEl.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;

      return btnEl;
    }
  }
  return null;
}

function fuzzyMatchModuleToSection(moduleName: string): string[] | null {
  const normalized = moduleName.replace(/[（）()]/g, "").trim();
  if (normalized.length < 2) return null;
  for (const [key, labels] of Object.entries(MODULE_NAME_TO_SECTION)) {
    if (key.includes(normalized) || normalized.includes(key)) return labels;
    for (const label of labels) {
      if (label.length >= 2 && (label.includes(normalized) || normalized.includes(label))) return labels;
    }
  }
  return null;
}

function countExistingSections(sectionLabels: string[], adapterRepeatItemSelector?: string): number {
  const sectionContainers = findSectionContainers(sectionLabels);
  if (sectionContainers.length === 0) return 0;

  const FALLBACK_REPEAT_SELECTORS =
    "[class*=resume-item], [class*=experience-item], [class*=record-item],"
    + " [class*=card-item], [class*=resume-block], [class*=list-item],"
    + " [class*=form-item], [class*=entry], [class*=row], [class*=group]";

  let totalRepeatGroups = 0;
  for (const container of sectionContainers) {
    const repeatSelector = adapterRepeatItemSelector || FALLBACK_REPEAT_SELECTORS;
    const repeatItems = container.querySelectorAll(repeatSelector);
    let visibleRepeatCount = 0;
    for (const item of repeatItems) {
      const el = item as HTMLElement;
      if (hasVisibleFormControls(el)) visibleRepeatCount++;
    }
    if (visibleRepeatCount > 0) {
      totalRepeatGroups += visibleRepeatCount;
      continue;
    }

    const directControls = container.querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]):not([type="file"]),'
      + " textarea, select, [contenteditable=true]",
    );
    let hasVisible = false;
    for (const c of directControls) {
      const rect = (c as HTMLElement).getBoundingClientRect();
      if (rect.width > 0 || rect.height > 0) { hasVisible = true; break; }
    }
    if (hasVisible) totalRepeatGroups += 1;
  }

  return totalRepeatGroups;
}

function findSectionContainers(sectionLabels: string[]): HTMLElement[] {
  const results: HTMLElement[] = [];
  const allSections = document.querySelectorAll(
    "[class*=card], [class*=section], section, [class*=block], [class*=module], "
    + "fieldset, form, [role=form], [class*=group], [class*=area], [class*=panel]",
  );

  for (const section of allSections) {
    const el = section as HTMLElement;
    const heading = el.querySelector(
      "h1, h2, h3, h4, h5, [class*=title], [class*=header], [class*=heading], [class*=label]",
    );
    const text = normalizeText(heading?.textContent || el.textContent?.slice(0, 200) || "");
    if (sectionLabels.some((label) => text.includes(label))) {
      results.push(el);
    }
  }

  if (results.length === 0) {
    const headings = document.querySelectorAll(
      "h1, h2, h3, h4, h5, [class*=title], [class*=header], [class*=heading]",
    );
    for (const heading of headings) {
      const headingEl = heading as HTMLElement;
      const headingText = normalizeText(headingEl.textContent || "");
      if (!sectionLabels.some((label) => headingText.includes(label))) continue;

      const parent = headingEl.closest(
        "[class*=card], [class*=section], section, [class*=block], [class*=module], "
        + "fieldset, form, [role=form], [class*=group], [class*=area], [class*=panel]",
      ) || headingEl.parentElement;
      if (parent && !results.includes(parent as HTMLElement)) {
        results.push(parent as HTMLElement);
      }
    }
  }

  return results;
}

function findAddButtonInSection(sectionLabels: string[]): HTMLElement | null {
  const allButtons = document.querySelectorAll(
    "button, [role=button], a.btn, a[class*=btn], span[class*=btn], div[class*=btn], [class*=add], [class*=Add]",
  );

  const candidates: Array<{ el: HTMLElement; score: number }> = [];

  for (const btn of allButtons) {
    const el = btn as HTMLElement;
    if (Number(el.getAttribute("data-smartfill-add-count") || "0") >= MAX_ADD_ENTRIES) continue;
    if (el.hasAttribute("data-smartfill-edit-attempt")) continue;

    const text = (el.textContent || "").trim().toLowerCase();
    const isAdd = DEFAULT_ADD_LABELS.some((l) => text.includes(l.toLowerCase()));
    if (!isAdd) continue;

    const isSave = DEFAULT_SAVE_LABELS.some((l) => text.includes(l.toLowerCase()));
    if (isSave) continue;

    if (wouldTriggerFileDialog(el)) continue;

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;

    const section = el.closest(
      "[class*=card], [class*=section], section, [class*=block], [class*=module], "
      + "fieldset, form, [role=form], [class*=group], [class*=area], [class*=panel]",
    );
    if (section) {
      const sectionText = normalizeText(section.textContent || "");
      if (sectionLabels.some((label) => sectionText.includes(label))) {
        candidates.push({ el, score: 10 });
        continue;
      }
    }

    const prevSibling = el.previousElementSibling;
    if (prevSibling) {
      const prevText = normalizeText(prevSibling.textContent || "");
      if (sectionLabels.some((label) => prevText.includes(label))) {
        candidates.push({ el, score: 8 });
        continue;
      }
    }

    let ancestor = el.parentElement;
    for (let depth = 0; depth < 5 && ancestor; depth++, ancestor = ancestor.parentElement) {
      const ancestorText = normalizeText(ancestor.textContent || "");
      if (sectionLabels.some((label) => ancestorText.includes(label))) {
        candidates.push({ el, score: 5 - depth });
        break;
      }
    }

    for (const label of sectionLabels) {
      if (text.includes(label.toLowerCase())) {
        candidates.push({ el, score: 3 });
        break;
      }
    }
  }

  if (candidates.length === 0) {
    const sectionHeadings = document.querySelectorAll(
      "h1, h2, h3, h4, h5, [class*=title], [class*=header], [class*=heading], [class*=label]",
    );
    for (const heading of sectionHeadings) {
      const headingEl = heading as HTMLElement;
      const headingText = normalizeText(headingEl.textContent || "");
      if (!sectionLabels.some((label) => headingText.includes(label))) continue;

      const parent = headingEl.closest(
        "[class*=card], [class*=section], section, [class*=block], [class*=module], "
        + "fieldset, form, [role=form], [class*=group], [class*=area], [class*=panel]",
      ) || headingEl.parentElement;
      if (!parent) continue;

      const nearbyButtons = parent.querySelectorAll(
        "button, [role=button], a.btn, a[class*=btn], span[class*=btn], [class*=add], [class*=Add]",
      );
      for (const btn of nearbyButtons) {
        const btnEl = btn as HTMLElement;
        if (Number(btnEl.getAttribute("data-smartfill-add-count") || "0") >= MAX_ADD_ENTRIES) continue;
        if (btnEl.hasAttribute("data-smartfill-edit-attempt")) continue;

        const btnText = (btnEl.textContent || "").trim().toLowerCase();
        const isAdd = DEFAULT_ADD_LABELS.some((l) => btnText.includes(l.toLowerCase()));
        if (!isAdd) continue;

        const isSave = DEFAULT_SAVE_LABELS.some((l) => btnText.includes(l.toLowerCase()));
        if (isSave) continue;

        if (wouldTriggerFileDialog(btnEl)) continue;

        const btnRect = btnEl.getBoundingClientRect();
        if (btnRect.width === 0 && btnRect.height === 0) continue;

        candidates.push({ el: btnEl, score: 7 });
      }
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].el;
}

// --- Button discovery ---

function findEditButtons(
  editLabels: string[],
  saveLabels: string[],
): HTMLElement[] {
  const result: HTMLElement[] = [];
  const allButtons = document.querySelectorAll("button, [role=button], a.btn, a[class*=btn]");

  for (const btn of allButtons) {
    const el = btn as HTMLElement;
    if (el.hasAttribute("data-smartfill-edit-attempt")) continue;

    const text = (el.textContent || "").trim().toLowerCase();
    const isEdit = editLabels.some((l) => text.includes(l.toLowerCase()));
    const isAdd = DEFAULT_ADD_LABELS.some((l) => text.includes(l.toLowerCase()));
    const isSave = saveLabels.some((l) => text.includes(l.toLowerCase()));

    if (isAdd) continue;
    if (!isEdit || isSave) continue;

    const isUpload = UPLOAD_LABELS.some((l) => text.includes(l.toLowerCase()));
    if (isUpload) continue;

    if (isNearFileInput(el)) continue;

    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      result.push(el);
    }
  }

  return result;
}

// --- Safety checks ---

function isNearFileInput(element: HTMLElement): boolean {
  const container = element.closest("[class*=upload], [class*=file], [class*=attach], [class*=resume]");
  if (container?.querySelector('input[type="file"]')) return true;

  let parent = element.parentElement;
  for (let i = 0; parent && i < 3; i++, parent = parent.parentElement) {
    if (parent.querySelector('input[type="file"]')) return true;
  }

  const cls = (element.className || "").toString().toLowerCase();
  if (/upload|file-picker|attach/.test(cls)) return true;

  return false;
}

function wouldTriggerFileDialog(element: HTMLElement): boolean {
  if (element.tagName === "INPUT" && (element as HTMLInputElement).type === "file") return true;

  const hiddenFileInput = element.querySelector('input[type="file"]');
  if (hiddenFileInput) return true;

  const uploadContainer = element.closest(
    '[class*="upload"], [class*="Upload"], '
    + '[class*="file-picker"], [class*="FilePicker"], '
    + '[class*="attach"], [class*="Attach"]',
  );
  if (uploadContainer?.querySelector('input[type="file"]')) return true;

  return false;
}

// --- Visibility ---

function hasVisibleFormControls(container: HTMLElement): boolean {
  const controls = container.querySelectorAll(
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]):not([type="file"]),'
    + " textarea, select, [contenteditable=true]",
  );
  for (const c of controls) {
    const el = c as HTMLElement;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return true;
  }
  return false;
}

function resolveSectionLabel(button: HTMLElement): string {
  const container = button.closest("[class*=card], [class*=item], [class*=section]");
  if (container) {
    const heading = container.querySelector("h1, h2, h3, h4, h5, [class*=title], [class*=header]");
    if (heading) return (heading.textContent || "").trim().slice(0, 50);
  }
  return button.textContent?.trim().slice(0, 50) || "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const __SectionExpanderInternals = {
  findEditButtons,
  hasVisibleFormControls,
  isNearFileInput,
  wouldTriggerFileDialog,
  UPLOAD_LABELS,
  DEFAULT_EDIT_LABELS,
  DEFAULT_ADD_LABELS,
};
