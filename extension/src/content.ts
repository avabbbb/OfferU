// =============================================
// OfferU Extension — Content Script
// =============================================
// 悬浮入口：存为岗位抽屉入口 + smartfill 网申智填
// =============================================

/// <reference types="chrome" />

import { scanFieldsSync } from "./content/smartfill-v2/scan/scanner.js";
import {
  applyCriticalSmartFillPlan,
  prepareCriticalSmartFillPlan,
} from "./content/smartfill-v2/pipeline.js";
import { PendingFieldHighlighter } from "./content/smartfill-v2/ui/highlighter.js";
import { setDebugEnabled, logDebug as logSmartFillDebug } from "./content/smartfill-v2/shared/logger.js";
import type { CriticalSmartFillPlan, ScannedField } from "./content/smartfill-v2/core/types.js";
import { safeExtensionError } from "./lib/safe-error.js";
import {
  showToast as showSaveToast,
  snapshotPage,
  type PageSnapshot,
  type SavePageResult,
} from "./background/save-page-job.js";

const OFFERU_TOAST_ID = "offeru-ext-toast";
const FLOATING_DOCK_ID = "offeru-ext-floating-dock";
const FLOATING_DOCK_STORAGE_KEY = "offeru-ext-floating-dock-state-v1";
const PAGE_DRAWER_HOST_ID = "offeru-ext-page-drawer";
const POPUP_UI_SETTINGS_KEY = "popupUiSettings";
const SHORTCUT_SETTINGS_KEY = "shortcutSettingsV1";
const DRAWER_CLOSE_REASON_BUTTON = "close-button";

type DockSide = "left" | "right" | "top" | "bottom";
type DrawerTab = "cart" | "resumes" | "settings";

interface DrawerController {
  open: (tab: DrawerTab) => void;
  close: () => void;
  toggle: (tab?: DrawerTab) => void;
  isOpen: () => boolean;
}

interface FloatingDockState {
  side: DockSide;
  top: number;
  expanded: boolean;
  edgeDocked: boolean;
  left?: number;
}

type UiTheme = "light" | "dark" | "system";

interface PopupUiSettings {
  theme?: UiTheme;
}

interface ShortcutSettings {
  settings: string;
}

const DEFAULT_SHORTCUT_SETTINGS: ShortcutSettings = {
  settings: "Alt+O",
};

const DOCK_COMPACT_WIDTH = 200;
const DOCK_COMPACT_HEIGHT = 44;
const DOCK_EXPANDED_WIDTH = 260;
const DOCK_EXPANDED_HEIGHT = 50;
const DOCK_PANEL_WIDTH = 260;
const DOCK_PANEL_HEIGHT = 208;
const EDGE_DOCK_LENGTH_REDUCTION = 30;
const EDGE_DOCK_SIDE_WIDTH = Math.max(60, Math.round(DOCK_COMPACT_WIDTH / 2) - EDGE_DOCK_LENGTH_REDUCTION);
const EDGE_DOCK_SIDE_HEIGHT = DOCK_COMPACT_HEIGHT;
const EDGE_DOCK_TOP_BOTTOM_WIDTH = Math.max(60, Math.round(DOCK_COMPACT_WIDTH / 2) - EDGE_DOCK_LENGTH_REDUCTION);
const EDGE_DOCK_TOP_BOTTOM_HEIGHT = DOCK_COMPACT_HEIGHT;
const EDGE_DOCK_TOP_BOTTOM_RADIUS = 16;
const DOCK_EDGE_SNAP_DISTANCE = 56;
const DOCK_RIGHT_GAP = 16;

let drawerController: DrawerController | null = null;

function showToast(message: string, isError = false): void {
  const existing = document.getElementById(OFFERU_TOAST_ID);
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = OFFERU_TOAST_ID;
  toast.textContent = message;
  toast.style.position = "fixed";
  toast.style.top = "16px";
  toast.style.right = "16px";
  toast.style.zIndex = "2147483647";
  toast.style.padding = "10px 14px";
  toast.style.borderRadius = "8px";
  toast.style.background = isError ? "#b91c1c" : "#0f172a";
  toast.style.color = "#f8fafc";
  toast.style.fontSize = "13px";
  toast.style.boxShadow = "0 8px 20px rgba(0,0,0,0.25)";
  toast.style.maxWidth = "340px";
  document.body.appendChild(toast);

  window.setTimeout(() => toast.remove(), 2000);
}

function buildDrawerUrl(tab: DrawerTab): string {
  const query = new URLSearchParams({ tab, embed: "drawer" });
  return chrome.runtime.getURL(`popup.html?${query.toString()}`);
}

function ensurePageDrawer(): DrawerController {
  if (drawerController) return drawerController;

  const stale = document.getElementById(PAGE_DRAWER_HOST_ID);
  if (stale) {
    stale.remove();
  }

  const host = document.createElement("div");
  host.id = PAGE_DRAWER_HOST_ID;
  host.style.setProperty("position", "fixed", "important");
  host.style.setProperty("inset", "0", "important");
  host.style.setProperty("z-index", "2147483647", "important");
  host.style.setProperty("pointer-events", "none", "important");
  host.style.setProperty("display", "block", "important");
  host.style.setProperty("visibility", "visible", "important");
  host.style.setProperty("opacity", "1", "important");
  host.style.setProperty("isolation", "isolate", "important");

  const root = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `
    .drawer-shell {
      position: fixed;
      inset: 0;
      pointer-events: none;
    }
    .drawer-panel {
      position: absolute;
      width: min(392px, calc(100vw - 12px));
      height: min(566px, calc(100vh - 12px));
      background: #f7f8fc;
      box-shadow: 0 18px 38px rgba(2, 6, 23, 0.28);
      --drawer-x: 0px;
      --drawer-y: 0px;
      --drawer-scale: 0.97;
      transform: translate3d(var(--drawer-x), var(--drawer-y), 0) scale(var(--drawer-scale));
      transform-origin: top left;
      transition: transform 0.18s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.18s ease;
      border-radius: 12px;
      display: none;
      grid-template-rows: minmax(0, 1fr);
      overflow: hidden;
      opacity: 0;
      pointer-events: none;
    }
    .drawer-shell.is-visible .drawer-panel {
      display: grid;
      pointer-events: auto;
    }
    .drawer-frame {
      width: 100%;
      height: 100%;
      border: 0;
      background: #f4f6fb;
      pointer-events: auto;
    }
    .drawer-shell.is-open .drawer-panel {
      opacity: 1;
      --drawer-scale: 1;
    }
    .drawer-shell.is-dragging .drawer-panel {
      transition: opacity 0.18s ease;
    }
  `;

  const shell = document.createElement("div");
  shell.className = "drawer-shell";
  shell.innerHTML = `
    <aside class="drawer-panel" role="dialog" aria-label="OfferU 功能弹窗" aria-modal="false">
      <iframe class="drawer-frame" title="OfferU Drawer" loading="eager" allow="clipboard-write"></iframe>
    </aside>
  `;

  const iframe = shell.querySelector("iframe") as HTMLIFrameElement;
  const panel = shell.querySelector(".drawer-panel") as HTMLElement;
  const PANEL_MARGIN = 10;
  let isOpen = false;
  let panelX = 0;
  let panelY = 0;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragOriginX = 0;
  let dragOriginY = 0;
  let pendingDragX = 0;
  let pendingDragY = 0;
  let dragRAF = 0;
  let dragging = false;
  let closeTimer = 0;

  function getPanelSize(): { width: number; height: number } {
    return {
      width: Math.max(280, Math.min(392, window.innerWidth - 12)),
      height: Math.max(360, Math.min(566, window.innerHeight - 12)),
    };
  }

  function clampPanelPosition(left: number, top: number): { left: number; top: number } {
    const size = getPanelSize();
    const maxLeft = Math.max(PANEL_MARGIN, window.innerWidth - size.width - PANEL_MARGIN);
    const maxTop = Math.max(PANEL_MARGIN, window.innerHeight - size.height - PANEL_MARGIN);
    return {
      left: Math.max(PANEL_MARGIN, Math.min(left, maxLeft)),
      top: Math.max(PANEL_MARGIN, Math.min(top, maxTop)),
    };
  }

  function applyPanelPosition(left = panelX, top = panelY): void {
    const next = clampPanelPosition(left, top);
    panelX = next.left;
    panelY = next.top;
    panel.style.setProperty("--drawer-x", `${panelX}px`);
    panel.style.setProperty("--drawer-y", `${panelY}px`);
  }

  function placePanelAtDefaultRight(): void {
    const size = getPanelSize();
    const defaultLeft = window.innerWidth - size.width - PANEL_MARGIN;
    const defaultTop = Math.round((window.innerHeight - size.height) / 2);
    applyPanelPosition(defaultLeft, defaultTop);
  }

  function ensurePanelVisible(): void {
    const rect = panel.getBoundingClientRect();
    const tooSmall = rect.width < 120 || rect.height < 120;
    const fullyOutside =
      rect.right < PANEL_MARGIN ||
      rect.left > window.innerWidth - PANEL_MARGIN ||
      rect.bottom < PANEL_MARGIN ||
      rect.top > window.innerHeight - PANEL_MARGIN;

    if (tooSmall || fullyOutside) {
      placePanelAtDefaultRight();
    }
  }

  function stopDragState(): void {
    if (dragRAF) {
      window.cancelAnimationFrame(dragRAF);
      dragRAF = 0;
    }
    dragging = false;
    shell.classList.remove("is-dragging");
  }

  function applyDragFrame(): void {
    dragRAF = 0;
    applyPanelPosition(pendingDragX, pendingDragY);
  }

  function startDrag(clientX: number, clientY: number): void {
    if (!isOpen) return;
    dragging = true;
    dragStartX = clientX;
    dragStartY = clientY;
    dragOriginX = panelX;
    dragOriginY = panelY;
    pendingDragX = panelX;
    pendingDragY = panelY;
    shell.classList.add("is-dragging");
  }

  function moveDrag(clientX: number, clientY: number): void {
    if (!dragging) return;
    pendingDragX = dragOriginX + (clientX - dragStartX);
    pendingDragY = dragOriginY + (clientY - dragStartY);

    if (!dragRAF) {
      dragRAF = window.requestAnimationFrame(applyDragFrame);
    }
  }

  function endDrag(clientX?: number, clientY?: number): void {
    if (!dragging) return;

    if (typeof clientX === "number" && typeof clientY === "number") {
      pendingDragX = dragOriginX + (clientX - dragStartX);
      pendingDragY = dragOriginY + (clientY - dragStartY);
      if (dragRAF) {
        window.cancelAnimationFrame(dragRAF);
        dragRAF = 0;
      }
      applyPanelPosition(pendingDragX, pendingDragY);
    }

    stopDragState();
  }

  const close = (): void => {
    if (!isOpen && !shell.classList.contains("is-visible")) return;

    isOpen = false;
    endDrag();
    shell.classList.remove("is-open");

    if (closeTimer) {
      window.clearTimeout(closeTimer);
      closeTimer = 0;
    }

    closeTimer = window.setTimeout(() => {
      if (isOpen) return;
      shell.classList.remove("is-visible");
    }, 190);
  };

  const open = (tab: DrawerTab): void => {
    const nextUrl = buildDrawerUrl(tab);
    if (iframe.getAttribute("src") !== nextUrl) {
      iframe.setAttribute("src", nextUrl);
    }

    if (closeTimer) {
      window.clearTimeout(closeTimer);
      closeTimer = 0;
    }

    shell.classList.add("is-visible");

    if (!isOpen) {
      placePanelAtDefaultRight();
    } else {
      applyPanelPosition(panelX, panelY);
    }

    isOpen = true;
    window.requestAnimationFrame(() => {
      if (!isOpen) return;
      shell.classList.add("is-open");
      ensurePanelVisible();
    });
  };

  const toggle = (tab: DrawerTab = "cart"): void => {
    if (isOpen) {
      close();
      return;
    }
    open(tab);
  };

  const isDrawerOpen = (): boolean => isOpen;

  window.addEventListener("message", (event) => {
    if (!isOpen) return;
    if (event.source !== iframe.contentWindow) return;
    const data = event.data as {
      type?: string;
      clientX?: number;
      clientY?: number;
      screenX?: number;
      screenY?: number;
      reason?: string;
      requestId?: string;
    } | null;
    const dragX = typeof data?.screenX === "number" ? data.screenX : data?.clientX;
    const dragY = typeof data?.screenY === "number" ? data.screenY : data?.clientY;

    if (data?.type === "offeru:drawer-focus-request") {
      try {
        window.focus();
      } catch {
        // ignore focus failures and continue with best-effort iframe focus
      }

      try {
        iframe.focus();
      } catch {
        // ignore iframe focus failures
      }

      iframe.contentWindow?.postMessage(
        {
          type: "offeru:drawer-focus-ack",
          requestId: data.requestId,
        },
        "*",
      );
      return;
    }

    // 抽屉里点「存为岗位」：页内点击不给 activeTab，由这里直接读页面快照交给后台保存，并在页面上提示结果。
    if (data?.type === "offeru:save-page-request") {
      const requestId = data.requestId;
      const reply = (result: SavePageResult): void => {
        showSaveToast(result.message);
        iframe.contentWindow?.postMessage({ type: "offeru:save-page-result", requestId, ...result }, "*");
      };
      let page: PageSnapshot;
      try {
        page = snapshotPage();
      } catch (error) {
        reply({ ok: false, message: "这个页面读不了：" + (error instanceof Error ? error.message : String(error)) });
        return;
      }
      chrome.runtime.sendMessage({ type: "SAVE_PAGE_AS_JOB", page }, (resp?: SavePageResult) => {
        if (chrome.runtime.lastError || !resp) {
          reply({ ok: false, message: "存为岗位失败：" + (chrome.runtime.lastError?.message || "后台无响应") });
          return;
        }
        reply(resp);
      });
      return;
    }

    if (data?.type === "offeru:drawer-close") {
      if (data.reason === DRAWER_CLOSE_REASON_BUTTON) {
        close();
      }
      return;
    }

    if (data?.type === "offeru:drawer-drag-start") {
      if (typeof dragX === "number" && typeof dragY === "number") {
        startDrag(dragX, dragY);
      }
      return;
    }

    if (data?.type === "offeru:drawer-drag-move") {
      if (typeof dragX === "number" && typeof dragY === "number") {
        moveDrag(dragX, dragY);
      }
      return;
    }

    if (data?.type === "offeru:drawer-drag-end") {
      endDrag(dragX, dragY);
    }
  });

  window.addEventListener("resize", () => {
    if (!isOpen) return;
    applyPanelPosition(panelX, panelY);
  });

  document.addEventListener(
    "keydown",
    (event) => {
      if (!isOpen) return;
      if (event.key === "Escape") {
        close();
      }
    },
    true,
  );

  root.appendChild(style);
  root.appendChild(shell);
  (document.body || document.documentElement).appendChild(host);

  drawerController = { open, close, toggle, isOpen: isDrawerOpen };
  return drawerController;
}

function openDrawer(tab: DrawerTab): void {
  try {
    ensurePageDrawer().open(tab);
  } catch {
    chrome.runtime.sendMessage({ type: "OPEN_DRAWER", tab }, (resp: { ok?: boolean }) => {
      if (chrome.runtime.lastError || !resp?.ok) {
        showToast("打开抽屉失败，请重试", true);
      }
    });
  }
}

function toggleDrawer(tab: DrawerTab = "cart"): void {
  try {
    ensurePageDrawer().toggle(tab);
  } catch {
    openDrawer(tab);
  }
}

function openSettingsPage(): void {
  openDrawer("settings");
}

function normalizeShortcutKey(key: string): string {
  const lowered = key.trim().toLowerCase();
  if (lowered === " ") return "Space";
  if (lowered === "escape") return "Esc";
  if (lowered === "arrowup") return "Up";
  if (lowered === "arrowdown") return "Down";
  if (lowered === "arrowleft") return "Left";
  if (lowered === "arrowright") return "Right";
  if (lowered.length === 1) return lowered.toUpperCase();
  if (/^f\d{1,2}$/.test(lowered)) return lowered.toUpperCase();
  return key.trim();
}

function normalizeShortcutString(raw: string): string {
  if (!raw) return "";
  const parts = raw
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

function eventToShortcut(event: KeyboardEvent): string {
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

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function createFloatingDock(): void {
  if (document.getElementById(FLOATING_DOCK_ID)) return;

  const host = document.createElement("div");
  host.id = FLOATING_DOCK_ID;
  host.style.position = "fixed";
  host.style.zIndex = "2147483645";
  host.style.top = `${Math.round(window.innerHeight * 0.38)}px`;
  host.style.right = "0px";
  host.style.left = "auto";
  const motionCurve = "cubic-bezier(0.22, 1, 0.36, 1)";
  const hostTransition = `transform 0.22s ${motionCurve}, top 0.18s ${motionCurve}, left 0.18s ${motionCurve}, right 0.18s ${motionCurve}`;
  host.style.transition = hostTransition;
  host.style.willChange = "transform";

  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    .dock {
      font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif;
      user-select: none;
      -webkit-user-select: none;
      touch-action: none;
      position: relative;
      width: fit-content;
      --motion: cubic-bezier(0.22, 1, 0.36, 1);
    }
    .compact {
      all: initial;
      font-family: inherit;
      border: 1px solid #dbe2ea;
      border-radius: 999px;
      background: #fffffff2;
      color: #111827;
      width: ${DOCK_COMPACT_WIDTH}px;
      height: ${DOCK_COMPACT_HEIGHT}px;
      padding: 0 12px;
      box-shadow: 0 8px 18px rgba(15, 23, 42, 0.18);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: width 0.22s var(--motion), height 0.22s var(--motion), padding 0.22s var(--motion), border-radius 0.22s var(--motion), box-shadow 0.22s var(--motion), background 0.22s var(--motion), backdrop-filter 0.22s var(--motion), opacity 0.18s var(--motion);
    }
    .dock.is-muted .compact {
      filter: grayscale(0.92);
      opacity: 0.64;
    }
    .compact:focus-visible {
      outline: 2px solid #2563eb;
      outline-offset: 2px;
    }
    .compact-inner {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .compact-main {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .brand {
      font-size: 16px;
      font-weight: 700;
      color: #0057be;
      line-height: 1;
    }
    .compact-actions {
      margin-left: auto;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .mini-btn {
      all: initial;
      width: 28px;
      height: 28px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      background: transparent;
      border: none;
    }
    .mini-btn:hover {
      opacity: 0.72;
    }
    .mini-icon {
      font-size: 10px;
      line-height: 1;
      color: #1b1b1e;
    }
    .mini-icon-arrow {
      width: 22px;
      height: 22px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2.2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .mini-icon-chevron {
      width: 22px;
      height: 22px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2.2;
      stroke-linecap: round;
      stroke-linejoin: round;
      transition: transform 0.18s var(--motion);
    }
    .mini-icon-chevron.is-open {
      transform: rotate(180deg);
    }
    .panel {
      position: absolute;
      top: calc(100% + 6px);
      width: ${DOCK_PANEL_WIDTH}px;
      min-height: ${DOCK_PANEL_HEIGHT}px;
      border: 1px solid #ffffff;
      border-radius: 20px;
      background: #ffffffe6;
      backdrop-filter: blur(10px);
      box-shadow: 0 12px 28px rgba(2, 6, 23, 0.14);
      padding: 10px;
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      transform: translateY(-10px) scale(0.94);
      transition: opacity 0.22s var(--motion), transform 0.22s var(--motion), visibility 0.22s linear;
    }
    .panel.show {
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
      transform: translateY(0) scale(1);
    }
    .smart-fill-card {
      margin-top: 8px;
      display: grid;
      gap: 6px;
    }
    .smart-fill-btn {
      all: initial;
      font-family: inherit;
      border-radius: 14px;
      min-height: 44px;
      box-sizing: border-box;
      padding: 8px 10px;
      font-size: 12px;
      font-weight: 700;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      border: 1px solid #1f88ff;
      background: linear-gradient(135deg, #0f66e9, #1f88ff);
      color: #ffffff;
      line-height: 1.2;
      text-align: center;
      transition: transform 0.18s var(--motion), opacity 0.18s var(--motion);
    }
    .smart-fill-btn[disabled] {
      opacity: 0.7;
      cursor: default;
    }
    .smart-fill-btn.is-busy {
      animation: offeruSmartFillBreath 1.15s ease-in-out infinite;
    }
    .smart-fill-link {
      all: initial;
      font-family: inherit;
      cursor: pointer;
      color: #0f66e9;
      font-size: 11px;
      font-weight: 600;
      text-align: center;
      line-height: 1.2;
    }
    .smart-fill-nav {
      margin-top: 2px;
      display: grid;
      grid-template-columns: auto 1fr auto auto auto;
      gap: 6px;
      align-items: center;
      font-size: 11px;
      color: #4b5563;
    }
    .smart-fill-nav.hidden,
    .smart-fill-link.hidden {
      display: none;
    }
    .smart-fill-nav button {
      all: initial;
      font-family: inherit;
      cursor: pointer;
      border-radius: 8px;
      border: 1px solid #d1d5db;
      padding: 2px 6px;
      font-size: 11px;
      color: #374151;
      background: #fff;
      text-align: center;
      min-width: 20px;
    }
    .smart-fill-nav button.exit {
      min-width: auto;
      padding: 2px 8px;
    }
    .smart-fill-checklist {
      margin-top: 6px;
      border: 1px solid #e5e7eb;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.72);
      max-height: 132px;
      overflow: auto;
      padding: 4px;
      display: grid;
      gap: 4px;
    }
    .smart-fill-checklist.hidden {
      display: none;
    }
    .smart-fill-checklist-item {
      all: initial;
      font-family: inherit;
      cursor: pointer;
      display: block;
      border: 1px solid #fecaca;
      border-radius: 8px;
      background: #fff5f5;
      color: #991b1b;
      padding: 5px 7px;
      font-size: 11px;
      line-height: 1.25;
    }
    .smart-fill-checklist-item[data-resolved="false"] {
      border-color: #fca5a5;
      background: #fef2f2;
      color: #b91c1c;
    }
    .smart-fill-checklist-item .tag {
      font-size: 10px;
      margin-left: 4px;
      color: #dc2626;
    }
    @keyframes offeruSmartFillBreath {
      0% { opacity: 0.72; transform: scale(0.995); }
      50% { opacity: 1; transform: scale(1); }
      100% { opacity: 0.72; transform: scale(0.995); }
    }
    .meta {
      margin-top: 8px;
      font-size: 11px;
      color: #6b7280;
      text-align: left;
      line-height: 1.3;
    }
    .meta.meta-secondary {
      margin-top: 4px;
      color: #4b5563;
    }
    .meta.meta-secondary.ok {
      color: #15803d;
    }
    .meta.meta-secondary.warn {
      color: #b45309;
    }
    .dock.theme-dark .compact {
      border-color: #3f3f46;
      background: #27272a;
      color: #f9fafb;
      box-shadow: 0 6px 14px rgba(0, 0, 0, 0.4);
    }
    .dock.theme-dark .brand {
      color: #006fee;
    }
    .dock.theme-dark .mini-btn {
      background: transparent;
      border: none;
    }
    .dock.theme-dark .mini-btn:hover {
      opacity: 0.72;
    }
    .dock.theme-dark .mini-icon {
      color: #a1a1aa;
    }
    .dock.theme-dark .panel {
      border-color: #3f3f46;
      background: #27272a;
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.42);
    }
    .dock.theme-dark .action-btn {
      border-color: transparent;
      background: #3f3f46;
      color: #e5e7eb;
    }
    .dock.theme-dark .action-btn.primary {
      background: linear-gradient(135deg, #1d4ed8, #2563eb);
      border-color: #2563eb;
      color: #ffffff;
    }
    .dock.theme-dark .smart-fill-btn {
      border-color: #2563eb;
      background: linear-gradient(135deg, #1d4ed8, #2563eb);
      color: #ffffff;
    }
    .dock.theme-dark .smart-fill-link {
      color: #93c5fd;
    }
    .dock.theme-dark .smart-fill-nav {
      color: #9ca3af;
    }
    .dock.theme-dark .smart-fill-nav button {
      border-color: #52525b;
      background: #3f3f46;
      color: #e5e7eb;
    }
    .dock.theme-dark .smart-fill-checklist {
      border-color: #52525b;
      background: rgba(39, 39, 42, 0.65);
    }
    .dock.theme-dark .smart-fill-checklist-item {
      border-color: #7f1d1d;
      background: #450a0a;
      color: #fecaca;
    }
    .dock.theme-dark .smart-fill-checklist-item[data-resolved="false"] {
      border-color: #b91c1c;
      background: #3f0a0a;
      color: #fca5a5;
    }
    .dock.theme-dark .meta {
      color: #9ca3af;
    }
    .dock.theme-dark .meta.meta-secondary {
      color: #9ca3af;
    }
    .dock.theme-dark .meta.meta-secondary.ok {
      color: #4ade80;
    }
    .dock.theme-dark .meta.meta-secondary.warn {
      color: #fbbf24;
    }
    .dock.mode-edge .compact {
      padding: 0 10px;
      background: #ffffff;
      border-color: #ffffff;
      box-shadow: 0 6px 14px rgba(2, 6, 23, 0.14);
      opacity: 1;
    }
    .dock.mode-edge.side-left .compact,
    .dock.mode-edge.side-right .compact {
      width: ${EDGE_DOCK_SIDE_WIDTH}px;
      min-width: ${EDGE_DOCK_SIDE_WIDTH}px;
      max-width: ${EDGE_DOCK_SIDE_WIDTH}px;
      height: ${EDGE_DOCK_SIDE_HEIGHT}px;
      min-height: ${EDGE_DOCK_SIDE_HEIGHT}px;
      max-height: ${EDGE_DOCK_SIDE_HEIGHT}px;
    }
    .dock.mode-edge.side-top .compact,
    .dock.mode-edge.side-bottom .compact {
      width: ${EDGE_DOCK_TOP_BOTTOM_WIDTH}px;
      min-width: ${EDGE_DOCK_TOP_BOTTOM_WIDTH}px;
      max-width: ${EDGE_DOCK_TOP_BOTTOM_WIDTH}px;
      height: ${EDGE_DOCK_TOP_BOTTOM_HEIGHT}px;
      min-height: ${EDGE_DOCK_TOP_BOTTOM_HEIGHT}px;
      max-height: ${EDGE_DOCK_TOP_BOTTOM_HEIGHT}px;
    }
    .dock.mode-edge.side-right .compact {
      border-radius: 999px 0 0 999px;
      border-right: 0;
    }
    .dock.mode-edge.side-left .compact {
      border-radius: 0 999px 999px 0;
      border-left: 0;
    }
    .dock.mode-edge.side-top .compact {
      border-radius: 0 0 ${EDGE_DOCK_TOP_BOTTOM_RADIUS}px ${EDGE_DOCK_TOP_BOTTOM_RADIUS}px;
      border-top: 0;
    }
    .dock.mode-edge.side-bottom .compact {
      border-radius: ${EDGE_DOCK_TOP_BOTTOM_RADIUS}px ${EDGE_DOCK_TOP_BOTTOM_RADIUS}px 0 0;
      border-bottom: 0;
    }
    .dock.mode-edge .compact-main {
      width: 100%;
      justify-content: center;
    }
    .dock.mode-edge .badge,
    .dock.mode-edge .compact-actions {
      display: none;
    }
    .dock.mode-edge .brand {
      font-size: 16px;
      color: #0057be;
    }
    .dock.mode-edge:hover .compact,
    .dock.mode-edge.mode-dragging .compact {
      opacity: 1;
    }
    .dock.theme-dark.mode-edge .compact {
      background: #1f1f23;
      border-color: #3f3f46;
      box-shadow: 0 6px 14px rgba(0, 0, 0, 0.42);
    }
    .dock.theme-dark.mode-edge .brand {
      color: #006fee;
    }
    .dock.mode-edge.side-left .compact-inner,
    .dock.mode-edge.side-right .compact-inner,
    .dock.mode-edge.side-top .compact-inner,
    .dock.mode-edge.side-bottom .compact-inner {
      flex-direction: row;
    }
    .dock.side-left .compact-inner {
      flex-direction: row-reverse;
    }
    .dock.side-left .compact-actions {
      margin-left: 0;
      margin-right: auto;
    }
    .dock.side-right .compact-inner {
      flex-direction: row;
    }
    .dock.side-right .compact-actions {
      margin-left: auto;
      margin-right: 0;
    }
    .dock.mode-expanded .compact {
      width: ${DOCK_EXPANDED_WIDTH}px;
      height: ${DOCK_EXPANDED_HEIGHT}px;
      border-radius: 999px;
      box-shadow: 0 10px 22px rgba(15, 23, 42, 0.24);
    }
    .dock.mode-dragging .compact {
      cursor: grabbing;
      box-shadow: 0 12px 30px rgba(15, 23, 42, 0.26);
    }
    .dock.side-left .panel {
      left: 0;
      right: auto;
      transform-origin: left top;
    }
    .dock.side-right .panel {
      right: 0;
      left: auto;
      transform-origin: right top;
    }
    .dock.side-top .panel,
    .dock.side-bottom .panel {
      left: 0;
      right: auto;
      transform-origin: left top;
    }
    .dock.side-bottom .panel {
      top: auto;
      bottom: calc(100% + 16px);
      transform-origin: left bottom;
      transform: translateY(10px) scale(0.94);
    }
  `;

  const wrap = document.createElement("div");
  wrap.className = "dock side-right";

  const compactBtn = document.createElement("div");
  compactBtn.className = "compact";
  compactBtn.setAttribute("role", "button");
  compactBtn.setAttribute("tabindex", "0");
  compactBtn.setAttribute("aria-label", "OfferU 悬浮入口");
  compactBtn.setAttribute("aria-expanded", "false");
  compactBtn.innerHTML = `
    <span class="compact-inner">
      <span class="compact-main">
        <span class="brand">OfferU</span>
      </span>
      <span class="compact-actions">
        <button class="mini-btn" type="button" data-action="open-drawer" aria-label="打开功能弹窗">
          <svg class="mini-icon mini-icon-arrow" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 16L16 8" />
            <path d="M10 8H16V14" />
          </svg>
        </button>
        <button class="mini-btn" type="button" data-action="toggle-panel" aria-label="展开面板">
          <svg class="mini-icon mini-icon-chevron" id="offeruFloatingToggleGlyph" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 9L12 15L18 9" />
          </svg>
        </button>
      </span>
    </span>
  `;

  wrap.appendChild(compactBtn);
  root.appendChild(style);
  root.appendChild(wrap);

  const toggleGlyphEl = root.querySelector("#offeruFloatingToggleGlyph") as HTMLElement | null;
  const pendingHighlighter = new PendingFieldHighlighter();

  let panel: HTMLDivElement | null = null;
  let panelController: AbortController | null = null;
  let collectabilityEl: HTMLDivElement | null = null;
  let smartFillBtnEl: HTMLButtonElement | null = null;
  let smartFillLinkEl: HTMLButtonElement | null = null;
  let smartFillNavEl: HTMLDivElement | null = null;
  let smartFillNavIndexEl: HTMLSpanElement | null = null;
  let smartFillChecklistEl: HTMLDivElement | null = null;
  let latestCollectabilityText = "当前页面：检测中";
  let latestCollectabilityTone: "ok" | "warn" = "warn";
  let smartFillBusy = false;
  let smartFillFilledCount = 0;
  let smartFillPendingCount = 0;
  let smartFillStatus: "idle" | "running" | "preview" | "success" | "partial" | "failed" = "idle";
  let smartFillStatusText = "一键智填";
  let smartFillSubText = "";
  let smartFillResetTimer: number | null = null;
  let smartFillLastRunAt = 0;
  let smartFillRunToken = 0;
  let smartFillRunActive = false;
  let smartFillAbortController: AbortController | null = null;
  let smartFillPlan: CriticalSmartFillPlan | null = null;
  let smartFillPreviewMode = false;
  let smartFillChecklistData: Array<{ fieldId: string; title: string; resolved: boolean; reason: string }> = [];

  let expanded = false;
  let edgeDocked = false;
  let side: DockSide = "right";
  let hovering = false;
  let themePreference: UiTheme = "system";
  let shortcutSettings: ShortcutSettings = { ...DEFAULT_SHORTCUT_SETTINGS };

  const darkMedia = window.matchMedia("(prefers-color-scheme: dark)");

  let pointerActive = false;
  let activePointerId: number | null = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragOriginX = 0;
  let dragOriginY = 0;
  let pendingDx = 0;
  let pendingDy = 0;
  let dragRAF = 0;
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  let dragDistance = 0;
  let dragging = false;
  let pendingUndockFromEdge = false;
  let saveTimer: number | null = null;

  function clampTop(top: number): number {
    const rect = host.getBoundingClientRect();
    const edgeHeight = (side === "left" || side === "right")
      ? EDGE_DOCK_SIDE_HEIGHT
      : EDGE_DOCK_TOP_BOTTOM_HEIGHT;
    const baseHeight = edgeDocked ? edgeHeight : DOCK_EXPANDED_HEIGHT;
    const dockHeight = Math.max(baseHeight, rect.height || baseHeight);
    const maxTop = Math.max(6, window.innerHeight - dockHeight - 6);
    return Math.max(6, Math.min(top, maxTop));
  }

  function clampLeft(left: number): number {
    const rect = host.getBoundingClientRect();
    const edgeWidth = (side === "left" || side === "right")
      ? EDGE_DOCK_SIDE_WIDTH
      : EDGE_DOCK_TOP_BOTTOM_WIDTH;
    const baseWidth = edgeDocked ? edgeWidth : DOCK_EXPANDED_WIDTH;
    const dockWidth = Math.max(baseWidth, rect.width || baseWidth);
    const maxLeft = Math.max(0, window.innerWidth - dockWidth);
    return Math.max(0, Math.min(left, maxLeft));
  }

  function readCurrentTop(): number {
    const parsed = Number.parseFloat(host.style.top || "0");
    return Number.isFinite(parsed) ? parsed : 8;
  }

  function readCurrentLeft(): number {
    const parsed = Number.parseFloat(host.style.left || "");
    if (Number.isFinite(parsed)) {
      return parsed;
    }
    return host.getBoundingClientRect().left;
  }

  function getDefaultUndockedLeft(): number {
    return window.innerWidth - (DOCK_EXPANDED_WIDTH + DOCK_RIGHT_GAP);
  }

  function resolveThemeValue(preference: UiTheme): "light" | "dark" {
    if (preference === "system") {
      return darkMedia.matches ? "dark" : "light";
    }
    return preference;
  }

  function applyDockTheme(): void {
    const resolved = resolveThemeValue(themePreference);
    wrap.classList.toggle("theme-dark", resolved === "dark");
  }

  function resolveSmartFillCollectability(): {
    text: string;
    tone: "ok" | "warn";
  } {
    const fieldCount = scanFieldsSync(document).length;
    if (fieldCount > 0) {
      return {
        text: "当前页面：支持智填",
        tone: "ok",
      };
    }

    return {
      text: "当前页面：未检测到可填写表单",
      tone: "warn",
    };
  }

  function syncPanelSummaryText(): void {
    if (collectabilityEl) {
      collectabilityEl.textContent = latestCollectabilityText;
      collectabilityEl.classList.toggle("ok", latestCollectabilityTone === "ok");
      collectabilityEl.classList.toggle("warn", latestCollectabilityTone === "warn");
    }
  }

  function clearSmartFillResetTimer(): void {
    if (smartFillResetTimer !== null) {
      window.clearTimeout(smartFillResetTimer);
      smartFillResetTimer = null;
    }
  }

  function syncSmartFillNavigationText(): void {
    if (!smartFillNavIndexEl) return;
    if (smartFillPendingCount <= 0) {
      smartFillNavIndexEl.textContent = "0/0";
      return;
    }
    smartFillNavIndexEl.textContent = `${pendingHighlighter.currentIndex()}/${smartFillPendingCount}`;
  }

  function buildChecklistTitle(field: ScannedField): string {
    const label = (field.semanticLabel || field.label || "未命名字段").trim();
    const moduleName = (field.moduleName || "").trim();
    if (!moduleName) return label;
    return `${moduleName} / ${label}`;
  }

  function resolveChecklistReason(field: ScannedField): string {
    const reason = field.runtime?.failureReason || "no_match";
    // Distinguish: AI/rule match failure vs write success failure
    switch (reason) {
      case "no_match": return "档案中无匹配数据";
      case "write_failed": return "已匹配但写入失败";
      case "write_blocked": return "控件不可写或只读";
      case "existing_value": return "已保护网页中的现有值";
      case "verify_failed": return "写入后未通过校验";
      case "control_not_supported": return "复杂控件待手动补充";
      case "validation_error": return "页面校验未通过";
      case "aborted": return "操作已中止";
      case "not_found": return "控件已从页面移除";
      default: return "待手动确认";
    }
  }

  function buildChecklistDataFromHighlighter(): Array<{ fieldId: string; title: string; resolved: boolean; reason: string }> {
    return pendingHighlighter
      .checklist()
      .map(({ field, resolved }) => ({
        fieldId: field.fieldId,
        title: buildChecklistTitle(field),
        resolved,
        reason: resolveChecklistReason(field),
      }));
  }

  function renderSmartFillChecklist(): void {
    if (!smartFillChecklistEl) return;
    const show = smartFillChecklistData.length > 0 && (smartFillPendingCount > 0 || smartFillPreviewMode);
    smartFillChecklistEl.classList.toggle("hidden", !show);
    if (!show) {
      smartFillChecklistEl.innerHTML = "";
      return;
    }

    smartFillChecklistEl.innerHTML = smartFillChecklistData
      .map((item, index) => {
        const safeTitle = item.title
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        const safeReason = item.reason
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        const unresolvedTag = item.resolved ? "" : `<span class="tag">待定位</span>`;
        return `<button class="smart-fill-checklist-item" data-action="smart-fill-focus-item" data-field-id="${item.fieldId}" data-resolved="${item.resolved ? "true" : "false"}">#${index + 1} ${safeTitle}${unresolvedTag}<br/>${safeReason}</button>`;
      })
      .join("");
  }

  function updateSmartFillUi(): void {
    if (!smartFillBtnEl) return;

    smartFillBtnEl.disabled = smartFillBusy;
    smartFillBtnEl.classList.toggle("is-busy", smartFillBusy);
    smartFillBtnEl.textContent = smartFillBusy
      ? `⏸ ${smartFillStatusText}`
      : smartFillStatusText;

    if (smartFillLinkEl) {
      const showLink = (smartFillPreviewMode && !smartFillBusy) || smartFillPendingCount > 0;
      smartFillLinkEl.classList.toggle("hidden", !showLink);
      smartFillLinkEl.dataset.action = smartFillPreviewMode
        ? "smart-fill-cancel-preview"
        : "smart-fill-focus";
      smartFillLinkEl.textContent = smartFillPreviewMode
        ? "取消本次填写"
        : (smartFillSubText || "查看待补字段 ›");
    }

    if (smartFillNavEl) {
      const showNav = !smartFillPreviewMode && smartFillPendingCount > 0;
      smartFillNavEl.classList.toggle("hidden", !showNav);
      syncSmartFillNavigationText();
    }
    renderSmartFillChecklist();
  }

  function resetSmartFillState(): void {
    clearSmartFillResetTimer();
    smartFillBusy = false;
    smartFillFilledCount = 0;
    smartFillPendingCount = 0;
    smartFillStatus = "idle";
    smartFillStatusText = "一键智填";
    smartFillSubText = "";
    smartFillPlan = null;
    smartFillPreviewMode = false;
    smartFillChecklistData = [];
    pendingHighlighter.clear();
    updateSmartFillUi();
  }

  async function runSmartFillFlow(): Promise<void> {
    if (smartFillBusy && smartFillAbortController) {
      smartFillAbortController.abort();
      smartFillAbortController = null;
      smartFillBusy = false;
      smartFillRunActive = false;
      smartFillStatus = "idle";
      smartFillStatusText = "已暂停";
      smartFillSubText = "";
      updateSmartFillUi();
      return;
    }

    const now = Date.now();
    if (smartFillBusy || smartFillRunActive) return;
    if (now - smartFillLastRunAt < 800) return;
    smartFillRunToken += 1;
    const runToken = smartFillRunToken;
    smartFillRunActive = true;
    smartFillLastRunAt = now;
    clearSmartFillResetTimer();

    smartFillBusy = true;
    smartFillFilledCount = 0;
    smartFillPendingCount = 0;
    smartFillChecklistData = [];
    pendingHighlighter.clear();
    smartFillStatus = "running";
    smartFillStatusText = "正在识别页面";
    smartFillSubText = "";
    updateSmartFillUi();

    const slowHintTimer = window.setTimeout(() => {
      if (!smartFillBusy) return;
      smartFillStatusText = "AI 正在分析页面，请稍候…";
      updateSmartFillUi();
    }, 18000);

    smartFillAbortController = new AbortController();

    try {
      const progressHandler = (progress: { detail: string }) => {
        if (runToken !== smartFillRunToken) return;
        smartFillStatusText = progress.detail;
        updateSmartFillUi();
      };

      if (!smartFillPlan) {
        const plan = await prepareCriticalSmartFillPlan({
          signal: smartFillAbortController.signal,
          onProgress: progressHandler,
        });
        if (runToken !== smartFillRunToken) return;
        if (plan.items.length === 0) {
          smartFillStatus = "failed";
          smartFillStatusText = "没有可安全填写的关键字段";
          const existingCount = plan.skipped.filter((item) => item.reason === "existing_value").length;
          smartFillSubText = existingCount > 0
            ? `已保护 ${existingCount} 个网页现有值`
            : "敏感、低置信或非关键字段已跳过";
          smartFillChecklistData = [];
          smartFillPreviewMode = false;
          return;
        }
        smartFillPlan = plan;
        smartFillPreviewMode = true;
        smartFillStatus = "preview";
        smartFillStatusText = `确认填写 ${plan.items.length} 项`;
        const protectedCount = plan.skipped.filter((item) => (
          item.reason === "existing_value" || item.reason === "sensitive"
        )).length;
        smartFillSubText = protectedCount > 0 ? `已保护或跳过 ${protectedCount} 项` : "不会自动提交";
        smartFillChecklistData = plan.items.map((item) => ({
          fieldId: item.field.fieldId,
          title: buildChecklistTitle(item.field),
          resolved: true,
          reason: `将填写：${item.valuePreview}`,
        }));
        return;
      }

      const planToApply = smartFillPlan;
      const result = await applyCriticalSmartFillPlan(planToApply, {
        signal: smartFillAbortController.signal,
        onProgress: progressHandler,
      });
      smartFillPlan = null;
      smartFillPreviewMode = false;

      if (runToken !== smartFillRunToken) return;
      const { outcome } = result;

      smartFillFilledCount = outcome.filledCount;
      smartFillPendingCount = outcome.pendingCount;

      if (result.fields.length === 0) {
        smartFillStatus = "failed";
        smartFillStatusText = "未检测到表单";
        smartFillSubText = "当前页面暂无可填写内容";
        smartFillChecklistData = [];
        pendingHighlighter.clear();
        return;
      }

      if (outcome.pendingCount <= 0) {
        smartFillStatus = "success";
        smartFillStatusText = outcome.skippedCount > 0
          ? `已填写 ${outcome.filledCount} 项｜跳过 ${outcome.skippedCount} 项`
          : `已填写 ${outcome.filledCount} 项`;
        smartFillSubText = outcome.protectedCount > 0
          ? `已保护 ${outcome.protectedCount} 项，页面不会自动提交`
          : "已完成本页智填，不会自动提交";
        smartFillChecklistData = [];
        pendingHighlighter.clear();
        smartFillResetTimer = window.setTimeout(() => {
          resetSmartFillState();
        }, 2000);
        return;
      }

      smartFillStatus = "partial";
      smartFillStatusText = outcome.aiUsed
        ? `已填 ${outcome.filledCount} 项｜待补 ${outcome.pendingCount} 项`
        : `已用规则智填｜待补 ${outcome.pendingCount} 项`;
      smartFillSubText = "查看待补字段 ›";
      pendingHighlighter.setPending(outcome.pendingFields);
      smartFillChecklistData = buildChecklistDataFromHighlighter();
      const unresolvedCount = pendingHighlighter.unresolvedCount();
      const highlightedCount = pendingHighlighter.size();
      smartFillPendingCount = outcome.pendingCount;
      if (smartFillPendingCount <= 0 && highlightedCount > 0) {
        smartFillPendingCount = highlightedCount;
      }
      if (smartFillPendingCount <= 0) {
        smartFillStatus = "success";
        smartFillStatusText = `已填写 ${outcome.filledCount} 项`;
        smartFillSubText = "已完成本页智填";
        smartFillChecklistData = [];
        pendingHighlighter.clear();
        smartFillResetTimer = window.setTimeout(() => {
          resetSmartFillState();
        }, 2000);
        return;
      }
      const suffix = unresolvedCount > 0 ? `（其中 ${unresolvedCount} 项待定位）` : "";
      smartFillStatusText = outcome.aiUsed
        ? `已填 ${outcome.filledCount} 项｜待补 ${smartFillPendingCount} 项${suffix}`
        : `已用规则智填｜待补 ${smartFillPendingCount} 项${suffix}`;
      if (highlightedCount > 0) {
        pendingHighlighter.focusFirst();
      }
    } catch (error: unknown) {
      if (runToken !== smartFillRunToken) return;
      smartFillStatus = "failed";
      const text = safeExtensionError(error, "请求失败");
      if (smartFillPendingCount > 0) {
        smartFillSubText = "查看待补字段 ›";
      } else {
        pendingHighlighter.clear();
        smartFillPendingCount = 0;
        smartFillChecklistData = [];
      }
      if (/档案|profile/i.test(text)) {
        smartFillStatusText = "未读取到档案";
        smartFillSubText = "请检查 OfferU 后端连接";
      } else if (/超时/i.test(text)) {
        smartFillStatusText = "智填超时，请重试";
        smartFillSubText = "";
      } else if (/fetch|网络|连接失败|Failed to fetch/i.test(text)) {
        smartFillStatusText = "AI 服务调用失败";
        smartFillSubText = "请检查网络或 AI 配置";
      } else if (/页面已变化|计划已过期/i.test(text)) {
        smartFillPlan = null;
        smartFillPreviewMode = false;
        smartFillStatusText = "页面已变化，请重新扫描";
        smartFillSubText = "";
      } else if (/Failed to set|Permission denied|read.only/i.test(text)) {
        smartFillStatusText = "部分字段写入失败";
        smartFillSubText = smartFillPendingCount > 0 ? "查看待补字段 ›" : "";
      } else {
        smartFillStatusText = "部分字段未写入";
        smartFillSubText = smartFillPendingCount > 0 ? "查看待补字段 ›" : "";
      }
    } finally {
      smartFillAbortController = null;
      if (runToken === smartFillRunToken) {
        smartFillRunActive = false;
      }
      smartFillBusy = false;
      window.clearTimeout(slowHintTimer);
      updateSmartFillUi();
      void refreshFloatingStatus();
    }
  }

  function handlePanelAction(action: string, trigger?: HTMLElement | null): void {
    if (action === "smart-fill") {
      void runSmartFillFlow();
      return;
    }

    if (action === "smart-fill-cancel-preview") {
      resetSmartFillState();
      return;
    }

    if (action === "smart-fill-focus") {
      pendingHighlighter.focusFirst();
      syncSmartFillNavigationText();
      return;
    }

    if (action === "smart-fill-focus-item") {
      const node = trigger?.closest<HTMLElement>("[data-field-id]") || null;
      const fieldId = node?.dataset.fieldId || "";
      if (smartFillPreviewMode && smartFillPlan) {
        const planned = smartFillPlan.items.find((item) => item.field.fieldId === fieldId);
        if (planned) {
          try {
            planned.field.element.scrollIntoView({ block: "center", behavior: "smooth" });
            planned.field.element.focus({ preventScroll: true });
          } catch { /* detached or non-focusable control */ }
        }
        return;
      }
      const focused = pendingHighlighter.focusByFieldId(fieldId);
      if (!focused) {
        pendingHighlighter.focusFirst();
      }
      syncSmartFillNavigationText();
      return;
    }

    if (action === "smart-fill-prev") {
      pendingHighlighter.focusPrev();
      syncSmartFillNavigationText();
      return;
    }

    if (action === "smart-fill-next") {
      pendingHighlighter.focusNext();
      syncSmartFillNavigationText();
      return;
    }

    if (action === "smart-fill-exit") {
      resetSmartFillState();
      latestCollectabilityText = "当前页面：支持智填";
      latestCollectabilityTone = "ok";
      syncPanelSummaryText();
    }
  }

  function mountPanel(): HTMLDivElement {
    if (panel) {
      syncPanelSummaryText();
      return panel;
    }

    const nextPanel = document.createElement("div");
    nextPanel.className = "panel";
    nextPanel.innerHTML = `
      <div class="smart-fill-card">
        <button class="smart-fill-btn" data-action="smart-fill" type="button">一键智填</button>
        <button class="smart-fill-link hidden" data-action="smart-fill-focus" type="button">查看待补字段 ›</button>
        <div class="meta meta-secondary">先预览再确认 · 不覆盖已填值 · 不自动提交</div>
      </div>
      <div class="smart-fill-nav hidden" id="offeruSmartFillNav">
        <span>待补导航</span>
        <span id="offeruSmartFillNavIndex">0/0</span>
        <button type="button" data-action="smart-fill-prev">←</button>
        <button type="button" data-action="smart-fill-next">→</button>
        <button type="button" class="exit" data-action="smart-fill-exit">退出高亮</button>
      </div>
      <div class="smart-fill-checklist hidden" id="offeruSmartFillChecklist"></div>
      <div class="meta meta-secondary" id="offeruFloatingCollectability">${latestCollectabilityText}</div>
    `;

    panelController = new AbortController();
    nextPanel.addEventListener(
      "click",
      (event) => {
        const target = event.target as HTMLElement;
        if (target.closest("[data-action='smart-fill-focus-item']")) {
          const node = target.closest<HTMLElement>("[data-action='smart-fill-focus-item']");
          handlePanelAction("smart-fill-focus-item", node);
          return;
        }
        const action = target.closest<HTMLButtonElement>("button[data-action]")?.dataset.action;
        if (!action) return;
        handlePanelAction(action, target);
      },
      { signal: panelController.signal },
    );

    wrap.appendChild(nextPanel);

    panel = nextPanel;
    collectabilityEl = panel.querySelector("#offeruFloatingCollectability") as HTMLDivElement | null;
    smartFillBtnEl = panel.querySelector(".smart-fill-btn") as HTMLButtonElement | null;
    smartFillLinkEl = panel.querySelector(".smart-fill-link") as HTMLButtonElement | null;
    smartFillNavEl = panel.querySelector("#offeruSmartFillNav") as HTMLDivElement | null;
    smartFillNavIndexEl = panel.querySelector("#offeruSmartFillNavIndex") as HTMLSpanElement | null;
    smartFillChecklistEl = panel.querySelector("#offeruSmartFillChecklist") as HTMLDivElement | null;
    syncPanelSummaryText();
    updateSmartFillUi();
    return nextPanel;
  }

  function unmountPanel(): void {
    if (!panel) return;

    panelController?.abort();
    panelController = null;

    panel.remove();
    panel = null;
    collectabilityEl = null;
    smartFillBtnEl = null;
    smartFillLinkEl = null;
    smartFillNavEl = null;
    smartFillNavIndexEl = null;
    smartFillChecklistEl = null;
  }

  function currentPeekTransform(): string {
    return "translate3d(0, 0, 0)";
  }

  function renderHostTransform(): void {
    const baseTransform = currentPeekTransform();
    if (dragOffsetX === 0 && dragOffsetY === 0) {
      host.style.transform = baseTransform;
      return;
    }

    host.style.transform = `${baseTransform} translate3d(${dragOffsetX}px, ${dragOffsetY}px, 0)`;
  }

  function updatePeek(): void {
    const edgeOnly = edgeDocked && !expanded && !hovering && !dragging;
    const muted = !hovering && !expanded && !dragging;

    wrap.classList.toggle("mode-edge", edgeOnly);
    wrap.classList.toggle("is-muted", muted);
    compactBtn.setAttribute("aria-label", edgeOnly ? "OfferU 贴边入口" : "OfferU 悬浮入口");
    renderHostTransform();
  }

  function setSide(next: DockSide): void {
    side = next;
    wrap.classList.toggle("side-left", side === "left");
    wrap.classList.toggle("side-right", side === "right");
    wrap.classList.toggle("side-top", side === "top");
    wrap.classList.toggle("side-bottom", side === "bottom");
  }

  function setExpanded(next: boolean, persist = true): void {
    expanded = next;
    wrap.classList.toggle("mode-expanded", expanded);

    if (expanded) {
      const nextPanel = mountPanel();
      nextPanel.classList.add("show");
      void refreshFloatingStatus();
    } else {
      panel?.classList.remove("show");
      unmountPanel();
    }

    compactBtn.setAttribute("aria-expanded", expanded ? "true" : "false");
    if (toggleGlyphEl) {
      toggleGlyphEl.classList.toggle("is-open", expanded);
    }
    updatePeek();
    if (persist) {
      scheduleDockStateSave();
    }
  }

  function getRect(): { x: number; y: number } {
    const rect = host.getBoundingClientRect();
    return { x: rect.left, y: rect.top };
  }

  function moveTo(x: number, y: number): void {
    const safeX = clampLeft(x);
    const safeY = clampTop(y);
    host.style.top = `${safeY}px`;
    host.style.left = `${safeX}px`;
    host.style.right = "auto";
  }

  function dockToEdge(nextSide: DockSide, left: number, top: number): void {
    edgeDocked = true;
    setSide(nextSide);
    if (expanded) {
      setExpanded(false, false);
    }

    if (nextSide === "left" || nextSide === "right") {
      host.style.top = `${clampTop(top)}px`;
      host.style.left = nextSide === "left" ? "0px" : "auto";
      host.style.right = nextSide === "right" ? "0px" : "auto";
      updatePeek();
      return;
    }

    host.style.left = `${clampLeft(left)}px`;
    host.style.right = "auto";
    const edgeHeight = nextSide === "top" || nextSide === "bottom"
      ? EDGE_DOCK_TOP_BOTTOM_HEIGHT
      : EDGE_DOCK_SIDE_HEIGHT;
    host.style.top = nextSide === "top" ? "0px" : `${Math.max(0, window.innerHeight - edgeHeight)}px`;
    updatePeek();
  }

  function undockTo(left: number, top: number): void {
    edgeDocked = false;
    host.style.top = `${clampTop(top)}px`;
    host.style.left = `${clampLeft(left)}px`;
    host.style.right = "auto";
    updatePeek();
  }

  function settleAfterDrag(): void {
    const rect = host.getBoundingClientRect();

    const candidates: Array<{ side: DockSide; gap: number }> = [
      { side: "left", gap: rect.left },
      { side: "right", gap: window.innerWidth - (rect.left + rect.width) },
      { side: "top", gap: rect.top },
      { side: "bottom", gap: window.innerHeight - (rect.top + rect.height) },
    ];
    candidates.sort((a, b) => a.gap - b.gap);

    const nearest = candidates[0];
    if (nearest && nearest.gap <= DOCK_EDGE_SNAP_DISTANCE) {
      dockToEdge(nearest.side, rect.left, rect.top);
    } else {
      undockTo(rect.left, rect.top);
    }

    scheduleDockStateSave();
  }

  function applyDragFrame(): void {
    dragRAF = 0;
    dragOffsetX = pendingDx;
    dragOffsetY = pendingDy;
    renderHostTransform();
  }

  function scheduleDockStateSave(): void {
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer);
    }
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      const nextState: FloatingDockState = {
        side,
        top: readCurrentTop(),
        expanded: false,
        edgeDocked,
        left: readCurrentLeft(),
      };
      chrome.storage.local.set({ [FLOATING_DOCK_STORAGE_KEY]: nextState });
    }, 120);
  }

  async function restoreDockState(): Promise<void> {
    const stored = await new Promise<Partial<FloatingDockState> | null>((resolve) => {
      chrome.storage.local.get([FLOATING_DOCK_STORAGE_KEY], (result) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        const value = result[FLOATING_DOCK_STORAGE_KEY];
        if (!value || typeof value !== "object") {
          resolve(null);
          return;
        }
        resolve(value as Partial<FloatingDockState>);
      });
    });

    if (!stored) {
      const defaultLeft = getDefaultUndockedLeft();
      const defaultTop = Math.round(window.innerHeight * 0.38);
      undockTo(defaultLeft, defaultTop);
      return;
    }

    if (stored.side === "left" || stored.side === "right" || stored.side === "top" || stored.side === "bottom") {
      setSide(stored.side);
    }

    if (typeof stored.top === "number" && Number.isFinite(stored.top)) {
      host.style.top = `${clampTop(stored.top)}px`;
    }

    const top = typeof stored.top === "number" && Number.isFinite(stored.top)
      ? stored.top
      : Math.round(window.innerHeight * 0.38);
    const left = typeof stored.left === "number" && Number.isFinite(stored.left)
      ? stored.left
      : getDefaultUndockedLeft();

    if (stored.edgeDocked) {
      dockToEdge(side, left, top);
    } else {
      undockTo(left, top);
    }

    setExpanded(false, false);
  }

  function finishPointerInteraction(): void {
    if (!pointerActive) return;

    window.removeEventListener("pointermove", handleDragPointerMove, true);
    window.removeEventListener("pointerup", handleDragPointerFinish, true);
    window.removeEventListener("pointercancel", handleDragPointerFinish, true);

    const wasDragging = dragging;

    if (dragRAF) {
      window.cancelAnimationFrame(dragRAF);
      dragRAF = 0;
    }

    if (activePointerId !== null && compactBtn.hasPointerCapture(activePointerId)) {
      compactBtn.releasePointerCapture(activePointerId);
    }

    pointerActive = false;
    activePointerId = null;
    dragging = false;
    pendingUndockFromEdge = false;
    dragDistance = 0;
    host.style.transition = hostTransition;
    wrap.classList.remove("mode-dragging");

    if (wasDragging) {
      const finalLeft = dragOriginX + pendingDx;
      const finalTop = dragOriginY + pendingDy;
      dragOffsetX = 0;
      dragOffsetY = 0;
      renderHostTransform();
      moveTo(finalLeft, finalTop);
      settleAfterDrag();
      return;
    }

    dragOffsetX = 0;
    dragOffsetY = 0;
    updatePeek();
  }

  function handleDragPointerMove(event: PointerEvent): void {
    if (!pointerActive || event.pointerId !== activePointerId) return;

    const dx = event.clientX - dragStartX;
    const dy = event.clientY - dragStartY;
    pendingDx = dx;
    pendingDy = dy;
    dragDistance = Math.hypot(dx, dy);

    if (!dragging && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
      dragging = true;
      if (pendingUndockFromEdge) {
        edgeDocked = false;
        const current = getRect();
        host.style.left = `${clampLeft(current.x)}px`;
        host.style.right = "auto";
        pendingUndockFromEdge = false;
      }
      setExpanded(false);
    }

    if (!dragging) return;

    if (!dragRAF) {
      dragRAF = window.requestAnimationFrame(applyDragFrame);
    }
  }

  function handleDragPointerFinish(event: PointerEvent): void {
    if (event.pointerId !== activePointerId) return;
    finishPointerInteraction();
  }

  async function refreshFloatingStatus(): Promise<void> {
    const collectability = resolveSmartFillCollectability();
    latestCollectabilityText = collectability.text;
    latestCollectabilityTone = collectability.tone;
    syncPanelSummaryText();
  }

  function loadThemePreference(): void {
    chrome.storage.local.get([POPUP_UI_SETTINGS_KEY], (result) => {
      const settings = (result[POPUP_UI_SETTINGS_KEY] || {}) as PopupUiSettings;
      const nextTheme = settings.theme;
      if (nextTheme === "light" || nextTheme === "dark" || nextTheme === "system") {
        themePreference = nextTheme;
      } else {
        themePreference = "system";
      }
      applyDockTheme();
    });
  }

  function loadShortcutPreference(): void {
    chrome.storage.local.get([SHORTCUT_SETTINGS_KEY], (result) => {
      const raw = (result[SHORTCUT_SETTINGS_KEY] || {}) as Partial<ShortcutSettings>;
      shortcutSettings = {
        settings: normalizeShortcutString(raw.settings || DEFAULT_SHORTCUT_SETTINGS.settings),
      };
    });
  }

  function handleShortcutAction(action: keyof ShortcutSettings): void {
    if (action === "settings") {
      openSettingsPage();
    }
  }

  function handleShortcutKeydown(event: KeyboardEvent): void {
    if (isEditableTarget(event.target)) return;

    const pressed = eventToShortcut(event);
    if (!pressed) return;

    const settingsShortcut = normalizeShortcutString(shortcutSettings.settings);

    if (pressed === settingsShortcut) {
      event.preventDefault();
      handleShortcutAction("settings");
    }
  }

  darkMedia.addEventListener("change", () => {
    if (themePreference === "system") {
      applyDockTheme();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;

    if (changes[POPUP_UI_SETTINGS_KEY]) {
      const next = changes[POPUP_UI_SETTINGS_KEY].newValue as PopupUiSettings | undefined;
      const nextTheme = next?.theme;
      if (nextTheme === "light" || nextTheme === "dark" || nextTheme === "system") {
        themePreference = nextTheme;
      } else {
        themePreference = "system";
      }
      applyDockTheme();
    }

    if (changes[SHORTCUT_SETTINGS_KEY]) {
      loadShortcutPreference();
    }
  });

  compactBtn.addEventListener("pointerdown", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("button[data-action]")) return;
    if (event.button !== 0) return;
    event.preventDefault();

    pointerActive = true;
    activePointerId = event.pointerId;
    dragging = false;
    dragDistance = 0;
    dragStartX = event.clientX;
    dragStartY = event.clientY;
    const pos = getRect();
    dragOriginX = pos.x;
    dragOriginY = pos.y;
    pendingUndockFromEdge = edgeDocked;

    wrap.classList.add("mode-dragging");
    host.style.transition = "none";
    compactBtn.setPointerCapture(event.pointerId);
    window.addEventListener("pointermove", handleDragPointerMove, true);
    window.addEventListener("pointerup", handleDragPointerFinish, true);
    window.addEventListener("pointercancel", handleDragPointerFinish, true);
  });

  compactBtn.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const action = target.closest<HTMLButtonElement>("button[data-action]")?.dataset.action;
    if (!action) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    if (action === "open-drawer") {
      toggleDrawer("cart");
      return;
    }

    if (action === "toggle-panel") {
      setExpanded(!expanded);
    }
  });

  compactBtn.addEventListener("lostpointercapture", (event) => {
    if (event.pointerId !== activePointerId) return;
    finishPointerInteraction();
  });

  wrap.addEventListener("mouseenter", () => {
    hovering = true;
    updatePeek();
    void refreshFloatingStatus();
  });

  wrap.addEventListener("mouseleave", () => {
    hovering = false;
    updatePeek();
  });

  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!expanded) return;
      const eventPath = typeof event.composedPath === "function" ? event.composedPath() : [];
      if (eventPath.includes(host)) return;
      setExpanded(false);
    },
    true,
  );

  window.addEventListener("resize", () => {
    const currentTop = readCurrentTop();
    const currentLeft = readCurrentLeft();
    if (edgeDocked) {
      dockToEdge(side, currentLeft, currentTop);
      return;
    }

    undockTo(currentLeft, currentTop);
  });

  window.addEventListener("beforeunload", () => {
    pendingHighlighter.clear();
  });

  document.addEventListener("keydown", handleShortcutKeydown, true);

  document.body.appendChild(host);

  void restoreDockState();
  loadThemePreference();
  loadShortcutPreference();
  updatePeek();
  void refreshFloatingStatus();
}

function run(): void {
  createFloatingDock();
}

let refreshTimer: number | null = null;

function scheduleRun(): void {
  if (refreshTimer !== null) {
    window.clearTimeout(refreshTimer);
  }
  refreshTimer = window.setTimeout(() => {
    run();
    refreshTimer = null;
  }, 220);
}

function init(): void {
  run();

  const observer = new MutationObserver(() => {
    scheduleRun();
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
