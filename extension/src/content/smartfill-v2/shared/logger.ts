import { TAG } from "./constants.js";
import { safeExtensionDebugPayload } from "../../../lib/safe-error.js";

let debugEnabled = false;

export function setDebugEnabled(enabled: boolean): void {
  debugEnabled = enabled;
}

export interface LogEntry {
  scope: "smart-fill.run" | "smart-fill.field";
  severity: "info" | "warn" | "error";
  payload: Record<string, unknown>;
}

const runLogs: LogEntry[] = [];

export function logDebug(tag: string, payload: unknown): void {
  if (!debugEnabled) return;
  try {
    console.groupCollapsed(`[OfferU SmartFill] ${tag}`);
    console.log(safeExtensionDebugPayload(payload));
    console.groupEnd();
  } catch {
    // ignore logging errors
  }
}

export function logRunEntry(entry: LogEntry): void {
  runLogs.push(entry);
}

export function flushRunLogs(): LogEntry[] {
  return runLogs.splice(0, runLogs.length);
}

export function logPipelineStage(
  stage: string,
  detail: string,
  payload?: Record<string, unknown>,
): void {
  logDebug(stage, { detail, ...payload, timestamp: new Date().toISOString() });
}
